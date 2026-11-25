import mongoose from 'mongoose';

// One row per counter per temple day: what the system expected in the till
// against what the office counted. Re-closing a day overwrites; the activity
// log keeps every close.
const DayCloseSchema = new mongoose.Schema({
  templeId:     { type: mongoose.Types.ObjectId, ref: 'Temple', required: true },
  day:          { type: String, required: true },
  deviceId:     { type: String, required: true },
  counterName:  { type: String },
  expectedCash: { type: Number, required: true },
  declaredCash: { type: Number, required: true, min: 0 },
  variance:     { type: Number, required: true },   // declared - expected
  note:         { type: String, default: '' },
  closedAt:     { type: Date, required: true },
  closedBy:     { type: mongoose.Types.ObjectId, ref: 'User' },
  closedByEmail: { type: String },
}, { timestamps: false });

DayCloseSchema.index({ templeId: 1, day: 1, deviceId: 1 }, { unique: true });

export default mongoose.model('DayClose', DayCloseSchema);
