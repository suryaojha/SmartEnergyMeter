const mongoose = require("mongoose");

const wifiProvisioningSchema = new mongoose.Schema({
  meterId: { type: String, required: true, unique: true, index: true },
  scanRequested: { type: Boolean, default: false },
  networks: [{
    ssid: { type: String, required: true },
    rssi: { type: Number, required: true },
    secure: { type: Boolean, default: true }
  }],
  scannedAt: { type: Date, default: null },
  status: { type: String, enum: ["unconfigured", "scan-requested", "scanned", "pending", "connected", "failed"], default: "unconfigured" },
  selectedSsid: { type: String, default: "" },
  passwordCiphertext: { type: String, default: null },
  passwordIv: { type: String, default: null },
  passwordTag: { type: String, default: null },
  revision: { type: Number, default: 0 },
  connectedAt: { type: Date, default: null },
  error: { type: String, default: "" }
}, { timestamps: true });

module.exports = mongoose.model("WifiProvisioning", wifiProvisioningSchema);
