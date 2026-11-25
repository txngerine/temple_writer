import { DateTime } from 'luxon';

export const templeZone = () => process.env.TEMPLE_TZ || 'Asia/Kolkata';

/** The temple-local calendar day ("2026-09-03") a moment falls on. */
export function templeDay(date = new Date()) {
  return DateTime.fromJSDate(date).setZone(templeZone()).toISODate();
}

export const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && DateTime.fromISO(s).isValid;
