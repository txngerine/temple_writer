import mongoose from 'mongoose';

const NakshatramSchema = new mongoose.Schema({
  mal:   { type: String, required: true, unique: true },
  eng:   { type: String, required: true },
  order: { type: Number, required: true },
});

export default mongoose.model('Nakshatram', NakshatramSchema);
