// Accounts: staff permissions, agent accounts, passwords, sessions, sign-up with a
// verification code, password reset, sign-in lockout and two-step sign-in.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { AREAS, handleApi } from '../src/api.js';
import * as auth from '../src/auth.js';
import { one, scalar, transaction } from '../src/db.js';
import { openDatabase } from '../src/server.js';

auth.settings.fastHashing = true;
process.env.EQUIDRON_SEED_DEMO = '1'; // the sample accounts sign in with the shared demo password

let db;
before(async () => { db = await openDatabase('memory'); });
after(() => db.close());

// A cookie-keeping client over handleApi.
function client() {
  const cookies = {};
  const call = async (method, path, body) => {
    const out = await handleApi(db, { method, path, query: new URLSearchParams(), body, cookies });
    if (out.setCookie) {
      const [k, v] = out.setCookie.split(';')[0].split('=');
      if (v) cookies[k] = v; else delete cookies[k];
    }
    return out;
  };
  call.cookies = cookies;
  return call;
}

const DEMO = 'equidron-demo';

async function staff(email, permissions) {
  await transaction(db, () => auth.createUser(db, email, 'Staff (test)', 'a-long-password', 'ops', false, { permissions }));
  const c = client();
  assert.equal((await c('POST', '/api/ops/login', { email, password: 'a-long-password' })).status, 200);
  return c;
}

test('staff need the right permission for each part of Ops', async () => {
  const support = await staff('support.test@example.com', ['support']);
  assert.equal((await support('GET', '/api/ops/overview')).status, 200);
  assert.equal((await support('GET', '/api/ops/support')).status, 200);
  assert.equal((await support('GET', '/api/ops/returns')).status, 200);
  const settle = await support('POST', '/api/ops/settlement/run', {});
  assert.equal(settle.status, 403);
  assert.match(settle.payload.error, /finance/);
  assert.equal((await support('GET', '/api/ops/submissions')).status, 403);
  assert.equal((await support('POST', '/api/ops/shipments/advance-all', {})).status, 403);
  assert.equal((await support('GET', '/api/ops/audit')).status, 403);

  const finance = await staff('finance.test@example.com', ['finance']);
  assert.equal((await finance('POST', '/api/ops/settlement/run', {})).status, 200);
  assert.equal((await finance('GET', '/api/ops/support')).status, 403);

  const admin = client();
  await admin('POST', '/api/ops/login', { email: 'ops@example.com', password: DEMO });
  assert.deepEqual((await admin('GET', '/api/ops/me')).payload.user.permissions, ['admin']);
  for (const path of ['/api/ops/submissions', '/api/ops/shipments', '/api/ops/returns', '/api/ops/support', '/api/ops/audit', '/api/ops/staff']) {
    assert.equal((await admin('GET', path)).status, 200, path);
  }
});

test('an admin changes permissions, and the change is audited; nobody else can', async () => {
  const admin = client();
  await admin('POST', '/api/ops/login', { email: 'ops@example.com', password: DEMO });
  const target = (await one(db, "SELECT id FROM users WHERE email = 'support.test@example.com'")).id;
  const out = await admin('POST', `/api/ops/staff/${target}/permissions`, { permissions: ['support', 'catalog'] });
  assert.equal(out.status, 200);
  assert.deepEqual(out.payload.permissions, ['support', 'catalog']);
  const row = await one(db, "SELECT * FROM audit_log WHERE action = 'staff.permissions' ORDER BY id DESC LIMIT 1");
  assert.deepEqual(row.before.permissions, ['support']);
  assert.deepEqual(row.after.permissions, ['support', 'catalog']);
  assert.equal((await admin('POST', `/api/ops/staff/${target}/permissions`, { permissions: ['boss'] })).status, 400);
  const self = (await one(db, "SELECT id FROM users WHERE email = 'ops@example.com'")).id;
  assert.equal((await admin('POST', `/api/ops/staff/${self}/permissions`, { permissions: [] })).status, 400); // no locking yourself out

  const finance = client();
  await finance('POST', '/api/ops/login', { email: 'finance.test@example.com', password: 'a-long-password' });
  assert.equal((await finance('POST', `/api/ops/staff/${target}/permissions`, { permissions: ['admin'] })).status, 403);
});

test('every interface refuses an agent account and an agent session', async () => {
  // A name that is not one of the seeded agents: 'returns' and the others already have accounts.
  const agentId = await transaction(db, () => auth.createAgentUser(db, 'demo_agent', 'Demo agent'));
  const agent = await one(db, 'SELECT * FROM users WHERE id = ?', agentId);
  assert.equal(agent.role, 'agent');
  for (const [area, role] of Object.entries(AREAS)) {
    const c = client();
    const login = await c('POST', `/api/${area}/login`, { email: agent.email, password: 'anything-at-all' });
    assert.ok([401, 403].includes(login.status), `${area} login`);
    // Even a session row made for the agent by hand is refused.
    const token = await transaction(db, () => auth.issueSession(db, agentId, role));
    c.cookies[`eq_${area}`] = token;
    assert.equal((await c('GET', `/api/${area}/me`)).payload.user, null, `${area} /me`);
    assert.equal((await c('GET', `/api/${area}/notifications`)).status, 401, `${area} notifications`);
  }
});


test('new passwords use scrypt; an old PBKDF2 hash is upgraded at the next sign-in', async () => {
  const id = await transaction(db, () => auth.createUser(db, 'new.user@example.com', 'New', 'a-long-password', 'customer'));
  assert.match((await one(db, 'SELECT pw_algo FROM users WHERE id = ?', id)).pw_algo, /^scrypt:/);

  // An account from before Phase 1: PBKDF2-SHA256 with 1,000 rounds.
  const [salt, hash] = auth.legacyPbkdf2('old-password-123', 1000);
  const old = await transaction(db, () => scalar(db, `INSERT INTO users (email, name, role, pw_salt, pw_hash, pw_algo, created_at)
    VALUES ('old.user@example.com', 'Old', 'customer', ?, ?, 'pbkdf2:1000', now()) RETURNING id`, salt, hash));
  const c = client();
  assert.equal((await c('POST', '/api/shop/login', { email: 'old.user@example.com', password: 'wrong-password' })).status, 401);
  assert.equal((await one(db, 'SELECT pw_algo FROM users WHERE id = ?', old)).pw_algo, 'pbkdf2:1000');
  assert.equal((await c('POST', '/api/shop/login', { email: 'old.user@example.com', password: 'old-password-123' })).status, 200);
  assert.match((await one(db, 'SELECT pw_algo FROM users WHERE id = ?', old)).pw_algo, /^scrypt:/);
  const again = client();
  assert.equal((await again('POST', '/api/shop/login', { email: 'old.user@example.com', password: 'old-password-123' })).status, 200);
});

test('sessions store only a hash of the token; signing in again replaces the old token', async () => {
  const c = client();
  await c('POST', '/api/shop/login', { email: 'rahul@example.com', password: DEMO });
  const first = c.cookies.eq_shop;
  const rahul = (await one(db, "SELECT id FROM users WHERE email = 'rahul@example.com'")).id;
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM sessions WHERE token = ?', first), 0);
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM sessions WHERE token = ?', auth.tokenHash(first)), 1);

  await c('POST', '/api/shop/login', { email: 'rahul@example.com', password: DEMO });
  assert.notEqual(c.cookies.eq_shop, first);
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM sessions WHERE token = ?', auth.tokenHash(first)), 0);
  const stale = client();
  stale.cookies.eq_shop = first;
  assert.equal((await stale('GET', '/api/shop/me')).payload.user, null);
  assert.ok(await scalar(db, 'SELECT COUNT(*) FROM sessions WHERE user_id = ?', rahul) >= 1);
});

test('"sign out of all devices" ends every session of that account', async () => {
  const phone = client();
  const laptop = client();
  for (const c of [phone, laptop]) await c('POST', '/api/seller/login', { email: 'lakshmi.seller@example.com', password: DEMO });
  assert.equal((await laptop('GET', '/api/seller/dashboard')).status, 200);
  assert.equal((await phone('POST', '/api/seller/logout-all', {})).status, 200);
  assert.equal((await laptop('GET', '/api/seller/dashboard')).status, 401);
  assert.equal((await phone('GET', '/api/seller/dashboard')).status, 401);
});

// The newest message in the outbox (the email stand-in) for this address, and the code in it.
async function lastCode(email) {
  const m = await one(db, 'SELECT * FROM outbox WHERE to_address = ? ORDER BY id DESC LIMIT 1', email);
  return m && /\b(\d{6})\b/.exec(m.body)[1];
}

test('sign-up needs the emailed code, which works once', async () => {
  const c = client();
  const reg = await c('POST', '/api/shop/register', { email: 'Meera@Example.com', name: 'Meera', password: 'meera-password' });
  assert.equal(reg.status, 201);
  assert.equal(reg.payload.needs_verification, true);
  assert.equal(c.cookies.eq_shop, undefined); // not signed in yet
  const login = await c('POST', '/api/shop/login', { email: 'meera@example.com', password: 'meera-password' });
  assert.equal(login.status, 403);
  assert.equal(login.payload.details.needs_verification, true);

  const code = await lastCode('meera@example.com');
  assert.ok(code);
  const wrong = String((Number(code) + 1) % 1e6).padStart(6, '0');
  assert.equal((await c('POST', '/api/shop/verify-email', { email: 'meera@example.com', code: wrong })).status, 400);
  assert.equal(await scalar(db, "SELECT attempts FROM auth_codes WHERE purpose = 'verify_email' ORDER BY id DESC LIMIT 1"), 1); // kept
  const ok = await c('POST', '/api/shop/verify-email', { email: 'meera@example.com', code });
  assert.equal(ok.status, 200);
  assert.equal(ok.payload.user.email, 'meera@example.com');
  assert.ok(c.cookies.eq_shop);
  assert.equal((await client()('POST', '/api/shop/verify-email', { email: 'meera@example.com', code })).status, 400);
  assert.equal((await client()('POST', '/api/shop/login', { email: 'meera@example.com', password: 'meera-password' })).status, 200);
});

test('password reset: the code works once, expires, and ends every session', async () => {
  const before = await scalar(db, 'SELECT COUNT(*) FROM outbox');
  const anon = client();
  const unknown = await anon('POST', '/api/shop/password/forgot', { email: 'nobody@example.com' });
  assert.equal(unknown.status, 200); // the same answer, so nobody learns which emails have accounts
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM outbox'), before);

  const signedIn = client();
  await signedIn('POST', '/api/shop/login', { email: 'meera@example.com', password: 'meera-password' });
  assert.equal((await anon('POST', '/api/shop/password/forgot', { email: 'meera@example.com' })).status, 200);
  const code = await lastCode('meera@example.com');
  const reset = await anon('POST', '/api/shop/password/reset', { email: 'meera@example.com', code, password: 'meera-new-password' });
  assert.equal(reset.status, 200);
  assert.equal((await signedIn('GET', '/api/shop/cart')).status, 401); // signed out everywhere
  assert.equal((await client()('POST', '/api/shop/login', { email: 'meera@example.com', password: 'meera-password' })).status, 401);
  assert.equal((await client()('POST', '/api/shop/login', { email: 'meera@example.com', password: 'meera-new-password' })).status, 200);
  assert.equal((await anon('POST', '/api/shop/password/reset', { email: 'meera@example.com', code, password: 'another-password' })).status, 400);

  await anon('POST', '/api/shop/password/forgot', { email: 'meera@example.com' });
  const late = await lastCode('meera@example.com');
  await transaction(db, () => db.run("UPDATE auth_codes SET expires_at = 0 WHERE purpose = 'reset_password'"));
  assert.equal((await anon('POST', '/api/shop/password/reset', { email: 'meera@example.com', code: late, password: 'another-password' })).status, 400);
  // A reset code for the store doesn't reset a seller account.
  assert.equal((await anon('POST', '/api/seller/password/forgot', { email: 'meera@example.com' })).status, 200);
  assert.equal(await lastCode('meera@example.com'), late);
});

test('five failed sign-ins lock the account for a while, then it opens again', async () => {
  const c = client();
  for (let i = 0; i < 5; i++) {
    assert.equal((await c('POST', '/api/shop/login', { email: 'rahul@example.com', password: `wrong-${i}` })).status, 401);
  }
  const locked = await c('POST', '/api/shop/login', { email: 'rahul@example.com', password: DEMO });
  assert.equal(locked.status, 429);
  assert.match(locked.payload.error, /Too many failed sign-ins/);
  assert.equal(await scalar(db, "SELECT COUNT(*) FROM audit_log WHERE action = 'auth.locked'"), 1);
  // Fifteen minutes later the lock has passed.
  await transaction(db, () => db.run("UPDATE login_attempts SET at = at - 16 * 60 WHERE email = 'rahul@example.com'"));
  assert.equal((await c('POST', '/api/shop/login', { email: 'rahul@example.com', password: DEMO })).status, 200);
});

test('two-step sign-in with an authenticator app, for sellers and staff', async () => {
  const s = client();
  await s('POST', '/api/seller/login', { email: 'urbancart.seller@example.com', password: DEMO });
  const setup = await s('POST', '/api/seller/2fa/setup', {});
  assert.equal(setup.status, 200);
  assert.match(setup.payload.otpauth_url, /^otpauth:\/\/totp\/Equidron/);
  const secret = setup.payload.secret;
  assert.equal((await s('POST', '/api/seller/2fa/enable', { code: '000000' })).status, 400);
  const t0 = Date.now();
  assert.equal((await s('POST', '/api/seller/2fa/enable', { code: auth.totp(secret, t0) })).status, 200);

  const c = client();
  const noCode = await c('POST', '/api/seller/login', { email: 'urbancart.seller@example.com', password: DEMO });
  assert.equal(noCode.status, 401);
  assert.equal(noCode.payload.details.otp_required, true);
  assert.equal((await c('POST', '/api/seller/login', { email: 'urbancart.seller@example.com', password: DEMO, otp: '123456' })).status, 401);
  const next = auth.totp(secret, t0 + 30_000);
  assert.equal((await c('POST', '/api/seller/login', { email: 'urbancart.seller@example.com', password: DEMO, otp: next })).status, 200);
  // The same code can't be used twice.
  assert.equal((await client()('POST', '/api/seller/login', { email: 'urbancart.seller@example.com', password: DEMO, otp: next })).status, 401);
  // Customers don't have two-step sign-in in this phase.
  assert.equal((await client()('POST', '/api/shop/2fa/setup', {})).status, 404);
});
