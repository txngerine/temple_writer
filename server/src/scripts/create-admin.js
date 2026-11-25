// Creates (or resets the password of) an office admin account.
//   npm run create-admin -- office@example.org 'a long password'
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import User from '../models/User.js';

const [email, password] = process.argv.slice(2);
if (!email || !password || password.length < 8) {
  console.error("Usage: npm run create-admin -- <email> '<password of at least 8 characters>'");
  process.exit(1);
}
await mongoose.connect(process.env.MONGO_URI);
const passwordHash = await bcrypt.hash(password, 10);
await User.updateOne(
  { email: email.toLowerCase() },
  { $set: { passwordHash, role: 'admin', active: true } },
  { upsert: true },
);
console.log(`Admin account ready: ${email.toLowerCase()}`);
await mongoose.disconnect();
