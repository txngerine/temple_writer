import mongoose from 'mongoose';

// The devotee dictionary, for when it moves off assets/models/malayalam_names.txt.
const NameSchema = new mongoose.Schema({
  text:    { type: String, required: true, unique: true, trim: true },
  section: { type: String },
  active:  { type: Boolean, default: true },
  receiptCount: { type: Number, default: 0 },
}, { timestamps: true });

// രാജൻ, never രാജന്: a name ending in ന/ണ/ര/ല/ള takes its chillu, not the base
// consonant plus a virama. A doubled consonant (പെണ്ണ്) is a real virama ending.
NameSchema.path('text').validate(
  (text) => !/(?<!്)[നണരലള]്$/u.test(text),
  'Use the chillu (ൻ ൺ ർ ൽ ൾ) at the end of a name, not the consonant with a virama.',
);

export default mongoose.model('Name', NameSchema);
