const fs = require("fs");
const path = require("path");
require("../models/productModel");
require("../models/addressModel");
require("../models/userModel");
const Order = require("../models/orderModel");
const { logPaymentEvent } = require("./paymentLogger");

const DEFAULT_API_VERSION = "v21.0";
const WHATSAPP_TIMEOUT_MS = 10_000;

const getWhatsAppConfig = () => {
  const accessToken = (process.env.WHATSAPP_CLOUD_ACCESS_TOKEN || "").trim();
  const phoneNumberId = (process.env.WHATSAPP_PHONE_NUMBER_ID || "").trim();
  const apiVersion = (process.env.WHATSAPP_API_VERSION || DEFAULT_API_VERSION).trim();
  const adminPhonesRaw = (process.env.WHATSAPP_ADMIN_PHONE || "").trim();
  const adminPhones = adminPhonesRaw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  return {
    accessToken,
    phoneNumberId,
    apiVersion,
    adminPhones,
    customerEnabled: process.env.WHATSAPP_CUSTOMER_ENABLED !== "false",
    adminTemplate: (process.env.WHATSAPP_ADMIN_TEMPLATE || "").trim(),
    customerTemplate: (process.env.WHATSAPP_CUSTOMER_TEMPLATE || "").trim(),
    templateLang: (process.env.WHATSAPP_TEMPLATE_LANG || "en").trim(),
    defaultCountryCode: (process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || "91").replace(/\D/g, "") || "91",
  };
};

const isWhatsAppConfigured = () => {
  const cfg = getWhatsAppConfig();
  return Boolean(cfg.accessToken && cfg.phoneNumberId);
};

/**
 * Normalizes phone inputs like "+91 98765-43210" or "09876543210" into Meta Cloud API format ("919876543210").
 */
const normalizeWhatsAppPhone = (rawPhone, defaultCountryCode = "91") => {
  if (!rawPhone || typeof rawPhone !== "string") return "";
  let digits = rawPhone.replace(/\D/g, "");
  if (!digits) return "";

  if (digits.startsWith("00")) {
    digits = digits.slice(2);
  }
  if (digits.length === 11 && digits.startsWith("0")) {
    digits = digits.slice(1);
  }
  if (digits.length === 10) {
    digits = `${defaultCountryCode}${digits}`;
  }
  return digits.length >= 11 && digits.length <= 15 ? digits : "";
};

const formatOrderItemsSummary = (orderItems = []) => {
  if (!Array.isArray(orderItems) || orderItems.length === 0) return "Fragrance Order";
  const backendBase =
    process.env.BACKEND_URL && !process.env.BACKEND_URL.includes("localhost")
      ? process.env.BACKEND_URL.replace(/\/+$/, "")
      : process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`.replace(/\/+$/, "")
      : process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`.replace(/\/+$/, "")
      : "https://fragrazia-backend.vercel.app";
  return orderItems
    .map((item) => {
      const prod = item?.product || {};
      const name = prod.title || prod.name || "Perfume";
      const brand = prod.brand ? ` [${prod.brand}]` : "";
      const size = item?.size ? ` (${item.size})` : "";
      const qty = Number(item?.quantity) || 1;
      const unitPrice = Number(item?.price) || Number(prod.price) || 0;
      const lineTotal = unitPrice * qty;
      const img = Array.isArray(prod.images) && prod.images[0] ? prod.images[0] : null;
      const imgUrl = img ? (img.startsWith("http") ? img : `${backendBase}/uploads/${img}`) : "";

      return [
        `• *${name}*${brand}${size}`,
        `  Qty: ${qty} × ₹${unitPrice} = *₹${lineTotal}*`,
        imgUrl ? `  Image: ${imgUrl}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
};

const buildAdminOrderText = (order) => {
  const addr = order.shippingAddress || {};
  const customerName = addr.fullName || order.user?.name || "Customer";
  const customerPhone = addr.phone || "N/A";
  const orderRef = order.orderNumber || `#${String(order._id).slice(-8).toUpperCase()}`;
  const paymentLine =
    order.paymentMethod === "UPI"
      ? `UPI (${order.paymentStatus || "Paid"})`
      : `Cash on Delivery (${order.paymentStatus || "Pending"})`;
  const addressLine = [addr.street, addr.city, addr.state, addr.zip]
    .filter(Boolean)
    .join(", ");

  return [
    `🛍️ *New Order Received — Fragranzia*`,
    `Order ID: *${orderRef}*`,
    `Amount: *₹${order.totalAmount ?? 0}*`,
    `Payment: ${paymentLine}`,
    ``,
    `*Customer:* ${customerName}`,
    `*Phone:* ${customerPhone}`,
    addressLine ? `*Address:* ${addressLine}` : null,
    ``,
    `*Items:*`,
    formatOrderItemsSummary(order.orderItems),
  ]
    .filter((line) => line !== null)
    .join("\n");
};

const buildCustomerOrderText = (order) => {
  const addr = order.shippingAddress || {};
  const customerName = addr.fullName || order.user?.name || "Valued Customer";
  const orderRef = order.orderNumber || `#${String(order._id).slice(-8).toUpperCase()}`;
  const paymentNote =
    order.paymentMethod === "UPI"
      ? `UPI payment received (Paid)`
      : `Cash on Delivery (Pay ₹${order.totalAmount ?? 0} on delivery)`;

  return [
    `✨ *Order Confirmed — Fragranzia*`,
    `Hi ${customerName}, thank you for shopping with Fragranzia!`,
    ``,
    `Order ID: *${orderRef}*`,
    `Total Amount: *₹${order.totalAmount ?? 0}*`,
    `Payment: ${paymentNote}`,
    ``,
    `*Items Ordered:*`,
    formatOrderItemsSummary(order.orderItems),
    ``,
    `We will pack and dispatch your fragrance shortly.`,
  ].join("\n");
};

const buildTemplatePayload = (to, templateName, cfg, bodyParams = []) => {
  const isHelloWorld = templateName === "hello_world";
  const languageCode = isHelloWorld ? "en_US" : cfg.templateLang || "en";

  const template = {
    name: templateName,
    language: { code: languageCode },
  };

  if (!isHelloWorld && Array.isArray(bodyParams) && bodyParams.length > 0) {
    template.components = [
      {
        type: "body",
        parameters: bodyParams.map((val) => ({
          type: "text",
          text: String(val ?? "").slice(0, 500),
        })),
      },
    ];
  }

  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template,
  };
};

const sendMetaWhatsAppPayload = async (payload, cfg) => {
  const endpoint = `https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WHATSAPP_TIMEOUT_MS);

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const apiMsg = data?.error?.message || `HTTP ${res.status}`;
      const apiCode = data?.error?.code;
      const err = new Error(apiCode ? `(${apiCode}) ${apiMsg}` : apiMsg);
      err.status = res.status;
      err.meta = data?.error;
      throw err;
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
};

/**
 * Uploads a local product image file directly to Meta WhatsApp Media API.
 * Returns media ID string on success, or null if file missing / upload failed.
 */
const uploadMediaToWhatsApp = async (filePath, cfg) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;

    const fileBuffer = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeType =
      ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
    const blob = new Blob([fileBuffer], { type: mimeType });
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("file", blob, path.basename(filePath));

    const endpoint = `https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/media`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.accessToken}`,
      },
      body: form,
    });

    const data = await res.json().catch(() => ({}));
    if (res.ok && data?.id) {
      return data.id;
    }
    console.warn("[WhatsApp] Media upload failed:", data?.error?.message);
    return null;
  } catch (err) {
    console.warn("[WhatsApp] Media upload exception:", err.message);
    return null;
  }
};

/**
 * Uploads a generated PDF buffer directly to Meta WhatsApp Media API as an application/pdf document.
 * Returns media ID string on success, or null if failed.
 */
const uploadPdfBufferToWhatsApp = async (pdfBuffer, fileName, cfg) => {
  try {
    if (!pdfBuffer || !pdfBuffer.length) return null;

    const blob = new Blob([pdfBuffer], { type: "application/pdf" });
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("file", blob, fileName);

    const endpoint = `https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/media`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.accessToken}`,
      },
      body: form,
    });

    const data = await res.json().catch(() => ({}));
    if (res.ok && data?.id) {
      return data.id;
    }
    console.warn("[WhatsApp] PDF media upload failed:", data?.error?.message);
    return null;
  } catch (err) {
    console.warn("[WhatsApp] PDF media upload exception:", err.message);
    return null;
  }
};

const sendWhatsAppToRecipient = async ({
  to,
  textBody,
  mediaId,
  documentMediaId,
  documentFileName,
  templateName,
  templateParams,
  roleLabel,
}) => {
  const cfg = getWhatsAppConfig();
  const normalizedTo = normalizeWhatsAppPhone(to, cfg.defaultCountryCode);

  if (!normalizedTo) {
    return { skipped: true, reason: "invalid_phone" };
  }

  const payload = templateName
    ? buildTemplatePayload(normalizedTo, templateName, cfg, templateParams)
    : documentMediaId
    ? {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: normalizedTo,
        type: "document",
        document: {
          id: documentMediaId,
          filename: documentFileName || "Invoice.pdf",
          caption: textBody.slice(0, 1024),
        },
      }
    : mediaId
    ? {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: normalizedTo,
        type: "image",
        image: {
          id: mediaId,
          caption: textBody.slice(0, 1024),
        },
      }
    : {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: normalizedTo,
        type: "text",
        text: {
          preview_url: false,
          body: textBody,
        },
      };

  const result = await sendMetaWhatsAppPayload(payload, cfg);
  logPaymentEvent("info", "whatsapp_notification_sent", {
    recipientRole: roleLabel,
    toSuffix: normalizedTo.slice(-4),
    messageId: result?.messages?.[0]?.id || null,
    mode: templateName ? "template" : documentMediaId ? "document" : mediaId ? "image" : "text",
  });
  return { sent: true, messageId: result?.messages?.[0]?.id || null };
};

/**
 * Idempotently notifies Store Owner(s) and Customer via Meta WhatsApp Cloud API once an order is confirmed.
 * Safe to call without awaiting on checkout paths so transient WhatsApp errors never fail order creation.
 */
const notifyOrderPlacedWhatsApp = async (orderId) => {
  if (!orderId) return { skipped: true, reason: "missing_order_id" };
  if (!isWhatsAppConfigured()) {
    logPaymentEvent("info", "whatsapp_skipped_unconfigured", {
      orderId: String(orderId),
    });
    return { skipped: true, reason: "unconfigured" };
  }

  const cfg = getWhatsAppConfig();

  // Atomically claim notification slot so webhook + verify + worker never send duplicate alerts
  const claimed = await Order.findOneAndUpdate(
    { _id: orderId, whatsappNotifiedAt: null },
    { $set: { whatsappNotifiedAt: new Date() } },
    { returnDocument: "after" }
  );

  if (!claimed) {
    return { skipped: true, reason: "already_notified" };
  }

  const order = await Order.findById(orderId)
    .populate("orderItems.product", "name title brand price images")
    .populate("shippingAddress")
    .populate("user", "name email");

  if (!order) {
    return { skipped: true, reason: "order_not_found" };
  }

  const orderRef = order.orderNumber || `#${String(order._id).slice(-8).toUpperCase()}`;
  const addr = order.shippingAddress || {};
  const customerName = addr.fullName || order.user?.name || "Customer";
  const amountText = `₹${order.totalAmount ?? 0}`;
  const itemsInline = (order.orderItems || [])
    .map((i) => `${i?.product?.name || "Perfume"}${i?.size ? ` ${i.size}` : ""} x${i?.quantity || 1}`)
    .join(", ");

  // Generate official PDF Tax Invoice and upload directly to Meta Media API as a WhatsApp Document
  const { generateInvoicePdf } = require("./invoicePdf");
  const pdfBuffer = await generateInvoicePdf(order).catch(() => null);
  const documentFileName = `Invoice_${(order.orderNumber || order._id)
    .toString()
    .replace(/[^a-zA-Z0-9-_]/g, "")}.pdf`;
  let documentMediaId = null;
  if (pdfBuffer) {
    documentMediaId = await uploadPdfBufferToWhatsApp(pdfBuffer, documentFileName, cfg);
  }

  // Upload product image to Meta Media API as fallback / media
  let mediaId = null;
  for (const item of order.orderItems || []) {
    const imgName = Array.isArray(item.product?.images) && item.product.images[0];
    if (imgName) {
      const fullPath = path.join(__dirname, "../uploads", imgName);
      mediaId = await uploadMediaToWhatsApp(fullPath, cfg);
      if (mediaId) break;
    }
  }

  const tasks = [];

  for (const adminPhone of cfg.adminPhones) {
    tasks.push(
      sendWhatsAppToRecipient({
        to: adminPhone,
        textBody: buildAdminOrderText(order),
        mediaId,
        documentMediaId,
        documentFileName,
        templateName: cfg.adminTemplate,
        templateParams: [orderRef, customerName, amountText, itemsInline || "Fragrance"],
        roleLabel: "admin",
      }).catch((err) => {
        logPaymentEvent("error", "whatsapp_notification_failed", {
          orderId: String(order._id),
          recipientRole: "admin",
          errorMessage: err.message,
        });
        return { sent: false, error: err.message };
      })
    );
  }

  if (cfg.customerEnabled && addr.phone) {
    tasks.push(
      sendWhatsAppToRecipient({
        to: addr.phone,
        textBody: buildCustomerOrderText(order),
        templateName: cfg.customerTemplate,
        templateParams: [customerName, orderRef, amountText, order.paymentMethod || "COD"],
        roleLabel: "customer",
      }).catch((err) => {
        logPaymentEvent("error", "whatsapp_notification_failed", {
          orderId: String(order._id),
          recipientRole: "customer",
          errorMessage: err.message,
        });
        return { sent: false, error: err.message };
      })
    );
  }

  if (tasks.length === 0) {
    logPaymentEvent("warn", "whatsapp_no_recipients", {
      orderId: String(order._id),
    });
    return { skipped: true, reason: "no_recipients" };
  }

  const outcomes = await Promise.all(tasks);
  return { completed: true, outcomes };
};

module.exports = {
  isWhatsAppConfigured,
  normalizeWhatsAppPhone,
  notifyOrderPlacedWhatsApp,
};

