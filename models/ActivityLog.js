const mongoose = require("mongoose");

const activitySchema = new mongoose.Schema({
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  actorName: { type: String, default: "" },
  role: { type: String, default: "" },
  action: { type: String, required: true },
  target: { type: String, default: "" },
  detail: { type: String, default: "" }
}, { timestamps: { createdAt: true, updatedAt: false } });

activitySchema.index({ createdAt: -1 });
activitySchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 86400 });

module.exports = mongoose.model("ActivityLog", activitySchema);
