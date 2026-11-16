const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/userModel");
const Address = require("../models/addressModel");
const Product = require("../models/productModel");
const { sendVerificationEmail } = require("../utils/mailer");

const VERIFICATION_CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 30 * 1000;
const MAX_VERIFICATION_ATTEMPTS = 5;

const generateVerificationCode = () => crypto.randomInt(100000, 1000000).toString();

const hashVerificationCode = (email, code) =>
  crypto
    .createHmac("sha256", process.env.SECRET_KEY || "fragranzia-otp-fallback")
    .update(`${String(email).trim().toLowerCase()}:${String(code).trim()}`)
    .digest("hex");

const verifyCodeHash = (email, code, storedHash) => {
  if (!storedHash || typeof code !== "string") return false;
  const computed = hashVerificationCode(email, code);
  const a = Buffer.from(computed, "utf8");
  const b = Buffer.from(storedHash, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const postnewuser = async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: "Name, email, and password are required" });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters long" });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const userExist = await User.findOne({ email: normalizedEmail });
    if (userExist && userExist.isVerified !== false) {
      return res.status(400).json({ message: "User already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const code = generateVerificationCode();
    const codeHash = hashVerificationCode(normalizedEmail, code);
    const expiresAt = new Date(Date.now() + VERIFICATION_CODE_TTL_MS);
    const now = new Date();

    let targetUser = userExist;
    let createdFresh = false;

    if (!targetUser) {
      targetUser = await User.create({
        name: name.trim(),
        email: normalizedEmail,
        password: hashedPassword,
        isVerified: false,
        verificationCodeHash: codeHash,
        verificationCodeExpiresAt: expiresAt,
        verificationAttempts: 0,
        lastVerificationSentAt: now,
      });
      createdFresh = true;
    } else {
      targetUser.name = name.trim();
      targetUser.password = hashedPassword;
      targetUser.verificationCodeHash = codeHash;
      targetUser.verificationCodeExpiresAt = expiresAt;
      targetUser.verificationAttempts = 0;
      targetUser.lastVerificationSentAt = now;
      await targetUser.save();
    }

    try {
      await sendVerificationEmail({
        to: normalizedEmail,
        name: targetUser.name,
        code,
      });
    } catch (mailError) {
      // Remove freshly inserted unverified record if initial email delivery fails
      if (createdFresh && targetUser?._id) {
        await User.deleteOne({ _id: targetUser._id }).catch(() => {});
      }
      console.error("Verification email send failed:", mailError.message);
      return res.status(503).json({
        message: "Unable to send verification code email. Please verify your email or SMTP settings and try again.",
      });
    }

    return res.status(201).json({
      success: true,
      requiresVerification: true,
      email: normalizedEmail,
      message: "Verification code sent to your email. Please enter it to activate your account.",
    });
  } catch (error) {
    if (error.name === "ValidationError") {
      return res.status(400).json({ message: error.message });
    }
    return res.status(500).json({ message: error.message });
  }
};

const verifyEmail = async (req, res) => {
  try {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const code = typeof req.body?.code === "string" ? req.body.code.trim() : String(req.body?.code || "").trim();

    if (!email || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ message: "Valid email and 6-digit verification code are required" });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: "Account not found" });
    }

    if (user.isVerified !== false) {
      return res.status(400).json({ message: "Account is already verified. Please sign in." });
    }

    if ((user.verificationAttempts || 0) >= MAX_VERIFICATION_ATTEMPTS) {
      return res.status(429).json({
        message: "Too many incorrect verification attempts. Please request a new verification code.",
      });
    }

    if (!user.verificationCodeExpiresAt || user.verificationCodeExpiresAt.getTime() < Date.now()) {
      return res.status(400).json({
        message: "Verification code has expired. Please request a new verification code.",
      });
    }

    if (!verifyCodeHash(email, code, user.verificationCodeHash)) {
      user.verificationAttempts = (user.verificationAttempts || 0) + 1;
      await user.save();
      const remaining = Math.max(0, MAX_VERIFICATION_ATTEMPTS - user.verificationAttempts);
      return res.status(400).json({
        message:
          remaining > 0
            ? `Invalid verification code. ${remaining} attempt(s) remaining.`
            : "Too many incorrect attempts. Please request a new code.",
      });
    }

    user.isVerified = true;
    user.verificationCodeHash = null;
    user.verificationCodeExpiresAt = null;
    user.verificationAttempts = 0;
    await user.save();

    const token = jwt.sign({ id: user._id }, process.env.SECRET_KEY, { expiresIn: "1d" });
    const data = { name: user.name, role: user.role, email: user.email };

    return res.status(200).json({
      success: true,
      token,
      data,
      message: "Email verified successfully!",
    });
  } catch (error) {
    console.error("Email verification error:", error);
    return res.status(500).json({ message: "Server error during verification" });
  }
};

const resendVerification = async (req, res) => {
  try {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    if (!email) {
      return res.status(400).json({ message: "Email address is required" });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: "No registration found for this email" });
    }

    if (user.isVerified !== false) {
      return res.status(400).json({ message: "Email is already verified. Please sign in." });
    }

    const lastSent = user.lastVerificationSentAt ? user.lastVerificationSentAt.getTime() : 0;
    const elapsed = Date.now() - lastSent;
    if (elapsed < RESEND_COOLDOWN_MS) {
      const waitSeconds = Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000);
      return res.status(429).json({
        message: `Please wait ${waitSeconds}s before requesting another verification code.`,
        retryAfterSeconds: waitSeconds,
      });
    }

    const code = generateVerificationCode();
    user.verificationCodeHash = hashVerificationCode(email, code);
    user.verificationCodeExpiresAt = new Date(Date.now() + VERIFICATION_CODE_TTL_MS);
    user.verificationAttempts = 0;
    user.lastVerificationSentAt = new Date();
    await user.save();

    try {
      await sendVerificationEmail({
        to: email,
        name: user.name,
        code,
      });
    } catch (mailError) {
      console.error("Resend verification email failed:", mailError.message);
      return res.status(503).json({
        message: "Unable to send verification email right now. Please try again shortly.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "A new verification code has been sent to your email.",
    });
  } catch (error) {
    console.error("Resend verification error:", error);
    return res.status(500).json({ message: "Server error sending verification code" });
  }
};

const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    const user = await User.findOne({ email: email.trim().toLowerCase() });
    if (!user) return res.status(400).json({ message: "Invalid email or password" });

    if (user.isActive === false) {
      return res.status(403).json({ message: "Your account is disabled. Please contact support." });
    }

    const ismatch = await bcrypt.compare(password, user.password);
    if (!ismatch) return res.status(400).json({ message: "Invalid email or password" });

    if (user.isVerified === false) {
      return res.status(403).json({
        success: false,
        requiresVerification: true,
        email: user.email,
        message: "Please verify your email address with the verification code before signing in.",
      });
    }

    const token = jwt.sign({ id: user._id }, process.env.SECRET_KEY, { expiresIn: "1d" });

    const data = { name: user.name, role: user.role, email: user.email };

    res.json({ token, success: true, data });
  } catch (error) {
    console.error("Login Error:", error);
    res.status(500).json({ message: "Server error during login" });
  }
};

const normalizeSize = (val) => (typeof val === "string" ? val.trim() : "");

const getCartMatchIndex = (cart, productId, reqSize, isPopulated = false) => {
  const hasExplicitSize = typeof reqSize === "string";
  const targetSize = hasExplicitSize ? reqSize.trim() : "";

  return cart.findIndex((item) => {
    const itemProdId = isPopulated ? item.product?._id?.toString() : item.product?.toString();
    if (itemProdId !== productId) return false;
    return !hasExplicitSize || (item.size || "") === targetSize;
  });
};

const adcart = async (req, res) => {
  try {
    const { id } = req.params;
    const [user, product] = await Promise.all([
      User.findById(req.userId),
      Product.findById(id).select("name brand price saleprice stock isActive sizes images").lean(),
    ]);

    if (!user) return res.status(404).json({ message: "User not found" });
    if (!product) return res.status(404).json({ message: "Product not found" });
    if (product.isActive === false) {
      return res.status(400).json({ message: "Product is currently unavailable" });
    }
    if (product.stock < 1) return res.status(400).json({ message: "Product out of stock" });

    const requestedSize = normalizeSize(req.body?.size);
    const defaultSize = normalizeSize(product.sizes?.[0]);
    const selectedSize =
      requestedSize && (!product.sizes?.length || product.sizes.includes(requestedSize))
        ? requestedSize
        : defaultSize;

    const existingItem = user.cart.find(
      (item) => item.product.toString() === id && (item.size || "") === selectedSize
    );
    const totalProductQtyInCart = user.cart.reduce(
      (sum, item) => (item.product.toString() === id ? sum + (item.quantity || 0) : sum),
      0
    );

    if (product.stock < totalProductQtyInCart + 1) {
      return res.status(400).json({ message: "Insufficient stock" });
    }

    if (existingItem) {
      existingItem.quantity += 1;
    } else {
      user.cart.push({ product: id, quantity: 1, size: selectedSize });
    }

    await user.save();
    await user.populate("cart.product");
    const cleanCart = user.cart.filter((item) => item.product !== null);
    res.json({ message: "Product added", data: cleanCart });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

const deletecart = async (req, res) => {
  try {
    const { id } = req.params;
    const reqSize = req.body?.size ?? req.query?.size;
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (typeof reqSize === "string") {
      const targetSize = reqSize.trim();
      user.cart = user.cart.filter(
        (item) => !(item.product.toString() === id && (item.size || "") === targetSize)
      );
    } else {
      user.cart.pull({ product: id });
    }
    await user.save();

    await user.populate("cart.product");
    const cleanCart = user.cart.filter((item) => item.product !== null);

    res.status(200).json({
      message: "Product removed from cart",
      cart: cleanCart
    });
  } catch (error) {
    res.status(500).json({
      message: error.message
    });
  }
};

const increaseQuantity = async (req, res) => {
  try {
    const productId = req.params.id;
    const reqSize = req.body?.size ?? req.query?.size;
    const user = await User.findById(req.userId).populate("cart.product");
    if (!user) return res.status(404).json({ message: "User not found" });

    user.cart = user.cart.filter(i => i.product !== null);
    const matchIndex = getCartMatchIndex(user.cart, productId, reqSize, true);
    const item = matchIndex !== -1 ? user.cart[matchIndex] : null;

    if (item) {
      const product = await Product.findById(productId);
      if (!product) {
        return res.status(404).json({ message: "Product not found" });
      }
      const totalProductQtyInCart = user.cart.reduce(
        (sum, c) => (c.product._id.toString() === productId ? sum + (c.quantity || 0) : sum),
        0
      );
      if (product.stock < totalProductQtyInCart + 1) {
        return res.status(400).json({ message: "Insufficient stock" });
      }
      item.quantity += 1;
      await user.save();
    }

    res.json(user.cart);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const decreaseQuantity = async (req, res) => {
  try {
    const productId = req.params.id;
    const reqSize = req.body?.size ?? req.query?.size;
    const userId = req.userId;

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const matchIndex = getCartMatchIndex(user.cart, productId, reqSize, false);
    const item = matchIndex !== -1 ? user.cart[matchIndex] : null;

    if (item) {
      item.quantity -= 1;

      if (item.quantity <= 0) {
        user.cart.splice(matchIndex, 1);
      }
      await user.save();
    }

    await user.populate("cart.product");
    const cleanCart = user.cart.filter((i) => i.product !== null);

    res.json(cleanCart);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const fetchcartproduct = async (req, res) => {
  try {
    const result = await User.findById(req.userId)
      .select("-password")
      .populate("cart.product");

    if (!result) {
      return res.status(404).json({ message: "User not found" });
    }

    result.cart = result.cart.filter(item => item.product !== null);

    res.status(200).json({ data: result, message: "fetched successfully" });
  } catch (error) {
    res.status(500).json({ message: "back_end error" });
  }
};

const adwishlist = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const alreadyExist = user.wishlist.some(
      (item) => item.toString() === id
    );

    if (alreadyExist) {
      user.wishlist.pull(id);
      await user.save();
      await user.populate("wishlist");
      return res.json({
        message: "Product removed from wishlist",
        data: user.wishlist.filter(Boolean)
      });
    }

    const productExists = await Product.exists({ _id: id });
    if (!productExists) return res.status(404).json({ message: "Product not found" });

    user.wishlist.push(id);
    await user.save();
    await user.populate("wishlist");

    res.json({
      message: "Product added to wishlist",
      data: user.wishlist.filter(Boolean)
    });
  } catch (error) {
    res.status(500).json({ message: "server error" });
  }
};

const getwishlist = async (req, res) => {
  try {
    const result = await User.findById(req.userId).populate("wishlist");
    if (!result) return res.status(404).json({ message: "User not found" });

    res.status(200).json({
      data: result.wishlist.filter(Boolean),
      message: "fetched successfully"
    });
  } catch (error) {
    res.status(500).json({ message: "back_end error" });
  }
};

const fetchusers = async (req, res) => {
  try {
    const result = await User.find()
      .select("-password -verificationCodeHash")
      .sort({ createdAt: -1 });
    res.status(200).json({ data: result, message: "fetched successfully" });
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch users" });
  }
};

const addaddress = async (req, res) => {
  try {
    const userId = req.userId;

    const {
      fullName,
      phone,
      street,
      city,
      state,
      zip,
      country,
    } = req.body;

    if (!fullName || !phone || !street || !city || !state || !zip || !country) {
      return res.status(400).json({
        success: false,
        message: "All address fields (fullName, phone, street, city, state, zip, country) are required",
      });
    }

    await Address.updateMany({ user: userId }, { isDefault: false });

    const address = new Address({
      user: userId,
      fullName: fullName.trim(),
      phone: phone.trim(),
      street: street.trim(),
      city: city.trim(),
      state: state.trim(),
      zip: zip.trim(),
      country: country.trim(),
      isDefault: true,
    });

    await address.save();

    res.status(201).json({
      success: true,
      message: "Address added and set as primary",
      data: address,
    });
  } catch (error) {
    console.error("Error in add address:", error);
    res.status(500).json({
      success: false,
      message: "Error adding address",
    });
  }
};

const getAddresses = async (req, res) => {
  try {
    const addresses = await Address.find({
      user: req.userId
    }).sort({ createdAt: -1 });

    res.status(200).json(addresses);
  } catch (error) {
    res.status(500).json({
      message: "Failed to fetch addresses",
      error: error.message
    });
  }
};

const saveLocation = async (req, res) => {
  try {
    const { latitude, longitude } = req.body;

    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({
        message: "Latitude and Longitude required"
      });
    }

    const userId = req.userId;

    const updatedUser = await User.findByIdAndUpdate(
      userId,
      {
        location: {
          lat: latitude,
          lng: longitude
        }
      },
      { new: true }
    );

    if (!updatedUser) {
      return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json({
      message: "Location saved successfully",
      location: updatedUser.location
    });
  } catch (error) {
    res.status(500).json({
      message: "Server Error",
      error: error.message
    });
  }
};

const editAddress = async (req, res) => {
  try {
    const { id } = req.params;
    const { fullName, phone, street, city, state, zip, country } = req.body;

    const updatedAddress = await Address.findOneAndUpdate(
      { _id: id, user: req.userId },
      { fullName, phone, street, city, state, zip, country },
      { new: true, runValidators: true }
    );

    if (!updatedAddress) {
      return res.status(404).json({ message: "Address not found" });
    }

    res.status(200).json({ message: "Address updated", data: updatedAddress });
  } catch (error) {
    res.status(500).json({ message: "Error updating address" });
  }
};

const deleteAddress = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.userId;

    const addressToDelete = await Address.findOne({ _id: id, user: userId });
    if (!addressToDelete) {
      return res.status(404).json({ message: "Address not found" });
    }

    const wasDefault = addressToDelete.isDefault;
    await Address.findOneAndDelete({ _id: id, user: userId });

    if (wasDefault) {
      const nextAddress = await Address.findOne({ user: userId }).sort({ createdAt: -1 });
      if (nextAddress) {
        nextAddress.isDefault = true;
        await nextAddress.save();
      }
    }

    res.status(200).json({ message: "Address deleted and primary address updated" });
  } catch (error) {
    res.status(500).json({ message: "Error deleting address" });
  }
};

const setDefaultAddress = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.userId;

    const addressExists = await Address.findOne({ _id: id, user: userId });
    if (!addressExists) {
      return res.status(404).json({ message: "Address not found" });
    }

    await Address.updateMany({ user: userId }, { isDefault: false });

    const updatedAddress = await Address.findOneAndUpdate(
      { _id: id, user: userId },
      { isDefault: true },
      { new: true }
    );

    res.status(200).json({ message: "Default address updated", data: updatedAddress });
  } catch (error) {
    res.status(500).json({ message: "Error setting default address" });
  }
};

module.exports = {
  postnewuser,
  verifyEmail,
  resendVerification,
  login,
  adcart,
  fetchcartproduct,
  fetchusers,
  addaddress,
  deletecart,
  adwishlist,
  getwishlist,
  saveLocation,
  getAddresses,
  editAddress,
  deleteAddress,
  increaseQuantity,
  decreaseQuantity,
  setDefaultAddress
};
