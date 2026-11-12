const Order = require("../models/orderModel");


// ✅ 1. Place Order
const OrderNow = async (req, res) => {
  try {
    const {  items, totalAmount, address, paymentMethod } = req.body;
   const  userId = req.userId

    if ( !userId|| !items || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields"
      });
    }

    const newOrder = new Order({
      user: req.userId, // ✅ match schema

      orderItems: items.map(item => ({
        product: item.productId,
        quantity: item.quantity
      })),

      shippingAddress: address._id, // ⚠️ must be saved address id

      paymentStatus: paymentMethod === "COD" ? "Pending" : "Paid"
    });

    await newOrder.save();  

    res.status(201).json({
      success: true,
      message: "Order placed successfully",
      order: newOrder
    });

  } catch (error) {
    console.log("Order Error:", error);
    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
};



// ✅ 2. Get Orders of Logged User
 const getUserOrders = async (req, res) => {
  try {
    const userId = req.userId; // from middleware

    console.log("User from token:", req.userId);
    const orders = await Order.find({ user : userId }) // ✅ filter
      .populate("orderItems.product")
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      data: orders
    });

  } catch (error) {
    console.log(error);
    res.status(500).json({
      success: false,
      message: "Error fetching orders"
    });
  }
};


// ✅ 3. Get All Orders (Admin)
 const getAllOrders = async (req, res) => {
  try {
    const orders = await Order.find()
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      orders
    });

  } catch (error) {
    console.log(error);
    res.status(500).json({
      success: false,
      message: "Error fetching all orders"
    });
  }
};



// ✅ 4. Update Order Status (Admin)
 const updateOrderStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const updatedOrder = await Order.findByIdAndUpdate(
      id,
      { status },
      { new: true }
    );

    if (!updatedOrder) {
      return res.status(404).json({
        success: false,
        message: "Order not found"
      });
    }

    res.json({
      success: true,
      message: "Order status updated",
      order: updatedOrder
    });

  } catch (error) {
    console.log(error);
    res.status(500).json({
      success: false,
      message: "Error updating status"
    });
  }
};

module.exports = {
    OrderNow,
    getUserOrders,
    getAllOrders,
    updateOrderStatus
    
}
