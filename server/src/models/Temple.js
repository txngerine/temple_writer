import mongoose from 'mongoose';

const TempleSchema = new mongoose.Schema({
  name:     { type: String, required: true, trim: true },
  // Short URL-safe handle, e.g. "guruvayur". Used by scripts and support.
  code:     { type: String, required: true, unique: true, lowercase: true, trim: true, match: /^[a-z0-9][a-z0-9-]{1,39}$/ },
  timezone: { type: String, default: 'Asia/Kolkata' },
  active:   { type: Boolean, default: true },
}, { timestamps: true });

TempleSchema.methods.toPublic = function toPublic() {
  return { id: this.id, name: this.name, code: this.code, timezone: this.timezone, active: this.active, createdAt: this.createdAt };
};

export default mongoose.model('Temple', TempleSchema);
