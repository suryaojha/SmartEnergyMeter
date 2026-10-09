const mongoose = require("mongoose");

const appSettingsSchema = new mongoose.Schema({
  key: { type: String, default: "default", unique: true },
  otpForUsers: { type: Boolean, default: false },
  otpForAdmins: { type: Boolean, default: false },
  otpTtlMinutes: { type: Number, default: 10, min: 2, max: 30 },
  alertAdminCopy: { type: Boolean, default: false },   // also e-mail every active admin when a user is alerted
  // Wallet payments
  upiId: { type: String, default: "", trim: true },
  payeeName: { type: String, default: "", trim: true },
  payInstructions: { type: String, default: "", maxlength: 400 },
  minRechargePaise: { type: Number, default: 1000 },
  qrFile: { type: String, default: "" }                // admin-uploaded static QR image
}, { timestamps: true });

module.exports = mongoose.model("AppSettings", appSettingsSchema);
