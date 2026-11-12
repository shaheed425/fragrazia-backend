const os = require("os");
const mongoose = require("mongoose");
require("dotenv").config();

const {
  runWebhookInboxPass,
  runPendingReconciliationPass,
  stopPaymentReconciliationJob,
  upsertWorkerHeartbeat,
} = require("./services/reconciliationService");
const { logPaymentEvent, emitPaymentAlert } = require("./utils/paymentLogger");

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
const WORKER_ID = `worker-${os.hostname()}-${process.pid}`;
const WEBHOOK_POLL_MS = Math.max(2000, Number(process.env.WORKER_WEBHOOK_POLL_MS || 5000));
const RECONCILE_INTERVAL_MS = Math.max(
  10_000,
  Number(process.env.WORKER_RECONCILE_INTERVAL_MS || 30_000)
);

if (!MONGO_URI) {
  console.error("FATAL: MONGODB_URI / MONGO_URI is required for the Render Background Worker.");
  process.exit(1);
}

let shuttingDown = false;
let webhookLoopTimer = null;
let reconcileLoopTimer = null;
let lastReconcileAt = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const connectMongoWithRetry = async () => {
  let attempt = 0;
  while (!shuttingDown) {
    attempt += 1;
    try {
      await mongoose.connect(MONGO_URI, {
        serverSelectionTimeoutMS: 10_000,
        socketTimeoutMS: 45_000,
        maxPoolSize: 10,
      });
      logPaymentEvent("info", "worker_mongo_connected", { workerId: WORKER_ID, attempt });
      return;
    } catch (err) {
      const delayMs = Math.min(30_000, 2000 * attempt);
      logPaymentEvent("error", "worker_mongo_connect_failed", {
        workerId: WORKER_ID,
        attempt,
        retryInMs: delayMs,
        errorMessage: err?.message,
      });
      if (attempt === 5) {
        emitPaymentAlert("worker_mongo_outage", {
          workerId: WORKER_ID,
          message: `Worker failed to connect to MongoDB after ${attempt} attempts`,
        });
      }
      await sleep(delayMs);
    }
  }
};

const runWorkerCycle = async () => {
  if (shuttingDown) return;

  if (mongoose.connection.readyState !== 1) {
    logPaymentEvent("warn", "worker_waiting_for_mongo", { workerId: WORKER_ID });
    return;
  }

  const now = Date.now();
  if (now - lastReconcileAt >= RECONCILE_INTERVAL_MS) {
    lastReconcileAt = now;
    await runPendingReconciliationPass({
      ignoreBackoff: false,
      workerId: WORKER_ID,
      mode: "worker",
    });
    return;
  }

  const { webhooksRecovered } = await runWebhookInboxPass({
    workerId: WORKER_ID,
    ignoreBackoff: false,
  });
  await upsertWorkerHeartbeat({
    workerId: WORKER_ID,
    mode: "worker",
    status: "healthy",
    webhooksRecovered,
  });
};

const scheduleNextCycle = () => {
  if (shuttingDown) return;
  webhookLoopTimer = setTimeout(async () => {
    try {
      await runWorkerCycle();
    } catch (err) {
      logPaymentEvent("error", "worker_cycle_error", {
        workerId: WORKER_ID,
        errorMessage: err?.message,
      });
    } finally {
      scheduleNextCycle();
    }
  }, WEBHOOK_POLL_MS);
};

const gracefulShutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logPaymentEvent("info", "worker_shutdown_initiated", { workerId: WORKER_ID, signal });

  if (webhookLoopTimer) clearTimeout(webhookLoopTimer);
  if (reconcileLoopTimer) clearInterval(reconcileLoopTimer);

  await stopPaymentReconciliationJob(25_000);
  await upsertWorkerHeartbeat({
    workerId: WORKER_ID,
    mode: "worker",
    status: "stopped",
  });

  await mongoose.connection.close(false).catch(() => {});
  logPaymentEvent("info", "worker_shutdown_complete", { workerId: WORKER_ID, signal });
  process.exit(0);
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

(async () => {
  mongoose.connection.on("disconnected", () => {
    if (!shuttingDown) {
      logPaymentEvent("warn", "worker_mongo_disconnected", { workerId: WORKER_ID });
    }
  });
  mongoose.connection.on("reconnected", () => {
    logPaymentEvent("info", "worker_mongo_reconnected", { workerId: WORKER_ID });
  });

  await connectMongoWithRetry();
  if (shuttingDown) return;

  // Immediate startup catch-up pass (ignores backoff to recover outage backlog right away)
  lastReconcileAt = Date.now();
  await runPendingReconciliationPass({
    ignoreBackoff: true,
    workerId: WORKER_ID,
    mode: "worker",
  });

  scheduleNextCycle();
})();

