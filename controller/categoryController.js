const Category = require("../models/categoryModel");

// ==============================
// Get All category
// ==============================
const getallcategory = async (req, res) => {
  try {
    const result = await Category.find();
    res.status(200).json({ data: result, message: "fetched successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message || "internal server error" });
  }
};

// ==============================
// Create New category
// ==============================
const postnewcategory = async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name || !description) {
      return res.status(400).json({ message: "Name and description are required" });
    }
    const result = await Category.create({
      name: name.trim(),
      description: description.trim()
    });
    res.status(201).json({ data: result, message: "successfully" });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: "Category already exists" });
    }
    res.status(500).json({ message: error.message || "internal server error" });
  }
};

// ==============================
// Edit category
// ==============================
const updateCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, isActive } = req.body;
    const updateData = {};
    if (name !== undefined) updateData.name = name.trim();
    if (description !== undefined) updateData.description = description.trim();
    if (isActive !== undefined) updateData.isActive = isActive;

    const updatedCategory = await Category.findByIdAndUpdate(id, updateData, {
      new: true,
      runValidators: true
    });

    if (!updatedCategory) {
      return res.status(404).json({ message: "Category not found" });
    }

    res.json({ message: "Category updated", data: updatedCategory });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: "Category name already exists" });
    }
    if (error.name === "CastError") {
      return res.status(400).json({ message: "Invalid category ID" });
    }
    res.status(500).json({ message: error.message || "internal server error" });
  }
};

// ==============================
// Delete category
// ==============================
const deleteCategory = async (req, res) => {
  try {
    const { id } = req.params;

    const deletedCategory = await Category.findByIdAndDelete(id);

    if (!deletedCategory) {
      return res.status(404).json({ message: "Category not found" });
    }

    res.json({ message: "Category deleted" });
  } catch (error) {
    if (error.name === "CastError") {
      return res.status(400).json({ message: "Invalid category ID" });
    }
    res.status(500).json({ message: error.message || "internal server error" });
  }
};

module.exports = {
  getallcategory,
  postnewcategory,
  updateCategory,
  deleteCategory,
};
