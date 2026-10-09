const mongoose = require("mongoose");

// A subscription plan: paying `pricePaise` from the wallet keeps one meter's data enabled for `days` days.
const planSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  pricePaise: { type: Number, required: true, min: 0 },
  days: { type: Number, required: true, min: 1, max: 3660 },
  active: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model("Plan", planSchema);
