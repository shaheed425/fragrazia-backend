const express = require("express");
const router = express.Router();


// const { placeOrder } = require("../controller/orderController");
const { OrderNow,getAllOrders,updateOrderStatus } = require("../controller/paynowController");
const { checkAuth } = require("../middleware/checkAuth");

// POST /api/payment now
router.post("/",checkAuth,OrderNow);

module.exports = router;



 