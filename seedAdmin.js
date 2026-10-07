require("dotenv").config();
const bcrypt = require("bcryptjs");
const connectDB = require("./db");
const User = require("./models/User");

(async () => {
  try {
    await connectDB();

    const email = (process.env.ADMIN_EMAIL || "").toLowerCase().trim();
    const password = process.env.ADMIN_PASSWORD || "";
    if (!email || !password || password.length < 12) {
      throw new Error("Set ADMIN_EMAIL and ADMIN_PASSWORD (at least 12 characters) in the environment before seeding.");
    }
    const hash = await bcrypt.hash(password, 10);

    await User.findOneAndUpdate(
      { email },
      { name: "System Admin", email, password: hash, role: "Admin", active: true },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    console.log("Admin ready:", email);
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
