const mongoose = require("mongoose");

// Append-only wallet ledger. Amounts are integer paise (1 rupee = 100 paise).
const walletTxnSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  type: { type: String, enum: ["credit", "debit"], required: true },
  amountPaise: { type: Number, required: true, min: 1 },
  balanceAfterPaise: { type: Number, required: true },
  reason: { type: String, enum: ["recharge", "subscription", "auto-renew", "admin-credit", "admin-debit"], required: true },
  note: { type: String, default: "", maxlength: 240 },
  meterId: { type: String, default: "" },
  paymentId: { type: mongoose.Schema.Types.ObjectId, ref: "PaymentRequest", default: null },
  by: { type: String, default: "" }
}, { timestamps: { createdAt: true, updatedAt: false } });

module.exports = mongoose.model("WalletTxn", walletTxnSchema);
