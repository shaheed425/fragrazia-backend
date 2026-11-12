const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

/**
 * Generates an elegant, luxury A4 PDF invoice for an order.
 * Returns a Buffer containing the complete PDF binary.
 */
const generateInvoicePdf = (order) => {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 40 });
      const buffers = [];

      doc.on("data", (chunk) => buffers.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(buffers)));
      doc.on("error", (err) => reject(err));

      const displayId =
        order.orderNumber || `#${String(order._id || "").slice(-8).toUpperCase()}`;
      const addr = order.shippingAddress || {};
      const customerName = addr.fullName || order.user?.name || "Customer";
      const customerPhone = addr.phone || "N/A";
      const customerEmail = order.user?.email || addr.email || "N/A";
      const paymentMethod =
        order.paymentMethod === "UPI" ? "Online / UPI (Paid)" : "Cash on Delivery (COD)";
      const orderDate = new Date(order.createdAt || Date.now()).toLocaleDateString(
        "en-IN",
        { day: "numeric", month: "short", year: "numeric" }
      );

      // --- Header Banner ---
      doc.rect(0, 0, doc.page.width, 100).fill("#0d2a46");

      doc
        .fillColor("#ffffff")
        .fontSize(22)
        .font("Helvetica-Bold")
        .text("FRAGRANZIA", 40, 30, { characterSpacing: 2 });

      doc
        .fontSize(9)
        .font("Helvetica")
        .fillColor("#94a3b8")
        .text("HAUTE PARFUMERIE • OFFICIAL TAX INVOICE", 40, 58, { characterSpacing: 1.5 });

      doc
        .fontSize(10)
        .font("Helvetica-Bold")
        .fillColor("#ffffff")
        .text(`INVOICE: ${displayId}`, doc.page.width - 240, 35, {
          width: 200,
          align: "right",
        });

      doc
        .fontSize(9)
        .font("Helvetica")
        .fillColor("#cbd5e1")
        .text(`Date: ${orderDate}`, doc.page.width - 240, 52, {
          width: 200,
          align: "right",
        });

      doc
        .fontSize(9)
        .font("Helvetica")
        .fillColor("#34d399")
        .text("STATUS: CONFIRMED", doc.page.width - 240, 68, {
          width: 200,
          align: "right",
        });

      // --- Billing & Shipping Info ---
      let y = 125;

      doc
        .fillColor("#0d2a46")
        .fontSize(10)
        .font("Helvetica-Bold")
        .text("BILLED & DELIVERED TO:", 40, y);

      doc
        .fillColor("#0d2a46")
        .fontSize(10)
        .font("Helvetica-Bold")
        .text("PAYMENT DETAILS:", 320, y);

      y += 18;

      doc
        .fillColor("#1e293b")
        .fontSize(10)
        .font("Helvetica-Bold")
        .text(customerName, 40, y);

      doc
        .font("Helvetica")
        .fontSize(9)
        .fillColor("#475569")
        .text(`Method: ${paymentMethod}`, 320, y);

      y += 14;

      const addressLine = [addr.street, addr.city].filter(Boolean).join(", ");
      const stateZip = [addr.state, addr.zip ? `- ${addr.zip}` : ""].filter(Boolean).join(" ");

      if (addressLine) {
        doc.text(addressLine, 40, y);
      }
      doc.text(`Transaction: ${order.transaction_reference || order.razorpay_payment_id || "Verified"}`, 320, y);

      y += 14;

      if (stateZip) {
        doc.text(stateZip, 40, y);
      }
      doc.text(`Customer Email: ${customerEmail}`, 320, y);

      y += 14;
      doc.text(`Phone: ${customerPhone}`, 40, y);

      // --- Items Table ---
      y += 30;

      // Table Header
      doc.rect(40, y, doc.page.width - 80, 24).fill("#f1f5f9");

      doc
        .fillColor("#475569")
        .fontSize(9)
        .font("Helvetica-Bold")
        .text("#", 50, y + 7)
        .text("ITEM DESCRIPTION", 80, y + 7)
        .text("SIZE", 310, y + 7)
        .text("QTY", 370, y + 7, { width: 40, align: "center" })
        .text("UNIT PRICE", 420, y + 7, { width: 60, align: "right" })
        .text("TOTAL", 490, y + 7, { width: 65, align: "right" });

      y += 24;

      const items = order.orderItems || [];
      items.forEach((item, index) => {
        const prod = item.product || {};
        const title = prod.title || prod.name || "Fragrance Item";
        const brand = prod.brand ? `${prod.brand} • ` : "";
        const size = item.size || "-";
        const qty = item.quantity || 1;
        const unitPrice = item.price ?? prod.price ?? 0;
        const lineTotal = unitPrice * qty;

        const rowHeight = 44;

        // Alternating row background
        if (index % 2 === 1) {
          doc.rect(40, y, doc.page.width - 80, rowHeight).fill("#fafbfc");
        }

        // Draw item product photo thumbnail if file exists
        const imgName = Array.isArray(prod.images) && prod.images[0] ? prod.images[0] : null;
        let hasImage = false;
        if (imgName) {
          const imgPath = path.join(__dirname, "../uploads", imgName);
          if (fs.existsSync(imgPath)) {
            try {
              // Clean border card for image thumbnail
              doc.roundedRect(75, y + 5, 34, 34, 4).fillAndStroke("#ffffff", "#e2e8f0");
              doc.image(imgPath, 77, y + 7, {
                fit: [30, 30],
                align: "center",
                valign: "center",
              });
              hasImage = true;
            } catch {
              hasImage = false;
            }
          }
        }

        const textX = hasImage ? 118 : 80;
        const textWidth = hasImage ? 180 : 218;

        doc
          .fillColor("#1e293b")
          .fontSize(9)
          .font("Helvetica")
          .text(String(index + 1), 50, y + 16);

        doc
          .font("Helvetica-Bold")
          .fontSize(9.5)
          .fillColor("#0f172a")
          .text(title, textX, y + 10, { width: textWidth, ellipsis: true });

        doc
          .font("Helvetica")
          .fontSize(8)
          .fillColor("#64748b")
          .text(`${brand}Size: ${size}`, textX, y + 24, { width: textWidth, ellipsis: true });

        doc
          .font("Helvetica")
          .fontSize(9)
          .fillColor("#334155")
          .text(size, 310, y + 16);

        doc
          .text(String(qty), 370, y + 16, { width: 40, align: "center" })
          .text(`₹${unitPrice}`, 420, y + 16, { width: 60, align: "right" })
          .font("Helvetica-Bold")
          .fillColor("#0d2a46")
          .text(`₹${lineTotal}`, 490, y + 16, { width: 65, align: "right" });

        // Thin bottom border
        doc
          .moveTo(40, y + rowHeight)
          .lineTo(doc.page.width - 40, y + rowHeight)
          .strokeColor("#e2e8f0")
          .stroke();

        y += rowHeight;
      });

      // --- Totals Box ---
      y += 15;

      const rightBoxX = doc.page.width - 240;

      doc
        .font("Helvetica")
        .fontSize(9)
        .fillColor("#64748b")
        .text("Subtotal:", rightBoxX, y)
        .fillColor("#0f172a")
        .text(`₹${order.totalAmount ?? 0}`, rightBoxX + 90, y, { width: 110, align: "right" });

      y += 16;

      doc
        .font("Helvetica")
        .fillColor("#64748b")
        .text("Shipping & Handling:", rightBoxX, y)
        .fillColor("#059669")
        .font("Helvetica-Bold")
        .text("FREE", rightBoxX + 90, y, { width: 110, align: "right" });

      y += 18;

      // Grand Total Highlight
      doc.rect(rightBoxX - 10, y - 4, 210, 28).fill("#0d2a46");

      doc
        .fillColor("#ffffff")
        .font("Helvetica-Bold")
        .fontSize(10)
        .text("GRAND TOTAL:", rightBoxX, y + 3)
        .fontSize(12)
        .text(`₹${order.totalAmount ?? 0}`, rightBoxX + 90, y + 2, {
          width: 100,
          align: "right",
        });

      // --- Security Seal & Support ---
      y += 65;

      doc.rect(40, y, doc.page.width - 80, 55).fillAndStroke("#f8fafc", "#e2e8f0");

      doc
        .fillColor("#0d2a46")
        .font("Helvetica-Bold")
        .fontSize(9)
        .text("AUTHENTICITY & CUSTOMER SUPPORT GUARANTEE", 54, y + 12);

      doc
        .fillColor("#64748b")
        .font("Helvetica")
        .fontSize(8.5)
        .text(
          "All Fragranzia perfumes are 100% handcrafted original formulations. For any inquiries or dispatch updates, contact Fragranzia Support via WhatsApp at +91 8590315711 or email support@fragranzia.com.",
          54,
          y + 26,
          { width: doc.page.width - 108, lineGap: 2 }
        );

      // --- Footer ---
      doc
        .fillColor("#94a3b8")
        .fontSize(8)
        .font("Helvetica")
        .text(
          "Fragranzia Haute Parfumerie • Registered Luxury Brand • Thank you for your business!",
          40,
          doc.page.height - 40,
          { align: "center", width: doc.page.width - 80 }
        );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
};

module.exports = {
  generateInvoicePdf,
};

