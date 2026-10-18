// Admin password and session tokens. The password is stored only as a salted scrypt hash.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const KEY_LEN = 64;
export const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 4;

export async function createAdminRecord(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error('비밀번호는 ' + MIN_PASSWORD_LENGTH + '자 이상이어야 합니다.');
  }
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LEN);
  return {
    version: 1,
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
    // Signing key for session tokens. A new one on every password change logs out every device.
    tokenSecret: crypto.randomBytes(32).toString('base64'),
    updatedAt: new Date().toISOString(),
  };
}

export async function readAdminRecord(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function verifyPassword(password, record) {
  if (typeof password !== 'string' || !password || password.length > 256) return false;
  const expected = Buffer.from(record.hash, 'base64');
  const actual = await scrypt(password, Buffer.from(record.salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function issueToken(record) {
  const exp = Date.now() + TOKEN_TTL_MS;
  const payload = b64url(JSON.stringify({ role: 'admin', exp }));
  const sig = crypto.createHmac('sha256', Buffer.from(record.tokenSecret, 'base64')).update(payload).digest('base64url');
  return { token: payload + '.' + sig, expiresAt: exp };
}

export function checkToken(token, record) {
  if (!record || typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', Buffer.from(record.tokenSecret, 'base64')).update(payload).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.role === 'admin' && data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

/** Blocks an address for a while after repeated wrong passwords. */
export class LoginLimiter {
  constructor({ maxFailures = 5, windowMs = 10 * 60 * 1000 } = {}) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
    this.entries = new Map();
  }

  retryAfterMs(key) {
    const e = this.entries.get(key);
    if (!e) return 0;
    if (Date.now() - e.first > this.windowMs) {
      this.entries.delete(key);
      return 0;
    }
    return e.count >= this.maxFailures ? this.windowMs - (Date.now() - e.first) : 0;
  }

  fail(key) {
    const e = this.entries.get(key);
    if (!e || Date.now() - e.first > this.windowMs) this.entries.set(key, { first: Date.now(), count: 1 });
    else e.count += 1;
  }

  succeed(key) {
    this.entries.delete(key);
  }
}
