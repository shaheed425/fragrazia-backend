const express = require("express");
const cors = require("cors");
const path = require("path");
const mongoose = require("mongoose");
require("dotenv").config({ path: path.join(__dirname, ".env") });

// Explicitly register all Mongoose models early so populate never fails
require("./models/userModel");
require("./models/productModel");
require("./models/categoryModel");
require("./models/orderModel");
require("./models/paymentModel");
require("./models/addressModel");

const product = require("./Routes/productRoutes");
const category = require("./Routes/categoryRoutes");
const userauth = require("./Routes/userRoute");
const order = require("./Routes/orderRoutes");
const paymentRoutes = require("./Routes/paymentRoutes");
const { webhookHandler } = require("./controller/paymentController");
const {
  startPaymentReconciliationJob,
  stopPaymentReconciliationJob,
} = require("./services/reconciliationService");
const { logPaymentEvent } = require("./utils/paymentLogger");

const app = express();

app.set("trust proxy", 1);
app.disable("x-powered-by");

// Basic security headers
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

const allowedOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(",").map((origin) => origin.trim().replace(/\/+$/, ""))
  : null;

const allowVercelPreviews = process.env.ALLOW_VERCEL_PREVIEWS === "true";

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || !allowedOrigins) return callback(null, true);
      const normalized = origin.trim().replace(/\/+$/, "");
      if (allowedOrigins.includes(normalized)) {
        return callback(null, true);
      }
      if (allowVercelPreviews && /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(normalized)) {
        return callback(null, true);
      }
      return callback(new Error("CORS origin not allowed"));
    },
    credentials: true,
  })
);

// Raw-body middleware MUST precede JSON body parsing for Razorpay webhook signature verification
app.post(
  ["/api/payments/webhook", "/api/payment/webhook"],
  express.raw({ type: "application/json", limit: "2mb" }),
  webhookHandler
);

app.use(
  express.json({
    limit: "10mb",
    verify: (req, res, buf) => {
      if (buf?.length) {
        req.rawBody = buf.toString("utf8");
      }
    },
  })
);
app.use(express.urlencoded({ extended: true }));

// Liveness & readiness probes for Render Web Service zero-downtime deploys
app.get("/api/health/live", (req, res) => {
  res.status(200).json({ status: "alive", uptimeSeconds: Math.round(process.uptime()) });
});

const healthHandler = (req, res) => {
  const dbReady = mongoose.connection.readyState === 1;
  res.status(dbReady ? 200 : 503).json({
    status: dbReady ? "ok" : "degraded",
    service: "api",
    dbState: dbReady ? "connected" : "disconnected",
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
};

app.get("/", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "Fragranzia Backend API",
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/health", healthHandler);
app.get("/healthz", healthHandler);

const MONGO_CONNECTION_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

let dbPromise = null;
const ensureDbConnected = async (req, res, next) => {
  if (mongoose.connection.readyState === 1) {
    return next();
  }
  try {
    if (!dbPromise) {
      dbPromise = mongoose.connect(MONGO_CONNECTION_URI, {
        serverSelectionTimeoutMS: 10_000,
        socketTimeoutMS: 45_000,
      });
    }
    await dbPromise;
    next();
  } catch (err) {
    console.error("DB connection error in middleware:", err);
    next();
  }
};
app.use(ensureDbConnected);

app.use("/api", userauth);
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use("/api/product", product);
app.use("/api/category", category);
app.use("/api", order);
app.use("/api/payments", paymentRoutes);
app.use("/api/payment", paymentRoutes);

// Global error handler
app.use((err, req, res, next) => {
  if (err && err.name === "MulterError") {
    return res.status(400).json({ message: err.message });
  }
  if (err && err.message === "CORS origin not allowed") {
    return res.status(403).json({ message: "Origin not permitted by CORS" });
  }
  if (err) {
    console.error("Unhandled error:", err);
    return res.status(err.status || 500).json({
      message: err.message || "Internal server error",
    });
  }
  next();
});

const PORT = process.env.PORT || 5000;

if (!MONGO_CONNECTION_URI) {
  console.error("FATAL: MONGODB_URI / MONGO_URI is not defined in environment variables.");
  process.exit(1);
}

if (!process.env.SECRET_KEY) {
  console.error("FATAL: SECRET_KEY is not defined in environment variables.");
  process.exit(1);
}

const shouldRunInProcessReconciler =
  process.env.RUN_IN_PROCESS_RECONCILER === "true" ||
  (process.env.RENDER !== "true" && process.env.RUN_IN_PROCESS_RECONCILER !== "false");

let httpServer = null;
let shuttingDown = false;

const gracefulShutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logPaymentEvent("info", "api_shutdown_initiated", { signal });

  const forceExitTimer = setTimeout(() => {
    logPaymentEvent("error", "api_shutdown_forced_timeout", { signal });
    process.exit(1);
  }, 25_000);
  if (typeof forceExitTimer.unref === "function") forceExitTimer.unref();

  try {
    if (httpServer) {
      await new Promise((resolve) => httpServer.close(() => resolve()));
    }
    if (shouldRunInProcessReconciler) {
      await stopPaymentReconciliationJob(15_000);
    }
    await mongoose.connection.close(false).catch(() => {});
    logPaymentEvent("info", "api_shutdown_complete", { signal });
    process.exit(0);
  } catch (err) {
    logPaymentEvent("error", "api_shutdown_error", { errorMessage: err?.message });
    process.exit(1);
  }
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

mongoose.connection.on("disconnected", () => {
  if (!shuttingDown) {
    logPaymentEvent("warn", "api_mongo_disconnected");
  }
});

mongoose.connection.on("reconnected", () => {
  logPaymentEvent("info", "api_mongo_reconnected");
});

mongoose
  .connect(MONGO_CONNECTION_URI, {
    serverSelectionTimeoutMS: 10_000,
    socketTimeoutMS: 45_000,
  })
  .then(() => {
    console.log("MongoDB connected");
    if (shouldRunInProcessReconciler) {
      startPaymentReconciliationJob(60_000, { mode: "web_reconciler" });
    }
    httpServer = app.listen(PORT, () => {
      console.log(`Backend running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err);
    process.exit(1);
  });

module.exports = app;
