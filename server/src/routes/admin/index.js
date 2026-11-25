import bcrypt from 'bcryptjs';
import { Router } from 'express';
import mongoose from 'mongoose';
import ActivityLog from '../../models/ActivityLog.js';
import DayClose from '../../models/DayClose.js';
import Device from '../../models/Device.js';
import Offering from '../../models/Offering.js';
import Receipt from '../../models/Receipt.js';
import Temple from '../../models/Temple.js';
import User, { TEMPLE_ROLES } from '../../models/User.js';
import {
  HttpError, hashSecret, newSecret, requireRole, requireSuperadmin, requireTemple, requireUser, signUserToken, wrap,
} from '../../middleware/auth.js';
import { logActivity } from '../../services/activity.js';
import { clearZoneCache, isDay, isZone, templeDay } from '../../services/day.js';
import { isOnline } from '../../services/presence.js';
import { seedOfferings } from '../../scripts/seed.js';
import { newDeviceId } from '../device/index.js';

const router = Router();
const office = requireRole('admin', 'supervisor');
const adminOnly = requireRole('admin');

const dayParam = (req) => {
  const { day } = req.query;
  if (day === undefined || day === '') return templeDay(new Date(), req.temple.timezone);
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
  let temple = null;
  if (user.role !== 'superadmin') {
    temple = await Temple.findById(user.templeId);
    if (!temple?.active) throw new HttpError(403, 'This temple is not active');
  }
  res.json({ token: signUserToken(user), user: user.toPublic(), temple: temple?.toPublic() ?? null });
}));

router.use(requireUser);

router.get('/auth/me', (req, res) => res.json({
  user: req.user.toPublic(),
  temple: req.user.role === 'superadmin' ? null : req.temple.toPublic(),
}));

// ---- temples (platform super admin) ----------------------------------------

const validationMessage = (err) => {
  if (err?.code === 11000) return 'That already exists';
  if (err?.name === 'ValidationError') return Object.values(err.errors).map((e) => e.message).join(' ');
  return null;
};

async function createUserIn(templeId, { email, name, password, role }, actor) {
  if (!email || !password || String(password).length < 8) throw new HttpError(400, 'Email and a password of at least 8 characters are required');
  if (!TEMPLE_ROLES.includes(role)) throw new HttpError(400, `role must be one of ${TEMPLE_ROLES.join(', ')}`);
  let user;
  try {
    user = await User.create({ email, name, role, templeId, passwordHash: await bcrypt.hash(String(password), 10) });
  } catch (err) {
    const msg = validationMessage(err);
    if (msg) throw new HttpError(400, err.code === 11000 ? 'That email already has an account' : msg);
    throw err;
  }
  await logActivity({
    templeId, type: 'user.created', actorType: 'user', userId: actor._id,
    objectType: 'user', objectId: user.id,
    message: `${actor.email} created ${user.email} as ${user.role}`,
    meta: { role: user.role, changedBy: actor.email },
  });
  return user;
}

const templeView = async (t) => {
  const [counters, users] = await Promise.all([
    Device.countDocuments({ templeId: t._id, revokedAt: null }),
    User.countDocuments({ templeId: t._id }),
  ]);
  return { ...t.toPublic(), counters, users };
};

// Platform overview: one row per temple for the day, so the super admin sees
// money and counter health without opening each temple in turn.
router.get('/temples/overview', requireSuperadmin, wrap(async (req, res) => {
  const { day: q } = req.query;
  if (q !== undefined && q !== '' && !isDay(q)) throw new HttpError(400, 'day must be YYYY-MM-DD');
  const temples = await Temple.find().sort({ name: 1 });
  const rows = await Promise.all(temples.map(async (t) => {
    const day = q || templeDay(new Date(), t.timezone);
    const [sums, voided, devices, closes] = await Promise.all([
      Receipt.aggregate([
        { $match: { templeId: t._id, day, voided: { $ne: true } } },
        { $group: { _id: '$paymentMode', count: { $sum: 1 }, amount: { $sum: '$amount' } } },
      ]),
      Receipt.countDocuments({ templeId: t._id, day, voided: true }),
      Device.find({ templeId: t._id, revokedAt: null, enrolledAt: { $ne: null } }).lean(),
      DayClose.find({ templeId: t._id, day }).lean(),
    ]);
    const mode = (m) => sums.filter((r) => (r._id || 'cash') === m).reduce((n, r) => n + r.amount, 0);
    const counters = devices.length;
    return {
      id: t.id, name: t.name, code: t.code, active: t.active, day,
      collected: sums.reduce((n, r) => n + r.amount, 0),
      receipts: sums.reduce((n, r) => n + r.count, 0),
      cash: mode('cash'), digital: mode('upi') + mode('card'),
      voided,
      counters, online: devices.filter(isOnline).length,
      unsynced: devices.reduce((n, d) => n + (d.pendingCount || 0), 0),
      closed: closes.length,
      short: closes.filter((c) => c.variance !== 0).length,
    };
  }));
  res.json({ temples: rows, total: { collected: rows.reduce((n, r) => n + r.collected, 0), receipts: rows.reduce((n, r) => n + r.receipts, 0) } });
}));

router.get('/temples', requireSuperadmin, wrap(async (_req, res) => {
  const temples = await Temple.find().sort({ name: 1 });
  res.json({ temples: await Promise.all(temples.map(templeView)) });
}));

// Creates a temple, loads its offering list, and (optionally) its first admin.
router.post('/temples', requireSuperadmin, wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const code = String(req.body?.code || '').trim().toLowerCase();
  const timezone = req.body?.timezone || 'Asia/Kolkata';
  if (!name) throw new HttpError(400, 'Temple name is required');
  if (!isZone(timezone)) throw new HttpError(400, 'Unknown timezone');
  const admin = req.body?.admin;
  if (admin && (!admin.email || String(admin.password || '').length < 8)) {
    throw new HttpError(400, 'The temple admin needs an email and a password of at least 8 characters');
  }
  let temple;
  try {
    temple = await Temple.create({ name, code, timezone });
  } catch (err) {
    const msg = validationMessage(err);
    if (msg) throw new HttpError(400, err.code === 11000 ? 'That temple code is taken' : msg.replace(/Path `code`.*/, 'Code must be 2-40 letters, digits or dashes'));
    throw err;
  }
  await seedOfferings(temple._id);
  let adminUser = null;
  if (admin) {
    try {
      adminUser = await createUserIn(temple._id, { ...admin, role: 'admin' }, req.user);
    } catch (err) {
      // Do not leave a temple nobody can sign in to because the admin was refused.
      await Promise.all([Temple.deleteOne({ _id: temple._id }), Offering.deleteMany({ templeId: temple._id })]);
      throw err;
    }
  }
  await logActivity({
    templeId: temple._id, type: 'temple.created', actorType: 'user', userId: req.user._id,
    objectType: 'temple', objectId: temple.id, message: `${req.user.email} created temple ${temple.name}`,
  });
  res.status(201).json({ temple: await templeView(temple), admin: adminUser?.toPublic() ?? null });
}));

router.patch('/temples/:id', requireSuperadmin, wrap(async (req, res) => {
  const temple = await Temple.findById(objectId(req.params.id));
  if (!temple) throw new HttpError(404, 'Temple not found');
  const { name, timezone, active } = req.body || {};
  if (typeof name === 'string' && name.trim()) temple.name = name.trim();
  if (timezone !== undefined) {
    if (!isZone(timezone)) throw new HttpError(400, 'Unknown timezone');
    temple.timezone = timezone;
  }
  if (typeof active === 'boolean') temple.active = active;
  await temple.save();
  clearZoneCache();
  await logActivity({
    templeId: temple._id, type: 'temple.updated', actorType: 'user', userId: req.user._id,
    objectType: 'temple', objectId: temple.id, message: `${req.user.email} updated temple ${temple.name}`,
    meta: { name: temple.name, timezone: temple.timezone, active: temple.active },
  });
  res.json({ temple: await templeView(temple) });
}));

// Everything below belongs to one temple.
router.use(requireTemple);

// ---- activity log ----------------------------------------------------------

router.get('/logs', wrap(async (req, res) => {
  const day = dayParam(req);
  const filter = { templeId: req.temple._id, day };
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
    { $match: { templeId: req.temple._id, day } },
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

router.get('/offerings', wrap(async (req, res) => {
  const offerings = await Offering.find({ templeId: req.temple._id }).sort({ sortOrder: 1, labelEng: 1 });
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

  const existing = new Map((await Offering.find({ templeId: req.temple._id })).map((o) => [o.labelMal, o]));
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
    const target = doc || new Offering({ templeId: req.temple._id, labelMal, sortOrder: nextSort });
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
        templeId: req.temple._id, type: doc ? 'offering.updated' : 'offering.created', actorType: 'user', userId: req.user._id,
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
  const offering = new Offering({ templeId: req.temple._id });
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
    templeId: req.temple._id, type: 'offering.created', actorType: 'user', userId: req.user._id,
    objectType: 'offering', objectId: offering.id,
    message: `${req.user.email} added offering ${offering.labelEng}`,
    meta: { before: null, after: offeringView(offering) },
  });
  res.status(201).json({ offering: offeringView(offering) });
}));

router.patch('/offerings/:id', office, wrap(async (req, res) => {
  const offering = await Offering.findOne({ _id: objectId(req.params.id), templeId: req.temple._id });
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
      templeId: req.temple._id, type: 'offering.updated', actorType: 'user', userId: req.user._id,
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
  const filter = { templeId: req.temple._id };
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
  const receipt = await Receipt.findOne({ _id: String(req.params.id).toLowerCase(), templeId: req.temple._id });
  if (!receipt) throw new HttpError(404, 'Receipt not found');
  if (receipt.voided) throw new HttpError(409, 'Receipt is already voided');
  Object.assign(receipt, { voided: true, voidedAt: new Date(), voidedBy: req.user._id, voidReason: reason });
  await receipt.save();
  await logActivity({
    templeId: req.temple._id, type: 'receipt.voided', severity: 'warning', actorType: 'user', userId: req.user._id,
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
    { $match: { templeId: req.temple._id, day, voided: { $ne: true } } },
    { $group: { _id: key, count: { $sum: 1 }, amount: { $sum: '$amount' } } },
    { $sort: { amount: -1 } },
  ]);
  const [byOffering, byCounter, voided] = await Promise.all([
    group('$offering'),
    group({ deviceId: '$deviceId', counterName: '$counterName' }),
    Receipt.aggregate([
      { $match: { templeId: req.temple._id, day, voided: true } },
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

// ---- day close (till reconciliation) ----------------------------------------
// Expected cash per counter = non-voided CASH receipts for the day. The office
// counts the till and enters the figure; the variance is stored with the close.

async function reconciliationFor(temple, day) {
  const templeId = temple._id;
  const [rows, closes, devices] = await Promise.all([
    Receipt.aggregate([
      { $match: { templeId, day, voided: { $ne: true } } },
      { $group: { _id: { deviceId: '$deviceId', mode: '$paymentMode' }, count: { $sum: 1 }, amount: { $sum: '$amount' } } },
    ]),
    DayClose.find({ templeId, day }).lean(),
    Device.find({ templeId }).lean(),
  ]);
  const byId = new Map(devices.map((d) => [d.deviceId, d]));
  const closeBy = new Map(closes.map((c) => [c.deviceId, c]));
  const counters = new Map();
  const blank = (deviceId) => ({ deviceId, cash: 0, upi: 0, card: 0, count: 0 });
  for (const r of rows) {
    if (!counters.has(r._id.deviceId)) counters.set(r._id.deviceId, blank(r._id.deviceId));
    const c = counters.get(r._id.deviceId);
    c[r._id.mode || 'cash'] += r.amount;
    c.count += r.count;
  }
  for (const id of closeBy.keys()) if (!counters.has(id)) counters.set(id, blank(id));
  return [...counters.values()].map((c) => {
    const d = byId.get(c.deviceId);
    const close = closeBy.get(c.deviceId);
    return {
      ...c,
      counterName: d?.counterName || close?.counterName || c.deviceId,
      pendingCount: d?.pendingCount || 0,
      online: d ? isOnline(d) : false,
      close: close ? {
        declaredCash: close.declaredCash, expectedCash: close.expectedCash, variance: close.variance,
        note: close.note, closedAt: close.closedAt, closedByEmail: close.closedByEmail,
        stale: close.expectedCash !== c.cash,
      } : null,
    };
  }).sort((a, b) => a.counterName.localeCompare(b.counterName));
}

router.get('/reports/reconciliation', wrap(async (req, res) => {
  const day = dayParam(req);
  res.json({ day, counters: await reconciliationFor(req.temple, day) });
}));

router.post('/reports/close', office, wrap(async (req, res) => {
  const day = dayParam(req);
  const deviceId = String(req.body?.deviceId || '');
  const declaredCash = Number(req.body?.declaredCash);
  if (!deviceId) throw new HttpError(400, 'deviceId required');
  if (req.body?.declaredCash === '' || req.body?.declaredCash == null || !Number.isFinite(declaredCash) || declaredCash < 0) {
    throw new HttpError(400, 'declaredCash must be a number, 0 or more');
  }
  const counter = (await reconciliationFor(req.temple, day)).find((c) => c.deviceId === deviceId);
  if (!counter) throw new HttpError(404, 'No such counter for that day');
  const expectedCash = counter.cash;
  const variance = Math.round((declaredCash - expectedCash) * 100) / 100;
  const note = String(req.body?.note || '').trim().slice(0, 500);
  if (variance !== 0 && !note) throw new HttpError(400, 'A note is required when the cash does not match');
  const close = await DayClose.findOneAndUpdate(
    { templeId: req.temple._id, day, deviceId },
    { templeId: req.temple._id, day, deviceId, counterName: counter.counterName, declaredCash, expectedCash, variance, note,
      closedAt: new Date(), closedBy: req.user._id, closedByEmail: req.user.email },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  await logActivity({
    templeId: req.temple._id, type: 'day.closed', severity: variance === 0 ? 'info' : 'warning',
    actorType: 'user', userId: req.user._id, deviceId, counterName: counter.counterName,
    objectType: 'dayclose', objectId: close.id,
    message: `${req.user.email} closed ${counter.counterName}: expected ₹${expectedCash}, counted ₹${declaredCash}`
      + (variance === 0 ? '' : ` (${variance > 0 ? 'over' : 'short'} ₹${Math.abs(variance)})`),
    meta: { day, expectedCash, declaredCash, variance, note },
  });
  res.json({ close: { declaredCash, expectedCash, variance, note } });
}));

// ---- devices ---------------------------------------------------------------

const deviceView = (d) => ({
  id: d.id, deviceId: d.deviceId, counterName: d.counterName,
  status: d.revokedAt ? 'revoked' : d.enrolledAt ? 'enrolled' : 'awaiting enrolment',
  appVersion: d.appVersion, modelVersion: d.modelVersion, platform: d.platform,
  lastSeenAt: d.lastSeenAt, pendingCount: d.pendingCount, enrolledAt: d.enrolledAt, revokedAt: d.revokedAt,
  online: isOnline(d),
});

router.get('/devices', wrap(async (req, res) => {
  const devices = await Device.find({ templeId: req.temple._id }).sort({ counterName: 1 });
  res.json({ devices: devices.map(deviceView) });
}));

// Registers a counter and returns the one-time code its tablet enrols with.
// The code is shown once and stored only as a hash.
router.post('/devices', adminOnly, wrap(async (req, res) => {
  const counterName = String(req.body?.counterName || '').trim();
  if (!counterName) throw new HttpError(400, 'counterName required');
  const enrollCode = newSecret(5).toUpperCase();
  const device = await Device.create({
    templeId: req.temple._id, deviceId: newDeviceId(), counterName, enrollCodeHash: hashSecret(enrollCode), enrolledBy: req.user._id,
  });
  res.status(201).json({ device: deviceView(device), enrollCode });
}));

router.post('/devices/:id/revoke', adminOnly, wrap(async (req, res) => {
  const device = await Device.findOne({ _id: objectId(req.params.id), templeId: req.temple._id });
  if (!device) throw new HttpError(404, 'Device not found');
  if (device.revokedAt) throw new HttpError(409, 'Device is already revoked');
  const reason = String(req.body?.reason || '').trim();
  Object.assign(device, { revokedAt: new Date(), tokenHash: undefined, enrollCodeHash: undefined });
  await device.save();
  await logActivity({
    templeId: req.temple._id, type: 'device.revoked', severity: 'warning', actorType: 'user', userId: req.user._id,
    deviceId: device.deviceId, counterName: device.counterName,
    objectType: 'device', objectId: device.deviceId,
    message: `${req.user.email} revoked ${device.counterName}`,
    meta: { revokedBy: req.user.email, reason },
  });
  res.json({ device: deviceView(device) });
}));

// ---- users -----------------------------------------------------------------

router.get('/users', adminOnly, wrap(async (req, res) => {
  const users = await User.find({ templeId: req.temple._id }).sort({ email: 1 });
  res.json({ users: users.map((u) => u.toPublic()) });
}));

router.post('/users', adminOnly, wrap(async (req, res) => {
  const user = await createUserIn(req.temple._id, req.body || {}, req.user);
  res.status(201).json({ user: user.toPublic() });
}));

router.patch('/users/:id', adminOnly, wrap(async (req, res) => {
  const user = await User.findOne({ _id: objectId(req.params.id), templeId: req.temple._id });
  if (!user) throw new HttpError(404, 'User not found');
  const { role, active, name, password } = req.body || {};
  const self = user.id === req.user.id;
  // The temple must never be left with nobody able to administer it.
  if (self && ((role !== undefined && role !== 'admin') || active === false)) {
    throw new HttpError(400, 'You cannot remove your own admin access');
  }
  const before = user.role;
  if (role !== undefined) {
    if (!TEMPLE_ROLES.includes(role)) throw new HttpError(400, `role must be one of ${TEMPLE_ROLES.join(', ')}`);
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
      templeId: req.temple._id, type: 'user.role.changed', actorType: 'user', userId: req.user._id,
      objectType: 'user', objectId: user.id,
      message: `${req.user.email} changed ${user.email} from ${before} to ${user.role}`,
      meta: { role: user.role, previousRole: before, changedBy: req.user.email },
    });
  }
  res.json({ user: user.toPublic() });
}));

export default router;
