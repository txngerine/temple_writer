import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import Device from '../models/Device.js';
import User from '../models/User.js';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** Wraps an async handler so a rejection reaches the error middleware. */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const jwtSecret = () => {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not set');
  return process.env.JWT_SECRET;
};

export const signUserToken = (user) =>
  jwt.sign({ sub: user.id, role: user.role }, jwtSecret(), { expiresIn: '12h' });

/** Tokens and enrol codes are stored only as peppered hashes. */
export const hashSecret = (secret) =>
  crypto.createHmac('sha256', process.env.DEVICE_TOKEN_PEPPER || '').update(secret).digest('hex');

export const newSecret = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');

/** People: `Authorization: Bearer <jwt>`. */
export const requireUser = wrap(async (req, _res, next) => {
  const [scheme, token] = (req.get('authorization') || '').split(' ');
  if (scheme !== 'Bearer' || !token) throw new HttpError(401, 'Sign in required');
  let payload;
  try {
    payload = jwt.verify(token, jwtSecret());
  } catch {
    throw new HttpError(401, 'Session expired, sign in again');
  }
  // Looked up on every request so a deactivated account or a changed role
  // takes effect at once, not when the token happens to expire.
  const user = await User.findById(payload.sub);
  if (!user || !user.active) throw new HttpError(401, 'Account is not active');
  req.user = user;
  next();
});

export const requireRole = (...roles) => (req, _res, next) =>
  next(roles.includes(req.user.role) ? undefined : new HttpError(403, 'Your role does not allow this'));

/** Counters: `Authorization: Device <token>`. */
export const requireDevice = wrap(async (req, _res, next) => {
  const [scheme, token] = (req.get('authorization') || '').split(' ');
  if (scheme !== 'Device' || !token) throw new HttpError(401, 'Device token required');
  const device = await Device.findOne({ tokenHash: hashSecret(token) });
  if (!device) throw new HttpError(401, 'Unknown device token');
  if (device.revokedAt) throw new HttpError(403, 'This device has been revoked');
  device.lastSeenAt = new Date();
  // The token demonstrably arrived, so the enrol code has done its job.
  if (device.enrollCodeHash) device.enrollCodeHash = undefined;
  await device.save();
  req.device = device;
  next();
});
