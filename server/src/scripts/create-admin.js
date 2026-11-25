// Creates (or resets the password of) a temple's admin account.
//   npm run create-admin -- <temple-code> office@example.org 'a long password'
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import Temple from '../models/Temple.js';
import User from '../models/User.js';

const [code, email, password] = process.argv.slice(2);
if (!code || !email || !password || password.length < 8) {
  console.error("Usage: npm run create-admin -- <temple-code> <email> '<password of at least 8 characters>'");
  process.exit(1);
}
await mongoose.connect(process.env.MONGO_URI);
const temple = await Temple.findOne({ code: code.toLowerCase() });
if (!temple) {
  console.error(`No temple with code "${code}". Create it first from the super admin panel.`);
  process.exit(1);
}
const existing = await User.findOne({ email: email.toLowerCase() });
if (existing && String(existing.templeId) !== String(temple._id)) {
  console.error(`${email} already belongs to a different account.`);
  process.exit(1);
}
await User.updateOne(
  { email: email.toLowerCase() },
  { $set: { passwordHash: await bcrypt.hash(password, 10), role: 'admin', templeId: temple._id, active: true } },
  { upsert: true },
);
console.log(`Admin ready for ${temple.name}: ${email.toLowerCase()}`);
await mongoose.disconnect();
