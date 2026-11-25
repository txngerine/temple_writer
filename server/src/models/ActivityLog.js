import mongoose from 'mongoose';

const ActivityLogSchema = new mongoose.Schema({
  templeId:   { type: mongoose.Types.ObjectId, ref: 'Temple', index: true },  // unset for platform-level events
  day:        { type: String, required: true },   // "2026-09-03", temple-local
  at:         { type: Date,   required: true },   // server receive time, UTC
  occurredAt: { type: Date },                     // device time, when it differs

  type:     { type: String, required: true },
  severity: { type: String, enum: ['info', 'warning', 'error'], default: 'info' },

  actorType: { type: String, enum: ['device', 'user', 'system'], required: true },
  deviceId:  { type: String },
  userId:    { type: mongoose.Types.ObjectId },
  counterName: { type: String },

  objectType: { type: String },
  objectId:   { type: String },
  message:    { type: String, required: true },
  meta:       { type: Object },
}, { timestamps: false });

ActivityLogSchema.index({ templeId: 1, day: 1, at: -1 });
ActivityLogSchema.index({ templeId: 1, deviceId: 1, at: -1 });
ActivityLogSchema.index({ templeId: 1, type: 1, at: -1 });
ActivityLogSchema.index({ objectType: 1, objectId: 1 });
// Only info rows expire after a year; warnings and errors are kept.
ActivityLogSchema.index(
  { at: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 365, partialFilterExpression: { severity: 'info' } },
);

export default mongoose.model('ActivityLog', ActivityLogSchema);
