// Password hashing and role-scoped sessions.
//
// Each interface (shop, seller, ops) has its own login endpoint, its own cookie
// and its own session role. A session created for one role is never accepted by
// another interface's API.
import crypto from 'node:crypto';
import { now, one, run } from './db.js';
import { AppError, badRequest } from './errors.js';

const SESSION_TTL_SECONDS = 7 * 24 * 3600;
export const settings = { pbkdf2Rounds: 120_000 };
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const digest = crypto.pbkdf2Sync(String(password), Buffer.from(salt, 'hex'), settings.pbkdf2Rounds, 32, 'sha256');
  return [salt, digest.toString('hex')];
}

export async function createUser(db, email, name, password, role, isSample = false) {
  email = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw badRequest('Enter a valid email address.');
  if (String(password || '').length < 8) throw badRequest('Password must be at least 8 characters.');
  if (!String(name || '').trim()) throw badRequest('Name is required.');
  if (await one(db, 'SELECT 1 AS x FROM users WHERE email = ?', email)) throw badRequest('An account with that email already exists.');
  const [salt, digest] = hashPassword(password);
  return await run(db, 'INSERT INTO users (email, name, role, pw_salt, pw_hash, is_sample, created_at) VALUES (?,?,?,?,?,?,?)',
    email, name.trim(), role, salt, digest, isSample ? 1 : 0, now());
}

const WHERE = { customer: 'the Equidron store', seller: 'Seller Central', ops: 'Equidron Ops' };

// Return a new session token, or throw 401. Accounts of another role are refused.
export async function login(db, email, password, role) {
  const user = await one(db, 'SELECT * FROM users WHERE email = ?', String(email || '').trim().toLowerCase());
  const ok = user && crypto.timingSafeEqual(Buffer.from(hashPassword(password || '', user.pw_salt)[1]), Buffer.from(user.pw_hash));
  if (!ok) throw new AppError(401, 'Incorrect email or password.');
  if (user.role !== role) throw new AppError(403, `This account can't sign in here. Please use ${WHERE[user.role]}.`);
  const token = crypto.randomBytes(32).toString('base64url');
  await run(db, 'INSERT INTO sessions (token, user_id, role, expires_at) VALUES (?,?,?,?)',
    token, user.id, role, Date.now() / 1000 + SESSION_TTL_SECONDS);
  return token;
}

export async function logout(db, token) {
  await run(db, 'DELETE FROM sessions WHERE token = ?', token);
}

// The user for a valid session of exactly this role, else null.
export async function userForToken(db, token, role) {
  if (!token) return null;
  const s = await one(db, 'SELECT * FROM sessions WHERE token = ?', token);
  if (!s || s.role !== role || s.expires_at < Date.now() / 1000) return null;
  const user = await one(db, 'SELECT id, email, name, role, is_sample FROM users WHERE id = ?', s.user_id);
  if (!user || user.role !== role) return null;
  if (role === 'seller') {
    const seller = await one(db, 'SELECT id, name FROM sellers WHERE user_id = ?', user.id);
    user.seller_id = seller.id;
    user.seller_name = seller.name;
  }
  return user;
}
