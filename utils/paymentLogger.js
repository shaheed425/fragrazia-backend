const REDACTED_KEYS = new Set([
  "razorpay_signature",
  "signature",
  "key_secret",
  "secret",
  "webhook_secret",
  "authorization",
  "card",
  "cvv",
  "card_number",
  "number",
  "token",
  "vpa",
  "upi_id",
]);

const sanitizeMeta = (value) => {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sanitizeMeta);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (REDACTED_KEYS.has(k.toLowerCase())) {
      out[k] = "[REDACTED]";
    } else if (v && typeof v === "object") {
      out[k] = sanitizeMeta(v);
    } else {
      out[k] = v;
    }
  }
  return out;
};

const maskId = (id) => {
  if (typeof id !== "string" || id.length <= 8) return id || null;
  return `${id.slice(0, 6)}...${id.slice(-4)}`;
};

const logPaymentEvent = (level, event, details = {}) => {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...sanitizeMeta(details),
  };
  if (entry.razorpayOrderId) entry.razorpayOrderId = maskId(entry.razorpayOrderId);
  if (entry.razorpayPaymentId) entry.razorpayPaymentId = maskId(entry.razorpayPaymentId);

  const line = `[PAYMENT] ${JSON.stringify(entry)}`;
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.info(line);
  }
};

/**
 * Emits a structured high-severity alert log and optionally forwards a sanitized
 * alert notification to ALERT_WEBHOOK_URL (e.g. Slack/Discord/PagerDuty) without
 * blocking payment flows.
 */
const emitPaymentAlert = (alertType, details = {}) => {
  logPaymentEvent("error", `alert_${alertType}`, details);

  const webhookUrl = process.env.ALERT_WEBHOOK_URL;
  if (!webhookUrl || typeof fetch !== "function") return;

  const safeDetails = sanitizeMeta(details);
  if (safeDetails.razorpayOrderId) {
    safeDetails.razorpayOrderId = maskId(safeDetails.razorpayOrderId);
  }
  if (safeDetails.razorpayPaymentId) {
    safeDetails.razorpayPaymentId = maskId(safeDetails.razorpayPaymentId);
  }

  const body = JSON.stringify({
    text: `[Fragranzia Payment Alert] ${alertType}: ${safeDetails.message || safeDetails.orderId || ""}`,
    service: "frangranzia-payments",
    alertType,
    ts: new Date().toISOString(),
    details: safeDetails,
  });

  fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(3000) : undefined,
  }).catch(() => {});
};

module.exports = { logPaymentEvent, emitPaymentAlert, sanitizeMeta, maskId };
