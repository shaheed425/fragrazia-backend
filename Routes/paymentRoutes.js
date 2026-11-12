const express = require("express");
const router = express.Router();
const { checkAuth, isAdmin } = require("../middleware/checkAuth");
const { createRateLimiter } = require("../middleware/rateLimit");

const {
  createOrder,
  verifyPayment,
  getPaymentStatus,
  reportClientFailure,
  retryPayment,
  webhookHandler,
  adminVerifyPayment,
  adminGetTransactions,
  adminGetPaymentOverview,
} = require("../controller/paymentController");

const verifyLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  maxRequests: 40,
  message: "Too many verification requests. Please wait a moment and check status again.",
});

const retryLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  maxRequests: 15,
  message: "Too many retry attempts. Please check payment status before trying again.",
});

// Razorpay official server-to-server webhook (raw body mounted before express.json in server/index.js)
router.post("/webhook", webhookHandler);

// Authenticated customer payment routes
router.post("/create-order", checkAuth, verifyLimiter, createOrder);
router.post("/verify-payment", checkAuth, verifyLimiter, verifyPayment);
router.get("/status/:orderId", checkAuth, getPaymentStatus);
router.post("/client-failure", checkAuth, verifyLimiter, reportClientFailure);
router.post("/retry/:orderId", checkAuth, retryLimiter, retryPayment);

// Admin manual payment management, verification & audit logs
router.get("/admin/overview", checkAuth, isAdmin, adminGetPaymentOverview);
router.post("/admin/verify/:orderId", checkAuth, isAdmin, adminVerifyPayment);
router.get("/admin/transactions/:orderId", checkAuth, isAdmin, adminGetTransactions);

module.exports = router;
