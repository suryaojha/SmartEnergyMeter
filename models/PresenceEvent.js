const mongoose = require("mongoose");

// One row each time a meter's ESP32 comes online or goes offline.
const presenceSchema = new mongoose.Schema({
  meterId: { type: String, required: true },
  state: { type: String, enum: ["online", "offline"], required: true },
  at: { type: Date, default: Date.now }
});

presenceSchema.index({ meterId: 1, at: 1 });
presenceSchema.index({ at: 1 }, { expireAfterSeconds: 180 * 86400 });

module.exports = mongoose.model("PresenceEvent", presenceSchema);
