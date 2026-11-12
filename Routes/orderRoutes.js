const express = require("express");
const router = express.Router();

const {
  placeOrder,
  getUserOrders,
  getAllOrders,
  updateOrderStatus,
  cancelOrder,
  returnOrder,
  downloadOrderInvoice
} = require("../controller/orderController");
const { checkAuth, isAdmin } = require("../middleware/checkAuth");

// User Routes
router.post("/order", checkAuth, placeOrder);
router.get("/user-orders", checkAuth, getUserOrders);
router.put("/order/cancel/:id", checkAuth, cancelOrder);
router.put("/order/return/:id", checkAuth, returnOrder);
router.get("/order/invoice/:id", downloadOrderInvoice);

// Admin Routes
router.get("/all-orders", checkAuth, isAdmin, getAllOrders);
router.patch("/update-status/:id", checkAuth, isAdmin, updateOrderStatus);

module.exports = router;
