import 'dotenv/config';
import mongoose from 'mongoose';
import { createApp } from './app.js';
import { startPresenceWatcher } from './services/presence.js';

for (const key of ['MONGO_URI', 'JWT_SECRET', 'DEVICE_TOKEN_PEPPER']) {
  if (!process.env[key] || process.env[key] === 'change-me') {
    console.error(`Set ${key} in admin/server/.env (see .env.example).`);
    process.exit(1);
  }
}

await mongoose.connect(process.env.MONGO_URI);
const port = Number(process.env.PORT) || 4000;
createApp().listen(port, () => console.log(`Temple counter admin API on http://localhost:${port}`));
startPresenceWatcher();
