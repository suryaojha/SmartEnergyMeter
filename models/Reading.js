const mongoose = require("mongoose");

const readingSchema = new mongoose.Schema({
  meterId: { type: String, required: true, index: true },
  voltage: Number,
  current: Number,
  power: Number,
  energy: Number,
  frequency: Number,
  powerFactor: Number,
  // 1 = visible. 0 = held: received while data collection was disabled; released (set to 1) when it is enabled again.
  status: { type: Number, default: 1, index: true },
  createdAt: { type: Date, default: Date.now, index: true }
});

readingSchema.index({ meterId: 1, createdAt: -1 });
module.exports = mongoose.model("Reading", readingSchema);
