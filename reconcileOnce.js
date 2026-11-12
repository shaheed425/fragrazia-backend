const os = require("os");
const mongoose = require("mongoose");
require("dotenv").config();

const { runPendingReconciliationPass } = require("./services/reconciliationService");
const { logPaymentEvent, emitPaymentAlert } = require("./utils/paymentLogger");

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
const CRON_WORKER_ID = `cron-${os.hostname()}-${process.pid}`;

(async () => {
  if (!MONGO_URI) {
    console.error("FATAL: MONGODB_URI / MONGO_URI is not configured.");
    process.exit(1);
  }

  try {
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 10_000,
      socketTimeoutMS: 45_000,
    });

    const summary = await runPendingReconciliationPass({
      ignoreBackoff: process.env.CRON_IGNORE_BACKOFF === "true",
      workerId: CRON_WORKER_ID,
      mode: "cron",
    });

    logPaymentEvent("info", "cron_reconciliation_finished", {
      workerId: CRON_WORKER_ID,
      ...summary,
    });

    await mongoose.connection.close(false);
    process.exit(summary?.error ? 1 : 0);
  } catch (err) {
    emitPaymentAlert("cron_reconciliation_failed", {
      workerId: CRON_WORKER_ID,
      errorMessage: err?.message,
    });
    await mongoose.connection.close(false).catch(() => {});
    process.exit(1);
  }
})();

