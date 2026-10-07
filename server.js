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
  return { ...x, online: online(x), user: x.userId?.name ? {
    _id: x.userId._id, name: x.userId.name, email: x.userId.email
  } : null };
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

async function sendResetEmail(user, resetLink) {
  const host = process.env.SMTP_HOST;
  if (!host) return false;
  const transporter = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT || 587) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  await transporter.sendMail({
    from: process.env.SMTP_FROM || "Energy Meter <no-reply@example.com>",
    to: user.email,
    subject: "Energy Meter password reset",
    text: `Reset your password: ${resetLink}\nThis link expires in 15 minutes.`
  });
  return true;
}

// ---------- Health ----------
app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date() }));

// ---------- ESP32 public device APIs ----------
app.post("/api/meter/data", async (req, res) => {
  try {
    const { meterId, status = "OFF" } = req.body;
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
    if (!["ON", "OFF"].includes(status)) return res.status(400).json({ message: "status must be ON or OFF" });

    const id = String(meterId).toUpperCase();
    const meter = await Meter.findOneAndUpdate(
      { meterId: id },
      {
        $set: {
          ...readings,
          status,
          lastSeen: new Date()
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

app.get("/api/meter/:meterId/command", async (req, res) => {
  const meter = await Meter.findOne({ meterId: req.params.meterId.toUpperCase() }).lean();
  if (!meter) return res.status(404).json({ message: "Meter not registered" });
  res.json({ command: meter.command });
});

app.get("/api/meter/:meterId/settings", async (req, res) => {
  const meter = await Meter.findOne({ meterId: req.params.meterId.toUpperCase() }).lean();
  if (!meter) return res.status(404).json({ message: "Meter not registered" });
  res.json({ updateFrequency: meter.updateFrequency, command: meter.command });
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
    if (!user) return res.json({ message: "If the account exists, a reset link has been prepared." });

    const rawToken = crypto.randomBytes(32).toString("hex");
    const hash = crypto.createHash("sha256").update(rawToken).digest("hex");
    user.resetTokenHash = hash;
    user.resetTokenExpiry = new Date(Date.now() + 15 * 60 * 1000);
    await user.save();

    const base = process.env.APP_URL || `http://localhost:${PORT}`;
    const resetLink = `${base}/reset-password.html?token=${rawToken}`;
    const emailed = await sendResetEmail(user, resetLink).catch(() => false);

    const payload = { message: emailed ? "Reset link sent to your email." : "Reset link generated for local demo." };
    if (!emailed) payload.resetLink = resetLink;
    res.json(payload);
  } catch {
    res.status(500).json({ message: "Could not create reset link" });
  }
});

app.post("/api/auth/reset-password", async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password || password.length < 6) return res.status(400).json({ message: "Valid token and 6+ character password required" });
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    const user = await User.findOne({ resetTokenHash: hash, resetTokenExpiry: { $gt: new Date() } });
    if (!user) return res.status(400).json({ message: "Reset link is invalid or expired" });

    user.password = await bcrypt.hash(password, 10);
    user.resetTokenHash = null;
    user.resetTokenExpiry = null;
    await user.save();
    res.json({ message: "Password reset successful. You can login now." });
  } catch {
    res.status(500).json({ message: "Password reset error" });
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
  const meters = await Meter.find().populate("userId", "name email").sort({ meterId: 1 }).lean();
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
  const meter = await Meter.create({
    meterId,
    meterName,
    updateFrequency: frequency
  });
  res.status(201).json({ message: "Meter created", meter: publicMeter(meter) });
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

app.put("/api/admin/meters/:meterId/config", auth, adminOnly, async (req, res) => {
  const meterName = String(req.body.meterName || "").trim();
  if (meterName.length > 80) return res.status(400).json({ message: "Meter name must be 80 characters or fewer" });
  const meter = await Meter.findOneAndUpdate(
    { meterId: req.params.meterId.toUpperCase() },
    { meterName },
    { new: true, runValidators: true }
  ).populate("userId", "name email");
  if (!meter) return res.status(404).json({ message: "Meter not found" });
  res.json({ message: "Meter name saved", meter: publicMeter(meter) });
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

// ---------- Consumption / charts ----------
app.get("/api/meters/:meterId/consumption", auth, async (req, res) => {
  const meter = await Meter.findOne({ meterId: req.params.meterId.toUpperCase() }).lean();
  if (!meter) return res.status(404).json({ message: "Meter not found" });
  if (req.user.role !== "Admin" && String(meter.userId) !== String(req.user._id)) {
    return res.status(403).json({ message: "Meter not assigned to you" });
  }

  const requestedDays = Number(req.query.days || 30);
  const days = Number.isFinite(requestedDays) ? Math.max(7, Math.min(365, requestedDays)) : 30;
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
    { $match: { meterId: meter.meterId, energy: { $type: "number" }, createdAt: { $gte: currentDayStart, $lte: end } } },
    { $sort: { createdAt: 1 } },
    { $group: {
      _id: { $dateToString: { format: "%H", date: "$createdAt", timezone: "Asia/Kolkata" } },
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

connectDB().then(() => {
  app.listen(PORT, "0.0.0.0", () => console.log(`Energy Meter Server running on port ${PORT}`));
}).catch(err => {
  console.error("MongoDB connection failed:", err);
  process.exit(1);
});
