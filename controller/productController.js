const Product = require("../models/productModel");

const parseStringList = (value) => {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((v) => String(v).trim()).filter(Boolean);
      }
    } catch {
      // fall through to comma split
    }
  }
  return trimmed.split(",").map((s) => s.trim()).filter(Boolean);
};

const parseBoolean = (value, defaultVal) => {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return defaultVal;
};

// ==============================
// Get All Products (with Search and Sort)
// ==============================
const fetchproduct = async (req, res) => {
  try {
    const { search, sort, category, featured, includeInactive } = req.query;
    const query = {};

    if (includeInactive !== "true") {
      query.isActive = { $ne: false };
    }

    if (category && category.trim()) {
      query.category = category.trim();
    }

    if (featured === "true") {
      query.isFeatured = true;
    }

    if (search && search.trim()) {
      const escapedSearch = search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      query.$or = [
        { name: { $regex: escapedSearch, $options: "i" } },
        { brand: { $regex: escapedSearch, $options: "i" } },
      ];
    }

    const sortOptions = {};
    if (sort === "price-low-high") {
      sortOptions.price = 1;
    } else if (sort === "price-high-low") {
      sortOptions.price = -1;
    } else {
      sortOptions.createdAt = -1;
    }

    const result = await Product.find(query).populate("category").sort(sortOptions);

    res.status(200).json({ data: result, message: "fetched successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message || "internal server error" });
  }
};

// ==============================
// Create New product
// ==============================
const createProduct = async (req, res) => {
  try {
    const {
      name,
      brand,
      description,
      price,
      saleprice,
      salePrice,
      category,
      stock,
      sizes,
      variants,
      isFeatured,
      isActive,
    } = req.body;

    if (!name || !description || price === undefined || !category) {
      return res.status(400).json({ message: "Name, description, price, and category are required" });
    }

    if (!req.file) {
      return res.status(400).json({ message: "Product image is required" });
    }

    const numericPrice = Number(price);
    const numericStock = Number(stock || 0);
    if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
      return res.status(400).json({ message: "Price must be a valid positive number" });
    }
    if (!Number.isFinite(numericStock) || numericStock < 0) {
      return res.status(400).json({ message: "Stock cannot be negative" });
    }

    const rawSalePrice = saleprice ?? salePrice;
    const productData = {
      name: name.trim(),
      brand: brand ? brand.trim() : "",
      description: description.trim(),
      price: numericPrice,
      category,
      stock: numericStock,
      sizes: parseStringList(sizes),
      variants: parseStringList(variants),
      isFeatured: parseBoolean(isFeatured, false),
      isActive: parseBoolean(isActive, true),
      images: [req.file.filename]
    };

    if (rawSalePrice !== undefined && rawSalePrice !== "") {
      const numericSale = Number(rawSalePrice);
      if (!Number.isFinite(numericSale) || numericSale < 0) {
        return res.status(400).json({ message: "Sale price must be zero or positive" });
      }
      productData.saleprice = numericSale;
    }

    const result = await Product.create(productData);

    res.status(201).json({ success: true, data: result });
  } catch (error) {
    console.error("Create product error:", error);
    res.status(500).json({ message: error.message || "internal server error" });
  }
};

// ==============================
// Get Single Product
// ==============================
const getSingleProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const product = await Product.findById(id).populate("category");

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    res.status(200).json({ data: product, message: "fetched successfully" });
  } catch (error) {
    if (error.name === "CastError") {
      return res.status(400).json({ message: "Invalid product ID" });
    }
    res.status(500).json({ message: error.message || "internal server error" });
  }
};

// ==============================
// Edit Product
// ==============================
const updateProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = { ...req.body };

    if (updateData.price !== undefined) {
      const numericPrice = Number(updateData.price);
      if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
        return res.status(400).json({ message: "Price must be a valid positive number" });
      }
      updateData.price = numericPrice;
    }
    if (updateData.stock !== undefined) {
      const numericStock = Number(updateData.stock);
      if (!Number.isFinite(numericStock) || numericStock < 0) {
        return res.status(400).json({ message: "Stock cannot be negative" });
      }
      updateData.stock = numericStock;
    }
    if (updateData.brand !== undefined) {
      updateData.brand = String(updateData.brand).trim();
    }
    if (updateData.sizes !== undefined) {
      updateData.sizes = parseStringList(updateData.sizes);
    }
    if (updateData.variants !== undefined) {
      updateData.variants = parseStringList(updateData.variants);
    }
    if (updateData.isFeatured !== undefined) {
      updateData.isFeatured = parseBoolean(updateData.isFeatured, false);
    }
    if (updateData.isActive !== undefined) {
      updateData.isActive = parseBoolean(updateData.isActive, true);
    }
    if (updateData.saleprice === "" || updateData.salePrice === "") {
      delete updateData.saleprice;
      delete updateData.salePrice;
      updateData.$unset = { saleprice: "" };
    } else if (updateData.saleprice !== undefined || updateData.salePrice !== undefined) {
      updateData.saleprice = Number(updateData.saleprice ?? updateData.salePrice);
      delete updateData.salePrice;
    }

    if (req.file) {
      updateData.images = [req.file.filename];
    }

    const updatedProduct = await Product.findByIdAndUpdate(id, updateData, {
      new: true,
      runValidators: true
    });

    if (!updatedProduct) {
      return res.status(404).json({ message: "Product not found" });
    }

    res.json({ message: "Product updated", data: updatedProduct });
  } catch (error) {
    if (error.name === "CastError") {
      return res.status(400).json({ message: "Invalid product ID" });
    }
    res.status(500).json({ message: error.message || "internal server error" });
  }
};

// ==============================
// Delete Product
// ==============================
const deleteProduct = async (req, res) => {
  try {
    const { id } = req.params;

    const deletedProduct = await Product.findByIdAndDelete(id);

    if (!deletedProduct) {
      return res.status(404).json({ message: "Product not found" });
    }

    res.json({ message: "Product deleted" });
  } catch (error) {
    if (error.name === "CastError") {
      return res.status(400).json({ message: "Invalid product ID" });
    }
    res.status(500).json({ message: error.message || "internal server error" });
  }
};

module.exports = {
  fetchproduct,
  createProduct,
  getSingleProduct,
  updateProduct,
  deleteProduct
};
