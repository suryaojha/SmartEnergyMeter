const mongoose = require("mongoose");

const meterSchema = new mongoose.Schema({
  meterId: { type: String, required: true, unique: true, trim: true, uppercase: true },
  meterName: { type: String, trim: true, default: "" },
  deviceTokenHash: { type: String, default: null, select: false },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  status: { type: String, enum: ["ON", "OFF"], default: null },
  command: { type: String, enum: ["ON", "OFF"], default: "OFF" },
  voltage: { type: Number, default: null },
  current: { type: Number, default: null },
  power: { type: Number, default: null },
  energy: { type: Number, default: null },
  frequency: { type: Number, default: null },
  powerFactor: { type: Number, default: null },
  updateFrequency: { type: Number, default: 5, min: 1, max: 3600 },
  lastSeen: { type: Date, default: null },
  onlineSince: { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model("Meter", meterSchema);
