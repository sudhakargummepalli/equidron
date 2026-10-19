// mask() and the audit trail: every pattern is hidden, every write request leaves an
// audit row naming who did it, and Ops decisions record decided_by.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { handleApi } from '../src/api.js';
import { settings } from '../src/auth.js';
import { all, one, scalar, transaction } from '../src/db.js';
import { mask } from '../src/mask.js';
import * as orders from '../src/orders.js';
import { openDatabase } from '../src/server.js';

settings.fastHashing = true;
process.env.EQUIDRON_SEED_DEMO = '1'; // the sample accounts sign in with the shared demo password

test('mask() hides emails, phones, PAN, card, bank account and UPI ids', () => {
  assert.equal(mask('asha@example.com'), 'a***@example.com');
  assert.equal(mask('call +91 98450 12345 or 9845012345'), 'call ******2345 or ******2345');
  assert.equal(mask('PAN ABCDE1234F'), 'PAN *****1234F');
  assert.equal(mask('card 4111 1111 1111 1111'), 'card **** **** **** 1111');
  assert.equal(mask('card 4111-1111-1111-1111'), 'card **** **** **** 1111');
  assert.equal(mask('a/c 001234567890123'), 'a/c ***********0123');
  assert.equal(mask('paid from asha.r@okaxis'), 'paid from a***@okaxis');
  assert.equal(mask('Order #57 for ₹1,499'), 'Order #57 for ₹1,499'); // nothing personal
  assert.deepEqual(mask({ to: 'rahul@example.com', items: [{ phone: '9876543210' }], n: 5 }),
    { to: 'r***@example.com', items: [{ phone: '******3210' }], n: 5 });
  assert.equal(mask(null), null);
});

let db;
before(async () => { db = await openDatabase('memory'); });
after(() => db.close());

// A tiny cookie-keeping client over handleApi, one per signed-in person.
function client() {
  const cookies = {};
  return async (method, path, body) => {
    const out = await handleApi(db, { method, path, query: new URLSearchParams(), body, cookies });
    if (out.setCookie) {
      const [pair] = out.setCookie.split(';');
      const [k, v] = pair.split('=');
      if (v) cookies[k] = v; else delete cookies[k];
    }
    return out;
  };
}

const audits = () => scalar(db, 'SELECT COUNT(*) FROM audit_log');

test('every successful write request leaves an audit row with the actor', async () => {
  const shop = client();
  const ops = client();
  const seller = client();
  const steps = [
    [shop, 'POST', '/api/shop/login', { email: 'asha@example.com', password: 'equidron-demo' }],
    [shop, 'POST', '/api/shop/cart', { offer_id: (await one(db, "SELECT id FROM offers WHERE status = 'active' ORDER BY id LIMIT 1")).id }],
    [shop, 'POST', '/api/shop/notifications/read', {}],
    [shop, 'POST', '/api/shop/support', { subject: 'Hello', message: 'Where is my order?' }],
    [seller, 'POST', '/api/seller/login', { email: 'techbazaar.seller@example.com', password: 'equidron-demo' }],
    [ops, 'POST', '/api/ops/login', { email: 'ops@example.com', password: 'equidron-demo' }],
    [ops, 'POST', '/api/ops/shipments/advance-all', {}],
    [ops, 'POST', '/api/ops/settlement/run', {}],
    [shop, 'POST', '/api/shop/logout', {}],
  ];
  for (const [call, method, path, body] of steps) {
    const before = await audits();
    const out = await call(method, path, body);
    assert.ok(out.status < 400, `${path}: ${JSON.stringify(out.payload)}`);
    assert.ok(await audits() > before, `${path} wrote no audit row`);
  }
  const asha = (await one(db, "SELECT id FROM users WHERE email = 'asha@example.com'")).id;
  const row = await one(db, "SELECT * FROM audit_log WHERE action = 'shop.cart' ORDER BY id DESC LIMIT 1");
  assert.equal(row.actor_type, 'user');
  assert.equal(row.actor_id, String(asha));
  const settle = await one(db, "SELECT * FROM audit_log WHERE action = 'settlement.run' ORDER BY id DESC LIMIT 1");
  assert.ok(settle, 'settlement is audited by the service function');
  // Reads write nothing.
  const before = await audits();
  await ops('GET', '/api/ops/overview');
  assert.equal(await audits(), before);
});

test('a failed request leaves no audit row, but a failed sign-in is recorded', async () => {
  const shop = client();
  const before = await audits();
  const out = await shop('POST', '/api/shop/login', { email: 'asha@example.com', password: 'wrong-password' });
  assert.equal(out.status, 401);
  const row = await one(db, 'SELECT * FROM audit_log ORDER BY id DESC LIMIT 1');
  assert.equal(await audits(), before + 1);
  assert.equal(row.action, 'auth.login_failed');
  assert.equal(row.entity_id, 'a***@example.com');
  const cart = await shop('POST', '/api/shop/cart', { offer_id: 1 });
  assert.equal(cart.status, 401);
  assert.equal(await audits(), before + 1);
});

test('Ops decisions record decided_by, and the lists show who decided', async () => {
  const ops = client();
  await ops('POST', '/api/ops/login', { email: 'ops@example.com', password: 'equidron-demo' });
  const opsId = (await one(db, "SELECT id FROM users WHERE email = 'ops@example.com'")).id;
  const pending = await one(db, "SELECT id FROM submissions WHERE status = 'pending' ORDER BY id LIMIT 1");
  const out = await ops('POST', `/api/ops/submissions/${pending.id}/decide`, { approve: false, note: 'Not allowed' });
  assert.equal(out.status, 200);
  assert.equal(out.payload.decided_by, opsId);
  assert.equal(out.payload.decided_by_name, 'Equidron Ops Reviewer (sample)');
  const row = await one(db, "SELECT * FROM audit_log WHERE action = 'submission.reject' AND entity_id = ?", String(pending.id));
  assert.equal(row.before.status, 'pending');
  assert.equal(row.after.status, 'rejected');

  // A return on Asha's delivered sample order, rejected by Ops.
  const asha = (await one(db, "SELECT id FROM users WHERE email = 'asha@example.com'")).id;
  const done = await orders.getOrder(db, (await one(db, "SELECT id FROM orders WHERE user_id = ? AND status = 'completed'", asha)).id, asha);
  const item = done.shipments.flatMap((s) => s.items)[0];
  const rid = await transaction(db, () => orders.requestReturn(db, asha, done.id, item.id, 1, 'Damaged or defective'));
  assert.equal((await ops('POST', `/api/ops/returns/${rid}/reject`, { note: 'Used item' })).status, 200);
  const mine = (await ops('GET', '/api/ops/returns')).payload.find((r) => r.id === rid);
  assert.equal(mine.decided_by, opsId);
  assert.equal(mine.decided_by_name, 'Equidron Ops Reviewer (sample)');
  const log = (await ops('GET', '/api/ops/audit')).payload;
  assert.ok(log.length > 0);
  assert.ok(log.every((r) => !/@example\.com/.test(JSON.stringify(r)) || /\*\*\*@/.test(JSON.stringify(r))));
});

test('audit rows keep before and after as JSON', async () => {
  const rows = await all(db, "SELECT before, after FROM audit_log WHERE action LIKE 'submission.%' LIMIT 3");
  for (const r of rows) assert.equal(typeof r.after, 'object');
});
