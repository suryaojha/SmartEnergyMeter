const jwt = require("jsonwebtoken");
const User = require("../models/User");

async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) return res.status(401).json({ message: "Login required" });
    const token = header.slice(7);
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      console.error("JWT_SECRET is not configured");
      return res.status(500).json({ message: "Authentication is not configured" });
    }
    const payload = jwt.verify(token, secret);
    const user = await User.findById(payload.id).select("-password");
    if (!user || !user.active) return res.status(401).json({ message: "Account inactive or not found" });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ message: "Invalid or expired login" });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== "Admin") return res.status(403).json({ message: "Admin access required" });
  next();
}

module.exports = { auth, adminOnly };
