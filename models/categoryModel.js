// import mongoose from "mongoose";
const mongoose = require("mongoose")
const categorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },

  description: {
      type: String,
      required: true,
    },

    // image: {
    //   type: String, // category image URL
    // },

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

// export default mongoose.model("Category", categorySchema);
module.exports = mongoose.model("Category",categorySchema) 