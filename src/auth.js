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
//
// Five failed sign-ins in 15 minutes lock an email for 15 minutes (login_attempts).
// New customers confirm their email with a one-time code, anyone can reset a forgotten
// password with one, and sellers and staff can add an authenticator app (TOTP).
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { audit } from './audit.js';
import { all, loads, now, one, run, scalar } from './db.js';
import { AppError, badRequest, notFound } from './errors.js';
import { mask } from './mask.js';
import { sendEmail } from './outbox.js';

const SESSION_TTL_SECONDS = 7 * 24 * 3600;
// fastHashing: tests only, so the sample accounts are quick to create.
export const settings = { fastHashing: false };

// Demo mode: the sample accounts and their shared password work only when
// EQUIDRON_SEED_DEMO=1 (local runs and the demo site). Anywhere else they can't sign in.
export const demoMode = () => process.env.EQUIDRON_SEED_DEMO === '1';
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
  email, name.trim(), role, salt, hash, algo, Boolean(isSample),
  JSON.stringify(role === 'ops' ? checkPermissions(permissions) : []), Boolean(verified), now());
}

// An agent's own account, e.g. createAgentUser(db, 'returns', 'Returns agent'). Its password
// is random and never stored anywhere: agents act through tools, not sign-in pages.
export async function createAgentUser(db, agentId, name) {
  return await createUser(db, `${agentId}@agents.equidron.invalid`, name, crypto.randomBytes(32).toString('hex'), 'agent');
}

export async function staffList(db) {
  const rows = await all(db, "SELECT id, email, name, permissions FROM users WHERE role = 'ops' ORDER BY id");
  return rows.map((r) => ({ ...r, permissions: loads(r.permissions, []) }));
}

export async function setPermissions(db, userId, permissions, byUserId) {
  const user = await one(db, "SELECT id, permissions FROM users WHERE id = ? AND role = 'ops'", userId);
  if (!user) throw notFound('Staff member');
  const next = checkPermissions(permissions);
  if (userId === byUserId && !next.includes('admin')) throw badRequest("You can't remove your own admin permission.");
  const before = loads(user.permissions, []);
  await run(db, 'UPDATE users SET permissions = ? WHERE id = ?', JSON.stringify(next), userId);
  await audit(db, 'staff.permissions', 'user', userId, { permissions: before }, { permissions: next });
  return { id: userId, permissions: next };
}

// ---------------------------------------------------------------- sign-in and sessions

const WHERE = { customer: 'the Equidron store', seller: 'Seller Central', ops: 'Equidron Ops' };
// Compared against when the email is unknown, so a wrong email takes as long as a wrong password.
const nobody = () => ({ pw_algo: currentAlgo(), pw_salt: '00'.repeat(16), pw_hash: '00'.repeat(32) });

const MAX_FAILURES = 5;
const LOCK_SECONDS = 15 * 60;
const nowSeconds = () => Date.now() / 1000;

async function recordAttempt(db, email, ok) {
  await run(db, 'INSERT INTO login_attempts (email, ok, at) VALUES (?,?,?)', email, Boolean(ok), nowSeconds());
}

// Seconds until this email may try again; 0 when it isn't locked.
async function lockedFor(db, email) {
  const since = Math.max(nowSeconds() - LOCK_SECONDS,
    await scalar(db, 'SELECT COALESCE(MAX(at), 0) FROM login_attempts WHERE email = ? AND ok', email));
  const failures = await all(db, 'SELECT at FROM login_attempts WHERE email = ? AND NOT ok AND at > ? ORDER BY at DESC', email, since);
  return failures.length >= MAX_FAILURES ? Math.max(1, failures[0].at + LOCK_SECONDS - nowSeconds()) : 0;
}

// Return a new session token, or throw. Accounts of another role are refused.
// Call it where a thrown error doesn't undo the attempt record: the login route answers
// with the error instead of throwing it, so its transaction still commits.
export async function login(db, email, password, role, { otp = null } = {}) {
  email = normalEmail(email);
  const wait = await lockedFor(db, email);
  if (wait) {
    await audit(db, 'auth.locked', 'user', mask(email), null, { role });
    throw new AppError(429, `Too many failed sign-ins. Try again in ${Math.ceil(wait / 60)} minutes, or reset your password.`);
  }
  const user = await one(db, 'SELECT * FROM users WHERE email = ?', email);
  const ok = await passwordMatches(user || nobody(), password || '');
  if (!user || !ok) {
    await recordAttempt(db, email, false);
    throw new AppError(401, 'Incorrect email or password.');
  }
  if (user.role === 'agent') throw new AppError(403, "Agent accounts can't sign in.");
  if (user.is_sample && !demoMode()) throw new AppError(403, 'Sample accounts are turned off on this site.');
  if (user.role !== role) throw new AppError(403, `This account can't sign in here. Please use ${WHERE[user.role]}.`);
  if (!user.email_verified) {
    throw new AppError(403, 'Please confirm your email first, with the code we sent you.', { needs_verification: true });
  }
  if (user.totp_enabled) {
    if (!otp) throw new AppError(401, 'Enter the 6-digit code from your authenticator app.', { otp_required: true });
    const step = matchTotp(user.totp_secret, otp, user.totp_last_step);
    if (step === null) {
      await recordAttempt(db, email, false);
      throw new AppError(401, "That code isn't right. Check your authenticator app and try again.", { otp_required: true });
    }
    await run(db, 'UPDATE users SET totp_last_step = ? WHERE id = ?', step, user.id);
  }
  await recordAttempt(db, email, true);
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
  user.permissions = role === 'ops' ? loads(user.permissions, []) : undefined;
  if (role === 'seller') {
    const seller = await one(db, 'SELECT id, name FROM sellers WHERE user_id = ?', user.id);
    user.seller_id = seller.id;
    user.seller_name = seller.name;
  }
  return user;
}

// ---------------------------------------------------------------- one-time codes

const CODE_TTL_SECONDS = 30 * 60;
const MAX_CODE_TRIES = 5;
const codeHash = (userId, purpose, code) => crypto.createHash('sha256').update(`${purpose}:${userId}:${String(code ?? '').trim()}`).digest('hex');

// A new 6-digit code for this purpose; any older one stops working.
async function issueCode(db, userId, purpose) {
  await run(db, 'UPDATE auth_codes SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL', nowSeconds(), userId, purpose);
  const code = String(crypto.randomInt(1_000_000)).padStart(6, '0');
  await run(db, 'INSERT INTO auth_codes (user_id, purpose, code_hash, expires_at) VALUES (?,?,?,?)',
    userId, purpose, codeHash(userId, purpose, code), nowSeconds() + CODE_TTL_SECONDS);
  return code;
}

// True when the code is right; it then can't be used again. Wrong tries are counted, and
// after five the code stops working. Callers answer instead of throwing, so the count is kept.
async function useCode(db, userId, purpose, code) {
  const c = await one(db, `SELECT * FROM auth_codes WHERE user_id = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?
                          ORDER BY id DESC LIMIT 1`, userId, purpose, nowSeconds());
  if (!c || c.attempts >= MAX_CODE_TRIES) return false;
  if (!crypto.timingSafeEqual(Buffer.from(codeHash(userId, purpose, code)), Buffer.from(c.code_hash))) {
    await run(db, 'UPDATE auth_codes SET attempts = attempts + 1 WHERE id = ?', c.id);
    return false;
  }
  await run(db, 'UPDATE auth_codes SET used_at = ? WHERE id = ?', nowSeconds(), c.id);
  return true;
}

// A new customer account, which can sign in once the emailed code is entered.
export async function startSignUp(db, email, name, password) {
  const id = await createUser(db, email, name, password, 'customer', false, { verified: false });
  await sendVerification(db, id);
  return id;
}

export async function sendVerification(db, userId) {
  const user = await one(db, 'SELECT id, email, email_verified FROM users WHERE id = ?', userId);
  if (!user || user.email_verified) return;
  const code = await issueCode(db, user.id, 'verify_email');
  await sendEmail(db, user.id, user.email, 'Confirm your Equidron account',
    `Your Equidron code is ${code}. It expires in 30 minutes. If you didn't create an account, ignore this email.`);
}

export async function resendVerification(db, email) {
  const user = await one(db, "SELECT id FROM users WHERE email = ? AND role = 'customer' AND NOT email_verified", normalEmail(email));
  if (user) await sendVerification(db, user.id);
}

// The user id once the email is confirmed, else null.
export async function verifyEmail(db, email, code) {
  const user = await one(db, "SELECT id FROM users WHERE email = ? AND role = 'customer' AND NOT email_verified", normalEmail(email));
  if (!user || !(await useCode(db, user.id, 'verify_email', code))) return null;
  await run(db, 'UPDATE users SET email_verified = true WHERE id = ?', user.id);
  await audit(db, 'auth.email_verified', 'user', user.id);
  return user.id;
}

// Send a reset code if this email has an account of this role. The answer is the same either way.
export async function requestPasswordReset(db, email, role, area) {
  const user = await one(db, 'SELECT id, email FROM users WHERE email = ? AND role = ?', normalEmail(email), role);
  if (!user) return;
  const code = await issueCode(db, user.id, 'reset_password');
  await sendEmail(db, user.id, user.email, 'Reset your Equidron password',
    `Your password reset code is ${code}. Open /${area}/#/reset?code=${code} to choose a new password. `
    + "It works once and expires in 30 minutes. If you didn't ask for this, ignore this email.");
  await audit(db, 'auth.reset_requested', 'user', user.id, null, { role });
}

// True when the password was changed. Every session of the account ends.
export async function resetPassword(db, email, role, code, password) {
  checkPassword(password);
  const user = await one(db, 'SELECT id, email FROM users WHERE email = ? AND role = ?', normalEmail(email), role);
  if (!user || !(await useCode(db, user.id, 'reset_password', code))) return false;
  await setPassword(db, user.id, password);
  await run(db, 'UPDATE users SET email_verified = true WHERE id = ?', user.id); // the code proved the email
  await logoutEverywhere(db, user.id);
  await recordAttempt(db, user.email, true); // lifts a lockout
  await audit(db, 'auth.password_reset', 'user', user.id, null, { role });
  return true;
}

// ---------------------------------------------------------------- authenticator apps (TOTP, RFC 6238)

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function toBase32(buf) {
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  return bits.match(/.{1,5}/g).map((c) => BASE32[parseInt(c.padEnd(5, '0'), 2)]).join('');
}

function fromBase32(text) {
  const bits = [...text.replace(/=+$/, '').toUpperCase()].map((c) => BASE32.indexOf(c).toString(2).padStart(5, '0')).join('');
  return Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
}

function hotp(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', fromBase32(secret)).update(msg).digest();
  const offset = h[h.length - 1] & 15;
  return String((h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

const timeStep = (ms) => Math.floor(ms / 30_000);

// The code an authenticator app shows at this time.
export const totp = (secret, ms = Date.now()) => hotp(secret, timeStep(ms));

// The time step the code belongs to (allowing 30 seconds of clock drift either way), else null.
// A step at or before lastStep is refused, so each code works only once.
function matchTotp(secret, code, lastStep) {
  const given = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(given)) return null;
  const now = timeStep(Date.now());
  for (const s of [now - 1, now, now + 1]) {
    if (s > (lastStep ?? -1) && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(hotp(secret, s)))) return s;
  }
  return null;
}

// A new secret for the app. Two-step sign-in starts only once confirmTotp() sees a right code.
export async function setupTotp(db, user) {
  const secret = toBase32(crypto.randomBytes(20));
  await run(db, 'UPDATE users SET totp_secret = ?, totp_enabled = false, totp_last_step = NULL WHERE id = ?', secret, user.id);
  const label = encodeURIComponent(`Equidron:${user.email}`);
  return { secret, otpauth_url: `otpauth://totp/${label}?secret=${secret}&issuer=Equidron&digits=6&period=30` };
}

// enable true turns two-step sign-in on, false turns it off. Either needs a current code.
export async function confirmTotp(db, userId, code, enable) {
  const user = await one(db, 'SELECT totp_secret, totp_last_step FROM users WHERE id = ?', userId);
  const step = user?.totp_secret ? matchTotp(user.totp_secret, code, user.totp_last_step) : null;
  if (step === null) return false;
  await run(db, 'UPDATE users SET totp_enabled = ?, totp_last_step = ?, totp_secret = ? WHERE id = ?',
    Boolean(enable), step, enable ? user.totp_secret : null, userId);
  await audit(db, enable ? 'auth.2fa_enabled' : 'auth.2fa_disabled', 'user', userId);
  return true;
}

export async function twoStepStatus(db, userId) {
  return { enabled: Boolean((await one(db, 'SELECT totp_enabled FROM users WHERE id = ?', userId)).totp_enabled) };
}
