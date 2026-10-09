const mongoose = require("mongoose");

// A wallet top-up the user says they paid by UPI. Credited only after an admin approves it.
const paymentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  amountPaise: { type: Number, required: true, min: 100 },
  utr: { type: String, required: true, trim: true, uppercase: true },   // UPI transaction / reference number
  screenshotFile: { type: String, required: true },
  status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending", index: true },
  receiptNo: { type: String, default: "" },
  adminNote: { type: String, default: "", maxlength: 240 },
  reviewedBy: { type: String, default: "" },
  reviewedAt: { type: Date, default: null }
}, { timestamps: true });

// The same UTR cannot be used for two live (pending or approved) requests.
paymentSchema.index({ utr: 1 }, { unique: true, partialFilterExpression: { status: { $in: ["pending", "approved"] } } });

module.exports = mongoose.model("PaymentRequest", paymentSchema);
