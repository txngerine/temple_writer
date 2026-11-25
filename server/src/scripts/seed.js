import 'dotenv/config';
import mongoose from 'mongoose';
import { pathToFileURL } from 'node:url';
import Nakshatram from '../models/Nakshatram.js';
import Offering from '../models/Offering.js';
import { NAKSHATRAMS, OFFERINGS } from './seed-data.js';

/** The 27 nakshatrams are the same for every temple, so they are shared. */
export async function seedNakshatrams() {
  let added = 0;
  for (const [i, [mal, eng]] of NAKSHATRAMS.entries()) {
    const r = await Nakshatram.updateOne({ mal }, { $setOnInsert: { mal, eng, order: i + 1 } }, { upsert: true });
    added += r.upsertedCount;
  }
  return added;
}

/**
 * Loads the 19 offerings the app hardcodes into one temple. Safe to re-run:
 * existing rows are left alone, so a rate the office has entered is never reset.
 * Prices ship unset on purpose — every offering seeds `price: null, active: false`.
 */
export async function seedOfferings(templeId) {
  let added = 0;
  for (const [i, [labelMal, labelEng, icon, devoteeChosen]] of OFFERINGS.entries()) {
    const r = await Offering.updateOne({ templeId, labelMal }, {
      $setOnInsert: {
        templeId, labelMal, labelEng, icon, price: null, active: false,
        priceIsFixed: !devoteeChosen, quickPick: Boolean(icon), sortOrder: (i + 1) * 10,
      },
    }, { upsert: true });
    added += r.upsertedCount;
  }
  return added;
}

export async function seed(templeId) {
  return { nakshatrams: await seedNakshatrams(), offerings: templeId ? await seedOfferings(templeId) : 0 };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  // npm run seed -- <temple-code>
  const code = process.argv[2];
  await mongoose.connect(process.env.MONGO_URI);
  const { default: Temple } = await import('../models/Temple.js');
  const temple = code ? await Temple.findOne({ code: code.toLowerCase() }) : null;
  if (code && !temple) { console.error(`No temple with code "${code}".`); process.exit(1); }
  const added = await seed(temple?._id);
  console.log(`Seeded ${added.nakshatrams} nakshatrams${temple ? ` and ${added.offerings} offerings for ${temple.name}` : ''} (existing rows untouched).`);
  await mongoose.disconnect();
}
