const mongoose = require("mongoose");

const smtpSettingsSchema = new mongoose.Schema({
  key: { type: String, default: "default", unique: true },
  host: { type: String, required: true, trim: true },
  port: { type: Number, required: true, min: 1, max: 65535 },
  username: { type: String, required: true, trim: true },
  passwordCiphertext: { type: String, required: true },
  passwordIv: { type: String, required: true },
  passwordTag: { type: String, required: true },
  lastTestedAt: { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model("SmtpSettings", smtpSettingsSchema);
