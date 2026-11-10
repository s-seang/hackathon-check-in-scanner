// ---------------------------------------------------------------
// auth.js — login for the whole app.
//
//  - One admin account (username + password), created on the first visit
//    from the laptop that runs the app. Saved in .env as a scrypt hash,
//    never as the password itself.
//  - After logging in, the browser gets a signed "session" cookie
//    (HttpOnly, SameSite=Strict) that lasts 12 hours.
//  - Wrong passwords are limited: 5 tries per device per 15 minutes.
// ---------------------------------------------------------------

const crypto = require('crypto');

const SESSION_HOURS = 12;
const COOKIE = 'session';
const MIN_PASSWORD = 8;

// ================= Passwords =================

/** Turn a password into "scrypt$<salt>$<hash>" for storing. */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** Does this password match the stored hash? (Constant-time compare.) */
function verifyPassword(password, stored) {
  const [kind, saltHex, hashHex] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

/** Returns an error message, or null if the password is acceptable. */
function checkNewPassword(password) {
  const p = String(password || '');
  if (p.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters.`;
  if (p.length > 200) return 'Password is too long.';
  return null;
}

// ================= Sessions (signed cookies) =================

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const sign = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

/**
 * A session token: "<data>.<signature>". The data holds the username, the expiry time,
 * and a fingerprint of the password hash, so changing the password logs out every device.
 */
function makeToken(secret, user, passwordHash) {
  const data = b64(JSON.stringify({ u: user, exp: Date.now() + SESSION_HOURS * 3600 * 1000, v: fingerprint(passwordHash) }));
  return `${data}.${sign(secret, data)}`;
}

function readToken(secret, token, passwordHash) {
  const [data, sig] = String(token || '').split('.');
  if (!data || !sig) return null;
  const good = Buffer.from(sign(secret, data));
  const given = Buffer.from(sig);
  if (good.length !== given.length || !crypto.timingSafeEqual(good, given)) return null;
  try {
    const s = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (s.exp < Date.now() || s.v !== fingerprint(passwordHash)) return null;
    return s;
  } catch {
    return null;
  }
}

const fingerprint = (hash) => crypto.createHash('sha256').update(String(hash || '')).digest('hex').slice(0, 16);

function getCookie(req, name) {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function setSessionCookie(req, res, token) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${SESSION_HOURS * 3600}`];
  if (req.secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${req.secure ? '; Secure' : ''}`);
}

// ================= Wrong-password limit =================

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const fails = new Map(); // ip → { count, first }

/** Seconds this device must still wait, or 0. */
function lockedFor(ip) {
  const f = fails.get(ip);
  if (!f) return 0;
  if (Date.now() - f.first > LOCK_MS) {
    fails.delete(ip);
    return 0;
  }
  return f.count >= MAX_FAILS ? Math.ceil((f.first + LOCK_MS - Date.now()) / 1000) : 0;
}
function recordFail(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.first > LOCK_MS) fails.set(ip, { count: 1, first: Date.now() });
  else f.count++;
}
const clearFails = (ip) => fails.delete(ip);

module.exports = {
  hashPassword,
  verifyPassword,
  checkNewPassword,
  makeToken,
  readToken,
  getCookie,
  setSessionCookie,
  clearSessionCookie,
  lockedFor,
  recordFail,
  clearFails,
  COOKIE,
  MAX_FAILS,
};
