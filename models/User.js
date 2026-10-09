const mongoose = require("mongoose");

// Personal alert settings a user manages for their own meters. A null limit falls back to the admin's value.
const alertPrefsSchema = new mongoose.Schema({
  emailAlerts: { type: Boolean, default: false },
  alertOffline: { type: Boolean, default: true },
  minVoltage: { type: Number, default: null },
  maxVoltage: { type: Number, default: null },
  maxCurrent: { type: Number, default: null },
  maxPower: { type: Number, default: null },
  minPowerFactor: { type: Number, default: null },
  dailyEnergyLimit: { type: Number, default: null },
  dailyCostLimit: { type: Number, default: null },
  monthlyCostLimit: { type: Number, default: null }
}, { _id: false });

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  role: { type: String, enum: ["Admin", "User"], default: "User" },
  active: { type: Boolean, default: true },
  resetCodeHash: { type: String, default: null },
  resetCodeExpiry: { type: Date, default: null },
  resetCodeSentAt: { type: Date, default: null },
  resetCodeAttempts: { type: Number, default: 0 },
  reportRequestSentAt: { type: Date, default: null },
  walletBalancePaise: { type: Number, default: 0, min: 0 },
  alertPrefs: { type: alertPrefsSchema, default: () => ({}) }
}, { timestamps: true });

module.exports = mongoose.model("User", userSchema);
