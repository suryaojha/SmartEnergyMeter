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
const { auth, adminOnly } = require("./middleware/auth");

const app = express();
const PORT = Number(process.env.PORT || 5000);
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";

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

async function consumptionFor(meterId, start, end) {
  const rows = await Reading.aggregate([
    { $match: { meterId, createdAt: { $gte: start, $lt: end } } },
    { $group: {
      _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Asia/Kolkata" } },
      firstEnergy: { $first: "$energy" },
      lastEnergy: { $last: "$energy" },
      minEnergy: { $min: "$energy" },
      maxEnergy: { $max: "$energy" },
      samples: { $sum: 1 }
    }},
    { $sort: { _id: 1 } }
  ]);

  return rows.map(r => {
    const first = Number(r.firstEnergy ?? 0);
    const last = Number(r.lastEnergy ?? 0);
    const min = Number(r.minEnergy ?? 0);
    const max = Number(r.maxEnergy ?? 0);
    const used = Math.max(0, Math.max(last - first, max - min));
    return { date: r._id, kwh: Number(used.toFixed(4)), samples: r.samples };
  });
}

async function periodConsumption(meterId, start, end) {
  const r = await Reading.aggregate([
    { $match: { meterId, createdAt: { $gte: start, $lt: end } } },
    { $group: {
      _id: null,
      first: { $min: "$energy" },
      last: { $max: "$energy" }
    }}
  ]);
  if (!r.length) return 0;
  return Math.max(0, Number(r[0].last || 0) - Number(r[0].first || 0));
}

function calculateBill(kwh, slabs) {
  let total = 0;
  let currentSlab = null;
  const sorted = [...slabs].sort((a, b) => a.minKwh - b.minKwh);

  for (const s of sorted) {
    const min = Number(s.minKwh);
    const max = s.maxKwh === null || s.maxKwh === undefined ? Infinity : Number(s.maxKwh);
    const units = Math.max(0, Math.min(kwh, max) - min);
    if (units > 0) total += units * Number(s.ratePerKwh);
    if (kwh >= min && kwh <= max) currentSlab = s;
  }

  return {
    kwh: Number(kwh.toFixed(4)),
    cost: Number(total.toFixed(2)),
    currentSlab: currentSlab ? {
      name: currentSlab.name,
      minKwh: currentSlab.minKwh,
      maxKwh: currentSlab.maxKwh,
      ratePerKwh: currentSlab.ratePerKwh
    } : null
  };
}

async function getMonthlyBill(meterId) {
  const start = indiaStart();
  const end = addIndiaDays(start, 1);
  const monthStart = new Date(start);
  monthStart.setUTCMonth(monthStart.getUTCMonth() - 1); // safe enough for rolling monthly demo
  const kwh = await periodConsumption(meterId, monthStart, new Date());
  const slabs = await TariffSlab.find().sort({ minKwh: 1 }).lean();
  return calculateBill(kwh, slabs);
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
    const {
      meterId, voltage = 0, current = 0, power = 0, energy = 0,
      frequency = 0, powerFactor = 0, status = "OFF"
    } = req.body;
    if (!meterId) return res.status(400).json({ message: "meterId required" });

    const id = String(meterId).toUpperCase();
    const meter = await Meter.findOneAndUpdate(
      { meterId: id },
      {
        $set: {
          voltage: Number(voltage) || 0,
          current: Number(current) || 0,
          power: Number(power) || 0,
          energy: Number(energy) || 0,
          frequency: Number(frequency) || 0,
          powerFactor: Number(powerFactor) || 0,
          status: status === "ON" ? "ON" : "OFF",
          lastSeen: new Date()
        },
        $setOnInsert: { meterId: id }
      },
      { upsert: true, new: true }
    );

    await Reading.create({
      meterId: id,
      voltage: Number(voltage) || 0,
      current: Number(current) || 0,
      power: Number(power) || 0,
      energy: Number(energy) || 0,
      frequency: Number(frequency) || 0,
      powerFactor: Number(powerFactor) || 0,
      status: meter.command
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
  res.json({ command: meter?.command || "OFF" });
});

app.get("/api/meter/:meterId/settings", async (req, res) => {
  const meter = await Meter.findOne({ meterId: req.params.meterId.toUpperCase() }).lean();
  res.json({ updateFrequency: Math.max(1, Number(meter?.updateFrequency || 5)), command: meter?.command || "OFF" });
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

app.post("/api/auth/register", async (req, res) => {
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
  const { name, email, password = "User@123" } = req.body;
  if (!name || !email) return res.status(400).json({ message: "Name and email required" });
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
  if (!meterId) return res.status(400).json({ message: "meterId required" });
  const exists = await Meter.findOne({ meterId });
  if (exists) return res.status(409).json({ message: "Meter already exists" });
  const meter = await Meter.create({
    meterId,
    updateFrequency: Math.max(1, Math.min(3600, Number(req.body.updateFrequency || 5)))
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

  const days = Math.max(7, Math.min(365, Number(req.query.days || 30)));
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const daily = await consumptionFor(meter.meterId, start, end);

  const monthStart = new Date();
  monthStart.setMonth(monthStart.getMonth() - 11);
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const monthlyRows = await Reading.aggregate([
    { $match: { meterId: meter.meterId, createdAt: { $gte: monthStart, $lte: end } } },
    { $group: {
      _id: { $dateToString: { format: "%Y-%m", date: "$createdAt", timezone: "Asia/Kolkata" } },
      firstEnergy: { $min: "$energy" },
      lastEnergy: { $max: "$energy" },
      samples: { $sum: 1 }
    }},
    { $sort: { _id: 1 } }
  ]);
  const monthly = monthlyRows.map(r => ({
    month: r._id,
    kwh: Number(Math.max(0, Number(r.lastEnergy || 0) - Number(r.firstEnergy || 0)).toFixed(4)),
    samples: r.samples
  }));

  const slabs = await TariffSlab.find().sort({ minKwh: 1 }).lean();
  const todayKwh = daily.reduce((s, x) => s + x.kwh, 0);
  const periodKwh = daily.reduce((s, x) => s + x.kwh, 0);
  const monthBeginning = new Date();
  monthBeginning.setDate(1); monthBeginning.setHours(0,0,0,0);
  const monthKwh = await periodConsumption(meter.meterId, monthBeginning, new Date());

  res.json({
    meter: publicMeter(meter),
    daily,
    monthly,
    table: [...daily].reverse(),
    summary: {
      todayKwh: Number(todayKwh.toFixed(4)),
      selectedPeriodKwh: Number(periodKwh.toFixed(4)),
      monthKwh: Number(monthKwh.toFixed(4)),
      todayBill: calculateBill(todayKwh, slabs),
      monthBill: calculateBill(monthKwh, slabs)
    },
    slabs
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

app.put("/api/admin/tariffs", auth, adminOnly, async (req, res) => {
  if (!Array.isArray(req.body.slabs)) return res.status(400).json({ message: "slabs array required" });
  const slabs = req.body.slabs.map((s, i) => ({
    name: s.name || `Slab ${i + 1}`,
    minKwh: Math.max(0, Number(s.minKwh)),
    maxKwh: s.maxKwh === "" || s.maxKwh === null || s.maxKwh === undefined ? null : Math.max(0, Number(s.maxKwh)),
    ratePerKwh: Math.max(0, Number(s.ratePerKwh))
  })).sort((a,b) => a.minKwh - b.minKwh);

  if (!slabs.length || slabs[0].minKwh !== 0) return res.status(400).json({ message: "First slab must start at 0 kWh" });
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
