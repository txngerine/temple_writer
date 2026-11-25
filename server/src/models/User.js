import mongoose from 'mongoose';

// `superadmin` runs the platform: creates temples and their admins, and belongs
// to no temple. Every other role belongs to exactly one temple.
export const TEMPLE_ROLES = ['admin', 'supervisor', 'operator', 'ml'];
export const ROLES = ['superadmin', ...TEMPLE_ROLES];

const UserSchema = new mongoose.Schema({
  email:        { type: String, required: true, unique: true, lowercase: true, trim: true },
  name:         { type: String, trim: true },
  passwordHash: { type: String, required: true },
  role:         { type: String, enum: ROLES, required: true },
  templeId:     { type: mongoose.Types.ObjectId, ref: 'Temple', index: true },
  active:       { type: Boolean, default: true },
}, { timestamps: true });

UserSchema.pre('validate', function requireTemple(next) {
  if (this.role === 'superadmin') this.templeId = undefined;
  else if (!this.templeId) this.invalidate('templeId', 'A temple account must belong to a temple.');
  next();
});

UserSchema.methods.toPublic = function toPublic() {
  return {
    id: this.id, email: this.email, name: this.name, role: this.role,
    templeId: this.templeId ? String(this.templeId) : null, active: this.active, createdAt: this.createdAt,
  };
};

export default mongoose.model('User', UserSchema);
