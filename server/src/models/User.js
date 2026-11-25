import mongoose from 'mongoose';

export const ROLES = ['admin', 'supervisor', 'operator', 'ml'];

const UserSchema = new mongoose.Schema({
  email:        { type: String, required: true, unique: true, lowercase: true, trim: true },
  name:         { type: String, trim: true },
  passwordHash: { type: String, required: true },
  role:         { type: String, enum: ROLES, required: true },
  active:       { type: Boolean, default: true },
}, { timestamps: true });

UserSchema.methods.toPublic = function toPublic() {
  return { id: this.id, email: this.email, name: this.name, role: this.role, active: this.active, createdAt: this.createdAt };
};

export default mongoose.model('User', UserSchema);
