const os = require("os");
const mongoose = require("mongoose");
const Order = require("../models/orderModel");
const { WebhookEvent, WorkerHeartbeat } = require("../models/paymentModel");
const {
  LOCK_STALE_MS,
  WEBHOOK_LEASE_MS,
  MAX_WEBHOOK_ATTEMPTS,
  reconcileOrderWithGateway,
  processWebhookEventById,
} = require("./paymentRecoveryService");
const { logPaymentEvent, emitPaymentAlert } = require("../utils/paymentLogger");

let activePassPromise = null;
let stopRequested = false;
let timers = { initialTimer: null, recurringTimer: null };

const isMongoReady = () => mongoose.connection && mongoose.connection.readyState === 1;

const upsertWorkerHeartbeat = async ({
  workerId,
  mode = "worker",
  status = "healthy",
  ordersChecked = 0,
  webhooksRecovered = 0,
  lastError = null,
}) => {
  if (!workerId || !isMongoReady()) return;
  try {
    await WorkerHeartbeat.findOneAndUpdate(
      { workerId },
      {
        $set: {
          mode,
          status,
          lastHeartbeatAt: new Date(),
          lastPassAt: new Date(),
          lastOrdersChecked: ordersChecked,
          lastWebhooksRecovered: webhooksRecovered,
          lastError,
        },
      },
      { upsert: true, setDefaultsOnInsert: true }
    );
  } catch {
    // Heartbeat write failure must never break reconciliation
  }
};

/**
 * Processes queued/failed webhook inbox events and recovers abandoned "processing"
 * leases left behind if a Render worker crashed or restarted mid-flight.
 */
const runWebhookInboxPass = async ({
  workerId = `${os.hostname()}-${process.pid}`,
  ignoreBackoff = false,
  limit = 25,
} = {}) => {
  if (!isMongoReady()) {
    return { webhooksRecovered: 0, skipped: true, reason: "mongo_unavailable" };
  }

  const now = new Date();
  const staleLeaseCutoff = new Date(now.getTime() - WEBHOOK_LEASE_MS);

  const candidates = await WebhookEvent.find({
    processingAttempts: { $lt: MAX_WEBHOOK_ATTEMPTS },
    $or: [
      {
        status: { $in: ["queued", "failed"] },
        ...(ignoreBackoff
          ? {}
          : { $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] }),
      },
      {
        status: "processing",
        lockedAt: { $lt: staleLeaseCutoff },
      },
    ],
  })
    .sort({ createdAt: 1 })
    .limit(limit)
    .select("_id");

  let webhooksRecovered = 0;
  for (const wh of candidates) {
    if (stopRequested) break;
    const processed = await processWebhookEventById(wh._id, { workerId });
    if (processed) {
      webhooksRecovered += 1;
    }
  }

  return { webhooksRecovered };
};

/**
 * Recovers queued/failed webhook events and unresolved payment attempts using
 * MongoDB atomic leases and bounded exponential backoff.
 */
const runPendingReconciliationPass = async ({
  ignoreBackoff = false,
  workerId = `${os.hostname()}-${process.pid}`,
  mode = "worker",
} = {}) => {
  if (activePassPromise) return { skipped: true };
  if (!isMongoReady()) {
    logPaymentEvent("warn", "reconciliation_skipped_mongo_unavailable", { workerId, mode });
    return { skipped: true, reason: "mongo_unavailable" };
  }

  activePassPromise = (async () => {
    try {
      // 1. Recover queued, retriable, or lease-expired webhook inbox events
      const { webhooksRecovered } = await runWebhookInboxPass({
        workerId,
        ignoreBackoff,
      });

      if (stopRequested) {
        await upsertWorkerHeartbeat({ workerId, mode, ordersChecked: 0, webhooksRecovered });
        return { checked: 0, webhooksRecovered };
      }

      // 2. Find unresolved UPI orders due for reconciliation
      const now = new Date();
      const cutoff = new Date(now.getTime() - 72 * 60 * 60 * 1000);
      const staleLockCutoff = new Date(now.getTime() - LOCK_STALE_MS);

      const query = {
        paymentMethod: "UPI",
        paymentState: { $in: ["CREATED", "PENDING", "AUTHORIZED", "REFUND_PENDING"] },
        paymentStatus: { $nin: ["Paid", "Refunded"] },
        razorpay_order_id: { $exists: true, $ne: null },
        createdAt: { $gte: cutoff },
        $and: [
          { $or: [{ reconcileLockedAt: null }, { reconcileLockedAt: { $lt: staleLockCutoff } }] },
          ...(ignoreBackoff
            ? []
            : [{ $or: [{ nextReconcileAt: null }, { nextReconcileAt: { $lte: now } }] }]),
        ],
      };

      const candidateIds = await Order.find(query)
        .sort({ nextReconcileAt: 1, lastPaymentCheckAt: 1, createdAt: 1 })
        .limit(25)
        .select("_id");

      let ordersChecked = 0;
      for (const candidate of candidateIds) {
        if (stopRequested) break;

        const locked = await Order.findOneAndUpdate(
          {
            _id: candidate._id,
            $or: [{ reconcileLockedAt: null }, { reconcileLockedAt: { $lt: staleLockCutoff } }],
          },
          { $set: { reconcileLockedAt: new Date() } },
          { returnDocument: "after" }
        );
        if (!locked) continue;

        try {
          const outcome = await reconcileOrderWithGateway(locked._id, { source: "reconciler" });
          ordersChecked += 1;
          if (outcome?.order?.paymentState === "REQUIRES_REVIEW") {
            emitPaymentAlert("reconciliation_requires_review", {
              orderId: locked._id.toString(),
              orderNumber: outcome.order.orderNumber,
              reason: outcome.order.requiresReviewReason,
            });
          }
        } finally {
          await Order.findByIdAndUpdate(locked._id, {
            $set: { reconcileLockedAt: null },
          }).catch(() => {});
        }
      }

      await upsertWorkerHeartbeat({
        workerId,
        mode,
        status: "healthy",
        ordersChecked,
        webhooksRecovered,
      });

      if (ordersChecked > 0 || webhooksRecovered > 0) {
        logPaymentEvent("info", "background_reconciliation_pass", {
          workerId,
          mode,
          ordersChecked,
          webhooksRecovered,
        });
      }

      return { checked: ordersChecked, webhooksRecovered };
    } catch (err) {
      logPaymentEvent("error", "background_reconciliation_failed", {
        workerId,
        mode,
        errorMessage: err?.message || "Unknown worker error",
      });
      await upsertWorkerHeartbeat({
        workerId,
        mode,
        status: "degraded",
        lastError: err?.message || "Unknown worker error",
      });
      return { error: err?.message };
    } finally {
      activePassPromise = null;
    }
  })();

  return activePassPromise;
};

const startPaymentReconciliationJob = (
  intervalMs = Number(process.env.RECONCILIATION_INTERVAL_MS || 60_000),
  { mode = "web_reconciler" } = {}
) => {
  stopRequested = false;
  const workerId = `${os.hostname()}-${process.pid}-${mode}`;

  timers.initialTimer = setTimeout(() => {
    runPendingReconciliationPass({ ignoreBackoff: true, workerId, mode });
  }, 4000);
  if (typeof timers.initialTimer.unref === "function") timers.initialTimer.unref();

  timers.recurringTimer = setInterval(() => {
    runPendingReconciliationPass({ workerId, mode });
  }, intervalMs);
  if (typeof timers.recurringTimer.unref === "function") timers.recurringTimer.unref();

  return timers;
};

const stopPaymentReconciliationJob = async (timeoutMs = 20_000) => {
  stopRequested = true;
  if (timers.initialTimer) clearTimeout(timers.initialTimer);
  if (timers.recurringTimer) clearInterval(timers.recurringTimer);
  timers = { initialTimer: null, recurringTimer: null };

  if (activePassPromise) {
    await Promise.race([
      activePassPromise.catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }
  stopRequested = false;
};

module.exports = {
  runWebhookInboxPass,
  runPendingReconciliationPass,
  startPaymentReconciliationJob,
  stopPaymentReconciliationJob,
  upsertWorkerHeartbeat,
};
