// Phase 6, slice 4: the Returns agent and the money limit. A refund under ₹2,000 runs when the
// agent is at L3; above it, the run waits for a person. A scripted model stands in throughout.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { getAgent, updateAgent } from '../src/agents/agents.js';
import { owns } from '../src/agents/tools.js';
import { settings } from '../src/auth.js';
import { all, one, run } from '../src/db.js';
import { reviewReturn } from '../src/job-kinds.js';
import * as orders from '../src/orders.js';
import { openDatabase } from '../src/server.js';

settings.fastHashing = true;
process.env.EQUIDRON_SEED_DEMO = '1';

let db;
let asha;
let paidItem;
before(async () => {
  db = await openDatabase('memory');
  asha = await one(db, "SELECT id, name FROM users WHERE email = 'asha@example.com'");
  // A delivered, paid order item: the shape a return is made from.
  paidItem = await one(db, `SELECT oi.id, oi.order_id, oi.title, oi.unit_price_paise
                            FROM order_items oi JOIN orders o ON o.id = oi.order_id
                            WHERE o.user_id = ? AND o.payment_status = 'captured' ORDER BY oi.id LIMIT 1`, asha.id);
  assert.ok(paidItem, 'the sample data has a paid order item');
});
after(async () => { await db?.close(); });

const usage = { input_tokens: 900, output_tokens: 250 };
const say = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage });
const callTool = (name, input, id = 'tu_1') => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }], usage });

function scripted(...steps) {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params) {
        calls.push(structuredClone(params));
        const step = steps[calls.length - 1];
        if (!step) throw new Error(`The script has no step ${calls.length}.`);
        return await step(params);
      },
    },
  };
}

// A return in the state the agent picks up: approved, waiting for the item to come back.
async function aReturn(pricePaise) {
  await run(db, 'UPDATE order_items SET unit_price_paise = ? WHERE id = ?', pricePaise, paidItem.id);
  return await run(db, `INSERT INTO returns (order_id, order_item_id, user_id, qty, reason, status, created_at, updated_at)
                        VALUES (?, ?, ?, 1, 'The item arrived damaged.', 'pickup_scheduled', now(), now())`,
  paidItem.order_id, paidItem.id, asha.id);
}

test('Returns starts off, at L1, on the judgement model, and owns the money tool', async () => {
  const agent = await getAgent(db, 'returns');
  assert.equal(agent.enabled, false);
  assert.equal(agent.autonomy_level, 1);
  assert.equal(agent.model, 'claude-sonnet-5-5');
  assert.ok(owns('returns', 'refund_return'), 'it holds the money tool');
  assert.ok(owns('returns', 'get_return'));
  assert.ok(owns('returns', 'reject_return'));
});

test('a refund under ₹2,000 runs at L3, and debits the seller', async () => {
  await updateAgent(db, 'returns', { enabled: true, autonomy_level: 3 });
  const returnId = await aReturn(150_000); // ₹1,500
  const client = scripted(
    () => callTool('get_return', { return_id: returnId }),
    () => callTool('refund_return', { return_id: returnId, reason: 'Damaged in transit, inside the return window.' }),
    () => say('Refunded the customer ₹1,500.'),
  );
  const out = await reviewReturn(db, returnId, { client });
  assert.equal(out.status, 'done');

  const ret = await one(db, 'SELECT status FROM returns WHERE id = ?', returnId);
  assert.equal(ret.status, 'refunded');
  const fee = await one(db, "SELECT * FROM seller_ledger WHERE order_item_id = ? AND kind = 'refund'", paidItem.id);
  assert.ok(fee, 'the seller ledger has the refund line');
  await updateAgent(db, 'returns', { enabled: false });
});

test('a refund above ₹2,000 waits for a person instead of running', async () => {
  await updateAgent(db, 'returns', { enabled: true, autonomy_level: 3 });
  const returnId = await aReturn(5_000_000); // ₹50,000
  const client = scripted(
    () => callTool('get_return', { return_id: returnId }),
    () => callTool('refund_return', { return_id: returnId, reason: 'Very expensive item, damaged.' }),
    () => say('This needs a person.'),
  );
  const out = await reviewReturn(db, returnId, { client });
  assert.equal(out.status, 'waiting', 'the run waits in Approvals');

  // The money did not move, and the approval says why.
  assert.equal((await one(db, 'SELECT status FROM returns WHERE id = ?', returnId)).status, 'pickup_scheduled');
  const approval = await one(db, "SELECT * FROM approvals WHERE status = 'pending' ORDER BY id DESC LIMIT 1");
  assert.ok(approval, 'an approval is waiting');
  assert.match(approval.summary ?? approval.reason ?? '', /2,000|above/i);
  await updateAgent(db, 'returns', { enabled: false });
});

test('a return outside the policy is refused with a note the customer can read', async () => {
  await updateAgent(db, 'returns', { enabled: true, autonomy_level: 3 });
  const returnId = await aReturn(120_000);
  const client = scripted(
    () => callTool('get_return', { return_id: returnId }),
    () => callTool('reject_return', {
      return_id: returnId, note: 'Grocery items cannot be returned once opened.', reason: 'Policy excludes opened groceries.',
    }),
    () => say('Refused, with the reason.'),
  );
  await reviewReturn(db, returnId, { client });
  assert.equal((await one(db, 'SELECT status FROM returns WHERE id = ?', returnId)).status, 'rejected');
  await updateAgent(db, 'returns', { enabled: false });
});

test('a return already decided is not decided again by a retry', async () => {
  const returnId = await aReturn(120_000);
  const before = await all(db, 'SELECT id FROM agent_runs WHERE agent_id = ?', 'returns');
  await run(db, "UPDATE returns SET status = 'refunded' WHERE id = ?", returnId);
  const client = scripted(() => say('must not run'));
  const out = await reviewReturn(db, returnId, { client });
  assert.equal(out, undefined);
  assert.equal(client.calls.length, 0);
  assert.equal((await all(db, 'SELECT id FROM agent_runs WHERE agent_id = ?', 'returns')).length, before.length);
});

test('a switched-off agent leaves a new return alone', async () => {
  const returnId = await aReturn(120_000);
  const client = scripted(() => say('must not run'));
  await reviewReturn(db, returnId, { client });
  assert.equal(client.calls.length, 0);
  assert.equal((await one(db, 'SELECT status FROM returns WHERE id = ?', returnId)).status, 'pickup_scheduled');
});
