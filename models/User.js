const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  role: { type: String, enum: ["Admin", "User"], default: "User" },
  active: { type: Boolean, default: true },
  resetCodeHash: { type: String, default: null },
  resetCodeExpiry: { type: Date, default: null },
  resetCodeSentAt: { type: Date, default: null },
  resetCodeAttempts: { type: Number, default: 0 }
}, { timestamps: true });

module.exports = mongoose.model("User", userSchema);
