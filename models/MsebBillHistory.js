const mongoose = require("mongoose");

// One month of the user's own MSEB bill, submitted so it can be compared against this
// system's own meter. Every entry needs admin approval before it is used in that comparison.
const msebBillHistorySchema = new mongoose.Schema({
  meterId: { type: String, required: true, trim: true, uppercase: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  month: { type: String, required: true, match: /^\d{4}-\d{2}$/ },   // "YYYY-MM"
  msebReadingKwh: { type: Number, required: true, min: 0, max: 999999 },
  msebBillAmount: { type: Number, required: true, min: 0, max: 9999999 },
  photoFile: { type: String, required: true },
  status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending", index: true },
  adminNote: { type: String, default: "", maxlength: 240 },
  reviewedBy: { type: String, default: "" },
  reviewedAt: { type: Date, default: null }
}, { timestamps: true });

// Only one live (pending or approved) entry per meter per month.
msebBillHistorySchema.index({ meterId: 1, month: 1 }, { unique: true, partialFilterExpression: { status: { $in: ["pending", "approved"] } } });

module.exports = mongoose.model("MsebBillHistory", msebBillHistorySchema);
