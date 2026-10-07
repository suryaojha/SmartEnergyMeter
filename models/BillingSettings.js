const mongoose = require("mongoose");

const billingSettingsSchema = new mongoose.Schema({
  key: { type: String, default: "default", unique: true },
  billingCycleStartDay: { type: Number, default: 1, min: 1, max: 28 },
  fixedCharge: { type: Number, default: 0, min: 0 },
  facPerKwh: { type: Number, default: 0, min: 0 },
  electricityDutyPercent: { type: Number, default: 0, min: 0 },
  wheelingChargePerKwh: { type: Number, default: 0, min: 0 },
  otherCharges: { type: Number, default: 0, min: 0 },
  dailyCostLimit: { type: Number, default: null, min: 0 },
  monthlyCostLimit: { type: Number, default: null, min: 0 },
  dailyEnergyLimit: { type: Number, default: null, min: 0 },
  consumptionTargetKwh: { type: Number, default: null, min: 0 },
  minVoltage: { type: Number, default: null, min: 0 },
  maxVoltage: { type: Number, default: null, min: 0 },
  maxCurrent: { type: Number, default: null, min: 0 },
  maxPower: { type: Number, default: null, min: 0 },
  standbyPowerThreshold: { type: Number, default: null, min: 0 },
  minPowerFactor: { type: Number, default: null, min: 0, max: 1 },
  alertsEnabled: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model("BillingSettings", billingSettingsSchema);
