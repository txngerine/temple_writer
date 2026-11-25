import crypto from 'node:crypto';
import { Router } from 'express';
import Device from '../../models/Device.js';
import Name from '../../models/Name.js';
import Nakshatram from '../../models/Nakshatram.js';
import Offering from '../../models/Offering.js';
import Receipt from '../../models/Receipt.js';
import { HttpError, hashSecret, newSecret, requireDevice, wrap } from '../../middleware/auth.js';
import { logActivity } from '../../services/activity.js';
import { templeDay, zoneOf } from '../../services/day.js';

// Devices are unattended and retry blindly, so every route here is safe to
// call twice.
const router = Router();

const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);

router.post('/enroll', wrap(async (req, res) => {
  const code = str(req.body?.code);
  if (!code) throw new HttpError(400, 'Enrolment code required');
  const device = await Device.findOne({ enrollCodeHash: hashSecret(code.toUpperCase()) });
  if (!device || device.revokedAt) throw new HttpError(401, 'Enrolment code is not valid');

  // A repeat call (the tablet never saw the first reply) issues a fresh token
  // and the old one stops working; the code itself survives until the token is
  // first used.
  const first = !device.enrolledAt;
  const token = newSecret();
  device.tokenHash = hashSecret(token);
  device.enrolledAt = device.enrolledAt || new Date();
  device.appVersion = str(req.body?.appVersion, 40) ?? device.appVersion;
  device.platform = str(req.body?.platform, 40) ?? device.platform;
  device.lastSeenAt = new Date();
  await device.save();

  if (first) {
    await logActivity({
      templeId: device.templeId, type: 'device.enrolled', actorType: 'device',
      deviceId: device.deviceId, counterName: device.counterName,
      objectType: 'device', objectId: device.deviceId,
      message: `${device.counterName} was enrolled`,
      meta: { appVersion: device.appVersion, enrolledBy: device.enrolledBy },
    });
  }
  res.json({ deviceId: device.deviceId, counterName: device.counterName, token });
}));

router.use(requireDevice);

router.post('/login', wrap(async (req, res) => {
  const { device } = req;
  const operatorName = str(req.body?.operatorName, 80);
  if (!operatorName) throw new HttpError(400, 'operatorName required');
  const appVersion = str(req.body?.appVersion, 40);
  const modelVersion = str(req.body?.modelVersion, 40);
  const platform = str(req.body?.platform, 40);
  Object.assign(device, {
    appVersion: appVersion ?? device.appVersion,
    modelVersion: modelVersion ?? device.modelVersion,
    platform: platform ?? device.platform,
  });
  await device.save();
  await logActivity({
    templeId: device.templeId, type: 'app.login', actorType: 'device',
    deviceId: device.deviceId, counterName: device.counterName,
    occurredAt: parseDate(req.body?.occurredAt),
    message: `${operatorName} signed in at ${device.counterName}`,
    meta: { operatorId: str(req.body?.operatorId, 40), operatorName, appVersion, modelVersion, platform },
  });
  res.json({ ok: true });
}));

router.post('/logout', wrap(async (req, res) => {
  const { device } = req;
  const operatorName = str(req.body?.operatorName, 80) || 'Operator';
  const reason = req.body?.reason === 'expiry' ? 'expiry' : 'user';
  await logActivity({
    templeId: device.templeId, type: 'app.logout', actorType: 'device',
    deviceId: device.deviceId, counterName: device.counterName,
    occurredAt: parseDate(req.body?.occurredAt),
    message: `${operatorName} signed out at ${device.counterName}`,
    meta: { operatorName, reason },
  });
  res.json({ ok: true });
}));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseDate(v) {
  if (typeof v !== 'string') return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Turns one pushed entry into a receipt document, or says why it cannot be. */
function toReceipt(entry, device, receivedAt, zone) {
  if (!entry || typeof entry !== 'object') return { error: 'not an object' };
  if (typeof entry.id !== 'string' || !UUID.test(entry.id)) return { error: 'id must be a UUID' };
  const name = str(entry.name);
  if (!name) return { error: 'name required' };
  const offering = str(entry.offering);
  if (!offering) return { error: 'offering required' };
  const amount = Number(entry.amount);
  if (!Number.isFinite(amount) || amount < 0) return { error: 'amount must be a number, 0 or more' };
  const occurredAt = parseDate(entry.timestamp);
  if (!occurredAt) return { error: 'timestamp must be an ISO-8601 date' };
  const paymentMode = ['cash', 'upi', 'card'].includes(entry.paymentMode) ? entry.paymentMode : 'cash';
  return {
    doc: {
      _id: entry.id.toLowerCase(), templeId: device.templeId, deviceId: device.deviceId, counterName: device.counterName,
      name, nakshatram: str(entry.nakshatram) || '', offering, amount,
      occurredAt, day: templeDay(occurredAt, zone), receivedAt, paymentMode, printed: entry.printed === true,
    },
  };
}

router.post('/receipts', wrap(async (req, res) => {
  const { device } = req;
  const entries = req.body?.entries;
  if (!Array.isArray(entries)) throw new HttpError(400, 'entries must be an array');
  if (entries.length > 500) throw new HttpError(413, 'Send at most 500 receipts per batch');
  const started = Date.now();
  const receivedAt = new Date();
  const zone = await zoneOf(device.templeId);
  const results = [];
  let created = 0, duplicate = 0, rejected = 0;

  // One entry at a time: a bad row is rejected on its own and never fails the
  // batch, and each id gets its own answer.
  for (const entry of entries) {
    const id = typeof entry?.id === 'string' ? entry.id : null;
    const { doc, error } = toReceipt(entry, device, receivedAt, zone);
    if (error) {
      rejected++;
      results.push({ id, status: 'rejected', error });
      continue;
    }
    try {
      // Insert-only. A receipt already here is left exactly as it is, so a
      // retried push cannot un-void it or change what was charged.
      const r = await Receipt.updateOne({ _id: doc._id }, { $setOnInsert: doc }, { upsert: true });
      if (r.upsertedCount) {
        created++;
        results.push({ id: doc._id, status: 'created' });
        await logActivity({
          templeId: device.templeId, type: 'receipt.created', actorType: 'device',
          deviceId: device.deviceId, counterName: device.counterName,
          objectType: 'receipt', objectId: doc._id, occurredAt: doc.occurredAt,
          message: `₹${doc.amount} ${doc.offering} for ${doc.name}`,
          meta: { amount: doc.amount, offering: doc.offering, printed: doc.printed },
        });
      } else {
        duplicate++;
        results.push({ id: doc._id, status: 'duplicate' });
      }
    } catch (err) {
      rejected++;
      results.push({ id: doc._id, status: 'rejected', error: err.message });
    }
  }

  const pendingAfter = Number.isInteger(req.body?.pendingAfter) ? req.body.pendingAfter : undefined;
  if (pendingAfter !== undefined) {
    device.pendingCount = pendingAfter;
    await device.save();
  }
  const accepted = created + duplicate;
  await logActivity({
    templeId: device.templeId, type: rejected ? 'app.sync.failed' : 'app.sync',
    severity: rejected ? 'warning' : 'info',
    actorType: 'device', deviceId: device.deviceId, counterName: device.counterName,
    message: `Synced ${accepted} of ${entries.length} receipts`,
    meta: { received: entries.length, accepted, created, duplicate, rejected, durationMs: Date.now() - started, pendingAfter },
  });
  res.json({ results });
}));

router.get('/master', wrap(async (req, res) => {
  const now = new Date();
  const since = parseDate(req.query.since);
  const [offerings, nakshatrams, names] = await Promise.all([
    Offering.find({
      templeId: req.device.templeId,
      active: true,
      $and: [
        { $or: [{ price: { $ne: null } }, { priceIsFixed: false }] },
        { $or: [{ activeFrom: null }, { activeFrom: { $lte: now } }] },
        { $or: [{ activeTo: null }, { activeTo: { $gte: now } }] },
      ],
    }).sort({ sortOrder: 1, labelEng: 1 }).lean(),
    Nakshatram.find().sort({ order: 1 }).lean(),
    Name.find(since ? { updatedAt: { $gt: since } } : { active: true }).sort({ text: 1 }).lean(),
  ]);
  res.json({
    serverTime: now.toISOString(),
    offerings: offerings.map((o) => ({
      id: String(o._id), labelMal: o.labelMal, labelEng: o.labelEng, icon: o.icon,
      price: o.price, priceIsFixed: o.priceIsFixed, quickPick: o.quickPick, sortOrder: o.sortOrder,
    })),
    nakshatrams: nakshatrams.map((n) => ({ mal: n.mal, eng: n.eng, order: n.order })),
    names: names.map((n) => ({ text: n.text, section: n.section, active: n.active })),
  });
}));

// Heartbeats are not activity: they update the device row and log nothing.
router.post('/heartbeat', wrap(async (req, res) => {
  const { device } = req;
  const pending = req.body?.pendingCount;
  Object.assign(device, {
    appVersion: str(req.body?.appVersion, 40) ?? device.appVersion,
    modelVersion: str(req.body?.modelVersion, 40) ?? device.modelVersion,
    pendingCount: Number.isInteger(pending) && pending >= 0 ? pending : device.pendingCount,
  });
  await device.save();
  res.json({ ok: true, serverTime: new Date().toISOString() });
}));

export const newDeviceId = () => crypto.randomUUID();

export default router;
