const mongoose = require("mongoose");

const tariffSlabSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  minKwh: { type: Number, required: true, min: 0 },
  maxKwh: { type: Number, default: null, min: 0 },
  ratePerKwh: { type: Number, required: true, min: 0 }
}, { timestamps: true });

module.exports = mongoose.model("TariffSlab", tariffSlabSchema);
