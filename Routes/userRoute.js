const express = require("express");
const router = express.Router();
const {
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
        increaseQuantity,
        decreaseQuantity,
        editAddress,
        deleteAddress,
        setDefaultAddress
} = require("../controller/userController");

const { checkAuth, isAdmin } = require("../middleware/checkAuth");
const { createRateLimiter } = require("../middleware/rateLimit");

const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxRequests: 15,
  skipSuccessfulRequests: true,
  message: "Too many login attempts. Please wait 15 minutes and try again.",
});

const registerLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxRequests: 15,
  message: "Too many registration attempts. Please try again later.",
});

/* --------------------------------
        USER CONTROLLER
-------------------------------- */
router.post("/user/register", registerLimiter, postnewuser);
router.post("/user/verify-email", registerLimiter, verifyEmail);
router.post("/user/resend-verification", registerLimiter, resendVerification);
router.post("/user/login", loginLimiter, login);
router.get("/user", checkAuth, isAdmin, fetchusers);

/* --------------------------------
        CART CONTROLLER
-------------------------------- */
router.put("/cart/:id", checkAuth, adcart);
router.delete("/cart/delete/:id", checkAuth, deletecart);
router.get("/cart/fetch", checkAuth, fetchcartproduct);
router.put("/cart/increase/:id", checkAuth, increaseQuantity);
router.put("/cart/decrease/:id", checkAuth, decreaseQuantity);

/* --------------------------------
        WISH LIST CONTROLLER
-------------------------------- */
router.put("/wishlist/:id", checkAuth, adwishlist);
router.get("/wishlist", checkAuth, getwishlist);
router.post("/location", checkAuth, saveLocation);

/* --------------------------------
        ADDRESS CONTROLLER
-------------------------------- */
router.post("/addaddress", checkAuth, addaddress);
router.get("/address", checkAuth, getAddresses);
router.put("/address/:id", checkAuth, editAddress);
router.delete("/address/:id", checkAuth, deleteAddress);
router.put("/address/default/:id", checkAuth, setDefaultAddress);

module.exports = router;
