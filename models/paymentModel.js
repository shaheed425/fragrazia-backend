const mongoose = require("mongoose");

const paymentTransactionSchema = new mongoose.Schema(
  {
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    gateway: {
      type: String,
      default: "razorpay",
    },
    gatewayOrderId: {
      type: String,
      required: true,
      index: true,
    },
    gatewayPaymentId: {
      type: String,
      default: null,
      index: true,
    },
    transactionReference: {
      type: String,
      default: null,
    },
    amount: {
      type: Number,
      required: true,
    },
    currency: {
      type: String,
      default: "INR",
    },
    gatewayStatus: {
      type: String,
      default: "created",
    },
    mappedStatus: {
      type: String,
      enum: [
        "CREATED",
        "PENDING",
        "AUTHORIZED",
        "CAPTURED",
        "FAILED",
        "REFUND_PENDING",
        "REFUNDED",
        "REQUIRES_REVIEW",
      ],
      default: "CREATED",
    },
    method: {
      type: String,
      default: null,
    },
    attemptNumber: {
      type: Number,
      default: 1,
    },
    source: {
      type: String,
      enum: [
        "checkout",
        "verify_api",
        "webhook",
        "reconciler",
        "retry",
        "admin_verify",
        "client_failure",
      ],
      default: "checkout",
    },
    failureCode: {
      type: String,
      default: null,
    },
    failureReason: {
      type: String,
      default: null,
    },
    verifiedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

paymentTransactionSchema.index(
  { gatewayOrderId: 1, gatewayPaymentId: 1 },
  { unique: true, partialFilterExpression: { gatewayPaymentId: { $type: "string" } } }
);

const webhookEventSchema = new mongoose.Schema(
  {
    eventId: {
      type: String,
      required: true,
      unique: true,
    },
    eventType: {
      type: String,
      required: true,
    },
    gatewayOrderId: {
      type: String,
      default: null,
      index: true,
    },
    gatewayPaymentId: {
      type: String,
      default: null,
    },
    payload: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    status: {
      type: String,
      enum: ["queued", "processing", "processed", "ignored", "failed", "dead_letter"],
      default: "queued",
      index: true,
    },
    lockedAt: {
      type: Date,
      default: null,
      index: true,
    },
    lockedBy: {
      type: String,
      default: null,
    },
    nextAttemptAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    lastAttemptAt: {
      type: Date,
      default: null,
    },
    processingAttempts: {
      type: Number,
      default: 0,
    },
    errorMessage: {
      type: String,
      default: null,
    },
    processedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

webhookEventSchema.index({ status: 1, nextAttemptAt: 1, lockedAt: 1 });

const workerHeartbeatSchema = new mongoose.Schema(
  {
    workerId: {
      type: String,
      required: true,
      unique: true,
    },
    mode: {
      type: String,
      enum: ["worker", "web_reconciler", "cron"],
      default: "worker",
    },
    status: {
      type: String,
      enum: ["healthy", "degraded", "stopped"],
      default: "healthy",
    },
    lastHeartbeatAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    lastPassAt: {
      type: Date,
      default: null,
    },
    lastOrdersChecked: {
      type: Number,
      default: 0,
    },
    lastWebhooksRecovered: {
      type: Number,
      default: 0,
    },
    lastError: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

const PaymentTransaction = mongoose.model("PaymentTransaction", paymentTransactionSchema);
const WebhookEvent = mongoose.model("WebhookEvent", webhookEventSchema);
const WorkerHeartbeat = mongoose.model("WorkerHeartbeat", workerHeartbeatSchema);

module.exports = { PaymentTransaction, WebhookEvent, WorkerHeartbeat };

