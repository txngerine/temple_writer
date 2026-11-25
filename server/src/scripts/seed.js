import 'dotenv/config';
import mongoose from 'mongoose';
import { pathToFileURL } from 'node:url';
import Nakshatram from '../models/Nakshatram.js';
import Offering from '../models/Offering.js';
import { NAKSHATRAMS, OFFERINGS } from './seed-data.js';

/**
 * Loads the 27 nakshatrams and 19 offerings the app hardcodes. Safe to re-run:
 * existing rows are left alone, so a rate the office has entered is never reset.
 * Prices ship unset on purpose — every offering seeds `price: null, active: false`.
 */
export async function seed() {
  let nakshatrams = 0, offerings = 0;
  for (const [i, [mal, eng]] of NAKSHATRAMS.entries()) {
    const r = await Nakshatram.updateOne({ mal }, { $setOnInsert: { mal, eng, order: i + 1 } }, { upsert: true });
    nakshatrams += r.upsertedCount;
  }
  for (const [i, [labelMal, labelEng, icon, devoteeChosen]] of OFFERINGS.entries()) {
    const r = await Offering.updateOne({ labelMal }, {
      $setOnInsert: {
        labelMal, labelEng, icon, price: null, active: false,
        priceIsFixed: !devoteeChosen, quickPick: Boolean(icon), sortOrder: (i + 1) * 10,
      },
    }, { upsert: true });
    offerings += r.upsertedCount;
  }
  return { nakshatrams, offerings };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await mongoose.connect(process.env.MONGO_URI);
  const added = await seed();
  console.log(`Seeded ${added.nakshatrams} nakshatrams and ${added.offerings} offerings (existing rows untouched).`);
  await mongoose.disconnect();
}
