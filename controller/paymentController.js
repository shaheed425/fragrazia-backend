const mongoose = require("mongoose");
const razorpay = require("../utils/razorpay");
const Order = require("../models/orderModel");
const { PaymentTransaction, WebhookEvent, WorkerHeartbeat } = require("../models/paymentModel");
const {
  verifyCheckoutSignature,
  reconcileOrderWithGateway,
  retryOrderPayment,
  enqueueWebhookEvent,
  recordTransaction,
} = require("../services/paymentRecoveryService");
const { logPaymentEvent } = require("../utils/paymentLogger");

const createOrder = async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    if (!amount || amount <= 0) {
      return res.status(400).json({ message: "Valid payment amount is required" });
    }

    const options = {
      amount: Math.round(amount * 100), // paise
      currency: "INR",
      receipt: "order_" + Date.now(),
    };

    const order = await razorpay.orders.create(options);
    res.json(order);
  } catch (error) {
    logPaymentEvent("error", "create_razorpay_order_failed", {
      errorMessage: error?.error?.description || error?.message || "Gateway error",
    });
    res.status(503).json({ message: "Payment gateway unavailable. Please try again." });
  }
};

const verifyPayment = async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        paymentState: "FAILED",
        message: "Missing payment verification parameters",
      });
    }

    const existingOrder = await Order.findOne({
      razorpay_order_id,
      user: req.userId,
    });

    if (!existingOrder) {
      return res.status(404).json({
        success: false,
        message: "Matching order not found",
      });
    }

    // Idempotent shortcut if order is already confirmed
    if (["CAPTURED", "REFUNDED"].includes(existingOrder.paymentState)) {
      const populated = await Order.findById(existingOrder._id)
        .populate("orderItems.product")
        .populate("shippingAddress");
      return res.status(200).json({
        success: true,
        duplicate: true,
        paymentState: existingOrder.paymentState,
        message: "Payment already verified",
        order: populated,
      });
    }

    if (!verifyCheckoutSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
      logPaymentEvent("warn", "checkout_signature_invalid", {
        orderId: existingOrder._id.toString(),
        razorpayOrderId: razorpay_order_id,
        razorpayPaymentId: razorpay_payment_id,
      });
      return res.status(400).json({
        success: false,
        paymentState: "FAILED",
        message: "Invalid payment signature",
      });
    }

    // Persist signature securely while verifying authoritative payment state with Razorpay API
    existingOrder.razorpay_signature = razorpay_signature;
    existingOrder.razorpay_payment_id = razorpay_payment_id;
    existingOrder.paymentState = "PENDING";
    await existingOrder.save();

    const reconciliation = await reconcileOrderWithGateway(existingOrder._id, {
      source: "verify_api",
      paymentIdHint: razorpay_payment_id,
      signature: razorpay_signature,
    });

    if (reconciliation.paymentState === "CAPTURED") {
      return res.status(200).json({
        success: true,
        paymentState: "CAPTURED",
        message: "Payment verified and confirmed",
        order: reconciliation.order,
      });
    }

    if (
      reconciliation.unknown ||
      ["PENDING", "AUTHORIZED", "REQUIRES_REVIEW"].includes(reconciliation.paymentState)
    ) {
      return res.status(202).json({
        success: true,
        pending: true,
        paymentState: reconciliation.paymentState,
        message:
          reconciliation.paymentState === "AUTHORIZED"
            ? "Payment authorized and awaiting capture confirmation"
            : reconciliation.paymentState === "REQUIRES_REVIEW"
            ? reconciliation.message
            : "Payment verification pending",
        order: reconciliation.order,
      });
    }

    return res.status(400).json({
      success: false,
      paymentState: reconciliation.paymentState,
      message: reconciliation.message || "Payment verification failed",
      order: reconciliation.order,
    });
  } catch (error) {
    logPaymentEvent("error", "verify_payment_exception", {
      errorMessage: error?.message || "Unexpected verification error",
    });
    return res.status(500).json({
      success: false,
      paymentState: "PENDING",
      message: "Payment verification pending",
    });
  }
};

const getPaymentStatus = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await Order.findById(orderId);

    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    if (order.user.toString() !== req.userId && req.userRole !== "admin") {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    let result;
    if (
      order.paymentMethod === "UPI" &&
      order.razorpay_order_id &&
      ["CREATED", "PENDING", "AUTHORIZED", "FAILED", "REFUND_PENDING"].includes(
        order.paymentState || "CREATED"
      )
    ) {
      result = await reconcileOrderWithGateway(order._id, { source: "verify_api" });
    } else {
      const populated = await Order.findById(order._id)
        .populate("orderItems.product")
        .populate("shippingAddress");
      const currentState =
        populated.paymentState || (populated.paymentStatus === "Paid" ? "CAPTURED" : "PENDING");
      result = {
        order: populated,
        paymentState: currentState,
        paymentStatus: populated.paymentStatus,
        canRetry:
          populated.paymentMethod === "UPI" && ["CREATED", "FAILED"].includes(currentState),
        message:
          currentState === "CAPTURED"
            ? "Payment verified and confirmed"
            : currentState === "AUTHORIZED"
            ? "Payment authorized and awaiting capture"
            : currentState === "REFUNDED"
            ? "Payment refunded"
            : currentState === "REFUND_PENDING"
            ? "Refund in progress"
            : currentState === "REQUIRES_REVIEW"
            ? populated.requiresReviewReason || "Payment confirmation delayed; under manual review"
            : currentState === "FAILED"
            ? populated.paymentFailureReason || "Payment failed"
            : "Payment verification pending",
      };
    }

    const transactions = await PaymentTransaction.find({ order: order._id })
      .sort({ createdAt: -1 })
      .select("-__v");

    return res.status(200).json({
      success: true,
      order: result.order,
      paymentState: result.paymentState,
      paymentStatus: result.paymentStatus,
      canRetry: Boolean(result.canRetry),
      unknown: Boolean(result.unknown),
      message: result.message,
      transactions,
    });
  } catch (error) {
    logPaymentEvent("error", "get_payment_status_error", {
      errorMessage: error?.message || "Status lookup failed",
    });
    return res.status(500).json({
      success: false,
      paymentState: "PENDING",
      message: "Payment verification pending",
    });
  }
};

const reportClientFailure = async (req, res) => {
  try {
    const { orderId, razorpay_payment_id, reason } = req.body;
    if (!orderId) {
      return res.status(400).json({ success: false, message: "Order ID is required" });
    }

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    if (order.user.toString() !== req.userId) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    if (order.razorpay_order_id && razorpay_payment_id) {
      await recordTransaction({
        order,
        gatewayOrderId: order.razorpay_order_id,
        gatewayPaymentId: razorpay_payment_id,
        gatewayStatus: "client_reported_failure",
        mappedStatus: "PENDING",
        source: "client_failure",
        failureReason: typeof reason === "string" ? reason.slice(0, 250) : "Checkout failure reported",
      });
    }

    // Never confirm a client failure without authoritative verification via Razorpay API
    if (!["CAPTURED", "REFUNDED", "REQUIRES_REVIEW"].includes(order.paymentState)) {
      order.paymentState = "PENDING";
      await order.save();
    }

    const check = await reconcileOrderWithGateway(order._id, {
      source: "client_failure",
      paymentIdHint: razorpay_payment_id || null,
    });

    return res.status(200).json({
      success: true,
      paymentState: check.paymentState,
      paymentStatus: check.paymentStatus,
      order: check.order,
      canRetry: Boolean(check.canRetry),
      message: check.message,
    });
  } catch (error) {
    logPaymentEvent("error", "client_failure_report_error", {
      errorMessage: error?.message || "Failed handling client failure report",
    });
    return res.status(500).json({
      success: false,
      paymentState: "PENDING",
      message: "Payment verification pending",
    });
  }
};

const retryPayment = async (req, res) => {
  try {
    const result = await retryOrderPayment(req.params.orderId, req.userId);
    return res.status(result.statusCode || 200).json(result);
  } catch (error) {
    logPaymentEvent("error", "retry_payment_exception", {
      orderId: req.params.orderId,
      errorMessage: error?.error?.description || error?.message || "Retry error",
    });
    return res.status(503).json({
      success: false,
      paymentState: "PENDING",
      message: "Unable to initiate retry while payment gateway is unreachable. Please check status again.",
    });
  }
};

const webhookHandler = async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      logPaymentEvent("warn", "webhook_rejected_mongo_unavailable");
      return res.status(503).json({
        success: false,
        message: "Temporary database outage; retry webhook delivery",
      });
    }

    const signature = req.headers["x-razorpay-signature"];
    const eventIdHeader = req.headers["x-razorpay-event-id"];
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body.toString("utf8")
      : typeof req.rawBody === "string"
      ? req.rawBody
      : typeof req.body === "string"
      ? req.body
      : JSON.stringify(req.body || {});

    const result = await enqueueWebhookEvent({
      rawBody,
      signature,
      eventIdHeader,
    });

    return res.status(result.statusCode).json(result.body);
  } catch (error) {
    logPaymentEvent("error", "webhook_handler_exception", {
      errorMessage: error?.message || "Webhook failure",
    });
    return res.status(503).json({
      success: false,
      message: "Temporary webhook persistence failure",
    });
  }
};

const adminVerifyPayment = async (req, res) => {
  try {
    const { orderId } = req.params;
    const result = await reconcileOrderWithGateway(orderId, {
      source: "admin_verify",
      actorId: req.userId,
    });

    if (!result.found) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    const transactions = await PaymentTransaction.find({ order: orderId })
      .sort({ createdAt: -1 })
      .select("-__v");

    return res.status(200).json({
      success: true,
      order: result.order,
      paymentState: result.paymentState,
      paymentStatus: result.paymentStatus,
      unknown: Boolean(result.unknown),
      message: result.message,
      transactions,
    });
  } catch (error) {
    logPaymentEvent("error", "admin_verify_exception", {
      orderId: req.params.orderId,
      actorId: req.userId,
      errorMessage: error?.message || "Admin verify failed",
    });
    return res.status(500).json({
      success: false,
      message: "Error running manual payment verification",
    });
  }
};

const adminGetTransactions = async (req, res) => {
  try {
    const transactions = await PaymentTransaction.find({ order: req.params.orderId })
      .sort({ createdAt: -1 })
      .select("-__v");

    return res.status(200).json({ success: true, transactions });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

const adminGetPaymentOverview = async (req, res) => {
  try {
    const { state } = req.query;
    const orderFilter = { paymentMethod: "UPI" };
    if (state && state !== "ALL") {
      orderFilter.paymentState = state;
    }

    const [
      orders,
      transactions,
      recentWebhooks,
      issueOrders,
      latestWorker,
      queuedWebhooks,
      deadLetterWebhooks,
    ] = await Promise.all([
      Order.find(orderFilter)
        .populate("user", "name email")
        .sort({ createdAt: -1 })
        .limit(150)
        .lean(),
      PaymentTransaction.find()
        .populate("order", "orderNumber totalAmount paymentState paymentStatus deliveryStatus requiresReviewReason reconcileAttempts lastPaymentCheckAt")
        .populate("user", "name email")
        .sort({ updatedAt: -1 })
        .limit(200)
        .lean(),
      WebhookEvent.find()
        .select("-payload -__v")
        .sort({ createdAt: -1 })
        .limit(50)
        .lean(),
      Order.find({
        paymentMethod: "UPI",
        $or: [
          { paymentState: { $in: ["FAILED", "REQUIRES_REVIEW", "PENDING", "AUTHORIZED"] } },
          { fulfillmentNote: { $ne: null } },
          { requiresReviewReason: { $ne: null } },
        ],
      })
        .select("orderNumber totalAmount paymentState paymentFailureReason requiresReviewReason fulfillmentNote reconcileAttempts updatedAt")
        .sort({ updatedAt: -1 })
        .limit(50)
        .lean(),
      WorkerHeartbeat.findOne({ mode: { $in: ["worker", "web_reconciler"] } })
        .sort({ lastHeartbeatAt: -1 })
        .lean(),
      WebhookEvent.countDocuments({ status: { $in: ["queued", "failed", "processing"] } }),
      WebhookEvent.countDocuments({ status: "dead_letter" }),
    ]);

    const summary = {
      totalGatewayOrders: orders.length,
      captured: orders.filter((o) => o.paymentState === "CAPTURED").length,
      pending: orders.filter((o) => ["CREATED", "PENDING", "AUTHORIZED"].includes(o.paymentState)).length,
      failed: orders.filter((o) => o.paymentState === "FAILED").length,
      requiresReview: orders.filter((o) => o.paymentState === "REQUIRES_REVIEW").length,
      refunded: orders.filter((o) => ["REFUND_PENDING", "REFUNDED"].includes(o.paymentState)).length,
    };

    const workerStale =
      !latestWorker ||
      Date.now() - new Date(latestWorker.lastHeartbeatAt).getTime() > 90_000;

    return res.status(200).json({
      success: true,
      summary,
      systemHealth: {
        mongoConnected: mongoose.connection.readyState === 1,
        workerStatus: workerStale ? "stale" : latestWorker.status,
        workerMode: latestWorker?.mode || null,
        lastWorkerHeartbeatAt: latestWorker?.lastHeartbeatAt || null,
        queuedWebhooks,
        deadLetterWebhooks,
      },
      orders,
      transactions,
      recentWebhooks,
      issueLogs: issueOrders,
    });
  } catch (error) {
    logPaymentEvent("error", "admin_payment_overview_error", {
      errorMessage: error?.message || "Failed loading payment overview",
    });
    return res.status(500).json({
      success: false,
      message: "Failed to load payment management overview",
    });
  }
};

module.exports = {
  createOrder,
  verifyPayment,
  getPaymentStatus,
  reportClientFailure,
  retryPayment,
  webhookHandler,
  adminVerifyPayment,
  adminGetTransactions,
  adminGetPaymentOverview,
};
