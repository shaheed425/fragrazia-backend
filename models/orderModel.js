const mongoose = require("mongoose");

const orderSchema = new mongoose.Schema(
    {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        orderNumber: { type: String, unique: true, sparse: true },
        orderItems: [
            {
                product: {
                    type: mongoose.Schema.Types.ObjectId,
                    ref: "Product"
                },
                quantity: {
                    type: Number
                },
                size: {
                    type: String,
                    default: ""
                },
                price: {
                    type: Number
                },
            }
        ],
        shippingAddress: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Address",
        },
        paymentMethod: { type: String, enum: ["COD", "UPI"], default: "COD" },
        paymentStatus: {
            type: String,
            enum: ["Pending", "Paid", "Failed", "Refunded"],
            default: "Pending",
        },
        paymentState: {
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
        paidAt: { type: Date, default: null },
        refundedAt: { type: Date, default: null },
        totalAmount: { type: Number, required: true, default: 0 },
        currency: { type: String, default: "INR" },
        deliveryStatus: {
            type: String,
            enum: [
                "Pending", "Confirmed", "Shipping", "Delivered", "Cancelled",
                "Returned", "Failed Delivery",
            ],
            default: "Pending",
        },
        deliveredAt: { type: Date },

        // Razorpay, Reconciliation & Recovery Fields
        razorpay_order_id: { type: String, index: true },
        razorpay_payment_id: { type: String, index: true },
        razorpay_signature: { type: String },
        transaction_reference: { type: String },
        payment_gateway_status: { type: String },
        paymentFailureReason: { type: String },
        requiresReviewReason: { type: String, default: null },
        paymentAttempts: { type: Number, default: 1 },
        lastPaymentCheckAt: { type: Date, default: null },
        reconcileAttempts: { type: Number, default: 0 },
        nextReconcileAt: { type: Date, default: null, index: true },
        reconcileLockedAt: { type: Date, default: null },
        retryLockedAt: { type: Date, default: null },
        confirmationOperationId: { type: String, default: null },
        confirmationEmailSentAt: { type: Date, default: null },
        whatsappNotifiedAt: { type: Date, default: null },
        webhookConfirmed: { type: Boolean, default: false },
        stockDeducted: { type: Boolean, default: false },
        stockRestored: { type: Boolean, default: false },
        fulfilledAt: { type: Date, default: null },
        fulfillmentNote: { type: String, default: null },
        idempotencyKey: { type: String, sparse: true },
        shipment_id: { type: String },
        awb_code: { type: String },
        courier_name: { type: String },
        courier_status: { type: String },

        // Return Section
        isReturned: { type: Boolean, default: false },
        returnReason: {
            type: String,
            enum: [
                "Damaged Product",
                "Wrong Item Received",
                "Defective Product",
                "Item Not as Described",
                "Size/Color Mismatch",
                "Other"
            ],
        },
        returnStatus: {
            type: String,
            enum: ["Requested", "Approved", "Rejected", "Completed"],
            default: "Requested",
        },
        returnedAt: { type: Date },
    },
    { timestamps: true }
);

orderSchema.index(
    { user: 1, idempotencyKey: 1 },
    { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } }
);

module.exports = mongoose.model("Order", orderSchema);
