const mongoose = require("mongoose");

async function connectDB() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI
    || (process.env.NODE_ENV === "production" ? "" : "mongodb://127.0.0.1:27017/energyMeterDB");
  if (!uri) throw new Error("Set MONGODB_URI (or MONGO_URI) before starting in production.");
  await mongoose.connect(uri, { dbName: process.env.MONGODB_DB_NAME || "energyMeterDB" });
  console.log("MongoDB Connected");
}

module.exports = connectDB;
