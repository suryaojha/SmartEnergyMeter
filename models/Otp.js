const mongoose = require("mongoose");

// One row per issued one-time passcode. Only a hash of the code is stored.
// Rows stay visible to admins for 24h after expiry, then MongoDB removes them (TTL index).
const otpSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  purpose: { type: String, enum: ["login", "reset"], required: true },
  codeHash: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  attempts: { type: Number, default: 0 },
  usedAt: { type: Date, default: null },
  delivery: { type: String, enum: ["sent", "failed"], default: "sent" },
  ip: { type: String, default: "" }
}, { timestamps: true });

otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86400 });
otpSchema.index({ userId: 1, purpose: 1, createdAt: -1 });

module.exports = mongoose.model("Otp", otpSchema);
