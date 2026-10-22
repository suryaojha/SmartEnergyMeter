const mongoose = require("mongoose");

// A user-raised support ticket. Simple single-response model (like PaymentRequest/ReadingChangeRequest):
// the user states the issue, the admin updates status and can leave one response note.
const ticketSchema = new mongoose.Schema({
  ticketNo: { type: String, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  meterId: { type: String, default: "", trim: true, uppercase: true },
  category: { type: String, enum: ["billing", "meter", "technical", "other"], default: "other" },
  subject: { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, required: true, maxlength: 2000 },
  status: { type: String, enum: ["open", "in-progress", "resolved", "closed"], default: "open", index: true },
  adminNote: { type: String, default: "", maxlength: 1000 },
  reviewedBy: { type: String, default: "" },
  reviewedAt: { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model("Ticket", ticketSchema);
