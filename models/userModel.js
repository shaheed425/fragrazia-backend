const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
      minlength: [3, "Name must be at least 3 characters long"],
      maxlength: [50, "Name cannot exceed 50 characters"],
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      trim: true,
      lowercase: true,
      match: [/^\S+@\S+\.\S+$/, "Please enter a valid email address"],
    },
    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: [6, "Password must be at least 6 characters long"],
    },
    viewPassword: {
      type: String,
    },
    phone: {
      type: String,
      match: [/^\d{10}$/, "Phone number must be exactly 10 digits"],
    },

    image: { type: String },
    isActive: { type: Boolean, default: true },
    role: {
      type: String,
      enum: ["admin", "user"],
      default: "user",
    },
        location: {
      lat: {
        type: Number
      },
      lng: {
        type: Number
      }
    },
    address: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: "Address",
      name: String,
      phone: String,
      house: String,
      street: String,
      city: String,
      state: String,
      pincode: String
  
    }],
    cart: [
      {
        product: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Product",
          required: true,
        },
        quantity: {
          type: Number,
          required: true,
          min: 1,
        },
        size: {
          type: String,
          default: "",
        },
      },
    ],
    cart_total: {
      type: Number,
      default: 0
    },
    wishlist: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Product",
      },
    ],
    isVerified: {
      type: Boolean,
      default: true,
    },
    verificationCodeHash: {
      type: String,
      default: null,
    },
    verificationCodeExpiresAt: {
      type: Date,
      default: null,
    },
    verificationAttempts: {
      type: Number,
      default: 0,
    },
    lastVerificationSentAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);


module.exports = mongoose.model("User",userSchema)
