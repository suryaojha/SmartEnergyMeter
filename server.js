require("dotenv").config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");

const connectDB = require("./db");
const User = require("./models/User");
const Meter = require("./models/Meter");
const Reading = require("./models/Reading");
const TariffSlab = require("./models/TariffSlab");
const BillingSettings = require("./models/BillingSettings");
const WifiProvisioning = require("./models/WifiProvisioning");
const SmtpSettings = require("./models/SmtpSettings");
const ReportSettings = require("./models/ReportSettings");
const { auth, adminOnly } = require("./middleware/auth");

const app = express();
const PORT = Number(process.env.PORT || 5000);
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error("JWT_SECRET must be configured in the environment.");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

function tokenFor(user) {
  return jwt.sign({ id: user._id.toString(), role: user.role }, JWT_SECRET, { expiresIn: "7d" });
}

function online(meter) {
  if (!meter.lastSeen) return false;
  const seconds = Math.max(15, Number(meter.updateFrequency || 5) * 3 + 5);
  return (Date.now() - new Date(meter.lastSeen).getTime()) <= seconds * 1000;
}

function publicMeter(m) {
  const x = m.toObject ? m.toObject() : m;
  const devicePaired = Boolean(x.deviceTokenHash);
  delete x.deviceTokenHash;
  const isOnline = online(x);
  const lastOnlineAt = x.lastSeen ? new Date(x.lastSeen) : null;
  const onlineSince = x.onlineSince ? new Date(x.onlineSince) : null;
  return { ...x, online: isOnline, devicePaired, user: x.userId?.name ? {
    _id: x.userId._id, name: x.userId.name, email: x.userId.email
  } : null,
  uptimeSeconds: lastOnlineAt && onlineSince
    ? Math.max(0, Math.floor(((isOnline ? Date.now() : lastOnlineAt.getTime()) - onlineSince.getTime()) / 1000))
    : null
  };
}

function indiaStart(date = new Date()) {
  const s = date.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  return new Date(`${s}T00:00:00+05:30`);
}

function addIndiaDays(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

function indiaMonthStart(date, day = 1, monthOffset = 0) {
  const parts = date.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).split("-").map(Number);
  const monthDate = new Date(Date.UTC(parts[0], parts[1] - 1 + monthOffset, 1));
  const year = monthDate.getUTCFullYear();
  const month = String(monthDate.getUTCMonth() + 1).padStart(2, "0");
  return new Date(`${year}-${month}-${String(day).padStart(2, "0")}T00:00:00+05:30`);
}

function billingPeriod(date, startDay) {
  const dayOfMonth = Number(date.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).slice(-2));
  const offset = dayOfMonth >= startDay ? 0 : -1;
  const start = indiaMonthStart(date, startDay, offset);
  const previousStart = indiaMonthStart(date, startDay, offset - 1);
  const end = indiaMonthStart(date, startDay, offset + 1);
  return { start, end, previousStart, previousEnd: new Date(previousStart.getTime() + (date.getTime() - start.getTime())) };
}

function counterUsage(firstValue, lastValue, maximumValue, samples = 2) {
  if (samples < 2) return null;
  const first = Number(firstValue);
  const last = Number(lastValue);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return 0;
  return Math.max(0, last >= first ? last - first : Number(maximumValue || last));
}

function sumMeasured(rows) {
  const measured = rows.filter(row => row.kwh != null && Number.isFinite(Number(row.kwh)));
  return measured.length ? measured.reduce((sum, row) => sum + Number(row.kwh), 0) : null;
}

async function consumptionFor(meterId, start, end) {
  const rows = await Reading.aggregate([
    { $match: { meterId, energy: { $type: "number" }, createdAt: { $gte: start, $lt: end } } },
    { $sort: { createdAt: 1 } },
    { $group: {
      _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Asia/Kolkata" } },
      firstEnergy: { $first: "$energy" },
      lastEnergy: { $last: "$energy" },
      maxEnergy: { $max: "$energy" },
      samples: { $sum: 1 }
    }},
    { $sort: { _id: 1 } }
  ]);
  return rows.map(r => {
    const used = counterUsage(r.firstEnergy, r.lastEnergy, r.maxEnergy, r.samples);
    return { date: r._id, kwh: used == null ? null : Number(used.toFixed(4)), samples: r.samples };
  });
}

async function periodConsumption(meterId, start, end) {
  const r = await Reading.aggregate([
    { $match: { meterId, energy: { $type: "number" }, createdAt: { $gte: start, $lt: end } } },
    { $sort: { createdAt: 1 } },
    { $group: {
      _id: null,
      first: { $first: "$energy" },
      last: { $last: "$energy" },
      maximum: { $max: "$energy" },
      samples: { $sum: 1 }
    }}
  ]);
  if (!r.length) return null;
  return counterUsage(r[0].first, r[0].last, r[0].maximum, r[0].samples);
}

function calculateBill(kwh, slabs, settings = {}, includeCycleCharges = false) {
  if (kwh == null || !Number.isFinite(Number(kwh))) return { kwh: null, cost: null, energyCharges: null, currentSlab: null };
  if (!slabs.length) return { kwh: Number(kwh.toFixed(4)), cost: null, energyCharges: null, currentSlab: null };
  let energyCharges = 0;
  let currentSlab = null;
  const sorted = [...slabs].sort((a, b) => a.minKwh - b.minKwh);

  for (const s of sorted) {
    const min = Number(s.minKwh);
    const max = s.maxKwh === null || s.maxKwh === undefined ? Infinity : Number(s.maxKwh);
    const units = Math.max(0, Math.min(kwh, max) - min);
    if (units > 0) energyCharges += units * Number(s.ratePerKwh);
    if (kwh >= min && kwh <= max) currentSlab = s;
  }

  const fac = kwh * Number(settings.facPerKwh || 0);
  const wheeling = kwh * Number(settings.wheelingChargePerKwh || 0);
  const duty = (energyCharges + fac) * Number(settings.electricityDutyPercent || 0) / 100;
  const fixed = includeCycleCharges ? Number(settings.fixedCharge || 0) : 0;
  const other = includeCycleCharges ? Number(settings.otherCharges || 0) : 0;
  const total = energyCharges + fac + wheeling + duty + fixed + other;
  return {
    kwh: Number(kwh.toFixed(4)),
    cost: Number(total.toFixed(2)),
    energyCharges: Number(energyCharges.toFixed(2)),
    fac: Number(fac.toFixed(2)),
    electricityDuty: Number(duty.toFixed(2)),
    wheelingCharges: Number(wheeling.toFixed(2)),
    fixedCharges: Number(fixed.toFixed(2)),
    otherCharges: Number(other.toFixed(2)),
    currentSlab: currentSlab ? {
      name: currentSlab.name,
      minKwh: currentSlab.minKwh,
      maxKwh: currentSlab.maxKwh,
      ratePerKwh: currentSlab.ratePerKwh
    } : null
  };
}

function billDifference(currentKwh, previousKwh, periodKwh, slabs, settings) {
  if (currentKwh == null || previousKwh == null) return calculateBill(null, slabs, settings);
  const current = calculateBill(currentKwh, slabs, settings);
  const previous = calculateBill(previousKwh, slabs, settings);
  if (current.cost == null || previous.cost == null) return calculateBill(null, slabs, settings);
  const subtract = (field) => Number(Math.max(0, current[field] - previous[field]).toFixed(2));
  return {
    ...current,
    kwh: periodKwh == null ? null : Number(periodKwh.toFixed(4)),
    cost: subtract("cost"),
    energyCharges: subtract("energyCharges"),
    fac: subtract("fac"),
    electricityDuty: subtract("electricityDuty"),
    wheelingCharges: subtract("wheelingCharges")
  };
}

function liveHourlyCost(power, cumulativeKwh, slabs, settings) {
  if (power == null || !slabs.length) return null;
  const cumulative = Number(cumulativeKwh || 0);
  const slab = [...slabs].sort((a, b) => a.minKwh - b.minKwh)
    .find(item => cumulative >= item.minKwh && (item.maxKwh == null || cumulative <= item.maxKwh));
  const usageKwh = Math.max(0, Number(power)) / 1000;
  const energyCharge = usageKwh * Number((slab || slabs[0]).ratePerKwh);
  const fac = usageKwh * Number(settings.facPerKwh || 0);
  const wheeling = usageKwh * Number(settings.wheelingChargePerKwh || 0);
  const duty = (energyCharge + fac) * Number(settings.electricityDutyPercent || 0) / 100;
  return Number((energyCharge + fac + wheeling + duty).toFixed(2));
}

async function sendResetEmail(user, code) {
  const config = await getSmtpConfig();
  if (!config.host || !config.username || !config.password) throw new Error("SMTP is not configured. Ask an administrator to configure email settings.");
  const transporter = createSmtpTransport(config);
  const name = String(user.name || "there").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character]);
  await transporter.sendMail({
    from: config.from,
    to: user.email,
    subject: "Your Smart Energy Meter password reset code",
    text: `Hello ${user.name || "there"},\n\nUse this six-digit code to reset your Smart Energy Meter password:\n\n${code}\n\nThis code expires in 10 minutes and can be used only once. If you did not request a password reset, you can ignore this email.`,
    html: `<div style="margin:0;padding:32px 16px;background:#f1f5f9;font-family:Arial,sans-serif;color:#172033"><div style="max-width:520px;margin:0 auto;padding:32px;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px"><p style="margin:0 0 8px;color:#2563eb;font-weight:700">SMART ENERGY METER</p><h1 style="margin:0 0 16px;font-size:24px">Reset your password</h1><p style="line-height:1.6">Hello ${name}, use this six-digit verification code to set a new password:</p><div style="margin:24px 0;padding:16px;text-align:center;background:#eff6ff;border-radius:12px;color:#1d4ed8;font-size:32px;font-weight:800;letter-spacing:10px">${code}</div><p style="line-height:1.6">This code expires in <strong>10 minutes</strong> and can be used only once.</p><p style="line-height:1.6;color:#64748b;font-size:13px">If you did not request a password reset, ignore this email. Your password will not change unless this code is submitted on the reset page.</p></div></div>`
  });
  return true;
}

function smtpEncryptionKey() {
  const configured = process.env.SMTP_CONFIG_KEY;
  if (!configured || configured.length < 32) {
    throw new Error("SMTP_CONFIG_KEY must be set to at least 32 characters before saving mail settings.");
  }
  return crypto.scryptSync(configured, "smart-energy-meter-smtp-v1", 32);
}

function encryptSmtpPassword(password) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", smtpEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
  return { passwordCiphertext: ciphertext.toString("hex"), passwordIv: iv.toString("hex"), passwordTag: cipher.getAuthTag().toString("hex") };
}

function decryptSmtpPassword(settings) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", smtpEncryptionKey(), Buffer.from(settings.passwordIv, "hex"));
  decipher.setAuthTag(Buffer.from(settings.passwordTag, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(settings.passwordCiphertext, "hex")),
    decipher.final()
  ]).toString("utf8");
}

async function getSmtpConfig() {
  const saved = await SmtpSettings.findOne({ key: "default" }).lean();
  return {
    host: saved?.host || process.env.SMTP_HOST || "",
    port: Number(saved?.port || process.env.SMTP_PORT || 587),
    username: saved?.username || process.env.SMTP_USER || "",
    from: `Smart Energy Meter <${saved?.username || process.env.SMTP_USER || ""}>`,
    password: saved?.passwordCiphertext ? decryptSmtpPassword(saved) : process.env.SMTP_PASS || "",
    lastTestedAt: saved?.lastTestedAt || null,
    source: saved ? "database" : "environment"
  };
}

function createSmtpTransport(config) {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: { user: config.username, pass: config.password }
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character]);
}

function reportBillRows(daily, slabs, settings) {
  let cumulativeKwh = 0;
  const rows = [];
  for (const entry of daily) {
    if (entry.kwh == null) {
      rows.push({ ...entry, cost: null });
      continue;
    }
    const previousKwh = cumulativeKwh;
    cumulativeKwh += entry.kwh;
    const incremental = billDifference(cumulativeKwh, previousKwh, entry.kwh, slabs, settings);
    rows.push({ ...entry, cost: incremental.cost });
  }
  return rows;
}

async function buildEnergyReport(meter, days, endExclusive = new Date()) {
  const reportEnd = new Date(endExclusive);
  const reportStart = addIndiaDays(indiaStart(new Date(reportEnd.getTime() - 1)), -(days - 1));
  const measuredRows = await consumptionFor(meter.meterId, reportStart, reportEnd);
  const rowsByDate = new Map(measuredRows.map(row => [row.date, row]));
  const daily = Array.from({ length: days }, (_, index) => {
    const date = addIndiaDays(reportStart, index).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const row = rowsByDate.get(date);
    return row ? { ...row } : { date, kwh: null, samples: 0 };
  });
  const slabs = await TariffSlab.find().sort({ minKwh: 1 }).lean();
  const settings = await BillingSettings.findOne({ key: "default" }).lean() || {};
  const totalKwh = sumMeasured(daily);
  const bill = calculateBill(totalKwh, slabs, settings, days >= 27);
  const priorStart = addIndiaDays(reportStart, -days);
  const previousKwh = await periodConsumption(meter.meterId, priorStart, reportStart);
  const previousBill = calculateBill(previousKwh, slabs, settings, days >= 27);
  const measuredDaily = daily.filter(row => row.kwh != null);
  const averageDailyKwh = measuredDaily.length
    ? measuredDaily.reduce((total, row) => total + row.kwh, 0) / measuredDaily.length
    : null;
  const highestUsageDay = measuredDaily.reduce((highest, row) => !highest || row.kwh > highest.kwh ? row : highest, null);
  const peak = await Reading.findOne({
    meterId: meter.meterId,
    power: { $type: "number" },
    createdAt: { $gte: reportStart, $lt: reportEnd }
  }).sort({ power: -1 }).select("power createdAt").lean();
  const meterOnline = online(meter);
  const alerts = [];
  if (settings.alertsEnabled !== false) {
    if (!meterOnline) alerts.push("Meter is offline or has not sent recent data.");
    if (meter.voltage != null && settings.minVoltage != null && meter.voltage < settings.minVoltage) alerts.push(`Under-voltage: ${meter.voltage} V is below ${settings.minVoltage} V.`);
    if (meter.voltage != null && settings.maxVoltage != null && meter.voltage > settings.maxVoltage) alerts.push(`Over-voltage: ${meter.voltage} V exceeds ${settings.maxVoltage} V.`);
    if (meter.current != null && settings.maxCurrent != null && meter.current > settings.maxCurrent) alerts.push(`Over-current: ${meter.current} A exceeds ${settings.maxCurrent} A.`);
    if (meter.power != null && settings.maxPower != null && meter.power > settings.maxPower) alerts.push(`Over-power: ${meter.power} W exceeds ${settings.maxPower} W.`);
    if (meter.powerFactor != null && settings.minPowerFactor != null && meter.powerFactor < settings.minPowerFactor) alerts.push(`Low power factor: ${meter.powerFactor} is below ${settings.minPowerFactor}.`);
    const peakDailyKwh = daily.reduce((max, row) => row.kwh == null ? max : Math.max(max, row.kwh), 0);
    if (settings.dailyEnergyLimit != null && peakDailyKwh > settings.dailyEnergyLimit) alerts.push(`Daily energy limit exceeded: ${peakDailyKwh.toFixed(3)} kWh against ${settings.dailyEnergyLimit} kWh.`);
    if (settings.dailyCostLimit != null && daily.some(row => row.cost != null && row.cost > settings.dailyCostLimit)) alerts.push(`Daily cost limit exceeded (${settings.dailyCostLimit}).`);
    if (days >= 27 && settings.monthlyCostLimit != null && bill.cost != null && bill.cost > settings.monthlyCostLimit) alerts.push(`Monthly budget exceeded: ₹${bill.cost.toFixed(2)} against ₹${settings.monthlyCostLimit.toFixed(2)}.`);
  }
  const withCosts = reportBillRows(daily, slabs, settings);
  return {
    meter,
    start: reportStart,
    end: reportEnd,
    days,
    daily: withCosts,
    totalKwh,
    bill,
    previousKwh,
    previousBill,
    averageDailyKwh,
    highestUsageDay,
    peak,
    alerts,
    settings
  };
}

function renderEnergyReportHtml(user, reports, title) {
  const formatMoney = value => value == null ? "Unavailable" : `₹${Number(value).toFixed(2)}`;
  const formatUnits = value => value == null ? "Unavailable" : `${Number(value).toFixed(3)} kWh`;
  const meterSections = reports.map(report => {
    const graphRows = report.daily.filter(row => row.kwh != null || row.cost != null);
    const maxKwh = Math.max(0, ...graphRows.map(row => row.kwh || 0));
    const maxCost = Math.max(0, ...graphRows.map(row => row.cost || 0));
    const chart = graphRows.length ? graphRows.map(row => {
      const usageWidth = maxKwh ? Math.max(2, (row.kwh || 0) / maxKwh * 100) : 0;
      const costWidth = maxCost ? Math.max(2, (row.cost || 0) / maxCost * 100) : 0;
      return `<tr><td style="padding:7px 6px;border-bottom:1px solid #e2e8f0;white-space:nowrap">${escapeHtml(row.date)}</td><td style="padding:7px 6px;border-bottom:1px solid #e2e8f0;width:42%">${row.kwh == null ? "—" : `<div style="height:10px;width:${usageWidth}%;background:#2563eb;border-radius:8px"></div>`}</td><td style="padding:7px 6px;border-bottom:1px solid #e2e8f0">${formatUnits(row.kwh)}</td><td style="padding:7px 6px;border-bottom:1px solid #e2e8f0;width:30%">${row.cost == null ? "—" : `<div style="height:10px;width:${costWidth}%;background:#10b981;border-radius:8px"></div>`}</td><td style="padding:7px 6px;border-bottom:1px solid #e2e8f0">${formatMoney(row.cost)}</td></tr>`;
    }).join("") : `<tr><td colspan="5" style="padding:12px;color:#64748b">No meter readings were received during this period.</td></tr>`;
    const alertBlock = report.alerts.length
      ? `<div style="padding:14px 16px;margin:16px 0;background:#fff7ed;border-left:4px solid #f97316;border-radius:8px"><b>Active alerts</b><ul style="margin:8px 0 0;padding-left:20px">${report.alerts.map(alert => `<li style="margin:5px 0">${escapeHtml(alert)}</li>`).join("")}</ul></div>`
      : `<div style="padding:12px 16px;margin:16px 0;background:#ecfdf5;border-left:4px solid #10b981;border-radius:8px"><b>No active configured alerts for this meter.</b></div>`;
    const previous = report.previousBill.cost == null
      ? "Previous period comparison unavailable"
      : `Previous comparable period: ${formatUnits(report.previousKwh)} · ${formatMoney(report.previousBill.cost)} · ${report.bill.cost == null ? "" : `${report.bill.cost <= report.previousBill.cost ? "↓" : "↑"} ${formatMoney(Math.abs(report.bill.cost - report.previousBill.cost))}`}`;
    const budget = report.days >= 27 && report.settings.monthlyCostLimit != null && report.bill.cost != null
      ? `<p style="font-size:13px">Monthly budget: <b>${formatMoney(report.bill.cost)}</b> of <b>${formatMoney(report.settings.monthlyCostLimit)}</b>${report.settings.monthlyCostLimit > 0 ? ` (${(report.bill.cost / report.settings.monthlyCostLimit * 100).toFixed(1)}% used)` : ""}</p>`
      : "";
    const target = report.settings.consumptionTargetKwh == null
      ? ""
      : `<p style="font-size:13px">Daily consumption target: <b>${report.averageDailyKwh == null ? "Unavailable" : `${report.averageDailyKwh.toFixed(3)} kWh average`} </b> against ${Number(report.settings.consumptionTargetKwh).toFixed(3)} kWh.</p>`;
    const technical = [
      ["Status", online(report.meter) ? "LIVE" : "OFFLINE"],
      ["Voltage", report.meter.voltage == null ? "Unavailable" : `${report.meter.voltage} V`],
      ["Current", report.meter.current == null ? "Unavailable" : `${report.meter.current} A`],
      ["Power", report.meter.power == null ? "Unavailable" : `${report.meter.power} W`],
      ["Power factor", report.meter.powerFactor == null ? "Unavailable" : report.meter.powerFactor],
      ["Frequency", report.meter.frequency == null ? "Unavailable" : `${report.meter.frequency} Hz`],
      ["Relay", report.meter.status || "Unavailable"],
      ["Last data received", report.meter.lastSeen ? new Date(report.meter.lastSeen).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "Never"]
    ].map(([label, value]) => `<tr><td style="padding:7px;border-bottom:1px solid #e2e8f0;color:#64748b">${label}</td><td style="padding:7px;border-bottom:1px solid #e2e8f0;font-weight:600">${escapeHtml(value)}</td></tr>`).join("");
    return `<section style="margin-top:24px;padding-top:20px;border-top:1px solid #e2e8f0"><h2 style="margin:0 0 5px;font-size:20px">${escapeHtml(report.meter.meterName || report.meter.meterId)}</h2><p style="margin:0 0 14px;color:#64748b">Meter ${escapeHtml(report.meter.meterId)} · ${report.start.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })} – ${new Date(report.end.getTime() - 1).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}</p><table role="presentation" style="width:100%;border-collapse:collapse"><tr><td style="padding:12px;background:#eff6ff;border-radius:8px"><small>ENERGY USED</small><div style="font-size:22px;font-weight:700">${formatUnits(report.totalKwh)}</div></td><td style="padding:12px 6px"></td><td style="padding:12px;background:#ecfdf5;border-radius:8px"><small>ESTIMATED COST</small><div style="font-size:22px;font-weight:700">${formatMoney(report.bill.cost)}</div></td></tr></table><p style="color:#64748b;font-size:13px">${previous}</p><p style="font-size:13px">Daily average: <b>${formatUnits(report.averageDailyKwh)}</b> · Highest-use day: <b>${report.highestUsageDay ? `${escapeHtml(report.highestUsageDay.date)} (${formatUnits(report.highestUsageDay.kwh)})` : "Unavailable"}</b></p>${target}${budget}<p style="font-size:13px">Peak load: <b>${report.peak ? `${Number(report.peak.power).toFixed(1)} W` : "Unavailable"}</b>${report.peak ? ` at ${new Date(report.peak.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}` : ""}</p>${report.bill.cost == null ? `<p style="color:#64748b">Cost is unavailable until tariffs and enough real meter readings are configured.</p>` : `<table role="presentation" style="width:100%;font-size:13px;color:#475569"><tr><td>Energy charges</td><td>${formatMoney(report.bill.energyCharges)}</td><td>FAC</td><td>${formatMoney(report.bill.fac)}</td></tr><tr><td>Electricity duty</td><td>${formatMoney(report.bill.electricityDuty)}</td><td>Wheeling</td><td>${formatMoney(report.bill.wheelingCharges)}</td></tr><tr><td>Fixed / other charges</td><td colspan="3">${formatMoney(report.bill.fixedCharges + report.bill.otherCharges)}</td></tr></table>`}${alertBlock}<h3 style="font-size:16px;margin:18px 0 8px">Daily usage and cost trend</h3><p style="margin:0 0 8px;color:#64748b;font-size:12px">Blue bars show kWh; green bars show estimated daily cost. Unavailable days are not represented as zero.</p><div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="text-align:left;background:#f8fafc"><th style="padding:7px 6px">Date</th><th style="padding:7px 6px">Usage graph</th><th style="padding:7px 6px">Units</th><th style="padding:7px 6px">Cost graph</th><th style="padding:7px 6px">Cost</th></tr></thead><tbody>${chart}</tbody></table></div><h3 style="font-size:16px;margin:18px 0 8px">Live meter parameters</h3><table style="width:100%;border-collapse:collapse;font-size:13px">${technical}</table></section>`;
  }).join("");
  return `<div style="margin:0;padding:28px 12px;background:#f1f5f9;font-family:Arial,sans-serif;color:#172033"><main style="max-width:760px;margin:auto;padding:28px;background:#fff;border:1px solid #e2e8f0;border-radius:16px"><p style="margin:0 0 8px;color:#2563eb;font-weight:700">SMART ENERGY METER</p><h1 style="margin:0 0 8px;font-size:26px">${escapeHtml(title)}</h1><p style="color:#475569">Hello ${escapeHtml(user.name || "there")}, here is your energy report. All figures below are calculated from readings received by your meter; unavailable values are not filled with sample data.</p>${meterSections}<footer style="margin-top:24px;padding-top:16px;border-top:1px solid #e2e8f0;color:#64748b;font-size:12px">Costs are estimates based on the configured tariff and charges, not a utility-issued bill. This report was sent to your registered account email.</footer></main></div>`;
}

function renderEnergyReportText(user, reports, title) {
  return `${title}\nHello ${user.name || "there"},\n\n${reports.map(report => {
    const lines = report.daily.map(row => `${row.date}: ${row.kwh == null ? "Unavailable" : `${row.kwh.toFixed(3)} kWh`} · ${row.cost == null ? "Unavailable" : `₹${row.cost.toFixed(2)}`}`);
    return `${report.meter.meterName || report.meter.meterId} (${report.meter.meterId})\nPeriod: ${report.start.toISOString()} to ${report.end.toISOString()}\nEnergy: ${report.totalKwh == null ? "Unavailable" : `${report.totalKwh.toFixed(3)} kWh`}\nEstimated cost: ${report.bill.cost == null ? "Unavailable" : `₹${report.bill.cost.toFixed(2)}`}\nAlerts: ${report.alerts.length ? report.alerts.join("; ") : "No active configured alerts"}\nDaily trend:\n${lines.join("\n")}`;
  }).join("\n\n")}\n\nCosts are estimates based on configured tariffs, not an official utility bill.`;
}

async function sendEnergyReport(user, meters, days, title, endExclusive = new Date()) {
  if (!meters.length) throw new Error("No assigned meter is available for this report.");
  const config = await getSmtpConfig();
  if (!config.host || !config.username || !config.password) {
    throw new Error("SMTP is not configured. Ask the administrator to configure mail delivery.");
  }
  const reports = [];
  for (const meter of meters) reports.push(await buildEnergyReport(meter, days, endExclusive));
  const transporter = createSmtpTransport(config);
  await transporter.sendMail({
    from: config.from,
    to: user.email,
    subject: `Smart Energy Meter — ${title}`,
    text: renderEnergyReportText(user, reports, title),
    html: renderEnergyReportHtml(user, reports, title)
  });
  return reports;
}

function wifiEncryptionKey() {
  const configured = process.env.WIFI_CONFIG_KEY;
  if (!configured || configured.length < 32) {
    throw new Error("WIFI_CONFIG_KEY must be set to at least 32 characters before saving Wi-Fi credentials.");
  }
  return crypto.scryptSync(configured, "smart-energy-meter-wifi-v1", 32);
}

function encryptWifiPassword(password) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", wifiEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
  return { passwordCiphertext: ciphertext.toString("hex"), passwordIv: iv.toString("hex"), passwordTag: cipher.getAuthTag().toString("hex") };
}

function decryptWifiPassword(provision) {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    wifiEncryptionKey(),
    Buffer.from(provision.passwordIv, "hex")
  );
  decipher.setAuthTag(Buffer.from(provision.passwordTag, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(provision.passwordCiphertext, "hex")),
    decipher.final()
  ]).toString("utf8");
}

async function deviceAuth(req, res, next) {
  try {
    const meterId = String(req.params.meterId || req.body.meterId || "").toUpperCase();
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) return res.status(401).json({ message: "Device token required" });
    const supplied = crypto.createHash("sha256").update(header.slice(7)).digest();
    const meter = await Meter.findOne({ meterId }).select("+deviceTokenHash");
    if (!meter?.deviceTokenHash) return res.status(401).json({ message: "Device is not paired; ask the administrator to issue a device token" });
    const expected = Buffer.from(meter.deviceTokenHash, "hex");
    if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
      return res.status(401).json({ message: "Invalid device token" });
    }
    req.deviceMeter = meter;
    next();
  } catch (error) {
    next(error);
  }
}

// ---------- Health ----------
app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date() }));

// ---------- Paired ESP32 device APIs ----------
app.post("/api/meter/data", deviceAuth, async (req, res) => {
  try {
    const { meterId, status = null } = req.body;
    if (typeof meterId !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(meterId)) {
      return res.status(400).json({ message: "meterId must contain 1 to 40 letters, numbers, underscores or hyphens" });
    }
    const fields = ["voltage", "current", "power", "energy", "frequency", "powerFactor"];
    const readings = {};
    for (const field of fields) {
      const value = req.body[field];
      if (value === undefined || value === null) {
        readings[field] = null;
      } else if (typeof value === "number" && Number.isFinite(value)) {
        readings[field] = value;
      } else {
        return res.status(400).json({ message: `${field} must be a finite number or null` });
      }
    }
    if (status !== null && !["ON", "OFF"].includes(status)) return res.status(400).json({ message: "status must be ON, OFF, or null" });

    const id = String(meterId).toUpperCase();
    if (id !== req.deviceMeter.meterId) return res.status(403).json({ message: "Meter ID does not match paired device" });
    const now = new Date();
    const meter = await Meter.findOneAndUpdate(
      { meterId: id },
      {
        $set: {
          ...readings,
          status,
          lastSeen: now,
          onlineSince: online(req.deviceMeter) ? req.deviceMeter.onlineSince : now
        }
      },
      { new: true }
    );
    if (!meter) return res.status(404).json({ message: "Meter is not registered; ask the administrator to add it first" });

    await Reading.create({
      meterId: id,
      ...readings,
      status
    });

    res.json({
      ok: true,
      command: meter.command,
      updateFrequency: meter.updateFrequency
    });
  } catch (e) {
    console.error("meter/data", e);
    res.status(500).json({ message: "Meter data error" });
  }
});

app.get("/api/device/:meterId/settings", deviceAuth, async (req, res) => {
  const provision = await WifiProvisioning.findOne({ meterId: req.deviceMeter.meterId }).lean();
  let wifiConfig = null;
  if (provision?.status === "pending" && provision.passwordCiphertext) {
    wifiConfig = {
      revision: provision.revision,
      ssid: provision.selectedSsid,
      password: decryptWifiPassword(provision)
    };
  }
  res.json({
    updateFrequency: req.deviceMeter.updateFrequency,
    command: req.deviceMeter.command,
    wifiScanRequested: provision?.scanRequested || false,
    wifiConfig
  });
});

app.post("/api/device/:meterId/wifi-scan", deviceAuth, async (req, res) => {
  const networks = req.body.networks;
  if (!Array.isArray(networks) || networks.length > 30) {
    return res.status(400).json({ message: "Networks must be an array containing at most 30 entries" });
  }
  const cleaned = [];
  for (const network of networks) {
    if (typeof network?.ssid !== "string" || !network.ssid.trim() || network.ssid.length > 32 ||
      !Number.isFinite(network.rssi) || network.rssi < -120 || network.rssi > 0) {
      return res.status(400).json({ message: "Each network needs a valid SSID and signal strength" });
    }
    cleaned.push({ ssid: network.ssid, rssi: network.rssi, secure: network.secure !== false });
  }
  const provision = await WifiProvisioning.findOneAndUpdate(
    { meterId: req.deviceMeter.meterId },
    { $set: { networks: cleaned, scannedAt: new Date(), scanRequested: false, status: "scanned", error: "" } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  res.json({ ok: true, count: provision.networks.length });
});

app.post("/api/device/:meterId/wifi-status", deviceAuth, async (req, res) => {
  const { revision, connected, ssid, error } = req.body;
  if (!Number.isInteger(revision) || typeof connected !== "boolean") {
    return res.status(400).json({ message: "Revision and connection status are required" });
  }
  const provision = await WifiProvisioning.findOne({ meterId: req.deviceMeter.meterId, revision });
  if (!provision || provision.status !== "pending") return res.status(409).json({ message: "No matching pending Wi-Fi configuration" });
  if (connected && ssid !== provision.selectedSsid) return res.status(400).json({ message: "Connected SSID does not match the pending configuration" });
  provision.status = connected ? "connected" : "failed";
  provision.error = connected ? "" : String(error || "ESP32 could not connect").slice(0, 160);
  if (connected) {
    provision.connectedAt = new Date();
    provision.passwordCiphertext = null;
    provision.passwordIv = null;
    provision.passwordTag = null;
  }
  await provision.save();
  res.json({ ok: true });
});

// ---------- Auth ----------
app.post("/api/auth/login", async (req, res) => {
  try {
    const email = String(req.body.email || "").toLowerCase().trim();
    const password = String(req.body.password || "");
    const user = await User.findOne({ email });
    if (!user || !user.active || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ message: "Invalid email or password" });
    }
    res.json({
      token: tokenFor(user),
      user: { id: user._id, name: user.name, email: user.email, role: user.role }
    });
  } catch {
    res.status(500).json({ message: "Login error" });
  }
});

app.get("/api/auth/me", auth, (req, res) => {
  res.json({ user: { id: req.user._id, name: req.user.name, email: req.user.email, role: req.user.role } });
});

app.post("/api/auth/register", auth, adminOnly, async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password || password.length < 6) {
      return res.status(400).json({ message: "Name, email and password (6+ chars) are required" });
    }
    const exists = await User.findOne({ email: String(email).toLowerCase().trim() });
    if (exists) return res.status(409).json({ message: "Email already registered" });
    const user = await User.create({
      name: String(name).trim(),
      email: String(email).toLowerCase().trim(),
      password: await bcrypt.hash(password, 10),
      role: "User"
    });
    res.status(201).json({ message: "User created", user: { id: user._id, name: user.name, email: user.email } });
  } catch {
    res.status(500).json({ message: "Registration error" });
  }
});

app.post("/api/auth/forgot-password", async (req, res) => {
  try {
    const email = String(req.body.email || "").toLowerCase().trim();
    const user = await User.findOne({ email });
    if (user) {
      if (user.resetCodeSentAt && Date.now() - user.resetCodeSentAt.getTime() < 60000) {
        return res.json({ message: "If the account exists, a password reset code will arrive by email." });
      }
      const code = String(crypto.randomInt(100000, 1000000));
      user.resetCodeHash = crypto.createHash("sha256").update(`${user._id}:${code}`).digest("hex");
      user.resetCodeExpiry = new Date(Date.now() + 10 * 60 * 1000);
      user.resetCodeSentAt = new Date();
      user.resetCodeAttempts = 0;
      await user.save();
      try {
        await sendResetEmail(user, code);
      } catch (error) {
        user.resetCodeHash = null;
        user.resetCodeExpiry = null;
        user.resetCodeSentAt = null;
        user.resetCodeAttempts = 0;
        await user.save();
        console.error("Password reset email delivery failed:", error.message);
        return res.status(503).json({ message: "Could not send the reset code. Check the SMTP configuration and try again." });
      }
    }
    res.json({ message: "If the account exists, a password reset code will arrive by email." });
  } catch (error) {
    console.error("Password reset request failed:", error);
    res.status(500).json({ message: "Could not create password reset code" });
  }
});

app.post("/api/auth/reset-password", async (req, res) => {
  try {
    const email = String(req.body.email || "").toLowerCase().trim();
    const code = String(req.body.code || "");
    const password = String(req.body.password || "");
    if (!email || !/^\d{6}$/.test(code) || password.length < 8) {
      return res.status(400).json({ message: "Email, six-digit code, and a password of at least 8 characters are required" });
    }
    const user = await User.findOne({
      email,
      resetCodeExpiry: { $gt: new Date() },
      resetCodeAttempts: { $lt: 5 }
    });
    const hash = user ? crypto.createHash("sha256").update(`${user._id}:${code}`).digest("hex") : "";
    if (!user || !user.resetCodeHash || !crypto.timingSafeEqual(Buffer.from(user.resetCodeHash, "hex"), Buffer.from(hash, "hex"))) {
      if (user) {
        user.resetCodeAttempts += 1;
        if (user.resetCodeAttempts >= 5) {
          user.resetCodeHash = null;
          user.resetCodeExpiry = null;
        }
        await user.save();
      }
      return res.status(400).json({ message: "Reset code is invalid or expired" });
    }

    user.password = await bcrypt.hash(password, 10);
    user.resetCodeHash = null;
    user.resetCodeExpiry = null;
    user.resetCodeSentAt = null;
    user.resetCodeAttempts = 0;
    await user.save();
    res.json({ message: "Password reset successful. You can login now." });
  } catch (error) {
    console.error("Password reset failed:", error);
    res.status(500).json({ message: "Password reset error" });
  }
});

app.put("/api/auth/change-password", auth, async (req, res) => {
  try {
    const currentPassword = String(req.body.currentPassword || "");
    const newPassword = String(req.body.newPassword || "");
    if (!currentPassword || newPassword.length < 8) {
      return res.status(400).json({ message: "Current password and a new password of at least 8 characters are required" });
    }
    const user = await User.findById(req.user._id);
    if (!user || !(await bcrypt.compare(currentPassword, user.password))) {
      return res.status(400).json({ message: "Current password is incorrect" });
    }
    if (await bcrypt.compare(newPassword, user.password)) {
      return res.status(400).json({ message: "Choose a new password different from your current password" });
    }
    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();
    res.json({ message: "Password changed successfully" });
  } catch (error) {
    console.error("Password change failed:", error);
    res.status(500).json({ message: "Could not change password" });
  }
});

// ---------- Admin ----------
app.get("/api/admin/overview", auth, adminOnly, async (req, res) => {
  const meters = await Meter.find().populate("userId", "name email").lean();
  const users = await User.countDocuments({ role: "User" });
  const onlineCount = meters.filter(online).length;
  const onCount = meters.filter(m => m.command === "ON").length;
  res.json({
    users, meters: meters.length, online: onlineCount, offline: meters.length - onlineCount, on: onCount, off: meters.length - onCount,
    meterList: meters.map(publicMeter)
  });
});

app.get("/api/admin/users", auth, adminOnly, async (req, res) => {
  const users = await User.find({ role: "User" }).select("-password -resetTokenHash -resetTokenExpiry").sort({ createdAt: -1 }).lean();
  res.json(users);
});

app.post("/api/admin/users", auth, adminOnly, async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password || String(password).length < 6) return res.status(400).json({ message: "Name, email and password (6+ characters) are required" });
  const exists = await User.findOne({ email: String(email).toLowerCase().trim() });
  if (exists) return res.status(409).json({ message: "Email already exists" });
  const user = await User.create({
    name, email: String(email).toLowerCase().trim(), password: await bcrypt.hash(password, 10), role: "User"
  });
  res.status(201).json({ message: "User created", user: { id: user._id, name: user.name, email: user.email } });
});

app.delete("/api/admin/users/:id", auth, adminOnly, async (req, res) => {
  try {
    const user = await User.findOne({ _id: req.params.id, role: "User" });
    if (!user) return res.status(404).json({ message: "User not found" });

    // Remove all meter assignments before deleting the user.
    await Meter.updateMany({ userId: user._id }, { $set: { userId: null } });
    await User.deleteOne({ _id: user._id });

    res.json({ message: "User deleted successfully" });
  } catch (e) {
    res.status(500).json({ message: "Failed to delete user" });
  }
});

app.get("/api/admin/meters", auth, adminOnly, async (req, res) => {
  const meters = await Meter.find().select("+deviceTokenHash").populate("userId", "name email").sort({ meterId: 1 }).lean();
  res.json(meters.map(publicMeter));
});

app.post("/api/admin/meters", auth, adminOnly, async (req, res) => {
  const meterId = String(req.body.meterId || "").trim().toUpperCase();
  if (!/^[A-Z0-9_-]{1,40}$/.test(meterId)) return res.status(400).json({ message: "Meter ID must contain 1 to 40 letters, numbers, underscores or hyphens" });
  const meterName = String(req.body.meterName || "").trim();
  if (meterName.length > 80) return res.status(400).json({ message: "Meter name must be 80 characters or fewer" });
  const exists = await Meter.findOne({ meterId });
  if (exists) return res.status(409).json({ message: "Meter already exists" });
  const frequency = Number(req.body.updateFrequency ?? 5);
  if (!Number.isInteger(frequency) || frequency < 1 || frequency > 3600) {
    return res.status(400).json({ message: "Frequency must be 1 to 3600 seconds" });
  }
  const deviceToken = crypto.randomBytes(32).toString("hex");
  const meter = await Meter.create({
    meterId,
    meterName,
    deviceTokenHash: crypto.createHash("sha256").update(deviceToken).digest("hex"),
    updateFrequency: frequency
  });
  res.status(201).json({ message: "Meter created. Save this one-time device token in the ESP32 setup portal.", meter: publicMeter(meter), deviceToken });
});

app.post("/api/admin/meters/:meterId/device-token", auth, adminOnly, async (req, res) => {
  const deviceToken = crypto.randomBytes(32).toString("hex");
  const meter = await Meter.findOneAndUpdate(
    { meterId: req.params.meterId.toUpperCase() },
    { deviceTokenHash: crypto.createHash("sha256").update(deviceToken).digest("hex") },
    { new: true }
  ).populate("userId", "name email");
  if (!meter) return res.status(404).json({ message: "Meter not found" });
  res.json({ message: "Save this one-time token in the ESP32 setup portal.", meter: publicMeter(meter), deviceToken });
});

app.get("/api/admin/meters/:meterId/wifi", auth, adminOnly, async (req, res) => {
  const meter = await Meter.findOne({ meterId: req.params.meterId.toUpperCase() }).select("+deviceTokenHash").lean();
  if (!meter) return res.status(404).json({ message: "Meter not found" });
  const provision = await WifiProvisioning.findOne({ meterId: meter.meterId }).lean();
  res.json({
    meterId: meter.meterId,
    paired: Boolean(meter.deviceTokenHash),
    online: online(meter),
    lastSeen: meter.lastSeen,
    status: provision?.status || "unconfigured",
    scanRequested: provision?.scanRequested || false,
    networks: provision?.networks || [],
    scannedAt: provision?.scannedAt || null,
    selectedSsid: provision?.selectedSsid || "",
    connectedAt: provision?.connectedAt || null,
    error: provision?.error || ""
  });
});

app.post("/api/admin/meters/:meterId/wifi/scan", auth, adminOnly, async (req, res) => {
  const meterId = req.params.meterId.toUpperCase();
  if (!await Meter.exists({ meterId })) return res.status(404).json({ message: "Meter not found" });
  await WifiProvisioning.findOneAndUpdate(
    { meterId },
    { $set: { scanRequested: true, status: "scan-requested", error: "" } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  res.json({ message: "Wi-Fi scan queued. The paired ESP32 must be online to return nearby networks." });
});

app.post("/api/admin/meters/:meterId/wifi/connect", auth, adminOnly, async (req, res) => {
  const meterId = req.params.meterId.toUpperCase();
  if (!await Meter.exists({ meterId })) return res.status(404).json({ message: "Meter not found" });
  const ssid = String(req.body.ssid || "");
  const password = String(req.body.password || "");
  if (!ssid || ssid.length > 32 || password.length > 63 || (password.length > 0 && password.length < 8)) {
    return res.status(400).json({ message: "Choose a scanned network and provide a valid Wi-Fi password (8-63 characters, or blank for an open network)" });
  }
  const provision = await WifiProvisioning.findOne({ meterId });
  if (!provision || !provision.networks.some(network => network.ssid === ssid)) {
    return res.status(400).json({ message: "Select a network returned by the ESP32 scan first" });
  }
  let encrypted;
  try {
    encrypted = encryptWifiPassword(password);
  } catch (error) {
    return res.status(503).json({ message: error.message });
  }
  provision.selectedSsid = ssid;
  provision.passwordCiphertext = encrypted.passwordCiphertext;
  provision.passwordIv = encrypted.passwordIv;
  provision.passwordTag = encrypted.passwordTag;
  provision.revision += 1;
  provision.status = "pending";
  provision.error = "";
  provision.connectedAt = null;
  await provision.save();
  res.json({ message: "Wi-Fi settings encrypted and saved to MongoDB. The ESP32 will apply them when it next checks in.", status: provision.status });
});

app.put("/api/admin/meters/:meterId/assign", auth, adminOnly, async (req, res) => {
  const meterId = req.params.meterId.toUpperCase();
  const userId = req.body.userId || null;
  if (userId) {
    const user = await User.findOne({ _id: userId, role: "User", active: true });
    if (!user) return res.status(400).json({ message: "Selected user not found" });
  }
  const meter = await Meter.findOneAndUpdate({ meterId }, { userId }, { new: true }).populate("userId", "name email");
  if (!meter) return res.status(404).json({ message: "Meter not found" });
  res.json({ message: userId ? "Meter assigned successfully" : "Meter unassigned", meter: publicMeter(meter) });
});

app.put("/api/admin/meters/:meterId/frequency", auth, adminOnly, async (req, res) => {
  const frequency = Number(req.body.updateFrequency);
  if (!Number.isFinite(frequency) || frequency < 1 || frequency > 3600) {
    return res.status(400).json({ message: "Frequency must be 1 to 3600 seconds" });
  }
  const meter = await Meter.findOneAndUpdate({ meterId: req.params.meterId.toUpperCase() }, { updateFrequency: Math.floor(frequency) }, { new: true });
  if (!meter) return res.status(404).json({ message: "Meter not found" });
  res.json({ message: `Update frequency set to ${meter.updateFrequency} seconds`, meter: publicMeter(meter) });
});

app.put("/api/admin/meters/:meterId/command", auth, adminOnly, async (req, res) => {
  const command = String(req.body.command || "").toUpperCase();
  if (!["ON", "OFF"].includes(command)) return res.status(400).json({ message: "Command must be ON or OFF" });
  const meter = await Meter.findOneAndUpdate({ meterId: req.params.meterId.toUpperCase() }, { command }, { new: true }).populate("userId", "name email");
  if (!meter) return res.status(404).json({ message: "Meter not found" });
  res.json({ message: `Command ${command} saved. ESP32 will apply it on its next poll.`, meter: publicMeter(meter) });
});

// ---------- User ----------
app.get("/api/user/meters", auth, async (req, res) => {
  const meters = await Meter.find({ userId: req.user._id }).populate("userId", "name email").lean();
  res.json(meters.map(publicMeter));
});

app.put("/api/user/meters/:meterId/command", auth, async (req, res) => {
  const command = String(req.body.command || "").toUpperCase();
  if (!["ON", "OFF"].includes(command)) return res.status(400).json({ message: "Command must be ON or OFF" });
  const meter = await Meter.findOne({ meterId: req.params.meterId.toUpperCase(), userId: req.user._id });
  if (!meter) return res.status(404).json({ message: "Meter is not assigned to your account" });
  meter.command = command;
  await meter.save();
  res.json({ message: `Command ${command} saved`, meter: publicMeter(meter) });
});

app.post("/api/user/reports/request", auth, async (req, res) => {
  try {
    const days = Number(req.body.days);
    const meterId = String(req.body.meterId || "").toUpperCase();
    if (![1, 7, 30, 90].includes(days)) {
      return res.status(400).json({ message: "Choose a report period of today, 7, 30, or 90 days." });
    }
    const meter = await Meter.findOne({ meterId, userId: req.user._id }).lean();
    if (!meter) return res.status(404).json({ message: "That meter is not assigned to your account." });
    const eligibleAt = new Date(Date.now() - 60 * 1000);
    const requestSlot = await User.findOneAndUpdate({
      _id: req.user._id,
      $or: [
        { reportRequestSentAt: null },
        { reportRequestSentAt: { $lte: eligibleAt } }
      ]
    }, { $set: { reportRequestSentAt: new Date() } }, { new: true });
    if (!requestSlot) return res.status(429).json({ message: "Please wait one minute before requesting another report." });

    const title = days === 1 ? "Today's energy report" : `Last ${days} days energy report`;
    try {
      await sendEnergyReport(req.user, [meter], days, title);
    } catch (error) {
      console.error("User energy report delivery failed:", error.message);
      return res.status(502).json({ message: "Could not deliver your report. Check the mail configuration or try again shortly." });
    }
    res.json({ message: `Your ${days === 1 ? "daily" : `${days}-day`} energy report was sent to ${req.user.email}.` });
  } catch (error) {
    console.error("User energy report request failed:", error);
    res.status(500).json({ message: "Could not prepare the energy report." });
  }
});

// ---------- Consumption / charts ----------
app.get("/api/meters/:meterId/consumption", auth, async (req, res) => {
  const meter = await Meter.findOne({ meterId: req.params.meterId.toUpperCase() }).lean();
  if (!meter) return res.status(404).json({ message: "Meter not found" });
  if (req.user.role !== "Admin" && String(meter.userId) !== String(req.user._id)) {
    return res.status(403).json({ message: "Meter not assigned to you" });
  }

  const range = String(req.query.range || `${req.query.days || 30}d`);
  const requestedDays = range === "24h" ? 1 : Number.parseInt(range, 10);
  const days = Number.isFinite(requestedDays) ? Math.max(1, Math.min(365, requestedDays)) : 30;
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const daily = await consumptionFor(meter.meterId, start, end);
  const currentDayStart = indiaStart(end);
  const currentDay = await consumptionFor(meter.meterId, currentDayStart, new Date(end.getTime() + 1));
  const todayKwh = sumMeasured(currentDay);
  const yesterdayStart = addIndiaDays(currentDayStart, -1);
  const yesterdayRows = await consumptionFor(meter.meterId, yesterdayStart, currentDayStart);
  const yesterdayKwh = sumMeasured(yesterdayRows);

  const monthStart = indiaMonthStart(end, 1, -11);

  const monthlyRows = await Reading.aggregate([
    { $match: { meterId: meter.meterId, energy: { $type: "number" }, createdAt: { $gte: monthStart, $lte: end } } },
    { $sort: { createdAt: 1 } },
    { $group: {
      _id: { $dateToString: { format: "%Y-%m", date: "$createdAt", timezone: "Asia/Kolkata" } },
      firstEnergy: { $first: "$energy" },
      lastEnergy: { $last: "$energy" },
      maxEnergy: { $max: "$energy" },
      samples: { $sum: 1 }
    }},
    { $sort: { _id: 1 } }
  ]);
  const monthly = monthlyRows.map(r => ({
    month: r._id,
    kwh: counterUsage(r.firstEnergy, r.lastEnergy, r.maxEnergy, r.samples) == null ? null :
      Number(counterUsage(r.firstEnergy, r.lastEnergy, r.maxEnergy, r.samples).toFixed(4)),
    samples: r.samples
  }));

  const slabs = await TariffSlab.find().sort({ minKwh: 1 }).lean();
  const periodKwh = sumMeasured(daily);
  const settings = await BillingSettings.findOne({ key: "default" }).lean() || {};
  const { start: cycleStart, end: cycleEnd, previousStart, previousEnd } = billingPeriod(end, settings.billingCycleStartDay || 1);
  const monthKwh = await periodConsumption(meter.meterId, cycleStart, end);
  const previousMonthKwh = await periodConsumption(meter.meterId, previousStart, previousEnd);
  const beforeTodayKwh = currentDayStart.getTime() === cycleStart.getTime()
    ? 0
    : await periodConsumption(meter.meterId, cycleStart, currentDayStart);
  const yesterdayCycleStart = yesterdayStart < cycleStart ? previousStart : cycleStart;
  const beforeYesterdayKwh = yesterdayStart.getTime() === yesterdayCycleStart.getTime()
    ? 0
    : await periodConsumption(meter.meterId, yesterdayCycleStart, yesterdayStart);
  const throughYesterdayKwh = await periodConsumption(meter.meterId, yesterdayCycleStart, currentDayStart);
  const calendarMonthStart = indiaMonthStart(end, 1, 0);
  const previousCalendarMonthStart = indiaMonthStart(end, 1, -1);
  const currentCalendarMonthKwh = await periodConsumption(meter.meterId, calendarMonthStart, end);
  const previousCalendarMonthKwh = await periodConsumption(meter.meterId, previousCalendarMonthStart, calendarMonthStart);
  const todayBill = billDifference(monthKwh, beforeTodayKwh, todayKwh, slabs, settings);
  const monthBill = calculateBill(monthKwh, slabs, settings, true);
  const yesterdayBill = billDifference(throughYesterdayKwh, beforeYesterdayKwh, yesterdayKwh, slabs, settings);
  const previousMonthBill = calculateBill(previousMonthKwh, slabs, settings, true);
  const currentCalendarMonthBill = calculateBill(currentCalendarMonthKwh, slabs, settings);
  const previousCalendarMonthBill = calculateBill(previousCalendarMonthKwh, slabs, settings);

  const hourlyRows = await Reading.aggregate([
    { $match: { meterId: meter.meterId, energy: { $type: "number" }, createdAt: { $gte: start, $lte: end } } },
    { $sort: { createdAt: 1 } },
    { $group: {
      _id: { $dateToString: { format: "%m-%d %H", date: "$createdAt", timezone: "Asia/Kolkata" } },
      firstEnergy: { $first: "$energy" },
      lastEnergy: { $last: "$energy" },
      maxEnergy: { $max: "$energy" },
      maxPower: { $max: "$power" },
      samples: { $sum: 1 }
    }},
    { $sort: { _id: 1 } }
  ]);
  const hourly = hourlyRows.map(row => {
    const usage = counterUsage(row.firstEnergy, row.lastEnergy, row.maxEnergy, row.samples);
    const kwh = usage == null ? null : Number(usage.toFixed(4));
    return { hour: row._id, kwh, cost: calculateBill(kwh, slabs, settings).cost, maxPower: row.maxPower ?? null, samples: row.samples };
  });

  const weekStart = addIndiaDays(currentDayStart, -6);
  const weeklyRows = await consumptionFor(meter.meterId, weekStart, end);
  const weekly = [];
  for (let offset = 0; offset < 7; offset++) {
    const day = addIndiaDays(weekStart, offset);
    const date = day.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const entry = weeklyRows.find(row => row.date === date);
    weekly.push({ date, kwh: entry?.kwh ?? null, samples: entry?.samples ?? 0 });
  }

  const peakReading = await Reading.findOne({
    meterId: meter.meterId, power: { $type: "number" }, createdAt: { $gte: start, $lte: end }
  }).sort({ power: -1 }).select("power createdAt").lean();
  const recentReadings = await Reading.find({ meterId: meter.meterId, power: { $type: "number" } })
    .sort({ createdAt: -1 }).limit(2).select("power createdAt").lean();
  const priorDaily = daily.slice(-8, -1).filter(row => row.kwh != null);
  const averageDailyKwh = priorDaily.length ? priorDaily.reduce((sum, row) => sum + row.kwh, 0) / priorDaily.length : null;
  const alerts = [];
  const meterOnline = online(meter);
  const available = {
    voltage: meter.voltage !== null && meter.voltage !== undefined,
    current: meter.current !== null && meter.current !== undefined,
    power: meter.power !== null && meter.power !== undefined,
    energy: meter.energy !== null && meter.energy !== undefined,
    frequency: meter.frequency !== null && meter.frequency !== undefined,
    powerFactor: meter.powerFactor !== null && meter.powerFactor !== undefined
  };
  if (settings.alertsEnabled !== false) {
    if (!meterOnline) alerts.push({ type: "offline", severity: "high", message: "Meter / ESP32 is offline; no recent data received." });
    else {
      if (meter.voltage != null && settings.maxVoltage != null && meter.voltage > settings.maxVoltage) alerts.push({ type: "over-voltage", severity: "high", message: `Voltage is above ${settings.maxVoltage} V.` });
      if (meter.voltage != null && settings.minVoltage != null && meter.voltage < settings.minVoltage) alerts.push({ type: "under-voltage", severity: "high", message: `Voltage is below ${settings.minVoltage} V.` });
      if (meter.current != null && settings.maxCurrent != null && meter.current > settings.maxCurrent) alerts.push({ type: "over-current", severity: "high", message: `Current is above ${settings.maxCurrent} A.` });
      if (meter.power != null && settings.maxPower != null && meter.power > settings.maxPower) alerts.push({ type: "over-power", severity: "high", message: `Power is above ${settings.maxPower} W.` });
      if (meter.power != null && settings.standbyPowerThreshold != null && meter.power > 0 && meter.power <= settings.standbyPowerThreshold) alerts.push({ type: "standby-power", severity: "low", message: `Power is within the configured standby range (up to ${settings.standbyPowerThreshold} W).` });
      if (meter.powerFactor != null && settings.minPowerFactor != null && meter.powerFactor < settings.minPowerFactor) alerts.push({ type: "low-power-factor", severity: "medium", message: `Power factor is below ${settings.minPowerFactor}.` });
      if (recentReadings.length === 2 && recentReadings[1].power > 0 && recentReadings[0].power >= recentReadings[1].power * 2) alerts.push({ type: "power-spike", severity: "medium", message: "A sudden power increase was detected." });
    }
    if (settings.dailyEnergyLimit != null && todayKwh != null && todayKwh > settings.dailyEnergyLimit) alerts.push({ type: "high-energy", severity: "medium", message: "Daily energy limit exceeded." });
    if (todayBill.cost != null && settings.dailyCostLimit != null && todayBill.cost > settings.dailyCostLimit) alerts.push({ type: "high-daily-cost", severity: "medium", message: "Daily cost limit exceeded." });
    if (monthBill.cost != null && settings.monthlyCostLimit != null && monthBill.cost > settings.monthlyCostLimit) alerts.push({ type: "high-monthly-cost", severity: "high", message: "Monthly cost limit exceeded." });
    if (monthBill.cost != null && monthBill.cost > 0 && settings.monthlyCostLimit != null && monthBill.cost >= settings.monthlyCostLimit * 0.8 && monthBill.cost <= settings.monthlyCostLimit) alerts.push({ type: "budget-warning", severity: "medium", message: "Monthly budget is at least 80% used." });
    if (averageDailyKwh != null && todayKwh != null && todayKwh > averageDailyKwh * 1.5 && todayKwh > 0) alerts.push({ type: "abnormal-consumption", severity: "medium", message: "Today's usage is unusually high compared with the recent daily average." });
  }

  const elapsedDays = Math.max(1, Math.ceil((end.getTime() - cycleStart.getTime()) / 86400000));
  const cycleLengthDays = Math.max(1, Math.ceil((cycleEnd.getTime() - cycleStart.getTime()) / 86400000));
  const recurringCharges = monthBill.cost == null ? 0 : monthBill.fixedCharges + monthBill.otherCharges;
  const expectedBill = monthBill.cost == null ? null :
    Number(((monthBill.cost - recurringCharges) * cycleLengthDays / elapsedDays + recurringCharges).toFixed(2));
  const mostExpensiveHour = hourly.reduce((best, row) => row.cost != null && (!best || row.cost > best.cost) ? row : best, null);
  const suggestions = [];
  if (alerts.some(alert => ["abnormal-consumption", "power-spike"].includes(alert.type))) suggestions.push("Check recently switched-on appliances for unexpected or standby load.");
  if (mostExpensiveHour && mostExpensiveHour.cost > 0) suggestions.push(`Shift flexible appliance use away from ${mostExpensiveHour.hour}:00, your highest-cost hour today.`);
  if (settings.consumptionTargetKwh != null && todayKwh != null && todayKwh > settings.consumptionTargetKwh) suggestions.push("Today's energy target has been exceeded; reduce non-essential loads.");

  res.json({
    meter: publicMeter(meter),
    daily,
    monthly,
    weekly,
    hourly,
    table: [...daily].reverse().map(row => ({ ...row, bill: calculateBill(row.kwh, slabs, settings) })),
    summary: {
      todayKwh: todayKwh == null ? null : Number(todayKwh.toFixed(4)),
      selectedPeriodKwh: periodKwh == null ? null : Number(periodKwh.toFixed(4)),
      monthKwh: monthKwh == null ? null : Number(monthKwh.toFixed(4)),
      yesterdayKwh: yesterdayKwh == null ? null : Number(yesterdayKwh.toFixed(4)),
      previousMonthKwh: previousMonthKwh == null ? null : Number(previousMonthKwh.toFixed(4)),
      todayBill,
      yesterdayBill,
      monthBill,
      previousMonthBill,
      currentCalendarMonthBill,
      previousCalendarMonthBill,
      expectedBill,
      costPerHour: liveHourlyCost(meter.power, monthKwh, slabs, settings),
      todayAverageCostPerHour: todayBill.cost == null ? null : Number((todayBill.cost / Math.max(1, (end.getTime() - currentDayStart.getTime()) / 3600000)).toFixed(2)),
      peakPower: peakReading ? { watts: peakReading.power, at: peakReading.createdAt } : null,
      mostExpensiveHour: mostExpensiveHour ? `${mostExpensiveHour.hour}:00` : null,
      averageDailyKwh: averageDailyKwh == null ? null : Number(averageDailyKwh.toFixed(4)),
      billingPeriod: { start: cycleStart, end: cycleEnd },
      budget: settings.monthlyCostLimit == null || monthBill.cost == null ? null : {
        limit: settings.monthlyCostLimit,
        usedPercent: settings.monthlyCostLimit === 0
          ? (monthBill.cost === 0 ? 0 : null)
          : Number((monthBill.cost / settings.monthlyCostLimit * 100).toFixed(1))
      }
    },
    slabs,
    settings,
    dataAvailability: available,
    alerts,
    suggestions
  });
});

app.get("/api/meters/:meterId/history", auth, async (req, res) => {
  const meter = await Meter.findOne({ meterId: req.params.meterId.toUpperCase() }).lean();
  if (!meter) return res.status(404).json({ message: "Meter not found" });
  if (req.user.role !== "Admin" && String(meter.userId) !== String(req.user._id)) return res.status(403).json({ message: "Access denied" });
  const limit = Math.max(10, Math.min(500, Number(req.query.limit || 100)));
  const rows = await Reading.find({ meterId: meter.meterId }).sort({ createdAt: -1 }).limit(limit).lean();
  res.json(rows.reverse());
});

app.get("/api/admin/tariffs", auth, adminOnly, async (req, res) => {
  res.json(await TariffSlab.find().sort({ minKwh: 1 }).lean());
});

app.get("/api/admin/smtp", auth, adminOnly, async (req, res) => {
  try {
    const config = await getSmtpConfig();
    res.json({
      host: config.host,
      port: config.port,
      username: config.username,
      passwordConfigured: Boolean(config.password),
      source: config.source,
      lastTestedAt: config.lastTestedAt
    });
  } catch (error) {
    console.error("Could not read SMTP settings:", error.message);
    res.status(503).json({ message: "Could not read encrypted SMTP settings. Check SMTP_CONFIG_KEY." });
  }
});

app.put("/api/admin/smtp", auth, adminOnly, async (req, res) => {
  const host = String(req.body.host || "").trim();
  const username = String(req.body.username || "").trim();
  const port = Number(req.body.port);
  const appPassword = String(req.body.appPassword || "").replace(/\s+/g, "");
  if (!host || host.length > 255 || /[\r\n]/.test(host)) return res.status(400).json({ message: "Enter a valid SMTP server host" });
  if (!Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).json({ message: "SMTP port must be between 1 and 65535" });
  if (!username || username.length > 254 || /[\r\n]/.test(username)) return res.status(400).json({ message: "Enter a valid SMTP username, usually your full email address" });
  if (appPassword.length > 256) return res.status(400).json({ message: "App password is too long" });

  const existing = await SmtpSettings.findOne({ key: "default" });
  const environmentPassword = process.env.SMTP_PASS || "";
  if (!appPassword && !existing?.passwordCiphertext && !environmentPassword) {
    return res.status(400).json({ message: "Enter an app password. Leave it blank only to keep the currently configured password." });
  }

  let encrypted;
  try {
    smtpEncryptionKey();
    if (appPassword) encrypted = encryptSmtpPassword(appPassword);
    else if (existing?.passwordCiphertext) {
      decryptSmtpPassword(existing);
      encrypted = {
        passwordCiphertext: existing.passwordCiphertext,
        passwordIv: existing.passwordIv,
        passwordTag: existing.passwordTag
      };
    } else encrypted = encryptSmtpPassword(environmentPassword);
  } catch (error) {
    console.error("Could not encrypt SMTP app password:", error.message);
    return res.status(503).json({ message: "Could not protect the SMTP password. Set or verify SMTP_CONFIG_KEY (at least 32 characters) and retry." });
  }

  const settings = await SmtpSettings.findOneAndUpdate(
    { key: "default" },
    {
      $set: {
        host, port, username,
        ...encrypted,
        lastTestedAt: null
      },
      $setOnInsert: { key: "default" }
    },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
  );
  res.json({
    message: "SMTP settings saved securely in MongoDB. Send a test email to verify delivery.",
    settings: {
      host: settings.host,
      port: settings.port,
      username: settings.username,
      passwordConfigured: true,
      source: "database",
      lastTestedAt: settings.lastTestedAt
    }
  });
});

app.post("/api/admin/smtp/test", auth, adminOnly, async (req, res) => {
  try {
    const config = await getSmtpConfig();
    if (!config.host || !config.username || !config.password) {
      return res.status(400).json({ message: "Save complete SMTP settings and an app password before testing." });
    }
    const transporter = createSmtpTransport(config);
    await transporter.verify();
    await transporter.sendMail({
      from: config.from,
      to: req.user.email,
      subject: "Smart Energy Meter SMTP test",
      text: `SMTP is configured and working for password reset emails.\nTest requested by ${req.user.email}.`
    });
    const lastTestedAt = new Date();
    await SmtpSettings.updateOne({ key: "default" }, { $set: { lastTestedAt } });
    res.json({ message: `Test email sent to ${req.user.email}.`, lastTestedAt });
  } catch (error) {
    console.error("SMTP test failed:", error.message);
    res.status(502).json({ message: "SMTP test failed. Check the host, port, username, app password, and sender, then try again." });
  }
});

app.get("/api/admin/report-settings", auth, adminOnly, async (req, res) => {
  const settings = await ReportSettings.findOneAndUpdate(
    { key: "default" },
    { $setOnInsert: { key: "default" } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();
  const nextRun = [settings.dailyEnabled, settings.weeklyEnabled, settings.monthlyEnabled].some(Boolean)
    ? `${String(settings.sendHour).padStart(2, "0")}:00`
    : null;
  res.json({
    dailyEnabled: settings.dailyEnabled,
    weeklyEnabled: settings.weeklyEnabled,
    monthlyEnabled: settings.monthlyEnabled,
    sendHour: settings.sendHour,
    nextRun
  });
});

app.put("/api/admin/report-settings", auth, adminOnly, async (req, res) => {
  const { dailyEnabled, weeklyEnabled, monthlyEnabled } = req.body;
  const sendHour = Number(req.body.sendHour);
  if (![dailyEnabled, weeklyEnabled, monthlyEnabled].every(value => typeof value === "boolean")) {
    return res.status(400).json({ message: "Choose whether each daily, weekly, and monthly report is enabled." });
  }
  if (!Number.isInteger(sendHour) || sendHour < 0 || sendHour > 23) {
    return res.status(400).json({ message: "Choose a valid delivery hour in India Standard Time." });
  }
  if (dailyEnabled || weeklyEnabled || monthlyEnabled) {
    try {
      const smtp = await getSmtpConfig();
      if (!smtp.host || !smtp.username || !smtp.password) {
        return res.status(400).json({ message: "Configure SMTP and send a successful test email before enabling scheduled reports." });
      }
    } catch (error) {
      console.error("Could not validate SMTP before enabling reports:", error.message);
      return res.status(503).json({ message: "Could not validate SMTP credentials. Check the mail settings and SMTP_CONFIG_KEY." });
    }
  }
  const settings = await ReportSettings.findOneAndUpdate(
    { key: "default" },
    {
      $set: { dailyEnabled, weeklyEnabled, monthlyEnabled, sendHour },
      $setOnInsert: { key: "default" }
    },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
  );
  const anyEnabled = dailyEnabled || weeklyEnabled || monthlyEnabled;
  res.json({
    message: anyEnabled
      ? `Report schedule saved. Enabled reports will be sent at ${String(sendHour).padStart(2, "0")}:00 India Standard Time.`
      : "Report schedule saved. Automatic reports are currently disabled.",
    settings: {
      dailyEnabled: settings.dailyEnabled,
      weeklyEnabled: settings.weeklyEnabled,
      monthlyEnabled: settings.monthlyEnabled,
      sendHour: settings.sendHour
    }
  });
});

app.get("/api/admin/settings", auth, adminOnly, async (req, res) => {
  const settings = await BillingSettings.findOneAndUpdate(
    { key: "default" },
    { $setOnInsert: { key: "default" } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();
  res.json(settings);
});

app.put("/api/admin/settings", auth, adminOnly, async (req, res) => {
  const numericFields = [
    "fixedCharge", "facPerKwh", "electricityDutyPercent", "wheelingChargePerKwh", "otherCharges",
    "dailyCostLimit", "monthlyCostLimit", "dailyEnergyLimit", "consumptionTargetKwh",
    "minVoltage", "maxVoltage", "maxCurrent", "maxPower", "standbyPowerThreshold", "minPowerFactor"
  ];
  const updates = {};
  const billingCycleStartDay = Number(req.body.billingCycleStartDay);
  if (!Number.isInteger(billingCycleStartDay) || billingCycleStartDay < 1 || billingCycleStartDay > 28) {
    return res.status(400).json({ message: "Billing cycle start day must be 1 to 28" });
  }
  updates.billingCycleStartDay = billingCycleStartDay;
  for (const field of numericFields) {
    if (!(field in req.body)) continue;
    const value = req.body[field];
    if (value === "" || value === null) {
      if (["dailyCostLimit", "monthlyCostLimit", "dailyEnergyLimit", "consumptionTargetKwh", "minVoltage", "maxVoltage", "maxCurrent", "maxPower", "standbyPowerThreshold", "minPowerFactor"].includes(field)) {
        updates[field] = null;
        continue;
      }
      return res.status(400).json({ message: `${field} is required` });
    }
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || (field === "minPowerFactor" && number > 1)) {
      return res.status(400).json({ message: `${field} must be a valid non-negative number${field === "minPowerFactor" ? " no greater than 1" : ""}` });
    }
    updates[field] = number;
  }
  if (updates.electricityDutyPercent > 100) return res.status(400).json({ message: "Electricity duty must not exceed 100%" });
  if (Object.prototype.hasOwnProperty.call(updates, "minVoltage") || Object.prototype.hasOwnProperty.call(updates, "maxVoltage")) {
    const existing = await BillingSettings.findOne({ key: "default" }).lean();
    const minimum = Object.prototype.hasOwnProperty.call(updates, "minVoltage") ? updates.minVoltage : existing?.minVoltage;
    const maximum = Object.prototype.hasOwnProperty.call(updates, "maxVoltage") ? updates.maxVoltage : existing?.maxVoltage;
    if (minimum != null && maximum != null && minimum >= maximum) {
      return res.status(400).json({ message: "Under-voltage limit must be lower than over-voltage limit" });
    }
  }
  if ("alertsEnabled" in req.body) {
    if (typeof req.body.alertsEnabled !== "boolean") return res.status(400).json({ message: "alertsEnabled must be true or false" });
    updates.alertsEnabled = req.body.alertsEnabled;
  }
  const settings = await BillingSettings.findOneAndUpdate(
    { key: "default" },
    { $set: updates, $setOnInsert: { key: "default" } },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
  ).lean();
  res.json({ message: "Billing and alert settings saved", settings });
});

app.put("/api/admin/tariffs", auth, adminOnly, async (req, res) => {
  if (!Array.isArray(req.body.slabs)) return res.status(400).json({ message: "slabs array required" });
  const slabs = req.body.slabs.map((s, i) => ({
    name: String(s.name ?? "").trim(),
    minKwh: s.minKwh === "" || s.minKwh === null || s.minKwh === undefined ? null : Number(s.minKwh),
    maxKwh: s.maxKwh === "" || s.maxKwh === null || s.maxKwh === undefined ? null : Number(s.maxKwh),
    ratePerKwh: s.ratePerKwh === "" || s.ratePerKwh === null || s.ratePerKwh === undefined ? null : Number(s.ratePerKwh)
  })).sort((a,b) => a.minKwh - b.minKwh);
  if (slabs.some(s => !s.name || !Number.isFinite(s.minKwh) || s.minKwh < 0 || !Number.isFinite(s.ratePerKwh) || s.ratePerKwh < 0 || (s.maxKwh !== null && (!Number.isFinite(s.maxKwh) || s.maxKwh < 0)))) {
    return res.status(400).json({ message: "Each tariff slab needs a name and valid non-negative unit bounds and rate" });
  }

  if (!slabs.length || slabs[0].minKwh !== 0) return res.status(400).json({ message: "First slab must start at 0 kWh" });
  if (slabs[slabs.length - 1].maxKwh !== null) return res.status(400).json({ message: "Last slab must have no upper limit" });
  for (let i=0;i<slabs.length-1;i++) {
    if (slabs[i].maxKwh === null || slabs[i].maxKwh <= slabs[i].minKwh || slabs[i].maxKwh !== slabs[i+1].minKwh) {
      return res.status(400).json({ message: "Slabs must be continuous: previous max must equal next min" });
    }
  }
  await TariffSlab.deleteMany({});
  await TariffSlab.insertMany(slabs);
  res.json({ message: "Tariff slabs saved", slabs: await TariffSlab.find().sort({ minKwh: 1 }).lean() });
});

app.get("/api/meters/:meterId", auth, async (req, res) => {
  const meter = await Meter.findOne({ meterId: req.params.meterId.toUpperCase() }).populate("userId", "name email").lean();
  if (!meter) return res.status(404).json({ message: "Meter not found" });
  if (req.user.role !== "Admin" && String(meter.userId?._id) !== String(req.user._id)) return res.status(403).json({ message: "Access denied" });
  res.json(publicMeter(meter));
});

// SPA entry points
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ message: "API route not found" });
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

let scheduledReportCheckRunning = false;
async function checkScheduledReports() {
  if (scheduledReportCheckRunning) return;
  scheduledReportCheckRunning = true;
  try {
    const now = new Date();
    const istHour = Number(new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata", hour: "2-digit", hourCycle: "h23"
    }).format(now));
    const todayStart = indiaStart(now);
    const todayKey = todayStart.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata", weekday: "short" }).format(now);
    const weekdayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
    const dayOfMonth = Number(new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata", day: "2-digit"
    }).format(now));
    const settings = await ReportSettings.findOne({ key: "default" });
    if (!settings || istHour < settings.sendHour) return;

    const due = [];
    if (settings.dailyEnabled) {
      due.push({ enabled: true, field: "lastDailyKey", key: todayKey, days: 1, end: todayStart, title: "Daily energy report" });
    }
    if (settings.weeklyEnabled && weekdayIndex === 1) {
      const weekEnd = todayStart;
      const weekKey = addIndiaDays(weekEnd, -7).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
      due.push({ enabled: true, field: "lastWeeklyKey", key: weekKey, days: 7, end: weekEnd, title: "Weekly energy report" });
    }
    if (settings.monthlyEnabled && dayOfMonth === 1) {
      const monthEnd = todayStart;
      const previousMonthStart = indiaMonthStart(now, 1, -1);
      const monthDays = Math.round((monthEnd.getTime() - previousMonthStart.getTime()) / 86400000);
      const monthKey = previousMonthStart.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).slice(0, 7);
      due.push({ enabled: true, field: "lastMonthlyKey", key: monthKey, days: monthDays, end: monthEnd, title: "Monthly energy report" });
    }
    for (const report of due) {
      const claimed = await ReportSettings.findOneAndUpdate(
        { _id: settings._id, [report.field]: { $ne: report.key } },
        { $set: { [report.field]: report.key } },
        { new: true }
      );
      if (!claimed) continue;
      const recipients = await User.find({ role: "User", active: true }).select("name email").lean();
      for (const recipient of recipients) {
        const assignedMeters = await Meter.find({ userId: recipient._id }).lean();
        if (!assignedMeters.length) continue;
        try {
          await sendEnergyReport(recipient, assignedMeters, report.days, report.title, report.end);
        } catch (error) {
          console.error(`Scheduled ${report.title.toLowerCase()} delivery failed for ${recipient.email}:`, error.message);
        }
      }
    }
  } catch (error) {
    console.error("Scheduled energy report check failed:", error);
  } finally {
    scheduledReportCheckRunning = false;
  }
}

connectDB().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Energy Meter Server running on port ${PORT}`);
    setInterval(checkScheduledReports, 60000);
  });
}).catch(err => {
  console.error("MongoDB connection failed:", err);
  process.exit(1);
});
