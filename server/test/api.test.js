import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, test } from 'node:test';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';

process.env.JWT_SECRET = 'test-secret';
process.env.DEVICE_TOKEN_PEPPER = 'test-pepper';
process.env.TEMPLE_TZ = 'Asia/Kolkata';

const { createApp } = await import('../src/app.js');
const { seed } = await import('../src/scripts/seed.js');
const { default: User } = await import('../src/models/User.js');
const { default: Temple } = await import('../src/models/Temple.js');
const { default: ActivityLog } = await import('../src/models/ActivityLog.js');
const { default: Name } = await import('../src/models/Name.js');
const { templeDay } = await import('../src/services/day.js');

let mongo, api, temple, admin, supervisor, viewer, superadmin, deviceToken, deviceRow;
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const dev = () => ({ Authorization: `Device ${deviceToken}` });
const logsOf = (type) => ActivityLog.find({ type }).sort({ at: 1, _id: 1 }).lean();

async function signIn(email, role, templeId = temple?._id) {
  await User.create({ email, role, templeId, passwordHash: await bcrypt.hash('password-1', 4) });
  const res = await api.post('/admin/auth/login').send({ email, password: 'password-1' });
  assert.equal(res.status, 200);
  return res.body.token;
}

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri('test'));
  await mongoose.connection.syncIndexes();
  api = request(createApp());
  temple = await Temple.create({ name: 'Test Temple', code: 'test' });
  superadmin = await signIn('super@t.test', 'superadmin');
  admin = await signIn('admin@t.test', 'admin');
  supervisor = await signIn('sup@t.test', 'supervisor');
  viewer = await signIn('ml@t.test', 'ml');
});

after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

test('seed loads 27 nakshatrams and 19 unpriced, inactive offerings, and is re-runnable', async () => {
  assert.deepEqual(await seed(temple._id), { nakshatrams: 27, offerings: 19 });
  assert.deepEqual(await seed(temple._id), { nakshatrams: 0, offerings: 0 });
  const { body } = await api.get('/admin/offerings').set(bearer(admin));
  assert.equal(body.offerings.length, 19);
  assert.ok(body.offerings.every((o) => o.price === null && o.active === false));
  assert.equal(body.offerings.filter((o) => !o.priceIsFixed).length, 2);
});

test('admin routes need a valid session; a wrong password is refused', async () => {
  assert.equal((await api.get('/admin/logs')).status, 401);
  assert.equal((await api.get('/admin/logs').set(bearer('nope'))).status, 401);
  const bad = await api.post('/admin/auth/login').send({ email: 'admin@t.test', password: 'wrong' });
  assert.equal(bad.status, 401);
});

test('a fixed-price offering cannot go live without a price; a price change is logged before/after', async () => {
  const { body } = await api.get('/admin/offerings').set(bearer(admin));
  const archana = body.offerings.find((o) => o.labelEng === 'Archana');
  const refuse = await api.patch(`/admin/offerings/${archana.id}`).set(bearer(supervisor)).send({ active: true });
  assert.equal(refuse.status, 400);

  const ok = await api.patch(`/admin/offerings/${archana.id}`).set(bearer(supervisor)).send({ price: 20, active: true });
  assert.equal(ok.status, 200);
  const raised = await api.patch(`/admin/offerings/${archana.id}`).set(bearer(supervisor)).send({ price: 25 });
  assert.equal(raised.status, 200, JSON.stringify(raised.body));
  const logs = await logsOf('offering.updated');
  const last = logs.at(-1);
  assert.deepEqual(last.meta.before, { price: 20 });
  assert.deepEqual(last.meta.after, { price: 25 });

  // Devotee-chosen offerings have no price by design and may still go live.
  const thula = body.offerings.find((o) => o.labelEng === 'Thulabharam');
  const live = await api.patch(`/admin/offerings/${thula.id}`).set(bearer(admin)).send({ active: true });
  assert.equal(live.status, 200);

  assert.equal((await api.patch(`/admin/offerings/${archana.id}`).set(bearer(viewer)).send({ price: 1 })).status, 403);
});

test('a counter enrols with a one-time code from the office, and the code dies on first use of the token', async () => {
  assert.equal((await api.post('/admin/devices').set(bearer(supervisor)).send({ counterName: 'Counter 1' })).status, 403);
  const made = await api.post('/admin/devices').set(bearer(admin)).send({ counterName: 'Counter 1' });
  assert.equal(made.status, 201);
  const code = made.body.enrollCode;
  deviceRow = made.body.device;

  assert.equal((await api.post('/device/v1/enroll').send({ code: 'WRONGCODE1' })).status, 401);
  const first = await api.post('/device/v1/enroll').send({ code, appVersion: '1.2.1' });
  assert.equal(first.status, 200);
  // The tablet lost the reply and asks again: it gets a working token.
  const again = await api.post('/device/v1/enroll').send({ code: code.toLowerCase() });
  assert.equal(again.status, 200);
  deviceToken = again.body.token;
  assert.equal((await api.post('/device/v1/heartbeat').set({ Authorization: `Device ${first.body.token}` }).send({})).status, 401);

  assert.equal((await api.post('/device/v1/heartbeat').set(dev()).send({ pendingCount: 3 })).status, 200);
  assert.equal((await api.post('/device/v1/enroll').send({ code })).status, 401);
  assert.equal((await logsOf('device.enrolled')).length, 1);
  assert.equal((await logsOf('app.heartbeat')).length, 0);
});

test('login and logout are logged against the counter', async () => {
  assert.equal((await api.post('/device/v1/login').send({ operatorName: 'x' })).status, 401);
  const res = await api.post('/device/v1/login').set(dev()).send({ operatorName: 'Rajesh', appVersion: '1.2.1', modelVersion: 'ctc-1', platform: 'windows' });
  assert.equal(res.status, 200);
  await api.post('/device/v1/logout').set(dev()).send({ operatorName: 'Rajesh', reason: 'expiry' });
  const [login] = await logsOf('app.login');
  assert.equal(login.message, 'Rajesh signed in at Counter 1');
  assert.equal(login.meta.platform, 'windows');
  assert.equal(login.day, templeDay());
  assert.equal((await logsOf('app.logout'))[0].meta.reason, 'expiry');
});

const receipt = (over = {}) => ({
  id: crypto.randomUUID(), name: 'ശ്രീകുമാരി', nakshatram: 'അശ്വതി', offering: 'അർച്ചന', amount: 25,
  timestamp: new Date().toISOString(), printed: true, ...over,
});
let pushed;

test('receipts are acknowledged one by one; a bad row does not fail the batch and a retry duplicates nothing', async () => {
  pushed = [receipt(), receipt({ name: 'വേണുഗോപാൽ', offering: 'പാൽപായസം', amount: 150 })];
  const bad = receipt({ amount: 'lots' });
  const noId = { ...receipt(), id: '7' };
  const res = await api.post('/device/v1/receipts').set(dev()).send({ entries: [...pushed, bad, noId], pendingAfter: 0 });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.results.map((r) => r.status), ['created', 'created', 'rejected', 'rejected']);
  assert.equal(res.body.results[0].id, pushed[0].id);

  const retry = await api.post('/device/v1/receipts').set(dev()).send({ entries: pushed });
  assert.deepEqual(retry.body.results.map((r) => r.status), ['duplicate', 'duplicate']);

  const list = await api.get('/admin/receipts').set(bearer(admin));
  assert.equal(list.body.total, 2);
  assert.equal((await logsOf('receipt.created')).length, 2);
  const failed = await logsOf('app.sync.failed');
  assert.equal(failed.length, 1);
  assert.deepEqual([failed[0].meta.received, failed[0].meta.accepted, failed[0].meta.rejected], [4, 2, 2]);
  assert.equal((await logsOf('app.sync')).length, 1);
});

test('a receipt written just after midnight IST lands on that temple day, not the UTC one', async () => {
  const late = receipt({ timestamp: '2026-09-02T18:40:00.000Z' }); // 00:10 IST on 3 September
  await api.post('/device/v1/receipts').set(dev()).send({ entries: [late] });
  const day = await api.get('/admin/receipts?day=2026-09-03').set(bearer(admin));
  assert.deepEqual(day.body.receipts.map((r) => r.id), [late.id]);
  assert.equal((await api.get('/admin/receipts?day=nonsense').set(bearer(admin))).status, 400);
});

test('voiding needs a reason, is logged as a warning, survives a re-push, and leaves the daily report', async () => {
  const today = templeDay();
  const before_ = await api.get(`/admin/reports/daily?day=${today}`).set(bearer(admin));
  assert.deepEqual(before_.body.total, { count: 2, amount: 175 });
  assert.equal(before_.body.byCounter[0].counterName, 'Counter 1');

  const id = pushed[1].id;
  assert.equal((await api.post(`/admin/receipts/${id}/void`).set(bearer(admin)).send({})).status, 400);
  assert.equal((await api.post(`/admin/receipts/${id}/void`).set(bearer(viewer)).send({ reason: 'x' })).status, 403);
  assert.equal((await api.post(`/admin/receipts/${id}/void`).set(bearer(supervisor)).send({ reason: 'Wrong offering' })).status, 200);
  assert.equal((await api.post(`/admin/receipts/${id}/void`).set(bearer(supervisor)).send({ reason: 'again' })).status, 409);

  await api.post('/device/v1/receipts').set(dev()).send({ entries: [pushed[1]] });
  const still = await api.get('/admin/receipts?voided=true').set(bearer(admin));
  assert.deepEqual(still.body.receipts.map((r) => r.id), [id]);

  const [log] = await logsOf('receipt.voided');
  assert.equal(log.severity, 'warning');
  assert.equal(log.meta.reason, 'Wrong offering');

  const report = await api.get(`/admin/reports/daily?day=${today}`).set(bearer(admin));
  assert.deepEqual(report.body.total, { count: 1, amount: 25 });
  assert.deepEqual(report.body.voided, { count: 1, amount: 150 });
  assert.deepEqual(report.body.byOffering, [{ offering: 'അർച്ചന', count: 1, amount: 25 }]);
});

test('master data gives counters only offerings they can charge for', async () => {
  const { body, status } = await api.get('/device/v1/master').set(dev());
  assert.equal(status, 200);
  assert.deepEqual(body.offerings.map((o) => o.labelEng).sort(), ['Archana', 'Thulabharam']);
  assert.equal(body.offerings.find((o) => o.labelEng === 'Archana').price, 25);
  assert.equal(body.nakshatrams.length, 27);
  assert.equal(body.nakshatrams[0].mal, 'അശ്വതി');
});

test('the daily log filters by type and the summary counts the four tiles', async () => {
  const day = templeDay();
  const logins = await api.get(`/admin/logs?day=${day}&type=app.login`).set(bearer(viewer));
  assert.equal(logins.body.logs.length, 1);
  const all = await api.get('/admin/logs').set(bearer(admin));
  assert.equal(all.body.day, day);
  assert.ok(all.body.logs.every((l, i, a) => i === 0 || new Date(a[i - 1].at) >= new Date(l.at)));
  const { body } = await api.get(`/admin/logs/summary?day=${day}`).set(bearer(admin));
  assert.equal(body.logins, 1);
  assert.equal(body.receipts, 3);
  assert.ok(body.syncs >= 3);
  assert.equal(body.errors, 0);
});

test('a revoked counter is locked out and the revocation is logged', async () => {
  const res = await api.post(`/admin/devices/${deviceRow.id}/revoke`).set(bearer(admin)).send({ reason: 'Tablet replaced' });
  assert.equal(res.body.device.status, 'revoked');
  assert.equal((await api.post('/device/v1/heartbeat').set(dev()).send({})).status, 401);
  assert.equal((await logsOf('device.revoked'))[0].meta.reason, 'Tablet replaced');
});

test('users: admin only, role changes are logged, and an admin cannot lock themselves out', async () => {
  assert.equal((await api.get('/admin/users').set(bearer(supervisor))).status, 403);
  const made = await api.post('/admin/users').set(bearer(admin)).send({ email: 'New@T.test', password: 'long-enough', role: 'operator' });
  assert.equal(made.status, 201);
  assert.equal(made.body.user.email, 'new@t.test');
  assert.equal(made.body.user.passwordHash, undefined);
  assert.equal((await api.post('/admin/users').set(bearer(admin)).send({ email: 'new@t.test', password: 'long-enough', role: 'operator' })).status, 400);
  assert.equal((await api.post('/admin/users').set(bearer(admin)).send({ email: 'b@t.test', password: 'short', role: 'operator' })).status, 400);

  await api.patch(`/admin/users/${made.body.user.id}`).set(bearer(admin)).send({ role: 'supervisor' });
  assert.equal((await logsOf('user.role.changed'))[0].meta.previousRole, 'operator');

  const me = (await api.get('/admin/auth/me').set(bearer(admin))).body.user;
  assert.equal((await api.patch(`/admin/users/${me.id}`).set(bearer(admin)).send({ role: 'ml' })).status, 400);

  // Deactivating an account ends its session at once.
  const sup = (await api.get('/admin/users').set(bearer(admin))).body.users.find((u) => u.email === 'sup@t.test');
  await api.patch(`/admin/users/${sup.id}`).set(bearer(admin)).send({ active: false });
  assert.equal((await api.get('/admin/logs').set(bearer(supervisor))).status, 401);
});

test('the name dictionary enforces the chillu rule', async () => {
  await assert.rejects(Name.create({ text: 'രാജന്' }), /chillu/);
  await Name.create({ text: 'രാജൻ' });
  await Name.create({ text: 'കൊച്ചുപെണ്ണ്' });
  await Name.create({ text: 'അശോക്' });
});

// ---- multi-temple ----------------------------------------------------------

test('only the super admin creates temples; a new temple gets its own offerings and admin', async () => {
  assert.equal((await api.get('/admin/temples').set(bearer(admin))).status, 403);
  assert.equal((await api.post('/admin/temples').set(bearer(admin)).send({ name: 'X', code: 'xx' })).status, 403);

  const bad = await api.post('/admin/temples').set(bearer(superadmin)).send({ name: 'Bad', code: 'bad', timezone: 'Mars/Base' });
  assert.equal(bad.status, 400);
  const made = await api.post('/admin/temples').set(bearer(superadmin)).send({
    name: 'Second Temple', code: 'second', timezone: 'America/New_York',
    admin: { email: 'boss@second.test', password: 'long-enough' },
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.admin.role, 'admin');
  assert.equal((await api.post('/admin/temples').set(bearer(superadmin)).send({ name: 'Dup', code: 'second' })).status, 400);

  // A refused admin must not leave a half-made temple behind.
  const refused = await api.post('/admin/temples').set(bearer(superadmin)).send({
    name: 'Ghost', code: 'ghost', admin: { email: 'boss@second.test', password: 'long-enough' },
  });
  assert.equal(refused.status, 400);
  assert.equal(await Temple.countDocuments({ code: 'ghost' }), 0);

  const list = await api.get('/admin/temples').set(bearer(superadmin));
  assert.deepEqual(list.body.temples.map((t) => t.code).sort(), ['second', 'test']);

  const login = await api.post('/admin/auth/login').send({ email: 'boss@second.test', password: 'long-enough' });
  assert.equal(login.status, 200);
  assert.equal(login.body.temple.code, 'second');
  const offerings = await api.get('/admin/offerings').set(bearer(login.body.token));
  assert.equal(offerings.body.offerings.length, 19);
});

test('a temple admin sees only their own temple: offerings, receipts, counters, users, logs', async () => {
  const boss = (await api.post('/admin/auth/login').send({ email: 'boss@second.test', password: 'long-enough' })).body.token;
  // Temple one has receipts and counters; temple two has none of them.
  assert.equal((await api.get('/admin/receipts').set(bearer(boss))).body.total, 0);
  assert.equal((await api.get('/admin/devices').set(bearer(boss))).body.devices.length, 0);
  assert.deepEqual((await api.get('/admin/users').set(bearer(boss))).body.users.map((u) => u.email), ['boss@second.test']);
  assert.equal((await api.get('/admin/receipts').set(bearer(admin))).body.total > 0, true);

  // Offering prices are per temple: pricing Archana in temple two leaves temple one alone.
  const mine = (await api.get('/admin/offerings').set(bearer(boss))).body.offerings.find((o) => o.labelEng === 'Archana');
  await api.patch(`/admin/offerings/${mine.id}`).set(bearer(boss)).send({ price: 99, active: true });
  const theirs = (await api.get('/admin/offerings').set(bearer(superadmin)).set('X-Temple-Id', String(temple._id))).body.offerings.find((o) => o.labelEng === 'Archana');
  assert.equal(theirs.price, 25);

  // Another temple's records answer as if they do not exist.
  assert.equal((await api.patch(`/admin/offerings/${theirs.id}`).set(bearer(boss)).send({ price: 1 })).status, 404);
  assert.equal((await api.post(`/admin/receipts/${pushed[0].id}/void`).set(bearer(boss)).send({ reason: 'x' })).status, 404);
  const [theirUser] = await User.find({ email: 'admin@t.test' });
  assert.equal((await api.patch(`/admin/users/${theirUser.id}`).set(bearer(boss)).send({ active: false })).status, 404);
  const theirDevice = deviceRow.id;
  assert.equal((await api.post(`/admin/devices/${theirDevice}/revoke`).set(bearer(boss)).send({})).status, 404);

  const logs = (await api.get('/admin/logs').set(bearer(boss))).body.logs;
  const secondId = String((await Temple.findOne({ code: 'second' }))._id);
  assert.ok(logs.length > 0 && logs.every((l) => String(l.templeId) === secondId));
});

test('a counter enrolled in one temple only ever sees and writes that temple', async () => {
  const boss = (await api.post('/admin/auth/login').send({ email: 'boss@second.test', password: 'long-enough' })).body.token;
  const made = await api.post('/admin/devices').set(bearer(boss)).send({ counterName: 'Gate' });
  const enrolled = await api.post('/device/v1/enroll').send({ code: made.body.enrollCode });
  const auth = { Authorization: `Device ${enrolled.body.token}` };

  const master = await api.get('/device/v1/master').set(auth);
  assert.deepEqual(master.body.offerings.map((o) => o.labelEng), ['Archana']);
  assert.equal(master.body.offerings[0].price, 99);

  // 23:30 on 2 Sept in New York is already 3 Sept in UTC and India: the day is the temple's own.
  const entry = receipt({ timestamp: '2026-09-03T03:30:00.000Z' });
  await api.post('/device/v1/receipts').set(auth).send({ entries: [entry] });
  const day = await api.get('/admin/receipts?day=2026-09-02').set(bearer(boss));
  assert.deepEqual(day.body.receipts.map((r) => r.id), [entry.id]);
  assert.equal((await api.get('/admin/receipts?day=2026-09-03').set(bearer(admin))).body.receipts.some((r) => r.id === entry.id), false);
});

test('a super admin steps into a temple with X-Temple-Id; without one, temple routes need a choice', async () => {
  assert.equal((await api.get('/admin/offerings').set(bearer(superadmin))).status, 400);
  const into = await api.get('/admin/offerings').set(bearer(superadmin)).set('X-Temple-Id', String(temple._id));
  assert.equal(into.status, 200);
  assert.equal((await api.get('/admin/offerings').set(bearer(superadmin)).set('X-Temple-Id', 'nope')).status, 400);
  // A temple admin cannot hop into another temple by sending the header.
  const boss = (await api.post('/admin/auth/login').send({ email: 'boss@second.test', password: 'long-enough' })).body.token;
  const hop = await api.get('/admin/receipts').set(bearer(boss)).set('X-Temple-Id', String(temple._id));
  assert.equal(hop.body.total, 1);
  // The super admin cannot be given to a temple by the users route.
  assert.equal((await api.post('/admin/users').set(bearer(boss)).send({ email: 's2@x.test', password: 'long-enough', role: 'superadmin' })).status, 400);
});

test('deactivating a temple locks out its staff and counters until it is switched back on', async () => {
  const second = await Temple.findOne({ code: 'second' });
  const boss = (await api.post('/admin/auth/login').send({ email: 'boss@second.test', password: 'long-enough' })).body.token;
  const made = await api.post('/admin/devices').set(bearer(boss)).send({ counterName: 'Side' });
  const token = (await api.post('/device/v1/enroll').send({ code: made.body.enrollCode })).body.token;

  const off = await api.patch(`/admin/temples/${second.id}`).set(bearer(superadmin)).send({ active: false });
  assert.equal(off.body.temple.active, false);
  assert.equal((await api.get('/admin/offerings').set(bearer(boss))).status, 403);
  assert.equal((await api.post('/admin/auth/login').send({ email: 'boss@second.test', password: 'long-enough' })).status, 403);
  assert.equal((await api.post('/device/v1/heartbeat').set({ Authorization: `Device ${token}` }).send({})).status, 403);

  await api.patch(`/admin/temples/${second.id}`).set(bearer(superadmin)).send({ active: true });
  assert.equal((await api.get('/admin/offerings').set(bearer(boss))).status, 200);
  assert.equal((await api.post('/device/v1/heartbeat').set({ Authorization: `Device ${token}` }).send({})).status, 200);
});

test('day close: expected cash per counter, mismatch needs a note, re-closing updates, other temples never see it', async () => {
  const today = templeDay();
  const made = await api.post('/admin/devices').set(bearer(admin)).send({ counterName: 'Till 9' });
  const enrolled = await api.post('/device/v1/enroll').send({ code: made.body.enrollCode });
  const dev = () => ({ Authorization: `Device ${enrolled.body.token}` });
  const upi = receipt({ amount: 40, paymentMode: 'upi' });
  await api.post('/device/v1/receipts').set(dev()).send({ entries: [upi, receipt({ amount: 25 })] });

  const rec = await api.get(`/admin/reports/reconciliation?day=${today}`).set(bearer(admin));
  assert.equal(rec.status, 200);
  const c = rec.body.counters.find((x) => x.counterName === 'Till 9');
  assert.deepEqual([c.cash, c.upi, c.close], [25, 40, null]);

  const close = (body, token = admin) => api.post(`/admin/reports/close?day=${today}`).set(bearer(token)).send({ deviceId: c.deviceId, ...body });
  assert.equal((await close({ declaredCash: 25 }, viewer)).status, 403);
  assert.equal((await close({ declaredCash: '' })).status, 400);
  assert.equal((await close({ declaredCash: 20 })).status, 400);               // short, no note
  assert.equal((await close({ declaredCash: 20, note: 'Change given' })).status, 200);
  const after1 = (await api.get(`/admin/reports/reconciliation?day=${today}`).set(bearer(admin))).body.counters.find((x) => x.deviceId === c.deviceId);
  assert.equal(after1.close.variance, -5);
  assert.equal((await close({ declaredCash: 25 })).status, 200);
  const after2 = (await api.get(`/admin/reports/reconciliation?day=${today}`).set(bearer(admin))).body.counters.find((x) => x.deviceId === c.deviceId);
  assert.equal(after2.close.variance, 0);
  assert.equal((await logsOf('day.closed')).length, 2);

  // A late cash receipt makes the close stale.
  await api.post('/device/v1/receipts').set(dev()).send({ entries: [receipt({ amount: 10 })] });
  const stale = (await api.get(`/admin/reports/reconciliation?day=${today}`).set(bearer(admin))).body.counters.find((x) => x.deviceId === c.deviceId);
  assert.equal(stale.close.stale, true);

  // Super admin overview and temple isolation.
  const other = await Temple.create({ name: 'Other', code: 'other' });
  const otherAdmin = await signIn('admin@other.test', 'admin', other._id);
  assert.deepEqual((await api.get(`/admin/reports/reconciliation?day=${today}`).set(bearer(otherAdmin))).body.counters, []);
  assert.equal((await api.get('/admin/temples/overview').set(bearer(admin))).status, 403);
  const ov = await api.get('/admin/temples/overview').set(bearer(superadmin));
  assert.equal(ov.status, 200);
  const mine = ov.body.temples.find((t) => t.code === 'test');
  assert.deepEqual([mine.collected, mine.digital, mine.closed], [mine.cash + 40, 40, 1]);
  assert.equal(ov.body.temples.find((t) => t.code === 'other').collected, 0);
});
