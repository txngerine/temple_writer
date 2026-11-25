// One-off: moves an existing single-temple database to the multi-temple layout.
// Creates one temple, stamps every existing user/counter/receipt/offering/log
// with it, and rebuilds the indexes. Safe to re-run.
//   npm run migrate:multi-temple -- "Temple name" temple-code
import 'dotenv/config';
import mongoose from 'mongoose';
import ActivityLog from '../models/ActivityLog.js';
import Device from '../models/Device.js';
import Offering from '../models/Offering.js';
import Receipt from '../models/Receipt.js';
import Temple from '../models/Temple.js';
import User from '../models/User.js';

const [name, code] = process.argv.slice(2);
if (!name || !code) {
  console.error('Usage: npm run migrate:multi-temple -- "Temple name" temple-code');
  process.exit(1);
}
await mongoose.connect(process.env.MONGO_URI);

const temple = (await Temple.findOne({ code: code.toLowerCase() }))
  || (await Temple.create({ name, code, timezone: process.env.TEMPLE_TZ || 'Asia/Kolkata' }));

// The old unique index on labelMal alone would stop a second temple having the same offering.
try { await Offering.collection.dropIndex('labelMal_1'); } catch { /* already gone */ }

const unset = { templeId: { $exists: false } };
const set = { $set: { templeId: temple._id } };
const counts = {
  users: (await User.updateMany({ ...unset, role: { $ne: 'superadmin' } }, set)).modifiedCount,
  devices: (await Device.updateMany(unset, set)).modifiedCount,
  receipts: (await Receipt.updateMany(unset, set)).modifiedCount,
  offerings: (await Offering.updateMany(unset, set)).modifiedCount,
  logs: (await ActivityLog.updateMany(unset, set)).modifiedCount,
};
await Promise.all([Device, Receipt, Offering, ActivityLog, User, Temple].map((m) => m.syncIndexes()));
console.log(`Migrated into "${temple.name}" (${temple.code}):`, counts);
await mongoose.disconnect();
