const express = require("express");
const upload = require("../middleware/upload");
const { checkAuth, isAdmin } = require("../middleware/checkAuth");
const router = express.Router();
const {
  createProduct,
  fetchproduct,
  getSingleProduct,
  updateProduct,
  deleteProduct
} = require("../controller/productController");
const { getAllOrders } = require("../controller/paynowController");

router.get("/", fetchproduct);
router.get("/ordersfetch", checkAuth, isAdmin, getAllOrders);
router.get("/:id", getSingleProduct);

// Admin only routes
router.post("/", checkAuth, isAdmin, upload.single("image"), createProduct);
router.put("/:id", checkAuth, isAdmin, upload.single("image"), updateProduct);
router.delete("/:id", checkAuth, isAdmin, deleteProduct);

module.exports = router;
