const crypto = require("crypto");
const mongoose = require("mongoose");
const razorpay = require("../utils/razorpay");
const Order = require("../models/orderModel");
const Product = require("../models/productModel");
const User = require("../models/userModel");
const { PaymentTransaction, WebhookEvent } = require("../models/paymentModel");
const { logPaymentEvent, emitPaymentAlert } = require("../utils/paymentLogger");
const { notifyOrderPlacedWhatsApp } = require("../utils/whatsapp");
const { sendOrderConfirmationEmail } = require("../utils/mailer");

const WEBHOOK_BACKOFF_MS = [15_000, 60_000, 300_000, 900_000, 1_800_000];
const MAX_WEBHOOK_ATTEMPTS = 5;
const WEBHOOK_LEASE_MS = Number(process.env.WORKER_LEASE_MS || 90_000);

const STATE_TO_STATUS = {
  CREATED: "Pending",
  PENDING: "Pending",
  AUTHORIZED: "Pending",
  CAPTURED: "Paid",
  FAILED: "Failed",
  REFUND_PENDING: "Paid",
  REFUNDED: "Refunded",
  REQUIRES_REVIEW: "Pending",
};

const BACKOFF_MS = [60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000];
const MAX_RECONCILE_ATTEMPTS = 8;
const LOCK_STALE_MS = 120_000;

const safeTimingEqual = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

const verifyCheckoutSignature = (razorpayOrderId, razorpayPaymentId, signature) => {
  if (!process.env.RAZORPAY_KEY_SECRET) return false;
  const expected = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest("hex");
  return safeTimingEqual(expected, signature);
};

const verifyWebhookSignature = (rawBody, signature, webhookSecret) => {
  if (!rawBody || !signature || !webhookSecret) return false;
  const expected = crypto
    .createHmac("sha256", webhookSecret)
    .update(rawBody)
    .digest("hex");
  return safeTimingEqual(expected, signature);
};

const isTransientGatewayError = (err) => {
  if (!err) return false;
  const statusCode = err.statusCode || err.status || err.response?.status;
  if (statusCode && (statusCode >= 500 || statusCode === 429)) return true;
  const code = String(err.code || "").toUpperCase();
  if (
    [
      "ETIMEDOUT",
      "ECONNRESET",
      "ECONNREFUSED",
      "ENOTFOUND",
      "EAI_AGAIN",
      "ESOCKETTIMEDOUT",
      "ERR_NETWORK",
    ].includes(code)
  ) {
    return true;
  }
  const msg = String(err.message || err.error?.description || "").toLowerCase();
  return msg.includes("timeout") || msg.includes("network") || msg.includes("socket");
};

const isUnsupportedTransactionError = (err) => {
  const msg = String(err?.message || "").toLowerCase();
  return (
    err?.code === 20 ||
    msg.includes("replica set") ||
    msg.includes("transactions are not supported")
  );
};

const runWithOptionalTransaction = async (workFn) => {
  let session = null;
  try {
    session = await mongoose.startSession();
    let result;
    await session.withTransaction(async () => {
      result = await workFn(session);
    });
    return result;
  } catch (err) {
    if (isUnsupportedTransactionError(err)) {
      return await workFn(null);
    }
    throw err;
  } finally {
    if (session) {
      await session.endSession().catch(() => {});
    }
  }
};

const mapRazorpayPaymentToState = (payment, rzpOrderStatus = null) => {
  if (!payment) {
    if (rzpOrderStatus === "paid") return "CAPTURED";
    return "CREATED";
  }

  const status = String(payment.status || "").toLowerCase();
  const amount = Number(payment.amount || 0);
  const refunded = Number(payment.amount_refunded || 0);

  if (status === "refunded" || (amount > 0 && refunded >= amount)) {
    return "REFUNDED";
  }
  if (status === "captured") {
    return "CAPTURED";
  }
  if (status === "authorized") {
    return "AUTHORIZED";
  }
  if (status === "created") {
    return "PENDING";
  }
  if (status === "failed") {
    return "FAILED";
  }
  return rzpOrderStatus === "paid" ? "CAPTURED" : "PENDING";
};

const extractTransactionRef = (payment) => {
  if (!payment) return null;
  return (
    payment.acquirer_data?.rrn ||
    payment.acquirer_data?.upi_transaction_id ||
    payment.acquirer_data?.bank_transaction_id ||
    payment.acquirer_data?.auth_code ||
    payment.id ||
    null
  );
};

const recordTransaction = async (
  {
    order,
    gatewayOrderId,
    gatewayPaymentId = null,
    transactionReference = null,
    gatewayStatus = "created",
    mappedStatus = "CREATED",
    amount,
    currency = "INR",
    method = null,
    source = "checkout",
    failureCode = null,
    failureReason = null,
    verifiedAt = null,
  },
  session = null
) => {
  if (!order || !gatewayOrderId) return null;

  const filter = gatewayPaymentId
    ? { gatewayOrderId, gatewayPaymentId }
    : { gatewayOrderId, gatewayPaymentId: null };

  const update = {
    $set: {
      order: order._id,
      user: order.user,
      gateway: "razorpay",
      gatewayOrderId,
      gatewayPaymentId,
      transactionReference: transactionReference || gatewayPaymentId || null,
      amount: amount ?? Math.round((order.totalAmount || 0) * 100),
      currency: currency || order.currency || "INR",
      gatewayStatus,
      mappedStatus,
      method,
      attemptNumber: order.paymentAttempts || 1,
      source,
      failureCode,
      failureReason,
      ...(verifiedAt ? { verifiedAt } : {}),
    },
  };

  return PaymentTransaction.findOneAndUpdate(filter, update, {
    upsert: true,
    returnDocument: "after",
    setDefaultsOnInsert: true,
    ...(session ? { session } : {}),
  });
};

/**
 * Single authoritative idempotent order confirmation service.
 * Used across checkout verify, webhooks, background reconciler, and admin reconcile.
 */
const confirmOrderFromCapturedPayment = async ({
  orderId,
  payment = null,
  source = "verify_api",
  signature = null,
  webhookConfirmed = false,
}) => {
  const now = new Date();
  const baseOrder = await Order.findById(orderId);
  if (!baseOrder) {
    return { found: false, message: "Order not found" };
  }

  const expectedPaise = Math.round((baseOrder.totalAmount || 0) * 100);
  if (payment) {
    if (Number(payment.amount) !== expectedPaise || (payment.currency || "INR") !== (baseOrder.currency || "INR")) {
      baseOrder.paymentState = "REQUIRES_REVIEW";
      baseOrder.paymentStatus = "Pending";
      baseOrder.requiresReviewReason = `Gateway payment mismatch (expected ${expectedPaise} ${baseOrder.currency || "INR"}, got ${payment.amount} ${payment.currency})`;
      baseOrder.lastPaymentCheckAt = now;
      await baseOrder.save();
      logPaymentEvent("error", "order_amount_or_currency_mismatch", {
        orderId: baseOrder._id.toString(),
        expectedPaise,
        gatewayPaise: payment.amount,
        source,
      });
      return {
        found: true,
        order: baseOrder,
        paymentState: "REQUIRES_REVIEW",
        newlyConfirmed: false,
        message: "Payment requires manual review due to amount mismatch",
      };
    }

    if (String(payment.status || "").toLowerCase() !== "captured") {
      return {
        found: true,
        order: baseOrder,
        paymentState: mapRazorpayPaymentToState(payment),
        newlyConfirmed: false,
        message: "Payment is not captured yet",
      };
    }
  }

  const txRef = extractTransactionRef(payment) || baseOrder.transaction_reference;
  const gatewayPaymentId = payment?.id || baseOrder.razorpay_payment_id;
  const opId = crypto.randomUUID();

  const confirmationResult = await runWithOptionalTransaction(async (session) => {
    const opt = session ? { session } : {};
    const lockedOrder = await Order.findOneAndUpdate(
      { _id: orderId, fulfilledAt: null },
      {
        $set: {
          paymentState: "CAPTURED",
          paymentStatus: "Paid",
          paidAt: baseOrder.paidAt || now,
          fulfilledAt: now,
          lastPaymentCheckAt: now,
          nextReconcileAt: null,
          paymentFailureReason: null,
          confirmationOperationId: opId,
          ...(baseOrder.confirmationEmailSentAt
            ? { confirmationEmailSentAt: baseOrder.confirmationEmailSentAt }
            : {}),
          ...(signature ? { razorpay_signature: signature } : {}),
          ...(gatewayPaymentId ? { razorpay_payment_id: gatewayPaymentId } : {}),
          ...(txRef ? { transaction_reference: txRef } : {}),
          ...(webhookConfirmed ? { webhookConfirmed: true } : {}),
          payment_gateway_status: payment?.status || "captured",
          ...(baseOrder.deliveryStatus === "Pending" ? { deliveryStatus: "Confirmed" } : {}),
        },
      },
      { returnDocument: "after", ...opt }
    );

    if (!lockedOrder) {
      // Already fulfilled earlier — update missing metadata safely without touching stock
      const existing = await Order.findById(orderId, null, opt);
      if (existing) {
        if (existing.paymentState !== "REFUNDED" && existing.paymentState !== "REQUIRES_REVIEW") {
          existing.paymentState = "CAPTURED";
          existing.paymentStatus = "Paid";
        }
        if (gatewayPaymentId && !existing.razorpay_payment_id) {
          existing.razorpay_payment_id = gatewayPaymentId;
        }
        if (txRef && !existing.transaction_reference) {
          existing.transaction_reference = txRef;
        }
        if (webhookConfirmed) existing.webhookConfirmed = true;
        existing.lastPaymentCheckAt = now;
        await existing.save(opt);
      }
      return { found: true, order: existing, paymentState: existing?.paymentState || "CAPTURED", newlyConfirmed: false };
    }

    const fulfillmentNotes = [];
    const decrementedItems = [];
    let allStockDeducted = true;

    try {
      if (!lockedOrder.stockDeducted) {
        for (const item of lockedOrder.orderItems || []) {
          if (!item.product) continue;
          const qty = Math.max(1, Number(item.quantity) || 1);
          const decremented = await Product.findOneAndUpdate(
            { _id: item.product, stock: { $gte: qty } },
            { $inc: { stock: -qty } },
            { returnDocument: "after", ...opt }
          );
          if (!decremented) {
            allStockDeducted = false;
            fulfillmentNotes.push(`Stock shortage on delayed confirmation for product ${item.product}`);
          } else {
            decrementedItems.push({ product: item.product, quantity: qty });
          }
        }

        lockedOrder.stockDeducted = allStockDeducted;
        if (fulfillmentNotes.length > 0) {
          lockedOrder.fulfillmentNote = fulfillmentNotes.join("; ");
        }
        await lockedOrder.save(opt);
      }

      await User.findByIdAndUpdate(
        lockedOrder.user,
        { cart: [], cart_total: 0 },
        opt
      );
    } catch (confirmErr) {
      // Compensating rollback when running on standalone MongoDB without multi-doc transactions
      if (!session) {
        for (const entry of decrementedItems) {
          await Product.updateOne(
            { _id: entry.product },
            { $inc: { stock: entry.quantity } }
          ).catch(() => {});
        }
        await Order.updateOne(
          { _id: orderId, confirmationOperationId: opId },
          {
            $set: {
              fulfilledAt: null,
              paymentState: "PENDING",
              paymentStatus: "Pending",
              deliveryStatus: baseOrder.deliveryStatus,
              stockDeducted: false,
              confirmationOperationId: null,
            },
          }
        ).catch(() => {});
      }
      throw confirmErr;
    }

    logPaymentEvent("info", "order_payment_confirmed", {
      orderId: lockedOrder._id.toString(),
      orderNumber: lockedOrder.orderNumber,
      razorpayOrderId: lockedOrder.razorpay_order_id,
      razorpayPaymentId: lockedOrder.razorpay_payment_id,
      stockDeducted: lockedOrder.stockDeducted,
      operationId: opId,
      source,
    });

    return {
      found: true,
      order: lockedOrder,
      paymentState: lockedOrder.paymentState,
      newlyConfirmed: true,
    };
  });

  const confirmedOrderId = confirmationResult?.order?._id;
  if (
    confirmedOrderId &&
    (confirmationResult?.paymentState === "CAPTURED" || confirmationResult?.newlyConfirmed)
  ) {
    void notifyOrderPlacedWhatsApp(confirmedOrderId).catch((waErr) => {
      logPaymentEvent("error", "whatsapp_upi_dispatch_error", {
        orderId: confirmedOrderId.toString(),
        errorMessage: waErr.message,
      });
    });

    void sendOrderConfirmationEmail(confirmedOrderId).catch((mailErr) => {
      logPaymentEvent("warn", "order_confirmation_email_upi_dispatch_error", {
        orderId: confirmedOrderId.toString(),
        errorMessage: mailErr.message,
      });
    });
  }

  return confirmationResult;
};

const pickBestGatewayPayment = (payments = []) => {
  if (!Array.isArray(payments) || payments.length === 0) return null;

  const priority = {
    refunded: 5,
    captured: 4,
    authorized: 3,
    created: 2,
    failed: 1,
  };

  return [...payments].sort((a, b) => {
    const diff = (priority[b.status] || 0) - (priority[a.status] || 0);
    if (diff !== 0) return diff;
    return (b.created_at || 0) - (a.created_at || 0);
  })[0];
};

const fetchAllOrderGatewayPayments = async (order) => {
  const knownGatewayOrderIds = new Set(
    await PaymentTransaction.distinct("gatewayOrderId", { order: order._id })
  );
  if (order.razorpay_order_id) {
    knownGatewayOrderIds.add(order.razorpay_order_id);
  }

  const allPayments = [];
  let latestRzpOrder = null;

  for (const gwOrderId of knownGatewayOrderIds) {
    const [rzpOrder, rzpPaymentsResp] = await Promise.all([
      razorpay.orders.fetch(gwOrderId),
      razorpay.orders.fetchPayments(gwOrderId),
    ]);
    if (gwOrderId === order.razorpay_order_id) {
      latestRzpOrder = rzpOrder;
    }
    if (Array.isArray(rzpPaymentsResp?.items)) {
      allPayments.push(...rzpPaymentsResp.items);
    }
  }

  return { latestRzpOrder, allPayments };
};

const populateOrder = (orderId) =>
  Order.findById(orderId)
    .populate("orderItems.product")
    .populate("shippingAddress");

/**
 * Reconciles an order across all Razorpay order attempts using official Razorpay APIs.
 */
const reconcileOrderWithGateway = async (
  orderId,
  { source = "reconciler", actorId = null, paymentIdHint = null, signature = null } = {}
) => {
  const order = await Order.findById(orderId);
  if (!order) {
    return { found: false, message: "Order not found" };
  }

  if (order.paymentMethod !== "UPI" || !order.razorpay_order_id) {
    return {
      found: true,
      order,
      paymentState: order.paymentState || "CREATED",
      paymentStatus: order.paymentStatus,
      canRetry: false,
      message: "Order does not use Razorpay gateway",
    };
  }

  const now = new Date();
  const previousState = order.paymentState || "CREATED";

  try {
    const { latestRzpOrder, allPayments } = await fetchAllOrderGatewayPayments(order);
    let paymentItems = allPayments;

    if (paymentIdHint && !paymentItems.some((p) => p.id === paymentIdHint)) {
      try {
        const directPayment = await razorpay.payments.fetch(paymentIdHint);
        if (directPayment && directPayment.order_id === order.razorpay_order_id) {
          paymentItems = [directPayment, ...paymentItems];
        }
      } catch (hintErr) {
        if (isTransientGatewayError(hintErr)) throw hintErr;
      }
    }

    // Record all discovered payments in audit table
    for (const p of paymentItems) {
      const pState = mapRazorpayPaymentToState(p, latestRzpOrder?.status);
      await recordTransaction({
        order,
        gatewayOrderId: p.order_id || order.razorpay_order_id,
        gatewayPaymentId: p.id,
        transactionReference: extractTransactionRef(p),
        gatewayStatus: p.status,
        mappedStatus: pState,
        amount: p.amount,
        currency: p.currency,
        method: p.method || null,
        source,
        failureCode: p.error_code || null,
        failureReason: p.error_description || p.error_reason || null,
        verifiedAt: now,
      });
    }

    // Detect duplicate captures across attempts for the same internal order
    const capturedPayments = paymentItems.filter(
      (p) => String(p.status || "").toLowerCase() === "captured"
    );
    const uniqueCapturedIds = [...new Set(capturedPayments.map((p) => p.id))];

    if (uniqueCapturedIds.length > 1) {
      const primaryCaptured = capturedPayments[0];
      await confirmOrderFromCapturedPayment({
        orderId: order._id,
        payment: primaryCaptured,
        source,
        signature,
      });

      const updated = await Order.findByIdAndUpdate(
        order._id,
        {
          $set: {
            paymentState: "REQUIRES_REVIEW",
            paymentStatus: "Paid",
            requiresReviewReason: `Multiple captured payments detected (${uniqueCapturedIds.join(", ")}); manual refund required`,
            lastPaymentCheckAt: now,
            nextReconcileAt: null,
          },
        },
        { returnDocument: "after" }
      );

      emitPaymentAlert("duplicate_captured_payment", {
        orderId: order._id.toString(),
        capturedCount: uniqueCapturedIds.length,
        source,
      });

      const populated = await populateOrder(updated._id);
      return {
        found: true,
        order: populated,
        paymentState: "REQUIRES_REVIEW",
        paymentStatus: "Paid",
        canRetry: false,
        message: "Multiple captured payments detected; flagged for admin review",
      };
    }

    let bestPayment = pickBestGatewayPayment(paymentItems);

    // Optional explicit auto-capture ONLY if RAZORPAY_AUTO_CAPTURE=true; otherwise keep AUTHORIZED distinct
    if (
      bestPayment &&
      bestPayment.status === "authorized" &&
      process.env.RAZORPAY_AUTO_CAPTURE === "true"
    ) {
      const expectedPaise = Math.round((order.totalAmount || 0) * 100);
      if (
        Number(bestPayment.amount) === expectedPaise &&
        bestPayment.currency === (order.currency || "INR")
      ) {
        try {
          bestPayment = await razorpay.payments.capture(
            bestPayment.id,
            bestPayment.amount,
            bestPayment.currency
          );
        } catch (capErr) {
          if (isTransientGatewayError(capErr)) throw capErr;
        }
      }
    }

    let nextState = mapRazorpayPaymentToState(bestPayment, latestRzpOrder?.status);

    // Out-of-order monotonic guards
    if (previousState === "REFUNDED") {
      nextState = "REFUNDED";
    } else if (previousState === "REQUIRES_REVIEW" && nextState !== "REFUNDED") {
      nextState = "REQUIRES_REVIEW";
    } else if (previousState === "CAPTURED" && nextState !== "REFUNDED") {
      nextState = "CAPTURED";
    } else if (!bestPayment && previousState === "PENDING" && latestRzpOrder?.status !== "paid") {
      nextState = "PENDING";
    }

    // Validate amount mismatch even for authorized/captured
    if (bestPayment && nextState !== "FAILED") {
      const expectedPaise = Math.round((order.totalAmount || 0) * 100);
      if (Number(bestPayment.amount) !== expectedPaise) {
        order.paymentState = "REQUIRES_REVIEW";
        order.paymentStatus = "Pending";
        order.requiresReviewReason = `Gateway amount mismatch: expected ${expectedPaise} paise, received ${bestPayment.amount}`;
        order.lastPaymentCheckAt = now;
        order.nextReconcileAt = null;
        await order.save();
        emitPaymentAlert("amount_mismatch", {
          orderId: order._id.toString(),
          razorpayOrderId: order.razorpay_order_id,
          expectedPaise,
          receivedPaise: Number(bestPayment.amount),
        });
        const populated = await populateOrder(order._id);
        return {
          found: true,
          order: populated,
          paymentState: "REQUIRES_REVIEW",
          paymentStatus: "Pending",
          canRetry: false,
          message: order.requiresReviewReason,
        };
      }
    }

    if (nextState === "CAPTURED") {
      const conf = await confirmOrderFromCapturedPayment({
        orderId: order._id,
        payment: bestPayment,
        source,
        signature,
        webhookConfirmed: source === "webhook" || order.webhookConfirmed,
      });
      const populated = await populateOrder(conf.order._id);
      return {
        found: true,
        order: populated,
        paymentState: conf.paymentState,
        paymentStatus: conf.order.paymentStatus,
        canRetry: false,
        message: "Payment captured and order confirmed",
      };
    }

    const txRef = extractTransactionRef(bestPayment);
    order.paymentState = nextState;
    order.paymentStatus = STATE_TO_STATUS[nextState] || "Pending";
    order.lastPaymentCheckAt = now;
    if (bestPayment?.id) order.razorpay_payment_id = bestPayment.id;
    if (txRef) order.transaction_reference = txRef;
    order.payment_gateway_status = bestPayment?.status || latestRzpOrder?.status || order.payment_gateway_status;

    if (nextState === "REFUNDED") {
      order.refundedAt = order.refundedAt || now;
      order.nextReconcileAt = null;
    } else if (nextState === "FAILED") {
      order.paymentFailureReason =
        bestPayment?.error_description ||
        bestPayment?.error_reason ||
        "Payment declined by gateway";
      order.nextReconcileAt = null;
    } else if (nextState === "AUTHORIZED" || nextState === "PENDING") {
      const attempts = (order.reconcileAttempts || 0) + 1;
      order.reconcileAttempts = attempts;
      if (attempts >= MAX_RECONCILE_ATTEMPTS) {
        order.paymentState = "REQUIRES_REVIEW";
        order.paymentStatus = "Pending";
        order.requiresReviewReason = `Unresolved ${nextState} state after ${attempts} reconciliation checks`;
        order.nextReconcileAt = null;
      } else {
        const delay = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
        order.nextReconcileAt = new Date(now.getTime() + delay);
      }
    }

    await order.save();

    logPaymentEvent("info", "payment_reconciled", {
      orderId: order._id.toString(),
      razorpayOrderId: order.razorpay_order_id,
      razorpayPaymentId: order.razorpay_payment_id,
      previousState,
      nextState: order.paymentState,
      source,
      actorId,
    });

    const populated = await populateOrder(order._id);
    return {
      found: true,
      order: populated,
      paymentState: order.paymentState,
      paymentStatus: order.paymentStatus,
      canRetry: ["CREATED", "FAILED"].includes(order.paymentState),
      message:
        order.paymentState === "AUTHORIZED"
          ? "Payment authorized and awaiting gateway capture"
          : order.paymentState === "PENDING"
          ? "Payment verification pending"
          : order.paymentState === "REQUIRES_REVIEW"
          ? order.requiresReviewReason || "Payment verification delayed; under review"
          : order.paymentState === "FAILED"
          ? order.paymentFailureReason || "Payment failed"
          : "Awaiting payment",
    };
  } catch (err) {
    // CRITICAL: Never mark FAILED on timeout or Razorpay unavailability
    const transient = isTransientGatewayError(err);
    const preserveTerminal = ["CAPTURED", "REFUNDED", "REQUIRES_REVIEW"].includes(order.paymentState);

    if (!preserveTerminal) {
      order.paymentState = order.paymentState === "AUTHORIZED" ? "AUTHORIZED" : "PENDING";
      order.paymentStatus = STATE_TO_STATUS[order.paymentState];
    }

    const attempts = (order.reconcileAttempts || 0) + 1;
    order.reconcileAttempts = attempts;
    order.lastPaymentCheckAt = now;

    if (!preserveTerminal && attempts >= MAX_RECONCILE_ATTEMPTS) {
      order.paymentState = "REQUIRES_REVIEW";
      order.requiresReviewReason = "Gateway unreachable across maximum reconciliation retries";
      order.nextReconcileAt = null;
    } else if (!preserveTerminal) {
      const delay = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
      order.nextReconcileAt = new Date(now.getTime() + delay);
    }

    await order.save();

    logPaymentEvent(transient ? "warn" : "error", "gateway_reconciliation_unavailable", {
      orderId: order._id.toString(),
      razorpayOrderId: order.razorpay_order_id,
      transient,
      attempts,
      errorMessage: err?.message || err?.error?.description || "Gateway error",
      source,
    });

    const populated = await populateOrder(order._id);
    return {
      found: true,
      unknown: true,
      order: populated,
      paymentState: order.paymentState,
      paymentStatus: order.paymentStatus,
      canRetry: false,
      message:
        order.paymentState === "REQUIRES_REVIEW"
          ? order.requiresReviewReason
          : "Payment verification pending",
    };
  }
};

/**
 * Safely creates a new Razorpay order retry ONLY after atomic concurrency lock
 * and checking all previous gateway attempts.
 */
const retryOrderPayment = async (orderId, userId) => {
  const now = new Date();
  const staleLockCutoff = new Date(now.getTime() - 30_000);

  // Atomic lock prevents concurrent retry race conditions
  const locked = await Order.findOneAndUpdate(
    {
      _id: orderId,
      user: userId,
      $or: [{ retryLockedAt: null }, { retryLockedAt: { $lt: staleLockCutoff } }],
    },
    { $set: { retryLockedAt: now } },
    { returnDocument: "after" }
  );

  if (!locked) {
    const existing = await Order.findById(orderId);
    if (!existing) {
      return { statusCode: 404, success: false, message: "Order not found" };
    }
    if (existing.user.toString() !== userId) {
      return { statusCode: 403, success: false, message: "Not authorized for this order" };
    }
    return {
      statusCode: 409,
      success: false,
      paymentState: existing.paymentState,
      message: "A payment retry is already in progress for this order",
    };
  }

  try {
    if (locked.paymentMethod !== "UPI") {
      return { statusCode: 400, success: false, message: "Retry is only available for online payments" };
    }
    if (locked.deliveryStatus === "Cancelled") {
      return { statusCode: 400, success: false, message: "Cancelled orders cannot be retried" };
    }

    const check = await reconcileOrderWithGateway(locked._id, { source: "retry" });

    if (check.paymentState === "CAPTURED" || check.paymentState === "REFUNDED") {
      return {
        statusCode: 200,
        success: true,
        alreadyPaid: true,
        paymentState: check.paymentState,
        order: check.order,
        message: "Payment already verified for this order",
      };
    }

    if (
      check.unknown ||
      ["PENDING", "AUTHORIZED", "REFUND_PENDING", "REQUIRES_REVIEW"].includes(check.paymentState)
    ) {
      return {
        statusCode: 409,
        success: false,
        paymentState: check.paymentState,
        order: check.order,
        message:
          check.paymentState === "REQUIRES_REVIEW"
            ? "Order payment is under manual review. Please do not retry."
            : "Payment verification pending. Please wait before retrying to avoid duplicate charges.",
      };
    }

    for (const item of locked.orderItems || []) {
      if (!item.product) continue;
      const prod = await Product.findById(item.product);
      if (!prod || prod.isActive === false || prod.stock < (item.quantity || 1)) {
        return {
          statusCode: 400,
          success: false,
          message: `${prod?.name || "Selected item"} is out of stock or unavailable`,
        };
      }
    }

    const nextAttempt = (locked.paymentAttempts || 1) + 1;
    const rzpOrder = await razorpay.orders.create({
      amount: Math.round((locked.totalAmount || 0) * 100),
      currency: locked.currency || "INR",
      receipt: `rcpt_${locked._id.toString().slice(-10)}_a${nextAttempt}_${Date.now()}`,
    });

    const refreshed = await Order.findById(locked._id);
    refreshed.razorpay_order_id = rzpOrder.id;
    refreshed.razorpay_payment_id = null;
    refreshed.razorpay_signature = null;
    refreshed.paymentState = "CREATED";
    refreshed.paymentStatus = "Pending";
    refreshed.paymentFailureReason = null;
    refreshed.payment_gateway_status = rzpOrder.status || "created";
    refreshed.paymentAttempts = nextAttempt;
    refreshed.reconcileAttempts = 0;
    refreshed.nextReconcileAt = null;
    refreshed.lastPaymentCheckAt = new Date();
    await refreshed.save();

    await recordTransaction({
      order: refreshed,
      gatewayOrderId: rzpOrder.id,
      gatewayStatus: rzpOrder.status || "created",
      mappedStatus: "CREATED",
      amount: rzpOrder.amount,
      currency: rzpOrder.currency,
      source: "retry",
    });

    logPaymentEvent("info", "payment_retry_created", {
      orderId: refreshed._id.toString(),
      razorpayOrderId: rzpOrder.id,
      attempt: nextAttempt,
    });

    return {
      statusCode: 200,
      success: true,
      order: refreshed,
      razorpayOrder: rzpOrder,
      paymentState: "CREATED",
      message: "Ready to retry payment",
    };
  } finally {
    await Order.findByIdAndUpdate(locked._id, { $set: { retryLockedAt: null } }).catch(() => {});
  }
};

/**
 * Atomically claims a MongoDB lease on a WebhookEvent and applies it idempotently
 * across concurrent workers, crashes, and out-of-order deliveries.
 */
const processWebhookEventById = async (webhookDocId, { workerId = "api-async" } = {}) => {
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - WEBHOOK_LEASE_MS);

  const eventDoc = await WebhookEvent.findOneAndUpdate(
    {
      _id: webhookDocId,
      status: { $in: ["queued", "failed", "processing"] },
      $or: [{ lockedAt: null }, { lockedAt: { $lt: staleCutoff } }],
    },
    {
      $set: {
        status: "processing",
        lockedAt: now,
        lockedBy: workerId,
        lastAttemptAt: now,
      },
    },
    { returnDocument: "after" }
  );

  if (!eventDoc) {
    return null;
  }

  try {
    const payload = eventDoc.payload;
    const eventType = eventDoc.eventType;
    const paymentEntity = payload?.payload?.payment?.entity || null;
    const orderEntity = payload?.payload?.order?.entity || null;
    const refundEntity = payload?.payload?.refund?.entity || null;

    const gatewayOrderId =
      eventDoc.gatewayOrderId || paymentEntity?.order_id || orderEntity?.id || null;
    const gatewayPaymentId =
      eventDoc.gatewayPaymentId || paymentEntity?.id || refundEntity?.payment_id || null;

    let order = null;
    if (gatewayOrderId) {
      order = await Order.findOne({ razorpay_order_id: gatewayOrderId });
    }
    if (!order && gatewayPaymentId) {
      order = await Order.findOne({ razorpay_payment_id: gatewayPaymentId });
    }
    if (!order && gatewayOrderId) {
      const tx = await PaymentTransaction.findOne({ gatewayOrderId });
      if (tx) order = await Order.findById(tx.order);
    }

    if (!order) {
      eventDoc.status = "ignored";
      eventDoc.processedAt = new Date();
      eventDoc.lockedAt = null;
      eventDoc.lockedBy = null;
      eventDoc.nextAttemptAt = null;
      await eventDoc.save();
      return eventDoc;
    }

    const isCurrentGatewayOrder = !gatewayOrderId || order.razorpay_order_id === gatewayOrderId;

    if (eventType === "refund.created") {
      await recordTransaction({
        order,
        gatewayOrderId: gatewayOrderId || order.razorpay_order_id,
        gatewayPaymentId,
        transactionReference: refundEntity?.id || extractTransactionRef(paymentEntity),
        gatewayStatus: "refund_pending",
        mappedStatus: "REFUND_PENDING",
        amount: refundEntity?.amount || Math.round((order.totalAmount || 0) * 100),
        source: "webhook",
        verifiedAt: new Date(),
      });
      if (order.paymentState !== "REFUNDED") {
        order.paymentState = "REFUND_PENDING";
        order.paymentStatus = STATE_TO_STATUS.REFUND_PENDING;
        order.lastPaymentCheckAt = new Date();
        await order.save();
      }
    } else if (eventType === "refund.processed") {
      await recordTransaction({
        order,
        gatewayOrderId: gatewayOrderId || order.razorpay_order_id,
        gatewayPaymentId,
        transactionReference: refundEntity?.id || extractTransactionRef(paymentEntity),
        gatewayStatus: "refunded",
        mappedStatus: "REFUNDED",
        amount: refundEntity?.amount || Math.round((order.totalAmount || 0) * 100),
        source: "webhook",
        verifiedAt: new Date(),
      });
      order.paymentState = "REFUNDED";
      order.paymentStatus = "Refunded";
      order.refundedAt = order.refundedAt || new Date();
      order.payment_gateway_status = "refunded";
      order.nextReconcileAt = null;
      order.lastPaymentCheckAt = new Date();
      await order.save();
    } else if (eventType === "refund.failed") {
      await recordTransaction({
        order,
        gatewayOrderId: gatewayOrderId || order.razorpay_order_id,
        gatewayPaymentId,
        transactionReference: refundEntity?.id || gatewayPaymentId,
        gatewayStatus: "refund_failed",
        mappedStatus: "REQUIRES_REVIEW",
        amount: refundEntity?.amount || Math.round((order.totalAmount || 0) * 100),
        source: "webhook",
        failureReason: "Refund failed on Razorpay",
        verifiedAt: new Date(),
      });
      order.paymentState = "REQUIRES_REVIEW";
      order.requiresReviewReason = `Refund ${refundEntity?.id || ""} failed on gateway`;
      order.lastPaymentCheckAt = new Date();
      await order.save();
    } else if (eventType === "payment.captured" || eventType === "order.paid") {
      const result = await reconcileOrderWithGateway(order._id, {
        source: "webhook",
        paymentIdHint: gatewayPaymentId,
      });
      if (result?.unknown && paymentEntity?.status === "captured") {
        await confirmOrderFromCapturedPayment({
          orderId: order._id,
          payment: paymentEntity,
          source: "webhook",
          webhookConfirmed: true,
        });
      }
    } else if (eventType === "payment.authorized") {
      if (
        isCurrentGatewayOrder &&
        !["CAPTURED", "REFUNDED", "REQUIRES_REVIEW"].includes(order.paymentState)
      ) {
        await reconcileOrderWithGateway(order._id, {
          source: "webhook",
          paymentIdHint: gatewayPaymentId,
        });
      }
    } else if (eventType === "payment.failed") {
      await recordTransaction({
        order,
        gatewayOrderId: gatewayOrderId || order.razorpay_order_id,
        gatewayPaymentId,
        transactionReference: gatewayPaymentId,
        gatewayStatus: "failed",
        mappedStatus: "FAILED",
        amount: paymentEntity?.amount || Math.round((order.totalAmount || 0) * 100),
        method: paymentEntity?.method || null,
        source: "webhook",
        failureCode: paymentEntity?.error_code || null,
        failureReason:
          paymentEntity?.error_description || paymentEntity?.error_reason || "Payment failed",
        verifiedAt: new Date(),
      });

      if (
        isCurrentGatewayOrder &&
        !["CAPTURED", "REFUND_PENDING", "REFUNDED", "REQUIRES_REVIEW"].includes(order.paymentState)
      ) {
        await reconcileOrderWithGateway(order._id, {
          source: "webhook",
          paymentIdHint: gatewayPaymentId,
        });
      }
    }

    eventDoc.status = "processed";
    eventDoc.processedAt = new Date();
    eventDoc.errorMessage = null;
    eventDoc.lockedAt = null;
    eventDoc.lockedBy = null;
    eventDoc.nextAttemptAt = null;
    await eventDoc.save();

    logPaymentEvent("info", "webhook_processed", {
      eventId: eventDoc.eventId,
      eventType,
      orderId: order._id.toString(),
      razorpayOrderId: gatewayOrderId,
      razorpayPaymentId: gatewayPaymentId,
      workerId,
    });
    return eventDoc;
  } catch (err) {
    const attempts = (eventDoc.processingAttempts || 0) + 1;
    const delayMs =
      WEBHOOK_BACKOFF_MS[Math.min(Math.max(0, attempts - 1), WEBHOOK_BACKOFF_MS.length - 1)];
    const deadLettered = attempts >= MAX_WEBHOOK_ATTEMPTS;

    eventDoc.status = deadLettered ? "dead_letter" : "failed";
    eventDoc.processingAttempts = attempts;
    eventDoc.errorMessage = err?.message || "Webhook processing failed";
    eventDoc.lockedAt = null;
    eventDoc.lockedBy = null;
    eventDoc.nextAttemptAt = deadLettered ? null : new Date(Date.now() + delayMs);
    await eventDoc.save();

    if (deadLettered) {
      emitPaymentAlert("webhook_dead_letter", {
        eventId: eventDoc.eventId,
        attempts,
        errorMessage: eventDoc.errorMessage,
      });
    } else {
      logPaymentEvent("error", "webhook_async_processing_failed", {
        eventId: eventDoc.eventId,
        attempts,
        errorMessage: eventDoc.errorMessage,
      });
    }
    return eventDoc;
  }
};

/**
 * Verifies webhook signature, saves durable WebhookEvent with X-Razorpay-Event-Id uniqueness,
 * returns HTTP 2xx promptly, and dispatches asynchronous processing.
 */
const enqueueWebhookEvent = async ({ rawBody, signature, eventIdHeader, awaitProcessing = false }) => {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    logPaymentEvent("error", "webhook_secret_missing");
    return { statusCode: 500, body: { success: false, message: "Webhook not configured" } };
  }

  if (!verifyWebhookSignature(rawBody, signature, webhookSecret)) {
    logPaymentEvent("warn", "webhook_signature_invalid");
    return { statusCode: 400, body: { success: false, message: "Invalid webhook signature" } };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, body: { success: false, message: "Invalid JSON payload" } };
  }

  if (!payload || typeof payload.event !== "string" || !payload.payload || typeof payload.payload !== "object") {
    return { statusCode: 400, body: { success: false, message: "Invalid webhook event structure" } };
  }

  const eventType = payload.event;
  const paymentEntity = payload.payload.payment?.entity || null;
  const orderEntity = payload.payload.order?.entity || null;
  const refundEntity = payload.payload.refund?.entity || null;

  const gatewayOrderId = paymentEntity?.order_id || orderEntity?.id || null;
  const gatewayPaymentId = paymentEntity?.id || refundEntity?.payment_id || null;

  const computedEventId =
    (typeof eventIdHeader === "string" && eventIdHeader.trim()) ||
    crypto
      .createHash("sha256")
      .update(`${eventType}:${gatewayOrderId || ""}:${gatewayPaymentId || ""}:${payload.created_at || ""}`)
      .digest("hex");

  let createdDoc;
  try {
    createdDoc = await WebhookEvent.create({
      eventId: computedEventId,
      eventType,
      gatewayOrderId,
      gatewayPaymentId,
      payload,
      status: "queued",
    });
  } catch (dupErr) {
    if (dupErr?.code === 11000) {
      logPaymentEvent("info", "webhook_duplicate_ignored", {
        eventId: computedEventId,
        eventType,
        razorpayOrderId: gatewayOrderId,
      });
      return { statusCode: 200, body: { success: true, duplicate: true, eventId: computedEventId } };
    }
    throw dupErr;
  }

  if (awaitProcessing) {
    await processWebhookEventById(createdDoc._id, { workerId: "api-sync" });
  } else if (process.env.ENABLE_IN_PROCESS_WEBHOOK_DISPATCH !== "false") {
    setImmediate(() => {
      processWebhookEventById(createdDoc._id, { workerId: "api-fastpath" }).catch(() => {});
    });
  }

  return {
    statusCode: 200,
    body: { success: true, received: true, eventId: computedEventId },
  };
};

module.exports = {
  STATE_TO_STATUS,
  LOCK_STALE_MS,
  WEBHOOK_LEASE_MS,
  MAX_WEBHOOK_ATTEMPTS,
  verifyCheckoutSignature,
  verifyWebhookSignature,
  isTransientGatewayError,
  mapRazorpayPaymentToState,
  extractTransactionRef,
  recordTransaction,
  confirmOrderFromCapturedPayment,
  reconcileOrderWithGateway,
  retryOrderPayment,
  enqueueWebhookEvent,
  processWebhookEventById,
};
