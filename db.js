const mongoose = require("mongoose");

async function connectDB() {
  await mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/energyMeterDB");
  console.log("MongoDB Connected");
}

module.exports = connectDB;
