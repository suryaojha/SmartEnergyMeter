const mongoose = require("mongoose");

const meterSchema = new mongoose.Schema({
  meterId: { type: String, required: true, unique: true, trim: true, uppercase: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  status: { type: String, enum: ["ON", "OFF"], default: "OFF" },
  command: { type: String, enum: ["ON", "OFF"], default: "OFF" },
  voltage: { type: Number, default: 0 },
  current: { type: Number, default: 0 },
  power: { type: Number, default: 0 },
  energy: { type: Number, default: 0 },
  frequency: { type: Number, default: 0 },
  powerFactor: { type: Number, default: 0 },
  updateFrequency: { type: Number, default: 5, min: 1, max: 3600 },
  lastSeen: { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model("Meter", meterSchema);
