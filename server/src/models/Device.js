import mongoose from 'mongoose';

const DeviceSchema = new mongoose.Schema({
  deviceId:    { type: String, required: true, unique: true },
  templeId:    { type: mongoose.Types.ObjectId, ref: 'Temple', required: true, index: true },
  counterName: { type: String, required: true, trim: true },
  tokenHash:   { type: String, index: true },
  // Set by the office when the counter is registered; the tablet trades it for
  // its token. Cleared on the device's first authenticated call, so a tablet
  // that lost the enrol response can simply ask again.
  enrollCodeHash: { type: String, index: true },
  enrolledBy:  { type: mongoose.Types.ObjectId, ref: 'User' },
  enrolledAt:  { type: Date },
  revokedAt:   { type: Date },
  appVersion:  { type: String },
  modelVersion: { type: String },
  platform:    { type: String },
  lastSeenAt:  { type: Date },
  pendingCount: { type: Number, default: 0 },
  // Last state the presence watcher recorded: 'online' | 'offline'. Lets it
  // log a change once instead of on every check.
  presence:    { type: String, enum: ['online', 'offline'] },
}, { timestamps: true });

export default mongoose.model('Device', DeviceSchema);
