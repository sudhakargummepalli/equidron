// Phase 12: the risk score is code, so it is deterministic; the hold is a record, so it is
// reversible; and the agent that uses both may never cancel or ban.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { getAgent } from '../src/agents/agents.js';
import { owns, tool } from '../src/agents/tools.js';
import { settings } from '../src/auth.js';
import { all, one } from '../src/db.js';
import { assess, band, hold, openHolds, release, RULES, score } from '../src/risk.js';
import { openDatabase } from '../src/server.js';

settings.fastHashing = true;
process.env.EQUIDRON_SEED_DEMO = '1';

let db;
let asha;
let cheapOrder;
before(async () => {
  db = await openDatabase('memory');
  asha = await one(db, "SELECT id FROM users WHERE email = 'asha@example.com'");
  cheapOrder = await one(db, `SELECT id, total_paise FROM orders WHERE user_id = ? ORDER BY total_paise LIMIT 1`, asha.id);
});
after(async () => { await db?.close(); });

test('the same facts always give the same score, and the rules add up', () => {
  const facts = { accountAgeDays: 2, totalPaise: 6_000_000, method: 'cod', cancelled30d: 4, failedPayments: 0, ordersLastHour: 1, cityIsNew: false, maxQty: 1 };
  const a = score(facts);
  const b = score(facts);
  assert.deepEqual(a, b);
  // new_account 25 + high_value 20 + cod_high_value 20 + cancellations 15 = 80
  assert.equal(a.score, 80);
  assert.equal(a.band, 'high');
  assert.equal(a.signals.length, 4);
  assert.match(a.explanation, /Hold: /);
  assert.match(a.explanation, /less than a week old/);
});

test('a plain order scores low and the explanation says so', () => {
  const quiet = score({ accountAgeDays: 400, totalPaise: 50_000, method: 'card', cancelled30d: 0, failedPayments: 0, ordersLastHour: 1, cityIsNew: false, maxQty: 1 });
  assert.equal(quiet.score, 0);
  assert.equal(quiet.band, 'low');
  assert.match(quiet.explanation, /nothing unusual/);
  // The thresholds are where the roadmap puts them.
  assert.equal(band(60), 'high');
  assert.equal(band(59), 'medium');
  assert.equal(band(29), 'low');
});

test('every rule has a code, points and a sentence a person can read', () => {
  for (const r of RULES) {
    assert.ok(r.code && r.points > 0 && r.why.length > 10, r.code);
    assert.equal(typeof r.test, 'function');
  }
});

test('the score reads the shop’s own facts for an order', async () => {
  const result = await assess(db, cheapOrder.id);
  assert.ok(Number.isInteger(result.score));
  assert.ok(['low', 'medium', 'high'].includes(result.band));
  assert.equal(result.facts.orderId, cheapOrder.id);
  // Whatever the seeded order used; the point is that the method is read from the row.
  assert.ok(['card', 'upi', 'cod', 'bank'].includes(result.facts.method));
});

test('a hold is a record with a reason, and it never cancels the order', async () => {
  const before = await one(db, 'SELECT status FROM orders WHERE id = ?', cheapOrder.id);
  const out = await hold(db, cheapOrder.id, { reason: 'New account, cash order, please check.', by: null });
  assert.equal(out.held, true);
  const row = await one(db, 'SELECT * FROM order_holds WHERE order_id = ?', cheapOrder.id);
  assert.equal(row.status, 'active');
  assert.match(row.reason, /please check/);
  assert.ok(Number.isInteger(Number(row.score)));
  assert.ok(Array.isArray(row.signals));
  // The order itself is untouched: a hold is not a cancellation.
  assert.equal((await one(db, 'SELECT status FROM orders WHERE id = ?', cheapOrder.id)).status, before.status);
  // A second hold cannot stack on the first.
  const again = await hold(db, cheapOrder.id, { reason: 'Second hold.' });
  assert.equal(again.held, false);
});

test('releasing keeps the history and is what a person does', async () => {
  const out = await release(db, cheapOrder.id, { note: 'Called the customer, it is genuine.' });
  assert.equal(out.released, true);
  const row = await one(db, 'SELECT * FROM order_holds WHERE id = ?', out.hold_id);
  assert.equal(row.status, 'released');
  assert.ok(row.released_at);
  assert.match(row.release_note, /genuine/);
  // Nothing is open for that order any more.
  assert.ok(!(await openHolds(db)).some((h) => h.order_id === cheapOrder.id));
});

test('the agent explains and holds; it has no way to cancel or ban', async () => {
  const agent = await getAgent(db, 'fraud_risk');
  assert.equal(agent.enabled, false);
  assert.equal(agent.autonomy_level, 1);
  for (const name of ['assess_order_risk', 'hold_order', 'release_order_hold']) assert.ok(owns('fraud_risk', name), name);
  // Nothing that ends an order or an account is available to it.
  assert.ok(!owns('fraud_risk', 'cancel_order'));
  assert.ok(!owns('fraud_risk', 'refund_return'));
});

test('the tools take the order from the model but the actor from the session', async () => {
  const assessTool = tool('assess_order_risk');
  const result = await assessTool.run(db, {}, { order_id: cheapOrder.id });
  assert.ok(Number.isInteger(result.score));
  await assert.rejects(() => assessTool.run(db, {}, { order_id: 999_999 }), /Order/i);
  // A hold without a note is refused: the reason is the record a person relies on.
  await assert.rejects(() => tool('hold_order').run(db, {}, { order_id: cheapOrder.id, note: '   ', reason: 'x' }), /reason/i);
});
