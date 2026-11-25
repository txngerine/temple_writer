import { DateTime } from 'luxon';
import Temple from '../models/Temple.js';

export const DEFAULT_ZONE = 'Asia/Kolkata';
export const isZone = (tz) => typeof tz === 'string' && DateTime.now().setZone(tz).isValid;

/** The temple-local calendar day ("2026-09-03") a moment falls on, in `zone`. */
export function templeDay(date = new Date(), zone = DEFAULT_ZONE) {
  return DateTime.fromJSDate(date).setZone(zone).toISODate();
}

// Zones are looked up by temple id and cached briefly; a changed timezone takes
// effect within a minute.
const cache = new Map();
export function clearZoneCache() { cache.clear(); }

export async function zoneOf(templeId) {
  if (!templeId) return DEFAULT_ZONE;
  const key = String(templeId);
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.zone;
  const temple = await Temple.findById(key).select('timezone').lean();
  const zone = temple?.timezone || DEFAULT_ZONE;
  cache.set(key, { zone, until: Date.now() + 60_000 });
  return zone;
}

export const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && DateTime.fromISO(s).isValid;
