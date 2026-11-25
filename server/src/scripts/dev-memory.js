// Runs the API against a throwaway in-memory MongoDB: the real offerings and
// nakshatrams from the app, plus one admin login. No sample counters, receipts
// or prices - the panel starts empty. Everything is lost when it stops.
//   npm run dev:memory
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

process.env.JWT_SECRET ||= 'dev-only-secret';
process.env.DEVICE_TOKEN_PEPPER ||= 'dev-only-pepper';

const { createApp } = await import('../app.js');
const { startPresenceWatcher } = await import('../services/presence.js');
const { seed } = await import('./seed.js');
const { default: User } = await import('../models/User.js');

const mongo = await MongoMemoryServer.create();
await mongoose.connect(mongo.getUri('temple_counter'));
await mongoose.connection.syncIndexes();
await seed();
await User.create({ email: 'admin@temple.test', name: 'Demo Admin', role: 'admin', passwordHash: await bcrypt.hash('temple-demo', 10) });

const port = Number(process.env.PORT) || 4000;
const server = createApp().listen(port);
startPresenceWatcher();
const base = `http://localhost:${port}`;


console.log(`\nDemo API on ${base} (in-memory database, nothing is saved)`);
console.log('Sign in to the web panel with  admin@temple.test  /  temple-demo\n');
const stop = async () => { server.close(); await mongoose.disconnect(); await mongo.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
