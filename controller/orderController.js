const Order = require("../models/orderModel");
const User = require("../models/userModel");
const Address = require("../models/addressModel");
const razorpay = require("../utils/razorpay");
const Product = require("../models/productModel");
const { getSizePricing } = require("../utils/pricing");
const { recordTransaction } = require("../services/paymentRecoveryService");
const { logPaymentEvent } = require("../utils/paymentLogger");
const { notifyOrderPlacedWhatsApp } = require("../utils/whatsapp");
const { sendOrderConfirmationEmail } = require("../utils/mailer");

// 1. Place Order (User)
const placeOrder = async (req, res) => {
  try {
    const userId = req.userId;
    const { items, address, paymentMethod = "COD", currency = "INR" } = req.body;
    const rawKey = req.body?.idempotencyKey || req.headers["x-idempotency-key"];
    const idempotencyKey =
      typeof rawKey === "string" && rawKey.trim() ? rawKey.trim().slice(0, 128) : null;

    if (idempotencyKey) {
      const existingOrder = await Order.findOne({ user: userId, idempotencyKey });
      if (existingOrder) {
        let existingRzpOrder = null;
        if (existingOrder.paymentMethod === "UPI" && existingOrder.razorpay_order_id) {
          existingRzpOrder = {
            id: existingOrder.razorpay_order_id,
            amount: Math.round((existingOrder.totalAmount || 0) * 100),
            currency: existingOrder.currency || "INR",
          };
        }
        return res.status(200).json({
          success: true,
          deduplicated: true,
          message: "Existing order retrieved",
          order: existingOrder,
          razorpayOrder: existingRzpOrder,
          paymentMethod: existingOrder.paymentMethod,
        });
      }
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "Cart is empty" });
    }

    if (!address || !address._id) {
      return res.status(400).json({ message: "Shipping address is required" });
    }

    if (!["COD", "UPI"].includes(paymentMethod)) {
      return res.status(400).json({ message: "Invalid payment method" });
    }

    const savedAddress = await Address.findOne({ _id: address._id, user: userId });
    if (!savedAddress) {
      return res.status(400).json({ message: "Invalid shipping address" });
    }

    // 1. Validate Stock & Calculate Total from DB prices
    let total = 0;
    const validatedItems = [];

    for (const item of items) {
      const quantity = Number(item.quantity);
      if (!item.productId || !Number.isInteger(quantity) || quantity < 1) {
        return res.status(400).json({ message: "Invalid order item or quantity" });
      }

      const product = await Product.findById(item.productId);
      if (!product) {
        return res.status(404).json({ message: `Product ${item.name || ""} not found` });
      }
      if (product.isActive === false) {
        return res.status(400).json({
          message: `Product "${product.name}" is currently unavailable. Please remove it from your cart.`,
        });
      }
      if (product.stock < quantity) {
        return res.status(400).json({ message: `Not enough stock for ${product.name}` });
      }
      const requestedSize = typeof item.size === "string" ? item.size.trim() : "";
      const { effectivePrice: unitPrice, size: resolvedSize } = getSizePricing(
        product,
        requestedSize
      );
      total += unitPrice * quantity;
      validatedItems.push({
        product: product._id,
        quantity,
        size: resolvedSize,
        price: unitPrice,
      });
    }

    if (total <= 0) {
      return res.status(400).json({ message: "Invalid order total" });
    }

    // 2. Create Razorpay Order first if UPI
    let razorpayOrder = null;
    if (paymentMethod === "UPI") {
      try {
        const options = {
          amount: Math.round(total * 100), // in paise
          currency,
          receipt: `receipt_${Date.now()}`,
        };

        razorpayOrder = await razorpay.orders.create(options);

        if (!razorpayOrder) {
          return res.status(503).json({
            message: "Unable to initiate payment gateway order. Please try again.",
          });
        }
      } catch (gwErr) {
        logPaymentEvent("error", "razorpay_order_create_failed", {
          userId,
          errorMessage: gwErr?.error?.description || gwErr?.message || "Gateway unavailable",
        });
        return res.status(503).json({
          message: "Payment gateway temporarily unavailable. Please try again shortly.",
        });
      }
    }

    // 3. Create Order (Stock for UPI is deducted atomically only upon confirmed payment)
    const orderNumber = `FRG-${Date.now().toString(36).toUpperCase()}-${Math.random()
      .toString(36)
      .slice(2, 6)
      .toUpperCase()}`;

    const order = new Order({
      user: userId,
      orderNumber,
      orderItems: validatedItems,
      shippingAddress: savedAddress._id,
      paymentMethod,
      paymentStatus: "Pending",
      paymentState: paymentMethod === "UPI" ? "CREATED" : "PENDING",
      currency,
      totalAmount: total,
      razorpay_order_id: razorpayOrder?.id,
      payment_gateway_status: razorpayOrder?.status || null,
      stockDeducted: false,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });

    try {
      await order.save();
    } catch (saveErr) {
      if (saveErr?.code === 11000 && idempotencyKey) {
        const dupOrder = await Order.findOne({ user: userId, idempotencyKey });
        if (dupOrder) {
          return res.status(200).json({
            success: true,
            deduplicated: true,
            message: "Existing order retrieved",
            order: dupOrder,
            razorpayOrder: dupOrder.razorpay_order_id
              ? {
                  id: dupOrder.razorpay_order_id,
                  amount: Math.round((dupOrder.totalAmount || 0) * 100),
                  currency: dupOrder.currency || "INR",
                }
              : null,
            paymentMethod: dupOrder.paymentMethod,
          });
        }
      }
      throw saveErr;
    }

    if (paymentMethod === "UPI" && razorpayOrder?.id) {
      await recordTransaction({
        order,
        gatewayOrderId: razorpayOrder.id,
        gatewayStatus: razorpayOrder.status || "created",
        mappedStatus: "CREATED",
        amount: razorpayOrder.amount,
        currency: razorpayOrder.currency || currency,
        source: "checkout",
      });
      logPaymentEvent("info", "razorpay_order_created", {
        orderId: order._id.toString(),
        razorpayOrderId: razorpayOrder.id,
        amountPaise: razorpayOrder.amount,
      });
    }

    // 4. For COD, deduct stock atomically and clear cart immediately.
    // For UPI, both stock deduction and cart clearing happen atomically once payment is verified.
    if (paymentMethod === "COD") {
      const decrementedItems = [];
      for (const item of validatedItems) {
        const updatedProduct = await Product.findOneAndUpdate(
          { _id: item.product, stock: { $gte: item.quantity }, isActive: { $ne: false } },
          { $inc: { stock: -item.quantity } },
          { new: true }
        );
        if (!updatedProduct) {
          for (const prev of decrementedItems) {
            await Product.findByIdAndUpdate(prev.product, { $inc: { stock: prev.quantity } });
          }
          await Order.findByIdAndDelete(order._id);
          return res.status(400).json({ message: "Insufficient stock to complete order" });
        }
        decrementedItems.push(item);
      }

      order.stockDeducted = true;
      await order.save();

      await User.findByIdAndUpdate(userId, {
        cart: [],
        cart_total: 0,
      });

      void notifyOrderPlacedWhatsApp(order._id).catch((waErr) => {
        logPaymentEvent("error", "whatsapp_cod_dispatch_error", {
          orderId: order._id.toString(),
          errorMessage: waErr.message,
        });
      });

      void sendOrderConfirmationEmail(order._id).catch((mailErr) => {
        logPaymentEvent("warn", "order_confirmation_email_cod_dispatch_error", {
          orderId: order._id.toString(),
          errorMessage: mailErr.message,
        });
      });
    }

    const populatedOrder = await Order.findById(order._id)
      .populate("orderItems.product", "name title brand price images")
      .populate("shippingAddress");

    res.status(200).json({
      success: true,
      message: "Order placed successfully",
      order: populatedOrder || order,
      razorpayOrder,
      paymentMethod
    });
  } catch (error) {
    console.error("Order Placement Error:", error);
    res.status(500).json({
      message: "Server Error",
      error: error.message,
    });
  }
};

// 2. Get User Orders
const getUserOrders = async (req, res) => {
  try {
    const orders = await Order.find({ user: req.userId })
      .populate("orderItems.product")
      .populate("shippingAddress")
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      data: orders
    });
  } catch (error) {
    res.status(500).json({ message: "Error fetching orders", error: error.message });
  }
};

// 3. Get All Orders (Admin)
const getAllOrders = async (req, res) => {
  try {
    const orders = await Order.find()
      .populate("user", "name email")
      .populate("orderItems.product")
      .populate("shippingAddress")
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      orders
    });
  } catch (error) {
    res.status(500).json({ message: "Error fetching all orders", error: error.message });
  }
};

// 4. Update Order Status (Admin)
const updateOrderStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const allowedStatuses = [
      "Pending",
      "Confirmed",
      "Shipping",
      "Delivered",
      "Cancelled",
      "Returned",
      "Failed Delivery",
    ];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ message: "Invalid delivery status" });
    }

    const updateFields = { deliveryStatus: status };
    if (status === "Delivered") {
      updateFields.deliveredAt = new Date();
    }

    const updatedOrder = await Order.findByIdAndUpdate(
      id,
      updateFields,
      { new: true }
    );

    if (!updatedOrder) {
      return res.status(404).json({ message: "Order not found" });
    }

    res.status(200).json({
      success: true,
      message: "Order status updated",
      order: updatedOrder
    });
  } catch (error) {
    res.status(500).json({ message: "Error updating status", error: error.message });
  }
};

// 5. Cancel Order (User)
const cancelOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const order = await Order.findById(id);

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    if (order.user.toString() !== req.userId) {
      return res.status(403).json({ message: "Not authorized to cancel this order" });
    }

    if (order.deliveryStatus !== "Pending" && order.deliveryStatus !== "Confirmed") {
      return res.status(400).json({ message: "Order cannot be cancelled at this stage" });
    }

    order.deliveryStatus = "Cancelled";
    if (order.stockDeducted && !order.stockRestored) {
      for (const item of order.orderItems) {
        if (item.product) {
          await Product.findByIdAndUpdate(item.product, {
            $inc: { stock: item.quantity },
          });
        }
      }
      order.stockRestored = true;
    }
    await order.save();

    res.status(200).json({
      success: true,
      message: "Order cancelled successfully",
      order
    });
  } catch (error) {
    res.status(500).json({ message: "Error cancelling order", error: error.message });
  }
};

// 6. Return Order (User)
const returnOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const order = await Order.findById(id);

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    if (order.user.toString() !== req.userId) {
      return res.status(403).json({ message: "Not authorized to return this order" });
    }

    if (order.isReturned || order.deliveryStatus === "Returned") {
      return res.status(400).json({ message: "Return request has already been submitted for this order" });
    }

    if (order.deliveryStatus !== "Delivered") {
      return res.status(400).json({ message: "Order must be delivered before it can be returned" });
    }

    const cleanedReason = typeof reason === "string" ? reason.trim().slice(0, 500) : "";
    if (!cleanedReason) {
      return res.status(400).json({ message: "Please select or provide a reason for return" });
    }

    order.deliveryStatus = "Returned";
    order.isReturned = true;
    order.returnReason = cleanedReason;
    order.returnStatus = "Requested";
    order.returnedAt = new Date();

    await order.save();

    res.status(200).json({
      success: true,
      message: "Return request submitted",
      order
    });
  } catch (error) {
    res.status(500).json({ message: "Error processing return", error: error.message });
  }
};

const downloadOrderInvoice = async (req, res) => {
  try {
    const { id } = req.params;
    const order = await Order.findById(id)
      .populate("orderItems.product")
      .populate("shippingAddress")
      .populate("user");

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const { generateInvoicePdf } = require("../utils/invoicePdf");
    const pdfBuffer = await generateInvoicePdf(order);
    const filename = `Invoice_${(order.orderNumber || order._id)
      .toString()
      .replace(/[^a-zA-Z0-9-_]/g, "")}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    return res.send(pdfBuffer);
  } catch (error) {
    console.error("Invoice Download Error:", error);
    return res.status(500).json({ message: "Failed to generate invoice" });
  }
};

module.exports = {
  placeOrder,
  getUserOrders,
  getAllOrders,
  updateOrderStatus,
  cancelOrder,
  returnOrder,
  downloadOrderInvoice,
};
