const mongoose = require("mongoose");

const appSettingsSchema = new mongoose.Schema({
  key: { type: String, default: "default", unique: true },
  otpForUsers: { type: Boolean, default: false },
  otpForAdmins: { type: Boolean, default: false },
  otpTtlMinutes: { type: Number, default: 10, min: 2, max: 30 }
}, { timestamps: true });

module.exports = mongoose.model("AppSettings", appSettingsSchema);
