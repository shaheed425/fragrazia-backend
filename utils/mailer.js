const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const { generateInvoicePdf } = require("./invoicePdf");

let cachedTransporter = null;

const getMailConfig = () => {
  const user = process.env.SMTP_USER || process.env.EMAIL_USER;
  const pass = process.env.SMTP_PASS || process.env.EMAIL_PASS;
  const service = process.env.SMTP_SERVICE || process.env.EMAIL_SERVICE || "";
  const host = process.env.SMTP_HOST || (service ? "" : "smtp.gmail.com");
  const port = Number(process.env.SMTP_PORT || 587);
  const secure =
    process.env.SMTP_SECURE !== undefined
      ? process.env.SMTP_SECURE === "true"
      : port === 465;
  const from =
    process.env.SMTP_FROM ||
    process.env.EMAIL_FROM ||
    (user ? `Fragranzia <${user}>` : "Fragranzia <no-reply@fragranzia.com>");

  return { user, pass, service, host, port, secure, from };
};

const getTransporter = () => {
  if (cachedTransporter) return cachedTransporter;
  const cfg = getMailConfig();

  if (!cfg.user || !cfg.pass) {
    throw new Error(
      "Email service is not configured. Please set SMTP_USER and SMTP_PASS in server/.env."
    );
  }

  const transportOptions = cfg.service
    ? {
        service: cfg.service,
        auth: { user: cfg.user, pass: cfg.pass },
      }
    : {
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        auth: { user: cfg.user, pass: cfg.pass },
      };

  cachedTransporter = nodemailer.createTransport({
    ...transportOptions,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });

  return cachedTransporter;
};

/**
 * Sends a 6-digit email verification code for account creation using Nodemailer.
 */
const sendVerificationEmail = async ({ to, name, code }) => {
  const cfg = getMailConfig();
  const transporter = getTransporter();
  const safeName = typeof name === "string" && name.trim() ? name.trim() : "Customer";

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden;">
      <div style="background: #0d2a46; color: #ffffff; padding: 20px 24px;">
        <h2 style="margin: 0; font-size: 20px;">Fragranzia</h2>
        <p style="margin: 4px 0 0; font-size: 13px; color: #cbd5e1;">Account Verification Code</p>
      </div>
      <div style="padding: 24px; color: #0f172a; line-height: 1.5;">
        <p style="margin-top: 0;">Hi ${safeName.replace(/[<>&"]/g, "")},</p>
        <p>Use the verification code below to complete your Fragranzia account registration:</p>
        <div style="margin: 22px 0; text-align: center;">
          <span style="display: inline-block; font-size: 28px; font-weight: bold; letter-spacing: 8px; padding: 12px 24px; background: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 8px; color: #0d2a46;">
            ${code}
          </span>
        </div>
        <p style="font-size: 13px; color: #475569;">
          This code expires in <strong>10 minutes</strong>. Never share it with anyone.
        </p>
        <p style="font-size: 12px; color: #64748b; margin-bottom: 0;">
          If you did not create a Fragranzia account, you can safely ignore this email.
        </p>
      </div>
    </div>
  `;

  await transporter.sendMail({
    from: cfg.from,
    to,
    subject: `${code} is your Fragranzia verification code`,
    text: `Hi ${safeName},\n\nYour Fragranzia account verification code is: ${code}\n\nThis code is valid for 10 minutes. If you did not request this, please ignore this email.`,
    html,
  });
};

// Exposed for tests or runtime config reloads
const resetMailerTransporter = () => {
  cachedTransporter = null;
};

/**
 * Sends a rich, branded order confirmation invoice email to the customer with embedded product images.
 * Uses atomic findOneAndUpdate on confirmationEmailSentAt to guarantee exactly-once dispatch.
 */
const sendOrderConfirmationEmail = async (orderIdOrDoc) => {
  let claimedId = null;
  try {
    // Explicitly ensure all referenced schemas are registered in Mongoose
    require("../models/userModel");
    require("../models/productModel");
    require("../models/addressModel");
    const Order = require("../models/orderModel");

    const orderId =
      typeof orderIdOrDoc === "string" ||
      orderIdOrDoc instanceof require("mongoose").Types.ObjectId
        ? orderIdOrDoc
        : orderIdOrDoc?._id;

    if (!orderId) return false;

    // Atomic claim to guarantee exactly-once email dispatch
    const claimed = await Order.findOneAndUpdate(
      { _id: orderId, confirmationEmailSentAt: null },
      { $set: { confirmationEmailSentAt: new Date() } },
      { returnDocument: "after" }
    )
      .populate("user", "name email")
      .populate("orderItems.product", "title name price brand images")
      .populate("shippingAddress");

    if (!claimed) {
      // Either already sent or order not found
      return false;
    }
    claimedId = claimed._id;

    const cfg = getMailConfig();
    const transporter = getTransporter();

    const customerEmail = claimed.user?.email || claimed.shippingAddress?.email;
    const adminEmail = (process.env.ADMIN_EMAIL || cfg.user || "").trim();

    const recipientSet = new Set();
    if (customerEmail) recipientSet.add(customerEmail.trim());
    if (adminEmail) recipientSet.add(adminEmail);

    if (recipientSet.size === 0) {
      console.warn(`[Mailer] No recipient email found for order ${claimed._id}`);
      return false;
    }
    const toList = Array.from(recipientSet).join(", ");

    const customerName =
      claimed.shippingAddress?.fullName || claimed.user?.name || "Customer";
    const displayId =
      claimed.orderNumber || `#${claimed._id.toString().slice(-8).toUpperCase()}`;
    const totalAmount = claimed.totalAmount ?? 0;
    const paymentMethod =
      claimed.paymentMethod === "COD"
        ? "Cash on Delivery (COD)"
        : "Online / UPI (Paid)";
    const whatsappPhone = process.env.WHATSAPP_ADMIN_PHONE || "918590315711";
    const cleanPhone = String(whatsappPhone).replace(/\D/g, "");

    const orderDate = new Date(claimed.createdAt || Date.now()).toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });

    const addr = claimed.shippingAddress;
    const addrLine = addr
      ? [addr.street, addr.city, addr.state, addr.zip ? `- ${addr.zip}` : ""].filter(Boolean).join(", ")
      : "";

    const itemsWhatsappText = (claimed.orderItems || [])
      .map((item) => {
        const prod = item.product || {};
        const pName = prod.title || prod.name || "Fragrance Item";
        const pBrand = prod.brand ? ` [${prod.brand}]` : "";
        const pSize = item.size ? ` (${item.size})` : "";
        const pQty = item.quantity || 1;
        const pPrice = (item.price ?? prod.price ?? 0) * pQty;
        return `• ${pName}${pBrand}${pSize} x${pQty} — ₹${pPrice}`;
      })
      .join("\n");

    const backendUrl = process.env.BACKEND_URL || "http://localhost:5000";
    const invoicePdfUrl = `${backendUrl}/api/order/invoice/${claimed._id}`;

    const whatsappInvoiceMsg = [
      `✨ *Official Order Invoice — Fragranzia*`,
      `Hi Fragranzia, here are my order details:`,
      ``,
      `*Order ID:* ${displayId}`,
      `*Date:* ${orderDate}`,
      `*Payment:* ${paymentMethod}`,
      `*Total Amount:* ₹${totalAmount}`,
      customerName ? `*Customer:* ${customerName}` : null,
      addr?.phone ? `*Phone:* ${addr.phone}` : null,
      addrLine ? `*Delivery Address:* ${addrLine}` : null,
      ``,
      `*Products Ordered:*`,
      itemsWhatsappText || "• Fragrance Order",
      ``,
      `📄 *Official PDF Invoice Link:*`,
      invoicePdfUrl,
      ``,
      `Please confirm dispatch & tracking updates. Thank you!`,
    ]
      .filter((line) => line !== null)
      .join("\n");

    const whatsappLink = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(whatsappInvoiceMsg)}`;

    // Process attachments for product images (inline CID embedding)
    const attachments = [];

    // Generate official PDF Tax Invoice and attach to email
    const cleanInvoiceName = `Invoice_${displayId.replace(/[^a-zA-Z0-9-_]/g, "")}.pdf`;
    const pdfBuffer = await generateInvoicePdf(claimed).catch((pdfErr) => {
      console.warn("[Mailer] PDF Invoice generation failed:", pdfErr.message);
      return null;
    });

    if (pdfBuffer) {
      attachments.push({
        filename: cleanInvoiceName,
        content: pdfBuffer,
        contentType: "application/pdf",
      });
    }
    const itemsHtml = (claimed.orderItems || [])
      .map((item, idx) => {
        const prod = item.product || {};
        const title = prod.title || prod.name || "Fragrance Item";
        const brand = prod.brand ? `<span style="display: block; font-size: 11px; color: #94a3b8; text-transform: uppercase;">${prod.brand}</span>` : "";
        const qty = item.quantity || 1;
        const price = item.price ?? prod.price ?? 0;
        const sizeStr = item.size ? ` (${item.size})` : "";

        // Check for product image to embed via CID
        let imgHtml = "";
        const imgName = Array.isArray(prod.images) && prod.images[0] ? prod.images[0] : null;
        if (imgName) {
          const localPath = path.join(__dirname, "../uploads", imgName);
          if (fs.existsSync(localPath)) {
            const cid = `prod_thumb_${idx}_${Date.now()}`;
            attachments.push({
              filename: imgName,
              path: localPath,
              cid,
            });
            imgHtml = `<td style="padding: 12px; width: 64px; vertical-align: middle; border-bottom: 1px solid #f1f5f9;"><img src="cid:${cid}" alt="${title}" style="width: 56px; height: 56px; object-fit: cover; border-radius: 8px; border: 1px solid #e2e8f0; display: block;" /></td>`;
          } else if (imgName.startsWith("http")) {
            imgHtml = `<td style="padding: 12px; width: 64px; vertical-align: middle; border-bottom: 1px solid #f1f5f9;"><img src="${imgName}" alt="${title}" style="width: 56px; height: 56px; object-fit: cover; border-radius: 8px; border: 1px solid #e2e8f0; display: block;" /></td>`;
          }
        }

        return `
          <tr>
            ${imgHtml || `<td style="padding: 12px; width: 64px; vertical-align: middle; border-bottom: 1px solid #f1f5f9;"><div style="width: 56px; height: 56px; border-radius: 8px; background: #f8fafc; border: 1px solid #e2e8f0; text-align: center; line-height: 56px; font-size: 20px;">🧴</div></td>`}
            <td style="padding: 12px 14px; border-bottom: 1px solid #f1f5f9; vertical-align: middle;">
              ${brand}
              <strong style="color: #0f172a; font-size: 14px;">${title}</strong>${sizeStr}
              <span style="display: block; color: #64748b; font-size: 12px; margin-top: 2px;">Unit Price: ₹${price}</span>
            </td>
            <td style="padding: 12px 14px; border-bottom: 1px solid #f1f5f9; text-align: center; color: #475569; font-size: 14px; font-weight: 600; vertical-align: middle;">
              ${qty}
            </td>
            <td style="padding: 12px 14px; border-bottom: 1px solid #f1f5f9; text-align: right; color: #0d2a46; font-size: 15px; font-weight: bold; vertical-align: middle;">
              ₹${price * qty}
            </td>
          </tr>
        `;
      })
      .join("");

    const addrHtml = addr
      ? `${addr.fullName || ""}<br>${addr.street || ""}, ${addr.city || ""}, ${
          addr.state || ""
        } - ${addr.zip || ""}<br>Phone: ${addr.phone || ""}`
      : "Address details in your account";

    const html = `
      <div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 620px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
        <!-- Header -->
        <div style="background: #0d2a46; color: #ffffff; padding: 32px 24px; text-align: center;">
          <h1 style="margin: 0; font-size: 26px; letter-spacing: 3px; text-transform: uppercase; font-family: Georgia, serif; font-weight: 700;">FRAGRANZIA</h1>
          <p style="margin: 6px 0 0; font-size: 12px; color: #94a3b8; letter-spacing: 2px; text-transform: uppercase;">Haute Parfumerie • Official Invoice</p>
        </div>

        <div style="padding: 28px 24px; color: #1e293b; line-height: 1.6;">
          <!-- Status Banner -->
          <div style="background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 8px; padding: 16px 20px; margin-bottom: 20px;">
            <p style="margin: 0; font-size: 16px; color: #065f46; font-weight: bold;">
              ✓ Order Confirmed — ${displayId}
            </p>
            <p style="margin: 4px 0 0; font-size: 13px; color: #047857;">
              Thank you for shopping with Fragranzia, ${customerName}! Your luxury fragrance order is confirmed and being prepared for dispatch.
            </p>
          </div>

          <!-- PDF Attached Notice -->
          <div style="background: #f8fafc; border: 1.5px dashed #94a3b8; border-radius: 8px; padding: 12px 18px; margin-bottom: 24px;">
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="width: 36px; vertical-align: middle; font-size: 24px;">📄</td>
                <td style="vertical-align: middle;">
                  <strong style="color: #0d2a46; font-size: 13.5px; display: block;">Official Tax Invoice (PDF) Attached</strong>
                  <span style="color: #64748b; font-size: 12px;">A complete, printable PDF copy is attached to this email (${cleanInvoiceName}).</span>
                </td>
              </tr>
            </table>
          </div>

          <!-- Invoice Metadata -->
          <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 13px; color: #475569;">
            <tr>
              <td style="padding: 6px 0;"><strong>Invoice / Order Ref:</strong> ${displayId}</td>
              <td style="padding: 6px 0; text-align: right;"><strong>Date:</strong> ${orderDate}</td>
            </tr>
            <tr>
              <td style="padding: 6px 0;"><strong>Payment Method:</strong> ${paymentMethod}</td>
              <td style="padding: 6px 0; text-align: right;"><strong>Status:</strong> <span style="color: #059669; font-weight: bold;">Paid & Confirmed</span></td>
            </tr>
          </table>

          <!-- Items Table with Product Images -->
          <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
            <thead>
              <tr style="background: #f8fafc; border-top: 1px solid #e2e8f0; border-bottom: 2px solid #e2e8f0;">
                <th style="padding: 10px 12px; text-align: left; font-size: 12px; font-weight: bold; color: #64748b; text-transform: uppercase;" colspan="2">Item</th>
                <th style="padding: 10px 12px; text-align: center; font-size: 12px; font-weight: bold; color: #64748b; text-transform: uppercase;">Qty</th>
                <th style="padding: 10px 12px; text-align: right; font-size: 12px; font-weight: bold; color: #64748b; text-transform: uppercase;">Total</th>
              </tr>
            </thead>
            <tbody>
              ${itemsHtml}
            </tbody>
            <tfoot>
              <tr style="border-top: 2px solid #e2e8f0;">
                <td colspan="3" style="padding: 14px 12px 6px; text-align: right; font-weight: bold; font-size: 15px; color: #0d2a46;">Grand Total:</td>
                <td style="padding: 14px 12px 6px; text-align: right; font-weight: bold; font-size: 18px; color: #0d2a46;">₹${totalAmount}</td>
              </tr>
            </tfoot>
          </table>

          <!-- Delivery Address -->
          <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px 18px; margin-bottom: 24px; font-size: 13px; color: #475569;">
            <p style="margin: 0 0 6px; font-weight: bold; color: #0f172a; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px;">Delivery Address</p>
            <div style="line-height: 1.6;">${addrHtml}</div>
          </div>

          <!-- WhatsApp Chat Button -->
          <div style="text-align: center; margin-top: 28px; padding-top: 20px; border-top: 1px solid #e2e8f0;">
            <p style="margin: 0 0 12px; font-size: 13px; color: #64748b;">Need tracking or instant assistance?</p>
            <a href="${whatsappLink}" style="display: inline-block; background: #25D366; color: #ffffff; text-decoration: none; padding: 12px 26px; border-radius: 8px; font-weight: bold; font-size: 14px; box-shadow: 0 2px 4px rgba(37,211,102,0.25);">
              💬 Chat with Fragranzia on WhatsApp
            </a>
          </div>
        </div>

        <!-- Footer -->
        <div style="background: #f8fafc; padding: 18px; text-align: center; font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9;">
          Fragranzia Haute Parfumerie • Handcrafted Luxury Perfumes • All rights reserved
        </div>
      </div>
    `;

    await transporter.sendMail({
      from: cfg.from,
      to: toList,
      subject: `Order Invoice: ${displayId} (₹${totalAmount}) - Fragranzia`,
      text: `Hi ${customerName},\n\nThank you for shopping at Fragranzia!\n\nOrder Ref: ${displayId}\nDate: ${orderDate}\nTotal Amount: ₹${totalAmount}\nPayment: ${paymentMethod}\n\nFor instant tracking or updates, message us on WhatsApp: ${whatsappLink}`,
      html,
      attachments,
    });

    console.log(
      `[Mailer] Order confirmation invoice email with product images successfully sent to [${toList}] for order ${claimed._id}`
    );
    return true;
  } catch (error) {
    console.error("[Mailer] Failed to send order confirmation email:", error.message);
    if (claimedId) {
      try {
        const Order = require("../models/orderModel");
        await Order.findByIdAndUpdate(claimedId, { confirmationEmailSentAt: null });
      } catch {}
    }
    return false;
  }
};

module.exports = {
  getTransporter,
  sendVerificationEmail,
  sendOrderConfirmationEmail,
  resetMailerTransporter,
};

