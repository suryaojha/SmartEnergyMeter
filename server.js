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
const Otp = require("./models/Otp");
const AppSettings = require("./models/AppSettings");
const ActivityLog = require("./models/ActivityLog");
const PresenceEvent = require("./models/PresenceEvent");
const Plan = require("./models/Plan");
const WalletTxn = require("./models/WalletTxn");
const PaymentRequest = require("./models/PaymentRequest");
const fs = require("fs");
const { auth, adminOnly } = require("./middleware/auth");

const app = express();
const PORT = Number(process.env.PORT || 5000);
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error("JWT_SECRET must be configured in the environment.");

// Image uploads (base64 in JSON) get a bigger body limit, but only on these authenticated routes (see uploadJson).
const UPLOAD_ROUTES = new Set(["/api/user/payments", "/api/admin/payment-qr"]);
const uploadJson = express.json({ limit: "5mb" });
const smallJson = express.json();
app.use((req, res, next) => (UPLOAD_ROUTES.has(req.path) && req.method === "POST" ? next() : smallJson(req, res, next)));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

function tokenFor(user) {
  return jwt.sign({ id: user._id.toString(), role: user.role }, JWT_SECRET, { expiresIn: "7d" });
}

const HEARTBEAT_TIMEOUT_MS = 20000; // the ESP32 contacts the server every ~2 s while powered and connected

// A meter is online while its ESP32 keeps contacting the server, whether or not the admin allows it to store data.
function online(meter) {
  if (meter.lastHeartbeat) return Date.now() - new Date(meter.lastHeartbeat).getTime() <= HEARTBEAT_TIMEOUT_MS;
  if (!meter.lastSeen) return false;
  const seconds = Math.max(15, Number(meter.updateFrequency || 5) * 3 + 5);
  return (Date.now() - new Date(meter.lastSeen).getTime()) <= seconds * 1000;
}

function subscriptionExpired(meter) {
  return Boolean(meter.subscriptionEnd) && new Date(meter.subscriptionEnd).getTime() <= Date.now();
}

// Data may be stored only while the admin has it ON and any subscription has not run out.
function dataAllowed(meter) {
  return meter.dataEnabled !== false && !subscriptionExpired(meter);
}

function publicMeter(m) {
  const x = m.toObject ? m.toObject() : m;
  const devicePaired = Boolean(x.deviceTokenHash);
  delete x.deviceTokenHash;
  delete x.activeAlerts;
  const isOnline = online(x);
  const lastOnlineAt = x.lastHeartbeat || x.lastSeen ? new Date(x.lastHeartbeat || x.lastSeen) : null;
  const onlineSince = x.onlineSince ? new Date(x.onlineSince) : null;
  const expired = subscriptionExpired(x);
  return { ...x, online: isOnline, dataEnabled: dataAllowed(x), disabledReason: expired ? "subscription" : (x.dataEnabled === false ? (x.disabledReason || "admin") : ""),
    subscriptionExpired: expired, daysLeft: x.subscriptionEnd ? Math.ceil((new Date(x.subscriptionEnd) - Date.now()) / 86400000) : null, devicePaired, user: x.userId?.name ? {
    _id: x.userId._id, name: x.userId.name, email: x.userId.email
  } : null,
  uptimeSeconds: lastOnlineAt && onlineSince
    ? Math.max(0, Math.floor(((isOnline ? Date.now() : lastOnlineAt.getTime()) - onlineSince.getTime()) / 1000))
    : null
  };
}

const USER_LIMIT_FIELDS = ["minVoltage", "maxVoltage", "maxCurrent", "maxPower", "minPowerFactor", "dailyEnergyLimit", "dailyCostLimit", "monthlyCostLimit"];

// The limits a user chose for themselves (null/unset ones fall back to the admin's values).
function userLimitOverrides(user) {
  const prefs = user?.alertPrefs || {};
  const out = {};
  for (const field of USER_LIMIT_FIELDS) if (prefs[field] != null) out[field] = prefs[field];
  return out;
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
    { $match: { meterId, status: { $ne: 0 }, energy: { $type: "number" }, createdAt: { $gte: start, $lt: end } } },
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
    { $match: { meterId, status: { $ne: 0 }, energy: { $type: "number" }, createdAt: { $gte: start, $lt: end } } },
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

// ---------- One-time passcodes (stored in the Otp collection) ----------
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_SECONDS = 60;

async function getAppSettings() {
  return AppSettings.findOneAndUpdate(
    { key: "default" },
    { $setOnInsert: { key: "default" } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();
}

function hashOtp(userId, purpose, code) {
  return crypto.createHash("sha256").update(`${userId}:${purpose}:${code}`).digest("hex");
}

async function logActivity(actor, action, target = "", detail = "") {
  try {
    await ActivityLog.create({
      actorId: actor?._id || null, actorName: actor?.name || "System", role: actor?.role || "",
      action, target: String(target).slice(0, 80), detail: String(detail).slice(0, 240)
    });
  } catch (error) {
    console.error("Activity log failed:", error.message);
  }
}

// Creates an OTP row and emails it. Throws an Error with .status when it cannot be delivered or is rate limited.
async function issueOtp(user, purpose, req) {
  const last = await Otp.findOne({ userId: user._id, purpose }).sort({ createdAt: -1 }).lean();
  if (last && Date.now() - new Date(last.createdAt).getTime() < OTP_RESEND_SECONDS * 1000) {
    const error = new Error(`Please wait ${OTP_RESEND_SECONDS} seconds before requesting another code.`);
    error.status = 429;
    throw error;
  }
  const settings = await getAppSettings();
  const code = String(crypto.randomInt(100000, 1000000));
  await Otp.updateMany({ userId: user._id, purpose, usedAt: null, expiresAt: { $gt: new Date() } }, { $set: { expiresAt: new Date() } });
  const row = await Otp.create({
    userId: user._id, email: user.email, purpose, codeHash: hashOtp(user._id, purpose, code),
    expiresAt: new Date(Date.now() + settings.otpTtlMinutes * 60000), ip: req?.ip || ""
  });
  try {
    await sendOtpEmail(user, code, purpose, settings.otpTtlMinutes);
  } catch (error) {
    row.delivery = "failed";
    row.expiresAt = new Date();
    await row.save();
    console.error("OTP email delivery failed:", error.message);
    const failure = new Error("Could not send the verification code. Ask an administrator to check the mail settings.");
    failure.status = 503;
    throw failure;
  }
  return row;
}

// Returns the matching user on success; throws an Error with .status otherwise.
async function consumeOtp(email, purpose, code) {
  const invalid = () => Object.assign(new Error("Code is invalid or expired"), { status: 400 });
  if (!/^\d{6}$/.test(code)) throw invalid();
  const user = await User.findOne({ email, active: true });
  if (!user) throw invalid();
  const row = await Otp.findOne({
    userId: user._id, purpose, usedAt: null, expiresAt: { $gt: new Date() }, attempts: { $lt: OTP_MAX_ATTEMPTS }
  }).sort({ createdAt: -1 });
  if (!row) throw invalid();
  const expected = Buffer.from(row.codeHash, "hex");
  const supplied = Buffer.from(hashOtp(user._id, purpose, code), "hex");
  if (!crypto.timingSafeEqual(expected, supplied)) {
    row.attempts += 1;
    if (row.attempts >= OTP_MAX_ATTEMPTS) row.expiresAt = new Date();
    await row.save();
    throw invalid();
  }
  row.usedAt = new Date();
  await row.save();
  return user;
}

async function sendOtpEmail(user, code, purpose, minutes) {
  const name = escapeHtml(user.name || "there");
  const reset = purpose === "reset";
  const heading = reset ? "Reset your password" : "Confirm your sign-in";
  const intro = reset ? "use this six-digit verification code to set a new password" : "use this six-digit code to finish signing in";
  await deliverMail(user.email, {
    subject: reset ? "Your Smart Energy Meter password reset code" : "Your Smart Energy Meter sign-in code",
    text: `Hello ${user.name || "there"},\n\nUse this six-digit code to ${reset ? "reset your Smart Energy Meter password" : "sign in to Smart Energy Meter"}:\n\n${code}\n\nThis code expires in ${minutes} minutes and can be used only once. If you did not request it, ignore this email${reset ? "" : " and consider changing your password"}.`,
    html: `<div style="margin:0;padding:32px 16px;background:#f1f5f9;font-family:Arial,sans-serif;color:#172033"><div style="max-width:520px;margin:0 auto;padding:32px;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px"><p style="margin:0 0 8px;color:#2563eb;font-weight:700">SMART ENERGY METER</p><h1 style="margin:0 0 16px;font-size:24px">${heading}</h1><p style="line-height:1.6">Hello ${name}, ${intro}:</p><div style="margin:24px 0;padding:16px;text-align:center;background:#eff6ff;border-radius:12px;color:#1d4ed8;font-size:32px;font-weight:800;letter-spacing:10px">${code}</div><p style="line-height:1.6">This code expires in <strong>${minutes} minutes</strong> and can be used only once.</p><p style="line-height:1.6;color:#64748b;font-size:13px">If you did not request this, ignore this email. Nobody can access your account without this code.</p></div></div>`
  }, `${purpose} code`);
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

// Sends one message to one address taken from the database and records the outcome in the activity log,
// so the admin can see exactly who each mail went to and why a delivery failed.
async function deliverMail(to, mail, kind) {
  const config = await getSmtpConfig();
  if (!config.host || !config.username || !config.password) throw new Error("SMTP is not configured.");
  try {
    const info = await createSmtpTransport(config).sendMail({ from: config.from, to, ...mail });
    if (!info.accepted?.length) throw new Error(`The mail server rejected ${to}`);
    await logActivity(null, "email-sent", to, kind);
  } catch (error) {
    await logActivity(null, "email-failed", to, `${kind}: ${error.message}`);
    throw error;
  }
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
    status: { $ne: 0 },
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
      ["Data collection", dataAllowed(report.meter) ? "Enabled" : subscriptionExpired(report.meter) ? "Paused: subscription expired" : "Disabled by administrator"],
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
  const reports = [];
  for (const meter of meters) reports.push(await buildEnergyReport(meter, days, endExclusive));
  await deliverMail(user.email, {
    subject: `Smart Energy Meter — ${title}`,
    text: renderEnergyReportText(user, reports, title),
    html: renderEnergyReportHtml(user, reports, title)
  }, title);
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

// Called on every authenticated ESP32 request. Keeps the meter's heartbeat fresh and records an
// "online" PresenceEvent (plus an "offline" one if the gap was missed by the sweeper) on a transition.
async function recordHeartbeat(meter, extra = {}) {
  const now = new Date();
  const set = { lastHeartbeat: now, ...extra };
  const stale = meter.presence === "online" && !online(meter);
  if (meter.presence === "online" && !stale) {
    const fresh = meter.lastHeartbeat && now - new Date(meter.lastHeartbeat) < 4000;
    if (fresh && !Object.keys(extra).length) return; // settings polls come every ~2 s; no need to write each one
    await Meter.updateOne({ _id: meter._id }, { $set: set });
    return;
  }
  const filter = { _id: meter._id, presence: meter.presence };
  if (stale) filter.lastHeartbeat = meter.lastHeartbeat;
  const claimed = await Meter.findOneAndUpdate(filter, { $set: { ...set, presence: "online", onlineSince: now } });
  if (!claimed) {
    await Meter.updateOne({ _id: meter._id }, { $set: set });
    return;
  }
  if (stale) await PresenceEvent.create({ meterId: meter.meterId, state: "offline", at: meter.lastHeartbeat });
  await PresenceEvent.create({ meterId: meter.meterId, state: "online", at: now });
}

// ---------- Health ----------
app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date() }));

// ---------- Paired ESP32 device APIs ----------
app.post("/api/meter/data", deviceAuth, async (req, res) => {
  try {
    const { meterId } = req.body;
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

    const id = String(meterId).toUpperCase();
    if (id !== req.deviceMeter.meterId) return res.status(403).json({ message: "Meter ID does not match paired device" });
    const dataEnabled = dataAllowed(req.deviceMeter);
    const { updateFrequency } = req.deviceMeter;
    const info = {
      ...(typeof req.body.firmware === "string" ? { firmware: req.body.firmware.slice(0, 20) } : {}),
      ...(Number.isFinite(req.body.rssi) ? { rssi: req.body.rssi } : {})
    };

    // Disabled (by the admin or an expired subscription): the ESP32 stays online and its readings are kept
    // with status 0 ("held"). Users cannot see them until data collection is enabled again.
    if (!dataEnabled) {
      await recordHeartbeat(req.deviceMeter, info);
      await Reading.create({ meterId: id, ...readings, status: 0, createdAt: new Date() });
      return res.json({ ok: true, stored: true, held: true, dataEnabled: false, updateFrequency });
    }

    const now = new Date();
    await recordHeartbeat(req.deviceMeter, { ...info, ...readings, lastSeen: now });
    await Reading.create({ meterId: id, ...readings, createdAt: now });
    res.json({ ok: true, stored: true, dataEnabled: true, updateFrequency });
  } catch (e) {
    console.error("meter/data", e);
    res.status(500).json({ message: "Meter data error" });
  }
});

app.get("/api/device/:meterId/settings", deviceAuth, async (req, res) => {
  await recordHeartbeat(req.deviceMeter);
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
    dataEnabled: dataAllowed(req.deviceMeter),
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
      await logActivity(user && user.active ? user : { name: email || "Unknown" }, "login-failed", email, `from ${req.ip}`);
      return res.status(401).json({ message: "Invalid email or password" });
    }
    const settings = await getAppSettings();
    if (user.role === "Admin" ? settings.otpForAdmins : settings.otpForUsers) {
      try {
        await issueOtp(user, "login", req);
      } catch (error) {
        return res.status(error.status || 500).json({ message: error.message });
      }
      return res.json({ otpRequired: true, email: user.email, ttlMinutes: settings.otpTtlMinutes });
    }
    await logActivity(user, "login", user.email, `from ${req.ip}`);
    res.json({
      token: tokenFor(user),
      user: { id: user._id, name: user.name, email: user.email, role: user.role }
    });
  } catch {
    res.status(500).json({ message: "Login error" });
  }
});

app.post("/api/auth/verify-otp", async (req, res) => {
  try {
    const email = String(req.body.email || "").toLowerCase().trim();
    const user = await consumeOtp(email, "login", String(req.body.code || ""));
    await logActivity(user, "login", user.email, `OTP verified, from ${req.ip}`);
    res.json({
      token: tokenFor(user),
      user: { id: user._id, name: user.name, email: user.email, role: user.role }
    });
  } catch (error) {
    res.status(error.status || 500).json({ message: error.status ? error.message : "Verification error" });
  }
});

app.post("/api/auth/resend-otp", async (req, res) => {
  try {
    const email = String(req.body.email || "").toLowerCase().trim();
    const user = await User.findOne({ email, active: true });
    // Only continue a login challenge that was started with a correct password.
    const pending = user && await Otp.exists({ userId: user._id, purpose: "login", createdAt: { $gt: new Date(Date.now() - 30 * 60000) } });
    if (user && pending) await issueOtp(user, "login", req);
    res.json({ message: "If a sign-in is in progress, a new code has been sent." });
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
});

app.post("/api/auth/logout", auth, async (req, res) => {
  await logActivity(req.user, "logout", req.user.email);
  res.json({ message: "Signed out" });
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
  const generic = { message: "If the account exists, a password reset code will arrive by email." };
  try {
    const email = String(req.body.email || "").toLowerCase().trim();
    const user = await User.findOne({ email, active: true });
    if (user) {
      try {
        await issueOtp(user, "reset", req);
      } catch (error) {
        if (error.status === 429) return res.json(generic);
        return res.status(error.status || 500).json({ message: error.message });
      }
    }
    res.json(generic);
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
    const user = await consumeOtp(email, "reset", code);
    user.password = await bcrypt.hash(password, 10);
    await user.save();
    await logActivity(user, "password-reset", user.email, "Reset with email OTP");
    res.json({ message: "Password reset successful. You can login now." });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message === "Code is invalid or expired" ? "Reset code is invalid or expired" : error.message });
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
  const onCount = meters.filter(dataAllowed).length;
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

// ---------- Wi-Fi provisioning (shared by admin and the meter's assigned user) ----------
async function wifiState(meter) {
  const full = await Meter.findById(meter._id).select("+deviceTokenHash").lean();
  const provision = await WifiProvisioning.findOne({ meterId: meter.meterId }).lean();
  return {
    meterId: meter.meterId,
    paired: Boolean(full?.deviceTokenHash),
    online: online(meter),
    lastSeen: meter.lastSeen,
    rssi: meter.rssi ?? null,
    status: provision?.status || "unconfigured",
    scanRequested: provision?.scanRequested || false,
    networks: provision?.networks || [],
    scannedAt: provision?.scannedAt || null,
    selectedSsid: provision?.selectedSsid || "",
    connectedAt: provision?.connectedAt || null,
    error: provision?.error || ""
  };
}

async function queueWifiScan(meter) {
  await WifiProvisioning.findOneAndUpdate(
    { meterId: meter.meterId },
    { $set: { scanRequested: true, status: "scan-requested", error: "" } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return { message: "Wi-Fi scan queued. The paired ESP32 must be online to return nearby networks." };
}

async function queueWifiConnect(meter, body) {
  const ssid = String(body.ssid || "");
  const password = String(body.password || "");
  if (!ssid || ssid.length > 32 || password.length > 63 || (password.length > 0 && password.length < 8)) {
    return { status: 400, message: "Choose a scanned network and provide a valid Wi-Fi password (8-63 characters, or blank for an open network)" };
  }
  const provision = await WifiProvisioning.findOne({ meterId: meter.meterId });
  if (!provision || !provision.networks.some(network => network.ssid === ssid)) {
    return { status: 400, message: "Select a network returned by the ESP32 scan first" };
  }
  let encrypted;
  try {
    encrypted = encryptWifiPassword(password);
  } catch (error) {
    return { status: 503, message: error.message };
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
  return { status: 200, message: "Wi-Fi settings encrypted and saved. The ESP32 will apply them when it next checks in.", wifiStatus: provision.status };
}

async function adminMeter(req, res) {
  const meter = await Meter.findOne({ meterId: req.params.meterId.toUpperCase() }).lean();
  if (!meter) res.status(404).json({ message: "Meter not found" });
  return meter;
}

// The signed-in user's own meter, only when the admin allowed user configuration.
async function ownMeter(req, res, needs = null) {
  const meter = await Meter.findOne({ meterId: req.params.meterId.toUpperCase(), userId: req.user._id }).lean();
  if (!meter) { res.status(404).json({ message: "Meter is not assigned to your account" }); return null; }
  if (needs && !meter[needs]) {
    res.status(403).json({ message: "Your administrator has not allowed you to configure this meter." });
    return null;
  }
  return meter;
}

app.get("/api/admin/meters/:meterId/wifi", auth, adminOnly, async (req, res) => {
  const meter = await adminMeter(req, res);
  if (meter) res.json(await wifiState(meter));
});

app.post("/api/admin/meters/:meterId/wifi/scan", auth, adminOnly, async (req, res) => {
  const meter = await adminMeter(req, res);
  if (meter) res.json(await queueWifiScan(meter));
});

app.post("/api/admin/meters/:meterId/wifi/connect", auth, adminOnly, async (req, res) => {
  const meter = await adminMeter(req, res);
  if (!meter) return;
  const result = await queueWifiConnect(meter, req.body);
  if (result.status !== 200) return res.status(result.status).json({ message: result.message });
  await logActivity(req.user, "wifi-connect", meter.meterId, `SSID ${req.body.ssid}`);
  res.json({ message: result.message, status: result.wifiStatus });
});

app.put("/api/admin/meters/:meterId/permissions", auth, adminOnly, async (req, res) => {
  const { userConfigAllowed } = req.body;
  const updates = {};
  if (userConfigAllowed !== undefined) {
    if (typeof userConfigAllowed !== "boolean") return res.status(400).json({ message: "userConfigAllowed must be true or false" });
    updates.userConfigAllowed = userConfigAllowed;
  }
  const meter = await Meter.findOneAndUpdate({ meterId: req.params.meterId.toUpperCase() }, { $set: updates }, { new: true }).populate("userId", "name email");
  if (!meter) return res.status(404).json({ message: "Meter not found" });
  await logActivity(req.user, "meter-permissions", meter.meterId, JSON.stringify(updates));
  res.json({ message: "User permissions updated", meter: publicMeter(meter) });
});

app.put("/api/admin/meters/:meterId/name", auth, adminOnly, async (req, res) => {
  const meterName = String(req.body.meterName || "").trim();
  if (meterName.length > 80) return res.status(400).json({ message: "Meter name must be 80 characters or fewer" });
  const meter = await Meter.findOneAndUpdate({ meterId: req.params.meterId.toUpperCase() }, { meterName }, { new: true }).populate("userId", "name email");
  if (!meter) return res.status(404).json({ message: "Meter not found" });
  res.json({ message: "Meter renamed", meter: publicMeter(meter) });
});

app.delete("/api/admin/meters/:meterId", auth, adminOnly, async (req, res) => {
  const meterId = req.params.meterId.toUpperCase();
  const meter = await Meter.findOneAndDelete({ meterId });
  if (!meter) return res.status(404).json({ message: "Meter not found" });
  await Promise.all([Reading.deleteMany({ meterId }), WifiProvisioning.deleteMany({ meterId }), PresenceEvent.deleteMany({ meterId })]);
  await logActivity(req.user, "meter-deleted", meterId);
  res.json({ message: "Meter and its readings were deleted" });
});

// Permanent: wipes every reading (including held ones), the online history and Wi-Fi jobs of a meter, and resets
// its settings, assignment and subscription to defaults. The meter record and its device token stay, so the
// ESP32 keeps working. Wallet history is a financial record and is not touched.
app.post("/api/admin/meters/:meterId/erase", auth, adminOnly, async (req, res) => {
  const meterId = req.params.meterId.toUpperCase();
  if (String(req.body.confirm || "").toUpperCase() !== meterId) return res.status(400).json({ message: `Type the meter ID (${meterId}) to confirm.` });
  const meter = await Meter.findOne({ meterId }).lean();
  if (!meter) return res.status(404).json({ message: "Meter not found" });
  const [readings, presence] = await Promise.all([
    Reading.deleteMany({ meterId }), PresenceEvent.deleteMany({ meterId }), WifiProvisioning.deleteMany({ meterId })
  ]);
  await Meter.updateOne({ _id: meter._id }, { $set: {
    meterName: "", userId: null, dataEnabled: true, disabledReason: "", userConfigAllowed: true, updateFrequency: 5,
    subscriptionEnd: null, autoRenewPlanId: null, expiryReminderFor: "", activeAlerts: [],
    voltage: null, current: null, power: null, energy: null, frequency: null, powerFactor: null,
    lastSeen: null, onlineSince: null, presence: "offline"
  } });
  await logActivity(req.user, "meter-erased", meterId, `${readings.deletedCount} readings, ${presence.deletedCount} presence events`);
  res.json({ message: `All data and settings of ${meterId} were erased (${readings.deletedCount} readings).` });
});

app.put("/api/admin/users/:id", auth, adminOnly, async (req, res) => {
  const updates = {};
  if (req.body.active !== undefined) {
    if (typeof req.body.active !== "boolean") return res.status(400).json({ message: "active must be true or false" });
    updates.active = req.body.active;
  }
  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name || name.length > 80) return res.status(400).json({ message: "Name must be 1 to 80 characters" });
    updates.name = name;
  }
  const user = await User.findOneAndUpdate({ _id: req.params.id, role: "User" }, { $set: updates }, { new: true }).select("-password");
  if (!user) return res.status(404).json({ message: "User not found" });
  await logActivity(req.user, "user-updated", user.email, JSON.stringify(updates));
  res.json({ message: "User updated", user });
});

app.post("/api/admin/users/:id/reset-password", auth, adminOnly, async (req, res) => {
  const password = String(req.body.password || "");
  if (password.length < 8) return res.status(400).json({ message: "Password must be at least 8 characters" });
  const user = await User.findOne({ _id: req.params.id, role: "User" });
  if (!user) return res.status(404).json({ message: "User not found" });
  user.password = await bcrypt.hash(password, 10);
  await user.save();
  await logActivity(req.user, "user-password-set", user.email);
  res.json({ message: "Password updated. Share it with the user securely." });
});

app.get("/api/admin/security", auth, adminOnly, async (req, res) => {
  const s = await getAppSettings();
  res.json({ otpForUsers: s.otpForUsers, otpForAdmins: s.otpForAdmins, otpTtlMinutes: s.otpTtlMinutes, alertAdminCopy: Boolean(s.alertAdminCopy) });
});

app.put("/api/admin/security", auth, adminOnly, async (req, res) => {
  const { otpForUsers, otpForAdmins } = req.body;
  const alertAdminCopy = req.body.alertAdminCopy === true;
  const otpTtlMinutes = Number(req.body.otpTtlMinutes);
  if (typeof otpForUsers !== "boolean" || typeof otpForAdmins !== "boolean") return res.status(400).json({ message: "Choose whether OTP login is required for users and admins." });
  if (!Number.isInteger(otpTtlMinutes) || otpTtlMinutes < 2 || otpTtlMinutes > 30) return res.status(400).json({ message: "OTP validity must be 2 to 30 minutes." });
  if (otpForUsers || otpForAdmins) {
    const smtp = await getSmtpConfig().catch(() => null);
    if (!smtp?.host || !smtp.username || !smtp.password) return res.status(400).json({ message: "Configure Mail delivery first; OTP codes are sent by email and you would be locked out otherwise." });
    if (otpForAdmins && !smtp.lastTestedAt) return res.status(400).json({ message: "Send a successful SMTP test email before requiring OTP for admins." });
  }
  await AppSettings.findOneAndUpdate({ key: "default" }, { $set: { otpForUsers, otpForAdmins, otpTtlMinutes, alertAdminCopy } }, { upsert: true, setDefaultsOnInsert: true });
  await logActivity(req.user, "security-settings", "otp", `users=${otpForUsers} admins=${otpForAdmins} ttl=${otpTtlMinutes} adminAlertCopy=${alertAdminCopy}`);
  res.json({ message: "Security settings saved" });
});

app.get("/api/admin/otps", auth, adminOnly, async (req, res) => {
  const rows = await Otp.find().sort({ createdAt: -1 }).limit(100).select("-codeHash").populate("userId", "name").lean();
  const now = Date.now();
  res.json(rows.map(row => ({
    _id: row._id, name: row.userId?.name || "(deleted)", email: row.email, purpose: row.purpose,
    createdAt: row.createdAt, expiresAt: row.expiresAt, attempts: row.attempts, usedAt: row.usedAt, ip: row.ip,
    state: row.usedAt ? "used" : row.delivery === "failed" ? "failed" : new Date(row.expiresAt).getTime() <= now ? "expired" : "active"
  })));
});

const SESSION_ACTIONS = ["login", "logout", "login-failed"];
const EMAIL_ACTIONS = ["email-sent", "email-failed"];
app.get("/api/admin/activity", auth, adminOnly, async (req, res) => {
  const filter = {};
  if (req.query.type === "sessions") filter.action = { $in: SESSION_ACTIONS };
  else if (req.query.type === "email") filter.action = { $in: EMAIL_ACTIONS };
  else if (req.query.type === "changes") filter.action = { $nin: [...SESSION_ACTIONS, ...EMAIL_ACTIONS] };
  res.json(await ActivityLog.find(filter).sort({ createdAt: -1 }).limit(300).lean());
});

// ---------- Garbage-value clean-up (admin) ----------
// A reading is "suspect" when a value is physically impossible for a single-phase PZEM-004T.
// Missing (null) values are not suspect; they are shown as unavailable everywhere else too.
const outOfRange = (field, min, max) => ({ [field]: { $type: "number", $not: { $gte: min, $lte: max } } });
const SUSPECT_FILTER = {
  $or: [
    outOfRange("voltage", 0, 300), outOfRange("current", 0, 100), outOfRange("power", 0, 25000),
    outOfRange("energy", 0, 100000), outOfRange("frequency", 40, 70), outOfRange("powerFactor", 0, 1)
  ]
};

// Makes every reading held (status 0) while data was disabled visible to the user, then refreshes the live values.
async function releaseHeldReadings(meterId) {
  const result = await Reading.updateMany({ meterId, status: 0 }, { $set: { status: 1 } });
  if (result.modifiedCount) await resyncMeterFromReadings(meterId);
  return result.modifiedCount;
}

// Puts the meter's "live" values back in line with the newest reading that remains after a delete.
async function resyncMeterFromReadings(meterId) {
  const latest = await Reading.findOne({ meterId, status: { $ne: 0 } }).sort({ createdAt: -1 }).lean();
  const set = latest
    ? { voltage: latest.voltage ?? null, current: latest.current ?? null, power: latest.power ?? null,
        energy: latest.energy ?? null, frequency: latest.frequency ?? null, powerFactor: latest.powerFactor ?? null, lastSeen: latest.createdAt }
    : { voltage: null, current: null, power: null, energy: null, frequency: null, powerFactor: null };
  await Meter.updateOne({ meterId }, { $set: set });
}

app.get("/api/admin/meters/:meterId/readings", auth, adminOnly, async (req, res) => {
  const meter = await adminMeter(req, res);
  if (!meter) return;
  const hours = Math.max(1, Math.min(24 * 90, Number(req.query.hours) || 24));
  const limit = Math.max(10, Math.min(500, Number(req.query.limit) || 200));
  const base = { meterId: meter.meterId, createdAt: { $gte: new Date(Date.now() - hours * 3600000) } };
  const filter = req.query.suspect === "1" ? { $and: [base, SUSPECT_FILTER] } : base;
  const [rows, suspectCount, heldCount] = await Promise.all([
    Reading.find(filter).sort({ createdAt: -1 }).limit(limit).lean(),
    Reading.countDocuments({ $and: [base, SUSPECT_FILTER] }),
    Reading.countDocuments({ meterId: meter.meterId, status: 0 })
  ]);
  res.json({ rows, suspectCount, heldCount });
});

app.post("/api/admin/meters/:meterId/readings/delete", auth, adminOnly, async (req, res) => {
  const meter = await adminMeter(req, res);
  if (!meter) return;
  let filter;
  if (req.body.suspectHours !== undefined) {
    const hours = Math.max(1, Math.min(24 * 90, Number(req.body.suspectHours) || 24));
    filter = { $and: [{ meterId: meter.meterId, createdAt: { $gte: new Date(Date.now() - hours * 3600000) } }, SUSPECT_FILTER] };
  } else {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.filter(id => /^[a-f\d]{24}$/i.test(String(id))) : [];
    if (!ids.length || ids.length > 500) return res.status(400).json({ message: "Select between 1 and 500 readings to delete." });
    filter = { meterId: meter.meterId, _id: { $in: ids } };
  }
  const result = await Reading.deleteMany(filter);
  await resyncMeterFromReadings(meter.meterId);
  await logActivity(req.user, "readings-deleted", meter.meterId, `${result.deletedCount} reading(s)`);
  res.json({ message: `${result.deletedCount} reading(s) deleted.`, deleted: result.deletedCount });
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
  await logActivity(req.user, "meter-assign", meterId, userId ? meter.userId?.email : "unassigned");
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

// ON: the ESP32 may store readings. OFF: it stays connected (shown online) but everything it sends is discarded.
app.put("/api/admin/meters/:meterId/data-enabled", auth, adminOnly, async (req, res) => {
  if (typeof req.body.dataEnabled !== "boolean") return res.status(400).json({ message: "dataEnabled must be true or false" });
  const target = await Meter.findOne({ meterId: req.params.meterId.toUpperCase() }).lean();
  if (!target) return res.status(404).json({ message: "Meter not found" });
  if (req.body.dataEnabled && subscriptionExpired(target)) {
    return res.status(400).json({ message: "This meter's subscription has expired. Extend the subscription (Subscriptions tab) to turn data collection back on." });
  }
  const meter = await Meter.findByIdAndUpdate(target._id, { dataEnabled: req.body.dataEnabled, disabledReason: req.body.dataEnabled ? "" : "admin" }, { new: true }).populate("userId", "name email");
  const released = req.body.dataEnabled ? await releaseHeldReadings(meter.meterId) : 0;
  await logActivity(req.user, "data-collection", meter.meterId, req.body.dataEnabled ? `enabled, ${released} held reading(s) released` : "disabled");
  res.json({
    message: req.body.dataEnabled
      ? `Data collection ON.${released ? ` ${released} reading(s) received while it was off are now visible to the user.` : ""}`
      : "Data collection OFF. The ESP32 stays connected; its readings are held (hidden) until you turn it back on.",
    meter: publicMeter(meter)
  });
});

// ---------- User ----------
app.get("/api/user/meters", auth, async (req, res) => {
  const meters = await Meter.find({ userId: req.user._id }).populate("userId", "name email").lean();
  res.json(meters.map(publicMeter));
});

// Everything the administrator has set up that applies to this user's meters (read-only for users).
app.get("/api/user/assigned-config", auth, async (req, res) => {
  const [slabs, settings, reports] = await Promise.all([
    TariffSlab.find().sort({ minKwh: 1 }).lean(),
    BillingSettings.findOne({ key: "default" }).lean(),
    ReportSettings.findOne({ key: "default" }).lean()
  ]);
  const meters = await Meter.find({ userId: req.user._id }).select("meterId meterName dataEnabled userConfigAllowed updateFrequency").lean();
  const { _id, key, createdAt, updatedAt, __v, ...billing } = settings || {};
  res.json({
    slabs: slabs.map(({ name, minKwh, maxKwh, ratePerKwh }) => ({ name, minKwh, maxKwh, ratePerKwh })),
    billing,
    reports: reports ? { dailyEnabled: reports.dailyEnabled, weeklyEnabled: reports.weeklyEnabled, monthlyEnabled: reports.monthlyEnabled, sendHour: reports.sendHour } : null,
    meters
  });
});

app.put("/api/user/meters/:meterId/settings", auth, async (req, res) => {
  const meter = await ownMeter(req, res, "userConfigAllowed");
  if (!meter) return;
  const updates = {};
  if (req.body.meterName !== undefined) {
    const meterName = String(req.body.meterName).trim();
    if (meterName.length > 80) return res.status(400).json({ message: "Meter name must be 80 characters or fewer" });
    updates.meterName = meterName;
  }
  if (req.body.updateFrequency !== undefined) {
    const frequency = Number(req.body.updateFrequency);
    if (!Number.isInteger(frequency) || frequency < 2 || frequency > 3600) return res.status(400).json({ message: "Reading interval must be 2 to 3600 seconds" });
    updates.updateFrequency = frequency;
  }
  const saved = await Meter.findByIdAndUpdate(meter._id, { $set: updates }, { new: true }).populate("userId", "name email");
  await logActivity(req.user, "meter-config", meter.meterId, JSON.stringify(updates));
  res.json({ message: "Meter settings saved. The ESP32 picks them up within seconds.", meter: publicMeter(saved) });
});

app.get("/api/user/meters/:meterId/wifi", auth, async (req, res) => {
  const meter = await ownMeter(req, res, "userConfigAllowed");
  if (meter) res.json(await wifiState(meter));
});

app.post("/api/user/meters/:meterId/wifi/scan", auth, async (req, res) => {
  const meter = await ownMeter(req, res, "userConfigAllowed");
  if (meter) res.json(await queueWifiScan(meter));
});

app.post("/api/user/meters/:meterId/wifi/connect", auth, async (req, res) => {
  const meter = await ownMeter(req, res, "userConfigAllowed");
  if (!meter) return;
  const result = await queueWifiConnect(meter, req.body);
  if (result.status !== 200) return res.status(result.status).json({ message: result.message });
  await logActivity(req.user, "wifi-connect", meter.meterId, `SSID ${req.body.ssid}`);
  res.json({ message: result.message, status: result.wifiStatus });
});

app.get("/api/meters/:meterId/export.csv", auth, async (req, res) => {
  const meter = await Meter.findOne({ meterId: req.params.meterId.toUpperCase() }).lean();
  if (!meter) return res.status(404).json({ message: "Meter not found" });
  if (req.user.role !== "Admin" && String(meter.userId) !== String(req.user._id)) return res.status(403).json({ message: "Access denied" });
  const days = Math.max(1, Math.min(90, Number(req.query.days) || 7));
  const rows = await Reading.find({ meterId: meter.meterId, status: { $ne: 0 }, createdAt: { $gte: new Date(Date.now() - days * 86400000) } })
    .sort({ createdAt: 1 }).limit(50000).lean();
  const cell = v => v == null ? "" : v;
  const csv = ["time_ist,voltage_v,current_a,power_w,energy_kwh,frequency_hz,power_factor"]
    .concat(rows.map(r => [
      new Date(r.createdAt).toLocaleString("sv-SE", { timeZone: "Asia/Kolkata" }),
      cell(r.voltage), cell(r.current), cell(r.power), cell(r.energy), cell(r.frequency), cell(r.powerFactor)
    ].join(","))).join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${meter.meterId}-${days}d.csv"`);
  res.send(csv);
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
    { $match: { meterId: meter.meterId, status: { $ne: 0 }, energy: { $type: "number" }, createdAt: { $gte: monthStart, $lte: end } } },
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
  let settings = await BillingSettings.findOne({ key: "default" }).lean() || {};
  // The meter's owner sees alerts against their own limits where they have set any.
  if (req.user.role !== "Admin") settings = { ...settings, ...userLimitOverrides(req.user) };
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
    { $match: { meterId: meter.meterId, status: { $ne: 0 }, energy: { $type: "number" }, createdAt: { $gte: start, $lte: end } } },
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
    meterId: meter.meterId, status: { $ne: 0 }, power: { $type: "number" }, createdAt: { $gte: start, $lte: end }
  }).sort({ power: -1 }).select("power createdAt").lean();
  const recentReadings = await Reading.find({ meterId: meter.meterId, status: { $ne: 0 }, power: { $type: "number" } })
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
  const rows = await Reading.find({ meterId: meter.meterId, status: { $ne: 0 } }).sort({ createdAt: -1 }).limit(limit).lean();
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
    // The test goes to the signed-in admin, or to any registered user the admin picks.
    let recipient = req.user.email;
    if (req.body.to) {
      const target = await User.findOne({ email: String(req.body.to).toLowerCase().trim(), active: true }).select("email");
      if (!target) return res.status(400).json({ message: "That address does not belong to an active user." });
      recipient = target.email;
    }
    await createSmtpTransport(config).verify();
    await deliverMail(recipient, {
      subject: "Smart Energy Meter SMTP test",
      text: `SMTP is configured and working.\nTest requested by ${req.user.email}.`
    }, "SMTP test");
    const lastTestedAt = new Date();
    await SmtpSettings.updateOne({ key: "default" }, { $set: { lastTestedAt } });
    res.json({ message: `Test email sent to ${recipient}.`, lastTestedAt });
  } catch (error) {
    console.error("SMTP test failed:", error.message);
    res.status(502).json({ message: `SMTP test failed: ${error.message}` });
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

// ---------- Subscription wallet ----------
// The wallet pays for the monitoring SERVICE (a subscription per meter). It is unrelated to the
// electricity cost estimates, which are informational only.
const UPLOAD_DIR = path.join(__dirname, "uploads");
const rupees = paise => Number((paise / 100).toFixed(2));
const OBJECT_ID = /^[a-f\d]{24}$/i;
const MAX_RECHARGE_PAISE = 10000000; // Rs 1,00,000 per request
const IMAGE_TYPES = {
  png: { ext: "png", mime: "image/png", ok: b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  jpeg: { ext: "jpg", mime: "image/jpeg", ok: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  webp: { ext: "webp", mime: "image/webp", ok: b => b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" }
};

function badRequest(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

// Validates a data:image/...;base64 upload (type, size and magic bytes) and stores it under uploads/.
async function saveImage(dataUrl, baseName) {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!match) throw badRequest("Upload a PNG, JPG or WebP image.");
  const type = IMAGE_TYPES[match[1]];
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length < 200 || bytes.length > 3.5 * 1024 * 1024) throw badRequest("The image must be under 3.5 MB.");
  if (!type.ok(bytes)) throw badRequest("That file is not a valid image.");
  await fs.promises.mkdir(UPLOAD_DIR, { recursive: true });
  const file = `${baseName}.${type.ext}`;
  await fs.promises.writeFile(path.join(UPLOAD_DIR, file), bytes);
  return file;
}

function sendImage(res, file) {
  const match = /\.(png|jpg|webp)$/.exec(file || "");
  if (!match || !/^[a-f\d]{24}\.|^qr-\d+\./.test(file)) return res.status(404).json({ message: "Image not found" });
  const mime = Object.values(IMAGE_TYPES).find(type => type.ext === match[1]).mime;
  res.setHeader("Content-Type", mime);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, max-age=300");
  res.sendFile(path.join(UPLOAD_DIR, file), error => { if (error && !res.headersSent) res.status(404).json({ message: "Image not found" }); });
}

async function removeUpload(file) {
  if (file && /^[\w.-]+$/.test(file)) await fs.promises.unlink(path.join(UPLOAD_DIR, file)).catch(() => {});
}

async function creditWallet(userId, paise, fields) {
  const user = await User.findByIdAndUpdate(userId, { $inc: { walletBalancePaise: paise } }, { new: true }).select("walletBalancePaise");
  await WalletTxn.create({ userId, type: "credit", amountPaise: paise, balanceAfterPaise: user.walletBalancePaise, ...fields });
  return user.walletBalancePaise;
}

// Atomic: the balance can never go negative. Returns the new balance, or null when funds are insufficient.
async function debitWallet(userId, paise, fields) {
  const user = await User.findOneAndUpdate({ _id: userId, walletBalancePaise: { $gte: paise } }, { $inc: { walletBalancePaise: -paise } }, { new: true }).select("walletBalancePaise");
  if (!user) return null;
  await WalletTxn.create({ userId, type: "debit", amountPaise: paise, balanceAfterPaise: user.walletBalancePaise, ...fields });
  return user.walletBalancePaise;
}

// New end date when `days` are added: from the current end if still running, otherwise from now.
function extendedEnd(meter, days) {
  const current = meter.subscriptionEnd ? new Date(meter.subscriptionEnd).getTime() : 0;
  return new Date(Math.max(current, Date.now()) + days * 86400000);
}

// An admin-disabled meter stays disabled when its subscription is renewed.
function renewalPatch(meter, end) {
  const set = { subscriptionEnd: end, expiryReminderFor: "" };
  if (meter.dataEnabled !== false || meter.disabledReason === "subscription") Object.assign(set, { dataEnabled: true, disabledReason: "" });
  return set;
}

async function activatePlan(user, meter, plan, reason) {
  const balance = await debitWallet(user._id, plan.pricePaise, { reason, note: `${plan.name} (${plan.days} days)`, meterId: meter.meterId });
  if (balance === null) return null;
  const end = extendedEnd(meter, plan.days);
  const patch = renewalPatch(meter, end);
  await Meter.updateOne({ _id: meter._id }, { $set: patch });
  const released = patch.dataEnabled ? await releaseHeldReadings(meter.meterId) : 0;
  return { balance, end, released };
}

const istDateTime = date => new Date(date).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
const money2 = paise => `₹${(paise / 100).toFixed(2)}`;

// Short notification mail to a user; failures are recorded in the activity log by deliverMail.
async function notifyUser(user, subject, lines, kind) {
  const html = `<div style="padding:28px 12px;background:#f1f5f9;font-family:Arial,sans-serif;color:#172033"><main style="max-width:560px;margin:auto;padding:28px;background:#fff;border:1px solid #e2e8f0;border-radius:16px"><p style="margin:0 0 8px;color:#2563eb;font-weight:700">SMART ENERGY METER</p><h1 style="margin:0 0 12px;font-size:22px">${escapeHtml(subject)}</h1><p>Hello ${escapeHtml(user.name || "there")},</p>${lines.map(l => `<p style="line-height:1.6">${escapeHtml(l)}</p>`).join("")}</main></div>`;
  try {
    await deliverMail(user.email, { subject: `Smart Energy Meter — ${subject}`, text: `Hello ${user.name || "there"},\n\n${lines.join("\n\n")}`, html }, kind);
    return true;
  } catch (error) {
    console.error(`${kind} e-mail to ${user.email} failed:`, error.message);
    return false;
  }
}

function receiptEmail(user, payment, balancePaise) {
  const rows = [
    ["Receipt no.", payment.receiptNo], ["Date", istDateTime(payment.reviewedAt)], ["Amount credited", money2(payment.amountPaise)],
    ["UPI reference (UTR)", payment.utr], ["Wallet balance now", money2(balancePaise)], ["Approved by", "Smart Energy Meter administrator"]
  ];
  const html = `<div style="padding:28px 12px;background:#f1f5f9;font-family:Arial,sans-serif;color:#172033"><main style="max-width:560px;margin:auto;padding:28px;background:#fff;border:1px solid #e2e8f0;border-radius:16px"><p style="margin:0 0 8px;color:#2563eb;font-weight:700">SMART ENERGY METER</p><h1 style="margin:0 0 4px;font-size:22px">Payment received ✓</h1><p style="color:#64748b;margin:0 0 16px">Hello ${escapeHtml(user.name || "there")}, your wallet recharge was approved.</p><table style="width:100%;border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="padding:9px 6px;border-bottom:1px solid #e2e8f0;color:#64748b">${k}</td><td style="padding:9px 6px;border-bottom:1px solid #e2e8f0;font-weight:700;text-align:right">${escapeHtml(v)}</td></tr>`).join("")}</table><p style="color:#64748b;font-size:12px;margin-top:16px">This is a receipt for a prepaid wallet top-up used to pay the meter-monitoring subscription. It is not an electricity bill.</p></main></div>`;
  const text = `Payment received\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\nThis is a receipt for a prepaid wallet top-up for the meter-monitoring subscription, not an electricity bill.`;
  return { subject: `Smart Energy Meter — Payment receipt ${payment.receiptNo}`, text, html };
}

function paymentView(p) {
  return { _id: p._id, amount: rupees(p.amountPaise), utr: p.utr, status: p.status, receiptNo: p.receiptNo, adminNote: p.adminNote, createdAt: p.createdAt, reviewedAt: p.reviewedAt };
}

function planView(p) {
  return { _id: p._id, name: p.name, price: rupees(p.pricePaise), days: p.days, active: p.active };
}

async function paymentConfig() {
  const s = await getAppSettings();
  return { upiId: s.upiId || "", payeeName: s.payeeName || "", instructions: s.payInstructions || "", minRecharge: rupees(s.minRechargePaise ?? 1000), hasQr: Boolean(s.qrFile) };
}

// --- user side ---
app.get("/api/user/wallet", auth, async (req, res) => {
  const [user, txns, payments, plans, pay, meters] = await Promise.all([
    User.findById(req.user._id).select("walletBalancePaise").lean(),
    WalletTxn.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(50).lean(),
    PaymentRequest.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(20).lean(),
    Plan.find({ active: true }).sort({ pricePaise: 1 }).lean(),
    paymentConfig(),
    Meter.find({ userId: req.user._id }).lean()
  ]);
  res.json({
    balance: rupees(user?.walletBalancePaise || 0),
    txns: txns.map(t => ({ _id: t._id, type: t.type, amount: rupees(t.amountPaise), balanceAfter: rupees(t.balanceAfterPaise), reason: t.reason, note: t.note, meterId: t.meterId, createdAt: t.createdAt })),
    payments: payments.map(paymentView),
    plans: plans.map(planView),
    pay,
    meters: meters.map(m => {
      const v = publicMeter(m);
      return { meterId: v.meterId, meterName: v.meterName, online: v.online, dataEnabled: v.dataEnabled, disabledReason: v.disabledReason,
        subscriptionEnd: v.subscriptionEnd || null, daysLeft: v.daysLeft, subscriptionExpired: v.subscriptionExpired, autoRenewPlanId: m.autoRenewPlanId || null };
    })
  });
});

app.post("/api/user/payments", auth, uploadJson, async (req, res) => {
  let file = "";
  try {
    const pay = await paymentConfig();
    if (!pay.upiId && !pay.hasQr) return res.status(503).json({ message: "Payments are not set up yet. Please contact the administrator." });
    const amountPaise = Math.round(Number(req.body.amount) * 100);
    if (!Number.isFinite(amountPaise) || amountPaise < Math.round(pay.minRecharge * 100) || amountPaise > MAX_RECHARGE_PAISE) {
      return res.status(400).json({ message: `Enter an amount between ₹${pay.minRecharge} and ₹${MAX_RECHARGE_PAISE / 100}.` });
    }
    const utr = String(req.body.utr || "").trim().toUpperCase().replace(/\s+/g, "");
    if (!/^[A-Z0-9]{6,30}$/.test(utr)) return res.status(400).json({ message: "Enter the UPI reference / UTR number shown in your payment app (6-30 letters or digits)." });
    if (await PaymentRequest.countDocuments({ userId: req.user._id, status: "pending" }) >= 5) {
      return res.status(429).json({ message: "You already have 5 payments waiting for approval. Please wait for the administrator to review them." });
    }
    file = await saveImage(req.body.screenshot, crypto.randomBytes(12).toString("hex"));
    let payment;
    try {
      payment = await PaymentRequest.create({ userId: req.user._id, amountPaise, utr, screenshotFile: file });
    } catch (error) {
      await removeUpload(file);
      if (error.code === 11000) return res.status(409).json({ message: "A payment with this UTR was already submitted." });
      throw error;
    }
    await logActivity(req.user, "payment-submitted", req.user.email, `${money2(amountPaise)} UTR ${utr}`);
    res.status(201).json({ message: "Payment submitted. The administrator will verify it and your wallet will be credited after approval.", payment: paymentView(payment) });
    // Tell the admins there is something to review (best effort, after responding).
    User.find({ role: "Admin", active: true }).select("name email").lean().then(admins => Promise.all(admins.map(admin =>
      notifyUser(admin, "Payment waiting for approval", [`${req.user.name} (${req.user.email}) submitted ${money2(amountPaise)} (UTR ${utr}). Open Payments in the admin dashboard to review the screenshot.`], "payment pending")))).catch(() => {});
  } catch (error) {
    await removeUpload(file);
    if (error.status) return res.status(error.status).json({ message: error.message });
    console.error("Payment submit failed:", error);
    res.status(500).json({ message: "Could not submit the payment." });
  }
});

app.get("/api/payments/:id/screenshot", auth, async (req, res) => {
  if (!OBJECT_ID.test(req.params.id)) return res.status(404).json({ message: "Not found" });
  const payment = await PaymentRequest.findById(req.params.id).lean();
  if (!payment || (req.user.role !== "Admin" && String(payment.userId) !== String(req.user._id))) return res.status(404).json({ message: "Not found" });
  sendImage(res, payment.screenshotFile);
});

app.get("/api/payment/qr", auth, async (req, res) => {
  const settings = await getAppSettings();
  if (!settings.qrFile) return res.status(404).json({ message: "No QR uploaded" });
  sendImage(res, settings.qrFile);
});

app.post("/api/user/meters/:meterId/subscribe", auth, async (req, res) => {
  const meter = await ownMeter(req, res);
  if (!meter) return;
  const plan = OBJECT_ID.test(String(req.body.planId)) ? await Plan.findOne({ _id: req.body.planId, active: true }) : null;
  if (!plan) return res.status(400).json({ message: "Choose an available plan." });
  const result = await activatePlan(req.user, meter, plan, "subscription");
  if (!result) return res.status(402).json({ message: `Your wallet has too little balance for ${plan.name} (${money2(plan.pricePaise)}). Recharge your wallet first.` });
  await logActivity(req.user, "subscription", meter.meterId, `${plan.name} until ${istDateTime(result.end)}`);
  notifyUser(req.user, "Subscription active", [`${meter.meterName || meter.meterId} is subscribed until ${istDateTime(result.end)} (${plan.name}, ${money2(plan.pricePaise)} paid from your wallet). Remaining balance: ${money2(result.balance)}.`], "subscription");
  res.json({ message: `Subscribed until ${istDateTime(result.end)}.`, balance: rupees(result.balance), subscriptionEnd: result.end });
});

app.put("/api/user/meters/:meterId/auto-renew", auth, async (req, res) => {
  const meter = await ownMeter(req, res);
  if (!meter) return;
  let planId = null;
  if (req.body.planId) {
    const plan = OBJECT_ID.test(String(req.body.planId)) ? await Plan.findOne({ _id: req.body.planId, active: true }).lean() : null;
    if (!plan) return res.status(400).json({ message: "Choose an available plan." });
    planId = plan._id;
  }
  await Meter.updateOne({ _id: meter._id }, { $set: { autoRenewPlanId: planId } });
  res.json({ message: planId ? "Auto-renew is on. The wallet will be charged when the subscription ends." : "Auto-renew is off." });
});

// --- admin side ---
app.get("/api/admin/payment-settings", auth, adminOnly, async (req, res) => res.json(await paymentConfig()));

app.put("/api/admin/payment-settings", auth, adminOnly, async (req, res) => {
  const upiId = String(req.body.upiId || "").trim();
  const payeeName = String(req.body.payeeName || "").trim();
  const instructions = String(req.body.instructions || "").trim().slice(0, 400);
  const minRecharge = Number(req.body.minRecharge);
  if (upiId && !/^[\w.\-]{2,256}@[a-zA-Z][a-zA-Z0-9.\-]{1,64}$/.test(upiId)) return res.status(400).json({ message: "Enter a valid UPI ID such as name@bank." });
  if (payeeName.length > 80) return res.status(400).json({ message: "Payee name must be 80 characters or fewer." });
  if (!Number.isFinite(minRecharge) || minRecharge < 1 || minRecharge > 100000) return res.status(400).json({ message: "Minimum recharge must be between ₹1 and ₹1,00,000." });
  await AppSettings.updateOne({ key: "default" }, { $set: { upiId, payeeName, payInstructions: instructions, minRechargePaise: Math.round(minRecharge * 100) } }, { upsert: true });
  await logActivity(req.user, "payment-settings", upiId || "(no UPI id)", "updated");
  res.json({ message: "Payment settings saved.", ...(await paymentConfig()) });
});

app.post("/api/admin/payment-qr", auth, adminOnly, uploadJson, async (req, res) => {
  try {
    const settings = await getAppSettings();
    const file = await saveImage(req.body.image, `qr-${Date.now()}`);
    await AppSettings.updateOne({ key: "default" }, { $set: { qrFile: file } });
    await removeUpload(settings.qrFile);
    await logActivity(req.user, "payment-qr", "uploaded");
    res.json({ message: "Payment QR uploaded." });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    console.error("QR upload failed:", error);
    res.status(500).json({ message: "Could not save the QR image." });
  }
});

app.delete("/api/admin/payment-qr", auth, adminOnly, async (req, res) => {
  const settings = await getAppSettings();
  await AppSettings.updateOne({ key: "default" }, { $set: { qrFile: "" } });
  await removeUpload(settings.qrFile);
  res.json({ message: "Payment QR removed." });
});

app.get("/api/admin/payments", auth, adminOnly, async (req, res) => {
  const filter = ["pending", "approved", "rejected"].includes(req.query.status) ? { status: req.query.status } : {};
  const [rows, pending] = await Promise.all([
    PaymentRequest.find(filter).sort({ createdAt: -1 }).limit(200).populate("userId", "name email").lean(),
    PaymentRequest.countDocuments({ status: "pending" })
  ]);
  res.json({ pending, payments: rows.map(p => ({ ...paymentView(p), user: p.userId ? { name: p.userId.name, email: p.userId.email } : null, reviewedBy: p.reviewedBy })) });
});

app.post("/api/admin/payments/:id/approve", auth, adminOnly, async (req, res) => {
  if (!OBJECT_ID.test(req.params.id)) return res.status(404).json({ message: "Payment not found" });
  const existing = await PaymentRequest.findById(req.params.id).lean();
  if (!existing) return res.status(404).json({ message: "Payment not found" });
  let amountPaise = existing.amountPaise;
  if (req.body.amount !== undefined && req.body.amount !== "") {
    amountPaise = Math.round(Number(req.body.amount) * 100);
    if (!Number.isFinite(amountPaise) || amountPaise < 100 || amountPaise > MAX_RECHARGE_PAISE) return res.status(400).json({ message: "Enter a valid amount to credit." });
  }
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).replaceAll("-", "");
  // Claiming pending -> approved first makes a double click or two admins crediting twice impossible.
  const payment = await PaymentRequest.findOneAndUpdate(
    { _id: existing._id, status: "pending" },
    { $set: { status: "approved", amountPaise, receiptNo: `RCP-${day}-${String(existing._id).slice(-6).toUpperCase()}`, reviewedBy: req.user.email, reviewedAt: new Date(), adminNote: String(req.body.note || "").slice(0, 240) } },
    { new: true }
  );
  if (!payment) return res.status(409).json({ message: "This payment was already reviewed." });
  let balance;
  try {
    balance = await creditWallet(payment.userId, amountPaise, { reason: "recharge", note: `UPI ${payment.utr} · ${payment.receiptNo}`, paymentId: payment._id, by: req.user.email });
  } catch (error) {
    await PaymentRequest.updateOne({ _id: payment._id }, { $set: { status: "pending", receiptNo: "", reviewedBy: "", reviewedAt: null } });
    console.error("Wallet credit failed:", error);
    return res.status(500).json({ message: "Could not credit the wallet; the payment is still pending." });
  }
  await logActivity(req.user, "payment-approved", payment.receiptNo, `${money2(amountPaise)} for user ${payment.userId}`);
  const user = await User.findById(payment.userId).select("name email").lean();
  let emailed = false;
  if (user) {
    try {
      await deliverMail(user.email, receiptEmail(user, payment, balance), `receipt ${payment.receiptNo}`);
      emailed = true;
    } catch (error) {
      console.error("Receipt e-mail failed:", error.message);
    }
  }
  checkSubscriptions(); // lets an expired auto-renew meter pick up the new balance immediately
  res.json({ message: emailed ? `Approved. ${money2(amountPaise)} credited and receipt e-mailed to ${user.email}.` : `Approved and credited, but the receipt e-mail could not be sent (see Activity log → E-mail deliveries).`, emailed });
});

app.post("/api/admin/payments/:id/reject", auth, adminOnly, async (req, res) => {
  if (!OBJECT_ID.test(req.params.id)) return res.status(404).json({ message: "Payment not found" });
  const note = String(req.body.note || "").trim().slice(0, 240);
  if (!note) return res.status(400).json({ message: "Give the user a reason for rejecting this payment." });
  const payment = await PaymentRequest.findOneAndUpdate({ _id: req.params.id, status: "pending" },
    { $set: { status: "rejected", adminNote: note, reviewedBy: req.user.email, reviewedAt: new Date() } }, { new: true });
  if (!payment) return res.status(409).json({ message: "This payment was already reviewed or does not exist." });
  await logActivity(req.user, "payment-rejected", payment.utr, note);
  const user = await User.findById(payment.userId).select("name email").lean();
  if (user) notifyUser(user, "Payment not approved", [`Your payment of ${money2(payment.amountPaise)} (UTR ${payment.utr}) could not be approved.`, `Reason: ${note}`, "If you believe this is a mistake, submit the payment again with a clear screenshot or contact your administrator."], "payment rejected");
  res.json({ message: "Payment rejected and the user was notified." });
});

app.get("/api/admin/subscriptions", auth, adminOnly, async (req, res) => {
  const [users, meters, plans] = await Promise.all([
    User.find({ role: "User" }).select("name email active walletBalancePaise").sort({ name: 1 }).lean(),
    Meter.find().populate("userId", "name email").sort({ meterId: 1 }).lean(),
    Plan.find().sort({ pricePaise: 1 }).lean()
  ]);
  res.json({
    users: users.map(u => ({ _id: u._id, name: u.name, email: u.email, active: u.active, balance: rupees(u.walletBalancePaise || 0) })),
    meters: meters.map(m => { const v = publicMeter(m); return { meterId: v.meterId, meterName: v.meterName, user: v.user, online: v.online, dataEnabled: v.dataEnabled,
      disabledReason: v.disabledReason, subscriptionEnd: v.subscriptionEnd || null, daysLeft: v.daysLeft, subscriptionExpired: v.subscriptionExpired }; }),
    plans: plans.map(planView)
  });
});

function parsePlan(body) {
  const name = String(body.name || "").trim();
  const price = Number(body.price);
  const days = Number(body.days);
  if (!name || name.length > 60) throw badRequest("Plan name must be 1 to 60 characters.");
  if (!Number.isFinite(price) || price < 1 || price > 100000) throw badRequest("Plan price must be between ₹1 and ₹1,00,000.");
  if (!Number.isInteger(days) || days < 1 || days > 3660) throw badRequest("Plan length must be 1 to 3660 days.");
  return { name, pricePaise: Math.round(price * 100), days };
}

app.post("/api/admin/plans", auth, adminOnly, async (req, res) => {
  try {
    const plan = await Plan.create(parsePlan(req.body));
    await logActivity(req.user, "plan-created", plan.name, `${money2(plan.pricePaise)} / ${plan.days} days`);
    res.status(201).json({ message: "Plan created.", plan: planView(plan) });
  } catch (error) { res.status(error.status || 500).json({ message: error.status ? error.message : "Could not create the plan." }); }
});

app.put("/api/admin/plans/:id", auth, adminOnly, async (req, res) => {
  try {
    if (!OBJECT_ID.test(req.params.id)) return res.status(404).json({ message: "Plan not found" });
    const updates = req.body.name !== undefined ? parsePlan(req.body) : {};
    if (req.body.active !== undefined) {
      if (typeof req.body.active !== "boolean") return res.status(400).json({ message: "active must be true or false" });
      updates.active = req.body.active;
    }
    const plan = await Plan.findByIdAndUpdate(req.params.id, { $set: updates }, { new: true });
    if (!plan) return res.status(404).json({ message: "Plan not found" });
    res.json({ message: "Plan saved.", plan: planView(plan) });
  } catch (error) { res.status(error.status || 500).json({ message: error.status ? error.message : "Could not save the plan." }); }
});

app.delete("/api/admin/plans/:id", auth, adminOnly, async (req, res) => {
  if (!OBJECT_ID.test(req.params.id)) return res.status(404).json({ message: "Plan not found" });
  await Plan.deleteOne({ _id: req.params.id });
  await Meter.updateMany({ autoRenewPlanId: req.params.id }, { $set: { autoRenewPlanId: null } });
  res.json({ message: "Plan deleted." });
});

app.post("/api/admin/users/:id/wallet", auth, adminOnly, async (req, res) => {
  if (!OBJECT_ID.test(req.params.id)) return res.status(404).json({ message: "User not found" });
  const user = await User.findOne({ _id: req.params.id, role: "User" }).select("name email").lean();
  if (!user) return res.status(404).json({ message: "User not found" });
  const amountPaise = Math.round(Number(req.body.amount) * 100);
  const type = req.body.type === "debit" ? "debit" : "credit";
  const note = String(req.body.note || "").trim().slice(0, 240);
  if (!Number.isFinite(amountPaise) || amountPaise < 100 || amountPaise > MAX_RECHARGE_PAISE) return res.status(400).json({ message: "Enter an amount between ₹1 and ₹1,00,000." });
  if (!note) return res.status(400).json({ message: "Add a note explaining this adjustment." });
  const fields = { reason: type === "credit" ? "admin-credit" : "admin-debit", note, by: req.user.email };
  const balance = type === "credit" ? await creditWallet(user._id, amountPaise, fields) : await debitWallet(user._id, amountPaise, fields);
  if (balance === null) return res.status(400).json({ message: "The wallet balance is lower than that amount." });
  await logActivity(req.user, `wallet-${type}`, user.email, `${money2(amountPaise)} — ${note}`);
  if (type === "credit") notifyUser(user, "Wallet credited", [`${money2(amountPaise)} was added to your wallet by the administrator (${note}). New balance: ${money2(balance)}.`], "wallet credit");
  checkSubscriptions();
  res.json({ message: `Wallet ${type === "credit" ? "credited" : "debited"}. New balance ${money2(balance)}.`, balance: rupees(balance) });
});

app.put("/api/admin/meters/:meterId/subscription", auth, adminOnly, async (req, res) => {
  const meter = await Meter.findOne({ meterId: req.params.meterId.toUpperCase() }).lean();
  if (!meter) return res.status(404).json({ message: "Meter not found" });
  let set;
  if (req.body.clear === true) {
    set = { subscriptionEnd: null, expiryReminderFor: "" };
    if (meter.disabledReason === "subscription") Object.assign(set, { dataEnabled: true, disabledReason: "" });
  } else {
    const days = Number(req.body.days);
    if (!Number.isInteger(days) || days < 1 || days > 3660) return res.status(400).json({ message: "Enter 1 to 3660 days to add." });
    set = renewalPatch(meter, extendedEnd(meter, days));
  }
  await Meter.updateOne({ _id: meter._id }, { $set: set });
  if (set.dataEnabled) await releaseHeldReadings(meter.meterId);
  await logActivity(req.user, "subscription-admin", meter.meterId, req.body.clear === true ? "removed (no expiry)" : `+${req.body.days} days`);
  res.json({ message: req.body.clear === true ? "Subscription limit removed; the meter never expires." : `Added ${req.body.days} day(s).` });
});

let subscriptionCheckRunning = false;
async function checkSubscriptions() {
  if (subscriptionCheckRunning) return;
  subscriptionCheckRunning = true;
  try {
    const now = new Date();
    const expired = await Meter.find({ subscriptionEnd: { $ne: null, $lte: now }, dataEnabled: { $ne: false } }).populate("userId", "name email active").lean();
    for (const meter of expired) {
      const user = meter.userId;
      const label = meter.meterName || meter.meterId;
      if (user?.active && meter.autoRenewPlanId) {
        const plan = await Plan.findOne({ _id: meter.autoRenewPlanId, active: true }).lean();
        const renewed = plan && await activatePlan(user, meter, plan, "auto-renew");
        if (renewed) {
          await logActivity(user, "auto-renew", meter.meterId, `${plan.name} until ${istDateTime(renewed.end)}`);
          notifyUser(user, "Subscription auto-renewed", [`${label} was renewed automatically with ${plan.name} (${money2(plan.pricePaise)}). New end date: ${istDateTime(renewed.end)}. Wallet balance: ${money2(renewed.balance)}.`], "auto-renew");
          continue;
        }
      }
      const result = await Meter.updateOne({ _id: meter._id, dataEnabled: { $ne: false } }, { $set: { dataEnabled: false, disabledReason: "subscription" } });
      if (!result.modifiedCount) continue;
      await logActivity(null, "subscription-expired", meter.meterId, "data collection disabled automatically");
      if (user) notifyUser(user, "Subscription expired", [`The subscription for ${label} has ended, so data collection is switched off. The meter stays connected but no new readings are saved.`, meter.autoRenewPlanId ? "Auto-renew could not charge your wallet because the balance is too low." : "Recharge your wallet and renew the subscription from the Wallet tab to resume."], "subscription expired");
    }
    const soon = await Meter.find({ subscriptionEnd: { $gt: now, $lte: new Date(now.getTime() + 3 * 86400000) }, userId: { $ne: null }, dataEnabled: { $ne: false } }).populate("userId", "name email active").lean();
    for (const meter of soon) {
      const key = new Date(meter.subscriptionEnd).toISOString();
      if (meter.expiryReminderFor === key || !meter.userId?.active) continue;
      await Meter.updateOne({ _id: meter._id }, { $set: { expiryReminderFor: key } });
      notifyUser(meter.userId, "Subscription ending soon", [`The subscription for ${meter.meterName || meter.meterId} ends on ${istDateTime(meter.subscriptionEnd)}. Keep enough balance in your wallet and renew it from the Wallet tab so your readings keep being saved.`], "subscription reminder");
    }
  } catch (error) {
    console.error("Subscription check failed:", error);
  } finally {
    subscriptionCheckRunning = false;
  }
}

// ---------- Online / offline timeline ----------
app.get("/api/meters/:meterId/presence", auth, async (req, res) => {
  const meter = await Meter.findOne({ meterId: req.params.meterId.toUpperCase() }).lean();
  if (!meter) return res.status(404).json({ message: "Meter not found" });
  if (req.user.role !== "Admin" && String(meter.userId) !== String(req.user._id)) return res.status(403).json({ message: "Access denied" });

  const today = indiaStart().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || "")) ? String(req.query.date) : today;
  const dayStart = new Date(`${date}T00:00:00+05:30`);
  if (Number.isNaN(dayStart.getTime())) return res.status(400).json({ message: "Choose a valid date." });
  const dayEnd = new Date(dayStart.getTime() + 86400000);
  const until = new Date(Math.min(dayEnd.getTime(), Date.now()));

  const [before, events] = await Promise.all([
    PresenceEvent.findOne({ meterId: meter.meterId, at: { $lt: dayStart } }).sort({ at: -1 }).lean(),
    PresenceEvent.find({ meterId: meter.meterId, at: { $gte: dayStart, $lt: dayEnd } }).sort({ at: 1 }).lean()
  ]);

  const segments = [];
  const push = (from, to, state) => {
    if (to <= from) return;
    segments.push({ state: state || "unknown", from, to, seconds: Math.round((to - from) / 1000) });
  };
  let cursor = dayStart, state = before?.state || null;
  for (const event of events) {
    push(cursor, event.at, state);
    cursor = event.at;
    state = event.state;
  }
  push(cursor, until, state);

  const total = which => segments.filter(s => s.state === which).reduce((sum, s) => sum + s.seconds, 0);
  res.json({
    date, dayStart, dayEnd, segments,
    onlineSeconds: total("online"), offlineSeconds: total("offline"), unknownSeconds: total("unknown"),
    changes: events.map(e => ({ state: e.state, at: e.at }))
  });
});

// ---------- Personal alert settings ----------
app.get("/api/user/alert-prefs", auth, async (req, res) => {
  const [user, billing] = await Promise.all([
    User.findById(req.user._id).select("alertPrefs").lean(),
    BillingSettings.findOne({ key: "default" }).lean()
  ]);
  const prefs = user?.alertPrefs || {};
  const adminDefaults = {};
  for (const field of USER_LIMIT_FIELDS) adminDefaults[field] = billing?.[field] ?? null;
  res.json({
    prefs: {
      emailAlerts: prefs.emailAlerts === true, alertOffline: prefs.alertOffline !== false,
      ...Object.fromEntries(USER_LIMIT_FIELDS.map(field => [field, prefs[field] ?? null]))
    },
    adminDefaults,
    email: req.user.email
  });
});

app.put("/api/user/alert-prefs", auth, async (req, res) => {
  const updates = {};
  for (const field of ["emailAlerts", "alertOffline"]) {
    if (!(field in req.body)) continue;
    if (typeof req.body[field] !== "boolean") return res.status(400).json({ message: `${field} must be true or false` });
    updates[`alertPrefs.${field}`] = req.body[field];
  }
  const limits = {};
  for (const field of USER_LIMIT_FIELDS) {
    if (!(field in req.body)) continue;
    const raw = req.body[field];
    if (raw === null || raw === "") { limits[field] = null; continue; }
    const number = Number(raw);
    if (!Number.isFinite(number) || number < 0 || (field === "minPowerFactor" && number > 1)) {
      return res.status(400).json({ message: `${field} must be a valid non-negative number${field === "minPowerFactor" ? " no greater than 1" : ""}` });
    }
    limits[field] = number;
  }
  const current = req.user.alertPrefs || {};
  const minV = "minVoltage" in limits ? limits.minVoltage : current.minVoltage;
  const maxV = "maxVoltage" in limits ? limits.maxVoltage : current.maxVoltage;
  if (minV != null && maxV != null && minV >= maxV) return res.status(400).json({ message: "Under-voltage limit must be lower than over-voltage limit" });
  for (const [field, value] of Object.entries(limits)) updates[`alertPrefs.${field}`] = value;
  if (!Object.keys(updates).length) return res.status(400).json({ message: "Nothing to update" });
  await User.updateOne({ _id: req.user._id }, { $set: updates });
  await logActivity(req.user, "alert-settings", req.user.email, "updated own alert settings");
  res.json({ message: "Your alert settings were saved." });
});

// ---------- Background jobs: presence sweep and e-mail alerts ----------
let presenceSweepRunning = false;
async function sweepPresence() {
  if (presenceSweepRunning) return;
  presenceSweepRunning = true;
  try {
    const cutoff = new Date(Date.now() - HEARTBEAT_TIMEOUT_MS);
    const stale = await Meter.find({
      presence: "online", $or: [{ lastHeartbeat: { $lt: cutoff } }, { lastHeartbeat: null }]
    }).select("meterId lastHeartbeat lastSeen").lean();
    for (const meter of stale) {
      const claimed = await Meter.findOneAndUpdate(
        { _id: meter._id, presence: "online", lastHeartbeat: meter.lastHeartbeat ?? null },
        { $set: { presence: "offline" } }
      );
      if (claimed) await PresenceEvent.create({ meterId: meter.meterId, state: "offline", at: meter.lastHeartbeat || meter.lastSeen || new Date() });
    }
  } catch (error) {
    console.error("Presence sweep failed:", error.message);
  } finally {
    presenceSweepRunning = false;
  }
}

const OFFLINE_ALERT_AFTER_MS = 120000;
const ALERT_RETRY_MS = 10 * 60000;
const alertRetryAt = new Map();

// What is wrong with this meter right now, judged against the owner's own limits (falling back to the admin's).
function liveAlerts(meter, prefs, limits) {
  const found = [];
  const lastContact = meter.lastHeartbeat || meter.lastSeen;
  if (!online(meter)) {
    if (prefs.alertOffline !== false && lastContact && Date.now() - new Date(lastContact).getTime() > OFFLINE_ALERT_AFTER_MS) {
      found.push({ type: "offline", message: `The meter has been offline since ${new Date(lastContact).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}.` });
    }
    return found;
  }
  if (!dataAllowed(meter)) return found;
  if (limits.alertsEnabled === false) return found;
  if (meter.voltage != null && limits.maxVoltage != null && meter.voltage > limits.maxVoltage) found.push({ type: "over-voltage", message: `Voltage is ${meter.voltage} V, above your ${limits.maxVoltage} V limit.` });
  if (meter.voltage != null && limits.minVoltage != null && meter.voltage < limits.minVoltage) found.push({ type: "under-voltage", message: `Voltage is ${meter.voltage} V, below your ${limits.minVoltage} V limit.` });
  if (meter.current != null && limits.maxCurrent != null && meter.current > limits.maxCurrent) found.push({ type: "over-current", message: `Current is ${meter.current} A, above your ${limits.maxCurrent} A limit.` });
  if (meter.power != null && limits.maxPower != null && meter.power > limits.maxPower) found.push({ type: "over-power", message: `Power is ${meter.power} W, above your ${limits.maxPower} W limit.` });
  if (meter.powerFactor != null && limits.minPowerFactor != null && meter.powerFactor < limits.minPowerFactor) found.push({ type: "low-power-factor", message: `Power factor is ${meter.powerFactor}, below your ${limits.minPowerFactor} limit.` });
  return found;
}

async function sendAlertEmail(user, meter, raised, recovered, adminCopies) {
  const label = meter.meterName || meter.meterId;
  const subject = raised.length
    ? `Smart Energy Meter alert — ${label}`
    : `Smart Energy Meter — ${label} is back online`;
  const lines = raised.length ? raised.map(a => a.message) : ["Your meter is online again and sending data."];
  const text = `Hello ${user.name || "there"},\n\n${lines.join("\n")}\n\nMeter: ${label} (${meter.meterId})\nYou can change which alerts are e-mailed from the Insights tab of your dashboard.`;
  const html = `<div style="padding:28px 12px;background:#f1f5f9;font-family:Arial,sans-serif;color:#172033"><main style="max-width:560px;margin:auto;padding:28px;background:#fff;border:1px solid #e2e8f0;border-radius:16px"><p style="margin:0 0 8px;color:#2563eb;font-weight:700">SMART ENERGY METER</p><h1 style="margin:0 0 12px;font-size:22px">${raised.length ? "Alert for your meter" : "Meter back online"}</h1><p>Hello ${escapeHtml(user.name || "there")},</p><ul style="padding-left:20px;line-height:1.7">${lines.map(l => `<li>${escapeHtml(l)}</li>`).join("")}</ul><p style="color:#64748b;font-size:13px">Meter: ${escapeHtml(label)} (${escapeHtml(meter.meterId)}). You can change which alerts are e-mailed from the Insights tab of your dashboard.</p></main></div>`;
  await deliverMail(user.email, { subject, text, html }, `alert: ${(raised.length ? raised : [{ type: "back-online" }]).map(a => a.type).join(", ")}`);
  for (const admin of adminCopies) {
    try {
      await deliverMail(admin.email, { subject: `[Copy for ${user.email}] ${subject}`, text, html }, "alert copy");
    } catch { /* already recorded in the activity log */ }
  }
}

let alertCheckRunning = false;
async function checkAlerts() {
  if (alertCheckRunning) return;
  alertCheckRunning = true;
  try {
    const [billing, app, meters] = await Promise.all([
      BillingSettings.findOne({ key: "default" }).lean(),
      getAppSettings(),
      Meter.find({ userId: { $ne: null } }).populate("userId", "name email active alertPrefs").lean()
    ]);
    const adminCopies = app.alertAdminCopy ? await User.find({ role: "Admin", active: true }).select("email").lean() : [];
    for (const meter of meters) {
      const user = meter.userId;
      const previous = meter.activeAlerts || [];
      if (!user?.active || user.alertPrefs?.emailAlerts !== true) {
        if (previous.length) await Meter.updateOne({ _id: meter._id }, { $set: { activeAlerts: [] } });
        continue;
      }
      const limits = { ...(billing || {}), ...userLimitOverrides(user) };
      const current = liveAlerts(meter, user.alertPrefs, limits);
      const types = current.map(a => a.type);
      const raised = current.filter(a => !previous.includes(a.type));
      const recovered = previous.includes("offline") && !types.includes("offline") && online(meter);
      if (!raised.length && !recovered && types.length === previous.length) continue;
      if ((raised.length || recovered) && Date.now() < (alertRetryAt.get(String(meter._id)) || 0)) continue;
      try {
        if (raised.length) await sendAlertEmail(user, meter, raised, false, adminCopies);
        else if (recovered) await sendAlertEmail(user, meter, [], true, adminCopies);
        alertRetryAt.delete(String(meter._id));
      } catch (error) {
        console.error(`Alert e-mail to ${user.email} failed:`, error.message);
        alertRetryAt.set(String(meter._id), Date.now() + ALERT_RETRY_MS);
        continue;
      }
      await Meter.updateOne({ _id: meter._id }, { $set: { activeAlerts: types } });
    }
  } catch (error) {
    console.error("Alert check failed:", error);
  } finally {
    alertCheckRunning = false;
  }
}

// SPA entry points
app.get("/",(req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ message: "API route not found" });
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((error, req, res, next) => {
  if (error?.type === "entity.too.large") return res.status(413).json({ message: "That upload is too large." });
  if (error?.type === "entity.parse.failed") return res.status(400).json({ message: "Malformed request." });
  console.error(error);
  res.status(500).json({ message: "Server error" });
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

connectDB().then(async () => {
  // Older readings stored the relay state ("ON"/"OFF") in `status`; it is now 1 (visible) or 0 (held).
  await Reading.updateMany({ status: { $type: "string" } }, { $set: { status: 1 } });
  await Reading.updateMany({ status: { $exists: false } }, { $set: { status: 1 } });
}).then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Energy Meter Server running on port ${PORT}`);
    setInterval(checkScheduledReports, 60000);
    setInterval(sweepPresence, 10000);
    setInterval(checkAlerts, 30000);
    setInterval(checkSubscriptions, 60000);
    checkSubscriptions();
  });
}).catch(err => {
  console.error("MongoDB connection failed:", err);
  process.exit(1);
});



