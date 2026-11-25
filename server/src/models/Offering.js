import mongoose from 'mongoose';

const OfferingSchema = new mongoose.Schema({
  labelMal: { type: String, required: true, unique: true, trim: true },
  labelEng: { type: String, required: true, trim: true },
  icon:     { type: String },
  price:    { type: Number, min: 0, default: null },   // ₹, null = not set
  priceIsFixed: { type: Boolean, default: true },      // false = devotee-chosen
  quickPick:    { type: Boolean, default: false },
  sortOrder:    { type: Number, default: 100 },
  active:       { type: Boolean, default: false },
  activeFrom:   { type: Date },
  activeTo:     { type: Date },
  updatedBy:    { type: mongoose.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

OfferingSchema.index({ active: 1, sortOrder: 1 });

// A counter that pulls the list must never receive an offering it cannot
// charge for. A devotee-chosen offering (തുലാഭാരം, അന്നദാനം) has no price by
// design, so the rule binds only fixed-price rows.
OfferingSchema.pre('validate', function requirePriceToActivate(next) {
  if (this.active && this.priceIsFixed && this.price == null) {
    this.invalidate('active', 'An offering with a fixed price cannot be active until its price is set.');
  }
  next();
});

export default mongoose.model('Offering', OfferingSchema);
