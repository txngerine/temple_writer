import bcrypt from 'bcryptjs';
import { Router } from 'express';
import mongoose from 'mongoose';
import ActivityLog from '../../models/ActivityLog.js';
import Device from '../../models/Device.js';
import Offering from '../../models/Offering.js';
import Receipt from '../../models/Receipt.js';
import User, { ROLES } from '../../models/User.js';
import {
  HttpError, hashSecret, newSecret, requireRole, requireUser, signUserToken, wrap,
} from '../../middleware/auth.js';
import { logActivity } from '../../services/activity.js';
import { isDay, templeDay } from '../../services/day.js';
import { isOnline } from '../../services/presence.js';
import { newDeviceId } from '../device/index.js';

const router = Router();
const office = requireRole('admin', 'supervisor');
const adminOnly = requireRole('admin');

const dayParam = (req) => {
  const { day } = req.query;
  if (day === undefined || day === '') return templeDay();
  if (!isDay(day)) throw new HttpError(400, 'day must be YYYY-MM-DD');
  return day;
};
const objectId = (id) => {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(404, 'Not found');
  return id;
};
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- sign-in ---------------------------------------------------------------

router.post('/auth/login', wrap(async (req, res) => {
  const email = String(req.body?.email || '').toLowerCase().trim();
  const password = String(req.body?.password || '');
  const user = await User.findOne({ email });
  // Same answer for a wrong address and a wrong password.
  const ok = user && user.active && await bcrypt.compare(password, user.passwordHash);
  if (!ok) throw new HttpError(401, 'Wrong email or password');
  res.json({ token: signUserToken(user), user: user.toPublic() });
}));

router.use(requireUser);

router.get('/auth/me', (req, res) => res.json({ user: req.user.toPublic() }));

// ---- activity log ----------------------------------------------------------

router.get('/logs', wrap(async (req, res) => {
  const day = dayParam(req);
  const filter = { day };
  for (const key of ['type', 'deviceId', 'actorType', 'severity']) {
    if (typeof req.query[key] === 'string' && req.query[key]) filter[key] = req.query[key];
  }
  const limit = Math.min(Number(req.query.limit) || 500, 2000);
  const [logs, total] = await Promise.all([
    ActivityLog.find(filter).sort({ at: -1 }).limit(limit).lean(),
    ActivityLog.countDocuments(filter),
  ]);
  res.json({ day, total, logs });
}));

router.get('/logs/summary', wrap(async (req, res) => {
  const day = dayParam(req);
  const rows = await ActivityLog.aggregate([
    { $match: { day } },
    { $group: { _id: { type: '$type', severity: '$severity' }, count: { $sum: 1 } } },
  ]);
  const byType = {};
  let errors = 0;
  for (const r of rows) {
    byType[r._id.type] = (byType[r._id.type] || 0) + r.count;
    if (r._id.severity === 'error') errors += r.count;
  }
  res.json({
    day, byType,
    logins: byType['app.login'] || 0,
    syncs: (byType['app.sync'] || 0) + (byType['app.sync.failed'] || 0),
    receipts: byType['receipt.created'] || 0,
    errors,
  });
}));

// ---- offerings (rate card) -------------------------------------------------

const OFFERING_FIELDS = ['labelMal', 'labelEng', 'icon', 'price', 'priceIsFixed', 'quickPick', 'sortOrder', 'active', 'activeFrom', 'activeTo'];
const offeringView = (o) => Object.fromEntries([['id', o.id], ...OFFERING_FIELDS.map((f) => [f, o[f] ?? null]), ['updatedAt', o.updatedAt]]);

function applyOfferingBody(offering, body) {
  for (const f of OFFERING_FIELDS) {
    if (!(f in (body || {}))) continue;
    let v = body[f];
    if (f === 'price') v = v === '' || v === null ? null : Number(v);
    if (f === 'price' && v !== null && !Number.isFinite(v)) throw new HttpError(400, 'price must be a number');
    if ((f === 'activeFrom' || f === 'activeTo') && !v) v = undefined;
    offering[f] = v;
  }
}

const validationMessage = (err) => {
  if (err?.code === 11000) return 'That already exists';
  if (err?.name === 'ValidationError') return Object.values(err.errors).map((e) => e.message).join(' ');
  return null;
};

router.get('/offerings', wrap(async (_req, res) => {
  const offerings = await Offering.find().sort({ sortOrder: 1, labelEng: 1 });
  res.json({ offerings: offerings.map(offeringView) });
}));

/**
 * Bulk add/update from a spreadsheet. The browser reads the sheet and sends
 * plain rows; this decides what each one would do and, unless `dryRun`, does it.
 *
 *  - A row whose Malayalam name already exists UPDATES that offering (price,
 *    pricing mode, and anything else the row supplies). Otherwise it CREATES one.
 *  - Rows are judged one by one: a bad row is reported and skipped, the good
 *    ones still go in. `dryRun: true` reports without writing, for the preview.
 *  - The same rules as the form apply: a fixed-price offering cannot be active
 *    until it has a price (see Offering's validation).
 */
router.post('/offerings/import', office, wrap(async (req, res) => {
  const rows = req.body?.rows;
  const dryRun = req.body?.dryRun === true;
  if (!Array.isArray(rows)) throw new HttpError(400, 'rows must be an array');
  if (rows.length === 0) throw new HttpError(400, 'The sheet has no rows to import');
  if (rows.length > 500) throw new HttpError(413, 'Import at most 500 offerings at a time');

  const existing = new Map((await Offering.find()).map((o) => [o.labelMal, o]));
  let nextSort = Math.max(0, ...[...existing.values()].map((o) => o.sortOrder || 0)) + 10;
  const seen = new Set();
  const results = [];

  for (const [i, raw] of rows.entries()) {
    const row = i + 1;
    const labelMal = String(raw?.labelMal ?? '').trim();
    const labelEng = String(raw?.labelEng ?? '').trim();
    const fail = (error) => results.push({ row, labelMal, labelEng, status: 'error', error });

    if (!labelMal) { fail('Malayalam name is missing'); continue; }
    if (seen.has(labelMal)) { fail('Listed twice in this sheet'); continue; }
    seen.add(labelMal);

    let price = null;
    if (raw.price !== '' && raw.price != null) {
      price = Number(raw.price);
      if (!Number.isFinite(price) || price < 0) { fail('Price must be a number, 0 or more'); continue; }
    }
    const priceIsFixed = raw.priceIsFixed !== false;
    const doc = existing.get(labelMal);
    if (!doc && !labelEng) { fail('English name is missing'); continue; }

    // Priced, or deliberately devotee-chosen, means ready for the counters unless
    // the sheet says otherwise.
    const active = typeof raw.active === 'boolean' ? raw.active : (priceIsFixed ? price != null : true);
    const target = doc || new Offering({ labelMal, sortOrder: nextSort });
    const before = doc ? offeringView(doc) : null;
    if (labelEng) target.labelEng = labelEng;
    target.priceIsFixed = priceIsFixed;
    target.price = priceIsFixed ? price : null;
    target.active = active;
    if (typeof raw.quickPick === 'boolean') target.quickPick = raw.quickPick;
    target.updatedBy = req.user._id;

    try {
      await target.validate();
    } catch (err) {
      fail(validationMessage(err) || 'Invalid row');
      continue;
    }
    const status = doc ? 'update' : 'create';
    if (!dryRun) {
      await target.save();
      await logActivity({
        type: doc ? 'offering.updated' : 'offering.created', actorType: 'user', userId: req.user._id,
        objectType: 'offering', objectId: target.id,
        message: `${req.user.email} ${doc ? 'updated' : 'added'} ${target.labelEng} (spreadsheet import)`,
        meta: { before, after: offeringView(target), source: 'import' },
      });
      existing.set(labelMal, target);
    }
    if (!doc) nextSort += 10;
    results.push({ row, labelMal, labelEng: target.labelEng, status, price: target.price, priceIsFixed, active });
  }

  const count = (s) => results.filter((r) => r.status === s).length;
  res.json({ dryRun, created: count('create'), updated: count('update'), errors: count('error'), results });
}));

router.post('/offerings', office, wrap(async (req, res) => {
  const offering = new Offering();
  applyOfferingBody(offering, req.body);
  offering.updatedBy = req.user._id;
  try {
    await offering.save();
  } catch (err) {
    const msg = validationMessage(err);
    if (msg) throw new HttpError(400, msg);
    throw err;
  }
  await logActivity({
    type: 'offering.created', actorType: 'user', userId: req.user._id,
    objectType: 'offering', objectId: offering.id,
    message: `${req.user.email} added offering ${offering.labelEng}`,
    meta: { before: null, after: offeringView(offering) },
  });
  res.status(201).json({ offering: offeringView(offering) });
}));

router.patch('/offerings/:id', office, wrap(async (req, res) => {
  const offering = await Offering.findById(objectId(req.params.id));
  if (!offering) throw new HttpError(404, 'Offering not found');
  const before = offeringView(offering);
  applyOfferingBody(offering, req.body);
  offering.updatedBy = req.user._id;
  try {
    await offering.save();
  } catch (err) {
    const msg = validationMessage(err);
    if (msg) throw new HttpError(400, msg);
    throw err;
  }
  const after = offeringView(offering);
  const changed = OFFERING_FIELDS.filter((f) => String(before[f]) !== String(after[f]));
  if (changed.length) {
    // Price changes are versioned here, not overwritten, so a receipt from
    // last month can be explained.
    await logActivity({
      type: 'offering.updated', actorType: 'user', userId: req.user._id,
      objectType: 'offering', objectId: offering.id,
      message: `${req.user.email} changed ${offering.labelEng}: ${changed.join(', ')}`,
      meta: {
        before: Object.fromEntries(changed.map((f) => [f, before[f]])),
        after: Object.fromEntries(changed.map((f) => [f, after[f]])),
      },
    });
  }
  res.json({ offering: after });
}));

// ---- receipts --------------------------------------------------------------

router.get('/receipts', wrap(async (req, res) => {
  const filter = {};
  if (req.query.day) filter.day = dayParam(req);
  if (typeof req.query.deviceId === 'string' && req.query.deviceId) filter.deviceId = req.query.deviceId;
  if (typeof req.query.offering === 'string' && req.query.offering) filter.offering = req.query.offering;
  if (req.query.voided === 'true') filter.voided = true;
  if (req.query.voided === 'false') filter.voided = { $ne: true };
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q) filter.$or = [{ name: new RegExp(escapeRegex(q), 'i') }, { _id: q.toLowerCase() }];
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const [receipts, total] = await Promise.all([
    Receipt.find(filter).sort({ occurredAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Receipt.countDocuments(filter),
  ]);
  res.json({ total, page, limit, receipts: receipts.map(({ _id, ...r }) => ({ id: _id, ...r })) });
}));

router.post('/receipts/:id/void', office, wrap(async (req, res) => {
  const reason = String(req.body?.reason || '').trim();
  if (!reason) throw new HttpError(400, 'A reason is required to void a receipt');
  const receipt = await Receipt.findById(String(req.params.id).toLowerCase());
  if (!receipt) throw new HttpError(404, 'Receipt not found');
  if (receipt.voided) throw new HttpError(409, 'Receipt is already voided');
  Object.assign(receipt, { voided: true, voidedAt: new Date(), voidedBy: req.user._id, voidReason: reason });
  await receipt.save();
  await logActivity({
    type: 'receipt.voided', severity: 'warning', actorType: 'user', userId: req.user._id,
    deviceId: receipt.deviceId, counterName: receipt.counterName,
    objectType: 'receipt', objectId: receipt.id,
    message: `${req.user.email} voided ₹${receipt.amount} ${receipt.offering} for ${receipt.name}`,
    meta: { amount: receipt.amount, reason },
  });
  const { _id, ...rest } = receipt.toObject();
  res.json({ receipt: { id: _id, ...rest } });
}));

// ---- reports ---------------------------------------------------------------

router.get('/reports/daily', wrap(async (req, res) => {
  const day = dayParam(req);
  const group = (key) => Receipt.aggregate([
    { $match: { day, voided: { $ne: true } } },
    { $group: { _id: key, count: { $sum: 1 }, amount: { $sum: '$amount' } } },
    { $sort: { amount: -1 } },
  ]);
  const [byOffering, byCounter, voided] = await Promise.all([
    group('$offering'),
    group({ deviceId: '$deviceId', counterName: '$counterName' }),
    Receipt.aggregate([
      { $match: { day, voided: true } },
      { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$amount' } } },
    ]),
  ]);
  res.json({
    day,
    total: { count: byOffering.reduce((n, r) => n + r.count, 0), amount: byOffering.reduce((n, r) => n + r.amount, 0) },
    voided: { count: voided[0]?.count || 0, amount: voided[0]?.amount || 0 },
    byOffering: byOffering.map((r) => ({ offering: r._id, count: r.count, amount: r.amount })),
    byCounter: byCounter.map((r) => ({ deviceId: r._id.deviceId, counterName: r._id.counterName, count: r.count, amount: r.amount })),
  });
}));

// ---- devices ---------------------------------------------------------------

const deviceView = (d) => ({
  id: d.id, deviceId: d.deviceId, counterName: d.counterName,
  status: d.revokedAt ? 'revoked' : d.enrolledAt ? 'enrolled' : 'awaiting enrolment',
  appVersion: d.appVersion, modelVersion: d.modelVersion, platform: d.platform,
  lastSeenAt: d.lastSeenAt, pendingCount: d.pendingCount, enrolledAt: d.enrolledAt, revokedAt: d.revokedAt,
  online: isOnline(d),
});

router.get('/devices', wrap(async (_req, res) => {
  const devices = await Device.find().sort({ counterName: 1 });
  res.json({ devices: devices.map(deviceView) });
}));

// Registers a counter and returns the one-time code its tablet enrols with.
// The code is shown once and stored only as a hash.
router.post('/devices', adminOnly, wrap(async (req, res) => {
  const counterName = String(req.body?.counterName || '').trim();
  if (!counterName) throw new HttpError(400, 'counterName required');
  const enrollCode = newSecret(5).toUpperCase();
  const device = await Device.create({
    deviceId: newDeviceId(), counterName, enrollCodeHash: hashSecret(enrollCode), enrolledBy: req.user._id,
  });
  res.status(201).json({ device: deviceView(device), enrollCode });
}));

router.post('/devices/:id/revoke', adminOnly, wrap(async (req, res) => {
  const device = await Device.findById(objectId(req.params.id));
  if (!device) throw new HttpError(404, 'Device not found');
  if (device.revokedAt) throw new HttpError(409, 'Device is already revoked');
  const reason = String(req.body?.reason || '').trim();
  Object.assign(device, { revokedAt: new Date(), tokenHash: undefined, enrollCodeHash: undefined });
  await device.save();
  await logActivity({
    type: 'device.revoked', severity: 'warning', actorType: 'user', userId: req.user._id,
    deviceId: device.deviceId, counterName: device.counterName,
    objectType: 'device', objectId: device.deviceId,
    message: `${req.user.email} revoked ${device.counterName}`,
    meta: { revokedBy: req.user.email, reason },
  });
  res.json({ device: deviceView(device) });
}));

// ---- users -----------------------------------------------------------------

router.get('/users', adminOnly, wrap(async (_req, res) => {
  const users = await User.find().sort({ email: 1 });
  res.json({ users: users.map((u) => u.toPublic()) });
}));

router.post('/users', adminOnly, wrap(async (req, res) => {
  const { email, name, password, role } = req.body || {};
  if (!email || !password || String(password).length < 8) throw new HttpError(400, 'Email and a password of at least 8 characters are required');
  if (!ROLES.includes(role)) throw new HttpError(400, `role must be one of ${ROLES.join(', ')}`);
  let user;
  try {
    user = await User.create({ email, name, role, passwordHash: await bcrypt.hash(String(password), 10) });
  } catch (err) {
    const msg = validationMessage(err);
    if (msg) throw new HttpError(400, err.code === 11000 ? 'That email already has an account' : msg);
    throw err;
  }
  await logActivity({
    type: 'user.created', actorType: 'user', userId: req.user._id,
    objectType: 'user', objectId: user.id,
    message: `${req.user.email} created ${user.email} as ${user.role}`,
    meta: { role: user.role, changedBy: req.user.email },
  });
  res.status(201).json({ user: user.toPublic() });
}));

router.patch('/users/:id', adminOnly, wrap(async (req, res) => {
  const user = await User.findById(objectId(req.params.id));
  if (!user) throw new HttpError(404, 'User not found');
  const { role, active, name, password } = req.body || {};
  const self = user.id === req.user.id;
  // The panel must never be left with nobody able to administer it.
  if (self && ((role !== undefined && role !== 'admin') || active === false)) {
    throw new HttpError(400, 'You cannot remove your own admin access');
  }
  const before = user.role;
  if (role !== undefined) {
    if (!ROLES.includes(role)) throw new HttpError(400, `role must be one of ${ROLES.join(', ')}`);
    user.role = role;
  }
  if (typeof active === 'boolean') user.active = active;
  if (typeof name === 'string') user.name = name;
  if (password !== undefined) {
    if (String(password).length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    user.passwordHash = await bcrypt.hash(String(password), 10);
  }
  await user.save();
  if (before !== user.role) {
    await logActivity({
      type: 'user.role.changed', actorType: 'user', userId: req.user._id,
      objectType: 'user', objectId: user.id,
      message: `${req.user.email} changed ${user.email} from ${before} to ${user.role}`,
      meta: { role: user.role, previousRole: before, changedBy: req.user.email },
    });
  }
  res.json({ user: user.toPublic() });
}));

export default router;
