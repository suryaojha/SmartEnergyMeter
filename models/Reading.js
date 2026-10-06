const mongoose = require("mongoose");

const readingSchema = new mongoose.Schema({
  meterId: { type: String, required: true, index: true },
  voltage: Number,
  current: Number,
  power: Number,
  energy: Number,
  frequency: Number,
  powerFactor: Number,
  status: String,
  createdAt: { type: Date, default: Date.now, index: true }
});

readingSchema.index({ meterId: 1, createdAt: -1 });
module.exports = mongoose.model("Reading", readingSchema);
