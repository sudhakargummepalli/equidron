// Accounts: staff permissions, agent accounts, passwords, sessions, sign-up with a
// verification code, password reset, sign-in lockout and two-step sign-in.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { AREAS, handleApi } from '../src/api.js';
import * as auth from '../src/auth.js';
import { one, scalar, transaction } from '../src/db.js';
import { openDatabase } from '../src/server.js';

auth.settings.fastHashing = true;

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
  const agentId = await transaction(db, () => auth.createAgentUser(db, 'returns', 'Returns agent'));
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

