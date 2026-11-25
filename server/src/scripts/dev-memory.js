// Runs the API against a throwaway in-memory MongoDB: the real offerings and
// nakshatrams from the app, a demo temple with its admin, and a super admin.
// No sample counters, receipts or prices - the panel starts empty. Everything
// is lost when it stops.
//   npm run dev:memory
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

process.env.JWT_SECRET ||= 'dev-only-secret';
process.env.DEVICE_TOKEN_PEPPER ||= 'dev-only-pepper';

const { createApp } = await import('../app.js');
const { startPresenceWatcher } = await import('../services/presence.js');
const { seed } = await import('./seed.js');
const { default: Temple } = await import('../models/Temple.js');
const { default: User } = await import('../models/User.js');

const mongo = await MongoMemoryServer.create();
await mongoose.connect(mongo.getUri('temple_counter'));
await mongoose.connection.syncIndexes();
const temple = await Temple.create({ name: 'Demo Temple', code: 'demo' });
await seed(temple._id);
const passwordHash = await bcrypt.hash('temple-demo', 10);
await User.create({ email: 'admin@temple.test', name: 'Demo Admin', role: 'admin', templeId: temple._id, passwordHash });
await User.create({ email: 'super@temple.test', name: 'Super Admin', role: 'superadmin', passwordHash });

const port = Number(process.env.PORT) || 4000;
const server = createApp().listen(port);
startPresenceWatcher();
const base = `http://localhost:${port}`;

console.log(`\nDemo API on ${base} (in-memory database, nothing is saved)`);
console.log('Temple admin:  admin@temple.test  /  temple-demo   (Demo Temple)');
console.log('Super admin:   super@temple.test  /  temple-demo   (creates temples)\n');
const stop = async () => { server.close(); await mongoose.disconnect(); await mongo.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
