require("dotenv").config();
const bcrypt = require("bcryptjs");
const connectDB = require("./db");
const User = require("./models/User");
const Meter = require("./models/Meter");
const TariffSlab = require("./models/TariffSlab");

(async () => {
  try {
    await connectDB();

    const email = (process.env.ADMIN_EMAIL || "admin@energymeter.com").toLowerCase();
    const password = process.env.ADMIN_PASSWORD || "Admin@123";
    const hash = await bcrypt.hash(password, 10);

    await User.findOneAndUpdate(
      { email },
      { name: "System Admin", email, password: hash, role: "Admin", active: true },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await Meter.findOneAndUpdate(
      { meterId: "MTR001" },
      { $setOnInsert: { meterId: "MTR001", command: "OFF", updateFrequency: 5 } },
      { upsert: true }
    );

    if (await TariffSlab.countDocuments() === 0) {
      await TariffSlab.insertMany([
        { name: "Slab 1", minKwh: 0, maxKwh: 100, ratePerKwh: 3 },
        { name: "Slab 2", minKwh: 100, maxKwh: 200, ratePerKwh: 5 },
        { name: "Slab 3", minKwh: 200, maxKwh: 500, ratePerKwh: 7 },
        { name: "Slab 4", minKwh: 500, maxKwh: null, ratePerKwh: 9 }
      ]);
    }

    console.log("Admin ready:", email);
    console.log("Password:", password);
    console.log("Meter ready: MTR001");
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
