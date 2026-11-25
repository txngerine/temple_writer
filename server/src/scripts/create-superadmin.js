// Creates (or resets the password of) the platform super admin, who creates
// temples and their admins and belongs to no temple.
//   npm run create-superadmin -- owner@example.org 'a long password'
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import User from '../models/User.js';

const [email, password] = process.argv.slice(2);
if (!email || !password || password.length < 8) {
  console.error("Usage: npm run create-superadmin -- <email> '<password of at least 8 characters>'");
  process.exit(1);
}
await mongoose.connect(process.env.MONGO_URI);
await User.updateOne(
  { email: email.toLowerCase() },
  { $set: { passwordHash: await bcrypt.hash(password, 10), role: 'superadmin', active: true }, $unset: { templeId: '' } },
  { upsert: true },
);
console.log(`Super admin ready: ${email.toLowerCase()}`);
await mongoose.disconnect();
