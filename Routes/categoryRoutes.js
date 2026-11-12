const express = require("express");
const { checkAuth, isAdmin } = require("../middleware/checkAuth");
const {
  getallcategory,
  postnewcategory,
  updateCategory,
  deleteCategory,
} = require("../controller/categoryController");

const router = express.Router();

router.get("/", getallcategory);

// Admin only routes
router.post("/", checkAuth, isAdmin, postnewcategory);
router.put("/:id", checkAuth, isAdmin, updateCategory);
router.delete("/:id", checkAuth, isAdmin, deleteCategory);

module.exports = router;
