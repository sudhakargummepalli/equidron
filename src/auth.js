// Password hashing, role-scoped sessions, staff permissions and agent accounts.
//
// Each interface (shop, seller, ops) has its own login endpoint, its own cookie
// and its own session role. A session created for one role is never accepted by
// another interface's API. Agent accounts (role 'agent') exist so agents act as
// real users in the audit log, but no interface accepts them.
//
// Passwords are hashed with scrypt; accounts from before that used PBKDF2 and are
// re-hashed at their next sign-in. The sessions table keeps only a SHA-256 hash of
// each token, so a copy of the database can't be used to sign in.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { audit } from './audit.js';
import { all, now, one, run } from './db.js';
import { AppError, badRequest, notFound } from './errors.js';

const SESSION_TTL_SECONDS = 7 * 24 * 3600;
// fastHashing: tests only, so the sample accounts are quick to create.
export const settings = { fastHashing: false };
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// ---------------------------------------------------------------- passwords

const scrypt = promisify(crypto.scrypt);
// One of OWASP's recommended scrypt settings: 16 MiB of memory, parallelism 5.
const SCRYPT = { N: 16384, r: 8, p: 5 };

async function scryptKey(password, saltHex, { N, r, p }) {
  return await scrypt(String(password), Buffer.from(saltHex, 'hex'), 32, { N, r, p, maxmem: 256 * N * r });
}

const cost = () => (settings.fastHashing ? { N: 1024, r: 8, p: 1 } : SCRYPT);
const currentAlgo = () => `scrypt:${cost().N}:${cost().r}:${cost().p}`;

export async function hashPassword(password) {
  const { N, r, p } = cost();
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scryptKey(password, salt, { N, r, p });
  return { salt, hash: key.toString('hex'), algo: currentAlgo() };
}

// The hash accounts had before Phase 1, kept so they can still sign in once.
export function legacyPbkdf2(password, rounds, salt = crypto.randomBytes(16).toString('hex')) {
  return [salt, crypto.pbkdf2Sync(String(password), Buffer.from(salt, 'hex'), rounds, 32, 'sha256').toString('hex')];
}

async function passwordMatches(user, password) {
  const [kind, ...params] = String(user.pw_algo).split(':').map((x, i) => (i ? Number(x) : x));
  const digest = kind === 'scrypt'
    ? await scryptKey(password, user.pw_salt, { N: params[0], r: params[1], p: params[2] })
    : Buffer.from(legacyPbkdf2(password, params[0], user.pw_salt)[1], 'hex');
  const expected = Buffer.from(user.pw_hash, 'hex');
  return digest.length === expected.length && crypto.timingSafeEqual(digest, expected);
}

function checkPassword(password) {
  if (String(password || '').length < 8) throw badRequest('Password must be at least 8 characters.');
}

export async function setPassword(db, userId, password) {
  checkPassword(password);
  const { salt, hash, algo } = await hashPassword(password);
  await run(db, 'UPDATE users SET pw_salt = ?, pw_hash = ?, pw_algo = ? WHERE id = ?', salt, hash, algo, userId);
}

// ---------------------------------------------------------------- accounts

// Staff permissions. admin includes all the others.
export const PERMISSIONS = ['support', 'catalog', 'logistics', 'finance', 'admin'];

export function hasPermission(user, permission) {
  const perms = user?.permissions || [];
  return perms.includes('admin') || perms.includes(permission);
}

function checkPermissions(list) {
  if (!Array.isArray(list) || list.some((p) => !PERMISSIONS.includes(p))) {
    throw badRequest(`Permissions must be chosen from: ${PERMISSIONS.join(', ')}.`);
  }
  return [...new Set(list)];
}

export const normalEmail = (email) => String(email || '').trim().toLowerCase();

export async function createUser(db, email, name, password, role, isSample = false, { permissions = [], verified = true } = {}) {
  email = normalEmail(email);
  if (!EMAIL_RE.test(email)) throw badRequest('Enter a valid email address.');
  checkPassword(password);
  if (!String(name || '').trim()) throw badRequest('Name is required.');
  if (await one(db, 'SELECT 1 AS x FROM users WHERE email = ?', email)) throw badRequest('An account with that email already exists.');
  const { salt, hash, algo } = await hashPassword(password);
  return await run(db, `INSERT INTO users (email, name, role, pw_salt, pw_hash, pw_algo, is_sample, permissions, email_verified, created_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?)`,
  email, name.trim(), role, salt, hash, algo, isSample ? 1 : 0,
  JSON.stringify(role === 'ops' ? checkPermissions(permissions) : []), verified ? 1 : 0, now());
}

// An agent's own account, e.g. createAgentUser(db, 'returns', 'Returns agent'). Its password
// is random and never stored anywhere: agents act through tools, not sign-in pages.
export async function createAgentUser(db, agentId, name) {
  return await createUser(db, `${agentId}@agents.equidron.invalid`, name, crypto.randomBytes(32).toString('hex'), 'agent');
}

export async function staffList(db) {
  const rows = await all(db, "SELECT id, email, name, permissions FROM users WHERE role = 'ops' ORDER BY id");
  return rows.map((r) => ({ ...r, permissions: JSON.parse(r.permissions) }));
}

export async function setPermissions(db, userId, permissions, byUserId) {
  const user = await one(db, "SELECT id, permissions FROM users WHERE id = ? AND role = 'ops'", userId);
  if (!user) throw notFound('Staff member');
  const next = checkPermissions(permissions);
  if (userId === byUserId && !next.includes('admin')) throw badRequest("You can't remove your own admin permission.");
  const before = JSON.parse(user.permissions);
  await run(db, 'UPDATE users SET permissions = ? WHERE id = ?', JSON.stringify(next), userId);
  await audit(db, 'staff.permissions', 'user', userId, { permissions: before }, { permissions: next });
  return { id: userId, permissions: next };
}

// ---------------------------------------------------------------- sign-in and sessions

const WHERE = { customer: 'the Equidron store', seller: 'Seller Central', ops: 'Equidron Ops' };
// Compared against when the email is unknown, so a wrong email takes as long as a wrong password.
const nobody = () => ({ pw_algo: currentAlgo(), pw_salt: '00'.repeat(16), pw_hash: '00'.repeat(32) });

// Return a new session token, or throw. Accounts of another role are refused.
export async function login(db, email, password, role) {
  const user = await one(db, 'SELECT * FROM users WHERE email = ?', normalEmail(email));
  const ok = await passwordMatches(user || nobody(), password || '');
  if (!user || !ok) throw new AppError(401, 'Incorrect email or password.');
  if (user.role === 'agent') throw new AppError(403, "Agent accounts can't sign in.");
  if (user.role !== role) throw new AppError(403, `This account can't sign in here. Please use ${WHERE[user.role]}.`);
  if (user.pw_algo !== currentAlgo()) await setPassword(db, user.id, password); // upgrade an older hash
  return await issueSession(db, user.id, role);
}

export const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

export async function issueSession(db, userId, role) {
  const token = crypto.randomBytes(32).toString('base64url');
  await run(db, 'INSERT INTO sessions (token, user_id, role, expires_at) VALUES (?,?,?,?)',
    tokenHash(token), userId, role, Date.now() / 1000 + SESSION_TTL_SECONDS);
  return token;
}

export async function logout(db, token) {
  await run(db, 'DELETE FROM sessions WHERE token = ?', tokenHash(token));
}

// "Sign out of all devices": every session of this account, in every interface.
export async function logoutEverywhere(db, userId) {
  await run(db, 'DELETE FROM sessions WHERE user_id = ?', userId);
}

// The user for a valid session of exactly this role, else null.
export async function userForToken(db, token, role) {
  if (!token) return null;
  const s = await one(db, 'SELECT * FROM sessions WHERE token = ?', tokenHash(token));
  if (!s || s.role !== role || s.expires_at < Date.now() / 1000) return null;
  const user = await one(db, 'SELECT id, email, name, role, is_sample, permissions FROM users WHERE id = ?', s.user_id);
  if (!user || user.role !== role || user.role === 'agent') return null;
  user.permissions = role === 'ops' ? JSON.parse(user.permissions) : undefined;
  if (role === 'seller') {
    const seller = await one(db, 'SELECT id, name FROM sellers WHERE user_id = ?', user.id);
    user.seller_id = seller.id;
    user.seller_name = seller.name;
  }
  return user;
}
