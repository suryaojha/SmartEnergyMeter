const mongoose = require("mongoose");

// In-app notifications shown from the bell icon (subscription, payment, reading-request status, …).
// Independent of e-mail: created alongside the existing e-mail notifications, not instead of them.
const notificationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  title: { type: String, required: true, maxlength: 140 },
  body: { type: String, default: "", maxlength: 400 },
  kind: { type: String, default: "" },
  meterId: { type: String, default: "" },
  read: { type: Boolean, default: false }
}, { timestamps: true });

notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 86400 });

module.exports = mongoose.model("Notification", notificationSchema);
