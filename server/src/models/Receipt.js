import mongoose from 'mongoose';

// A financial record: never expires, never hard-deleted. `_id` is the UUID the
// counter generated, which is what makes a retried push idempotent.
const ReceiptSchema = new mongoose.Schema({
  _id:        { type: String },
  deviceId:   { type: String, required: true },
  counterName: { type: String },
  name:       { type: String, required: true },
  nakshatram: { type: String, default: '' },
  offering:   { type: String, required: true },
  amount:     { type: Number, required: true, min: 0 },   // the amount charged, not a reference
  occurredAt: { type: Date, required: true },             // device time
  day:        { type: String, required: true },           // temple-local day of occurredAt
  receivedAt: { type: Date, required: true },
  printed:    { type: Boolean, default: false },
  voided:     { type: Boolean, default: false },
  voidedAt:   { type: Date },
  voidedBy:   { type: mongoose.Types.ObjectId, ref: 'User' },
  voidReason: { type: String },
}, { timestamps: false });

ReceiptSchema.index({ day: 1, occurredAt: -1 });
ReceiptSchema.index({ deviceId: 1, occurredAt: -1 });
ReceiptSchema.index({ name: 1 });

export default mongoose.model('Receipt', ReceiptSchema);
