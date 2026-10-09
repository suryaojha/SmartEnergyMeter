const mongoose = require("mongoose");

const meterSchema = new mongoose.Schema({
  meterId: { type: String, required: true, unique: true, trim: true, uppercase: true },
  meterName: { type: String, trim: true, default: "" },
  deviceTokenHash: { type: String, default: null, select: false },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  // Admin switch: true = the ESP32 may store readings; false = it stays connected but its data is discarded.
  dataEnabled: { type: Boolean, default: true },
  voltage: { type: Number, default: null },
  current: { type: Number, default: null },
  power: { type: Number, default: null },
  energy: { type: Number, default: null },
  frequency: { type: Number, default: null },
  powerFactor: { type: Number, default: null },
  // Subscription: when subscriptionEnd passes, data collection is switched off automatically (null = not subscription-managed).
  subscriptionEnd: { type: Date, default: null },
  disabledReason: { type: String, enum: ["", "admin", "subscription"], default: "" },
  autoRenewPlanId: { type: mongoose.Schema.Types.ObjectId, ref: "Plan", default: null },
  expiryReminderFor: { type: String, default: "" },
  userConfigAllowed: { type: Boolean, default: true },
  firmware: { type: String, default: "" },
  rssi: { type: Number, default: null },
  updateFrequency: { type: Number, default: 5, min: 1, max: 3600 },
  lastSeen: { type: Date, default: null },        // last stored reading
  lastHeartbeat: { type: Date, default: null },   // last time the ESP32 contacted the server at all
  onlineSince: { type: Date, default: null },
  presence: { type: String, enum: ["online", "offline"], default: "offline" },
  activeAlerts: { type: [String], default: [] }   // alert types already e-mailed and not yet cleared
}, { timestamps: true });

module.exports = mongoose.model("Meter", meterSchema);
