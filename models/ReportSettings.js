const mongoose = require("mongoose");

const reportSettingsSchema = new mongoose.Schema({
  key: { type: String, default: "default", unique: true },
  dailyEnabled: { type: Boolean, default: false },
  weeklyEnabled: { type: Boolean, default: false },
  monthlyEnabled: { type: Boolean, default: false },
  sendHour: { type: Number, default: 8, min: 0, max: 23 },
  lastDailyKey: { type: String, default: "" },
  lastWeeklyKey: { type: String, default: "" },
  lastMonthlyKey: { type: String, default: "" }
}, { timestamps: true });

module.exports = mongoose.model("ReportSettings", reportSettingsSchema);
