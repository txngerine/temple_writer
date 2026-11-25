import Device from '../models/Device.js';
import { logActivity } from './activity.js';

/**
 * Whether a counter is up, judged from the last time it spoke to the server.
 *
 * The app sends a heartbeat every 30 s, and any authenticated call (prices,
 * receipts, sign-in) also counts as being seen. Three missed beats — 90 s —
 * is "offline": long enough that a slow network does not flap the status,
 * short enough that the office hears about a dead tablet while it matters.
 */
export const ONLINE_WINDOW_MS = 90_000;

export const isOnline = (d, now = Date.now()) =>
  Boolean(d.enrolledAt && !d.revokedAt && d.lastSeenAt && now - new Date(d.lastSeenAt).getTime() <= ONLINE_WINDOW_MS);

/**
 * Compares every enrolled counter with the state last recorded for it and
 * writes one activity entry per change — so the log says "Counter 2 went
 * offline" once, not on every check. A counter seen for the first time is
 * recorded without an entry: coming online after enrolment is not news.
 */
export async function checkPresence(now = new Date()) {
  const devices = await Device.find({ enrolledAt: { $ne: null }, revokedAt: null });
  for (const d of devices) {
    const online = isOnline(d, now.getTime());
    const was = d.presence;
    if (online && was !== 'online') {
      d.presence = 'online';
      await d.save();
      if (was === 'offline') {
        await logActivity({
          type: 'device.online', actorType: 'system', deviceId: d.deviceId, counterName: d.counterName,
          objectType: 'device', objectId: d.deviceId, message: `${d.counterName} is back online`,
        });
      }
    } else if (!online && was !== 'offline') {
      d.presence = 'offline';
      await d.save();
      await logActivity({
        type: 'device.offline', severity: 'warning', actorType: 'system',
        deviceId: d.deviceId, counterName: d.counterName,
        objectType: 'device', objectId: d.deviceId, message: `${d.counterName} went offline`,
        meta: { lastSeenAt: d.lastSeenAt },
      });
    }
  }
}

/** Runs [checkPresence] on a timer. Returns a function that stops it. */
export function startPresenceWatcher(intervalMs = 30_000) {
  const timer = setInterval(() => {
    checkPresence().catch((err) => console.error('presence check failed', err.message));
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
