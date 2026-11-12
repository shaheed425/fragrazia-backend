const jwt = require("jsonwebtoken");
const User = require("../models/userModel");

const checkAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        message: "Login Required",
      });
    }

    const token = authHeader.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : authHeader;

    if (!token) {
      return res.status(401).json({
        message: "Login Required",
      });
    }

    const tokenValid = jwt.verify(token, process.env.SECRET_KEY);
    const user = await User.findById(tokenValid.id).select("_id role isActive");

    if (!user) {
      return res.status(401).json({
        message: "Account not found. Please login again.",
      });
    }

    if (user.isActive === false) {
      return res.status(403).json({
        message: "Your account is disabled. Please contact support.",
      });
    }

    req.userId = user._id.toString();
    req.userRole = user.role;

    next();
  } catch (error) {
    console.error("Auth Error:", error.message);
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        message: "Session expired. Please login again.",
      });
    }
    return res.status(401).json({
      message: "You are UnAuthorized",
    });
  }
};

const isAdmin = (req, res, next) => {
  if (req.userRole !== "admin") {
    return res.status(403).json({
      message: "You are not authorized",
    });
  }
  next();
};

module.exports = { checkAuth, isAdmin };
