// const mongoose = require("mongoose");
const mongoose = require("mongoose")

const  productSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

    description: {
      type: String,
      required: true,
    },

    price: {
      type: Number,
      required: true,
    },

    // discountPrice: {
    //   type: Number,
    // },
        saleprice: {
      type: Number,
        //  required: true,
    },

    stock: {
      type: Number,
      default: 0,
    },

    images: [
      {
        type: String,
        required: true,
      },
    ],

    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: true,
    },

    brand: {
      type: String,
      trim: true,
    },

    sizes: [
      {
        type: String,
        trim: true,
      },
    ],

    variants: [
      {
        type: String,
        trim: true,
      },
    ],

    isFeatured: {
      type: Boolean,
      default: false,
    },

    rating: {
      type: Number,
      default: 0,
    },

    numReviews: {
      type: Number,
      default: 0,
    },

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

// High performance query indexes
productSchema.index({ isActive: 1, createdAt: -1 });
productSchema.index({ category: 1, isActive: 1 });
productSchema.index({ isFeatured: 1, isActive: 1 });

module.exports = mongoose.model("Product", productSchema); 