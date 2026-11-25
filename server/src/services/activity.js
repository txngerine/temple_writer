import ActivityLog from '../models/ActivityLog.js';
import { templeDay, zoneOf } from './day.js';

/**
 * The single writer for the activity log, so no route invents its own shape.
 * Never lets logging fail the operation it describes: a counter must be able
 * to sync even if the log write does not land.
 */
export async function logActivity({
  templeId, type, message, actorType, severity = 'info',
  deviceId, userId, counterName, objectType, objectId, occurredAt, meta,
}) {
  const at = new Date();
  try {
    await ActivityLog.create({
      templeId, day: templeDay(at, await zoneOf(templeId)), at, occurredAt, type, severity, message,
      actorType, deviceId, userId, counterName, objectType, objectId, meta,
    });
  } catch (err) {
    console.error('activity log write failed', type, err.message);
  }
}
