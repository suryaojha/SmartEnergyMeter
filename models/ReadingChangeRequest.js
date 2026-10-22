const mongoose = require("mongoose");

// A user-submitted correction to the MSEB meter reading recorded at commissioning. The first
// submission is applied directly to the Meter document; any later change goes through here and
// needs an admin to approve it before it overwrites the stored reading.
const readingChangeRequestSchema = new mongoose.Schema({
  meterId: { type: String, required: true, trim: true, uppercase: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  reading: { type: Number, required: true, min: 0, max: 999999 },
  photoFile: { type: String, required: true },
  status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending", index: true },
  adminNote: { type: String, default: "", maxlength: 240 },
  reviewedBy: { type: String, default: "" },
  reviewedAt: { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model("ReadingChangeRequest", readingChangeRequestSchema);
