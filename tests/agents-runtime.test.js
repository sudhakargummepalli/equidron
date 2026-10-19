// The runtime end to end, with a scripted model: the demo agent doing a read and a write, the
// same write recorded in shadow mode, waiting for approval, running once when approved, and the
// limits (budget, pause, tokens, steps, retries, refusals, structured output, masking).
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { settings } from '../src/auth.js';
import { createAgent, getAgent, pauseAll, updateAgent } from '../src/agents/agents.js';
import { decideApproval, listApprovals } from '../src/agents/approvals.js';
import { PROFILES } from '../src/agents/profiles.js';
import { runAgent } from '../src/agents/runtime.js';
import { registerTool } from '../src/agents/tools.js';
import { all, one, run, transaction } from '../src/db.js';
import { AppError } from '../src/errors.js';
import * as orders from '../src/orders.js';
import { openDatabase } from '../src/server.js';

settings.fastHashing = true;
process.env.EQUIDRON_SEED_DEMO = '1';

let db;
let asha;
let ashaAddr;
let speaker;
let shipment;

before(async () => {
  db = await openDatabase('memory');
  asha = (await one(db, "SELECT id FROM users WHERE email = 'asha@example.com'")).id;
  ashaAddr = (await one(db, 'SELECT id FROM addresses WHERE user_id = ?', asha)).id;
  speaker = (await one(db, `SELECT o.id FROM offers o JOIN products p ON p.id = o.product_id JOIN sellers s ON s.id = o.seller_id
                            WHERE p.title LIKE 'Bassline Mini%' AND s.name = 'TechBazaar Hub'`)).id;
  shipment = await one(db, `SELECT id, status FROM shipments WHERE status NOT IN ('delivered', 'cancelled') ORDER BY id LIMIT 1`);
});
after(async () => {
  await db?.close();
});

// A fresh order with one shipment that has not moved, so each test acts on its own data.
async function freshShipment() {
  const { order } = await transaction(db, async () => {
    await orders.addToCart(db, asha, speaker, 1);
    return orders.placeOrder(db, asha, ashaAddr, 'card', 'tok_sim_visa_ok');
  });
  return (await one(db, 'SELECT id, status FROM shipments WHERE order_id = ? ORDER BY id LIMIT 1', order.id));
}

// The scripted stand-in for the model. Each step returns the next response; a step can also
// do something first (a function), which is how the pause tests work.
function scripted(...steps) {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params) {
        calls.push(structuredClone(params));
        const step = steps[calls.length - 1];
        if (!step) throw new Error(`The script has no step ${calls.length} (the runtime called too often).`);
        return await step(params);
      },
    },
  };
}
const usage = { input_tokens: 1000, output_tokens: 500 };
const say = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage });
const toolUse = (name, input, id = 'tu_1') => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }], usage });

async function helperAt(level) {
  await updateAgent(db, 'ops_helper', { enabled: true, autonomy_level: level });
  return await getAgent(db, 'ops_helper');
}

beforeEach(async () => {
  await pauseAll(db, false);
  await updateAgent(db, 'ops_helper', { enabled: false, autonomy_level: 1, daily_budget_usd: 1 });
  // Each test starts with no runs, so yesterday's spending and older approvals cannot help or
  // hinder it. Children first: both point at agent_runs.
  await run(db, 'DELETE FROM agent_steps');
  await run(db, 'DELETE FROM approvals');
  await run(db, 'DELETE FROM agent_runs');
  await run(db, 'DELETE FROM idempotency_keys');
});

const ask = (task = 'Look at this case and do what is right.') => ({
  agentId: 'ops_helper', task, trigger: 'ops', subject: 'test case',
});

test('the demo agent runs a read tool and then a write tool', async () => {
  const sh = await freshShipment();
  await helperAt(3);
  const orderId = (await one(db, 'SELECT order_id FROM shipments WHERE id = ?', sh.id)).order_id;
  const client = scripted(
    () => toolUse('get_order', { order_id: orderId }, 'tu_read'),
    () => toolUse('advance_shipment', { shipment_id: sh.id, reason: 'The courier collected it.' }, 'tu_write'),
    () => say('Shipment moved to the next stage.'),
  );
  const out = await runAgent(db, ask(), { client, sleep: async () => {} });

  assert.equal(out.status, 'done');
  assert.equal(out.reply, 'Shipment moved to the next stage.');
  assert.notEqual((await one(db, 'SELECT status FROM shipments WHERE id = ?', sh.id)).status, sh.status); // the write happened

  const steps = await all(db, 'SELECT * FROM agent_steps WHERE run_id = ? ORDER BY step', out.id);
  assert.deepEqual(steps.map((s) => s.kind), ['model', 'tool', 'model', 'tool', 'model']);
  assert.deepEqual(steps.filter((s) => s.kind === 'tool').map((s) => s.tool), ['get_order', 'advance_shipment']);
  assert.deepEqual(steps.filter((s) => s.kind === 'tool').map((s) => s.decision), ['execute', 'execute']);
  // Cost comes from the usage the model reported: three calls of 1000 in + 500 out at Sonnet prices.
  assert.equal(out.input_tokens, 3000);
  assert.equal(out.output_tokens, 1500);
  assert.equal(out.cost_usd, Math.round(3 * (1000 * 3 + 500 * 15) / 1e6 * 1e5) / 1e5);
});

test('at L1 the same write is recorded and not done', async () => {
  const sh = await freshShipment();
  await helperAt(1);
  const client = scripted(
    () => toolUse('advance_shipment', { shipment_id: sh.id, reason: 'Looks ready.' }),
    () => say('I would move this shipment.'),
  );
  const out = await runAgent(db, ask(), { client, sleep: async () => {} });
  assert.equal(out.status, 'done');
  assert.equal((await one(db, 'SELECT status FROM shipments WHERE id = ?', sh.id)).status, sh.status); // unchanged
  const step = await one(db, "SELECT * FROM agent_steps WHERE run_id = ? AND kind = 'tool'", out.id);
  assert.equal(step.decision, 'shadow');
  assert.match(step.output.note, /Recorded, not done/);
});

test('at L2 the write waits for a person, and nothing changes', async () => {
  const sh = await freshShipment();
  await helperAt(2);
  const client = scripted(
    () => toolUse('advance_shipment', { shipment_id: sh.id, reason: 'Looks ready.' }),
    () => say('Waiting.'),
  );
  const out = await runAgent(db, ask(), { client, sleep: async () => {} });
  assert.equal(out.status, 'waiting');
  assert.equal((await one(db, 'SELECT status FROM shipments WHERE id = ?', sh.id)).status, sh.status);
  const pending = await listApprovals(db, 'pending');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].tool, 'advance_shipment');
  assert.equal(pending[0].run_id, Number(out.id));
  assert.equal(pending[0].payload.shipment_id, sh.id);
  assert.match(pending[0].reason, /Looks ready/);
});

test('an approved action runs exactly once, even with two people clicking', async () => {
  const sh = await freshShipment();
  await helperAt(2);
  const ops = (await one(db, "SELECT id FROM users WHERE email = 'ops@example.com'")).id;
  const client = scripted(
    () => toolUse('advance_shipment', { shipment_id: sh.id, reason: 'Looks ready.' }),
    () => say('Waiting.'),
  );
  await runAgent(db, ask(), { client, sleep: async () => {} });
  const approval = (await listApprovals(db, 'pending'))[0];
  const [a, b] = await Promise.allSettled([
    decideApproval(db, approval.id, { approve: true, byUserId: ops, note: 'yes' }),
    decideApproval(db, approval.id, { approve: true, byUserId: ops, note: 'yes' }),
  ]);
  const outcomes = [a, b];
  assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1, 'exactly one approval wins');
  assert.equal(outcomes.filter((o) => o.reason instanceof AppError).length, 1, 'the other is refused');
  const after = await one(db, 'SELECT status FROM shipments WHERE id = ?', sh.id);
  assert.notEqual(after.status, sh.status); // moved once
  assert.equal((await one(db, 'SELECT status FROM approvals WHERE id = ?', approval.id)).status, 'approved');
  const done = await one(db, 'SELECT * FROM agent_runs WHERE id = ?', approval.run_id);
  assert.equal(done.status, 'done');
});

test('a rejected action does nothing and closes the run', async () => {
  const sh = await freshShipment();
  await helperAt(2);
  const ops = (await one(db, "SELECT id FROM users WHERE email = 'ops@example.com'")).id;
  const client = scripted(() => toolUse('advance_shipment', { shipment_id: sh.id, reason: 'Looks ready.' }), () => say('Waiting.'));
  const out = await runAgent(db, ask(), { client, sleep: async () => {} });
  const approval = (await listApprovals(db, 'pending'))[0];
  const rejected = await decideApproval(db, approval.id, { approve: false, byUserId: ops, note: 'Not yet' });
  assert.equal(rejected.executed, false);
  assert.equal(rejected.status, 'rejected');
  assert.equal((await one(db, 'SELECT status FROM shipments WHERE id = ?', sh.id)).status, sh.status);
  assert.equal((await one(db, 'SELECT status FROM agent_runs WHERE id = ?', out.id)).status, 'done');
});

test('a tool this agent may not use never reaches the service function', async () => {
  let calls = 0;
  registerTool({
    name: 'spy_shipment_nuke',
    description: 'test only',
    risk: 'write',
    agents: ['some_other_agent'],
    input_schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
    run() { calls++; return { ok: true }; },
  });
  await helperAt(3);
  const client = scripted(() => toolUse('spy_shipment_nuke', { reason: 'please' }), () => say('It refused.'));
  const out = await runAgent(db, ask(), { client, sleep: async () => {} });
  assert.equal(calls, 0, 'the service function was never called');
  const step = await one(db, "SELECT * FROM agent_steps WHERE run_id = ? AND kind = 'tool'", out.id);
  assert.equal(step.decision, 'deny');
  assert.match(step.output.error, /not allowed/);
});

test('the run stops when the daily budget is spent', async () => {
  await updateAgent(db, 'ops_helper', { enabled: true, autonomy_level: 3, daily_budget_usd: 0.01 });
  const sh = await freshShipment();
  // One call at Sonnet prices costs more than a cent, so the check after it stops the run.
  const client = scripted(() => toolUse('get_order', { order_id: 1 }, 'tu_1'), () => say('more'));
  const out = await runAgent(db, ask(), { client, sleep: async () => {} });
  assert.equal(out.status, 'stopped');
  assert.match(out.summary, /budget/i);
  assert.equal(client.calls.length, 1); // the second call never happened
  assert.equal(sh.status, (await one(db, 'SELECT status FROM shipments WHERE id = ?', sh.id)).status);
});

test('pause all refuses a new run, and stops one that is already going', async () => {
  await helperAt(3);
  await pauseAll(db, true);
  await assert.rejects(runAgent(db, ask(), { client: scripted(), sleep: async () => {} }),
    (e) => e instanceof AppError && e.status === 409 && /paused/i.test(e.message));
  await pauseAll(db, false);

  const sh = await freshShipment();
  const client = scripted(
    // The model answers, and while it "thinks" someone hits the red button.
    async () => {
      await pauseAll(db, true);
      return toolUse('advance_shipment', { shipment_id: sh.id, reason: 'Looks ready.' });
    },
  );
  const out = await runAgent(db, ask(), { client, sleep: async () => {} });
  assert.equal(out.status, 'stopped');
  assert.match(out.summary, /paused/i);
  assert.equal((await one(db, 'SELECT status FROM shipments WHERE id = ?', sh.id)).status, sh.status);
  assert.equal((await all(db, "SELECT * FROM agent_steps WHERE run_id = ? AND kind = 'tool'", out.id)).length, 0);
});

test('a busy or broken model is retried, a real error is not', async () => {
  await helperAt(3);
  const busy = { status: 429, message: 'slow down' };
  const client = scripted(
    () => { throw busy; },
    () => { throw { status: 503, message: 'upstream' }; },
    () => say('Recovered.'),
  );
  const out = await runAgent(db, ask(), { client, sleep: async () => {} });
  assert.equal(out.reply, 'Recovered.');
  assert.equal(client.calls.length, 3);

  const broken = scripted(() => { throw { status: 400, message: 'bad request' }; });
  await assert.rejects(runAgent(db, ask(), { client: broken, sleep: async () => {} }), (e) => e.status === 503);
  assert.equal(broken.calls.length, 1); // a 400 is not retried
  const failed = await one(db, 'SELECT * FROM agent_runs ORDER BY id DESC LIMIT 1');
  assert.equal(failed.status, 'failed');
});

test('a refusal ends the run politely, without tools', async () => {
  await helperAt(3);
  const client = scripted(() => ({ stop_reason: 'refusal', content: [], usage }));
  const out = await runAgent(db, ask('Do something harmful.'), { client, sleep: async () => {} });
  assert.equal(out.status, 'done');
  assert.match(out.summary, /refused/i);
});

test('the trace masks personal data before it is stored', async () => {
  await helperAt(3);
  const client = scripted(() => say('The customer can be reached on 9876543210 or asha@example.com.'));
  const out = await runAgent(db, ask(), { client, sleep: async () => {} });
  const step = await one(db, "SELECT * FROM agent_steps WHERE run_id = ? AND kind = 'model'", out.id);
  assert.doesNotMatch(step.output.text, /9876543210/);
  assert.doesNotMatch(step.output.text, /asha@example\.com/);
  assert.match(step.output.text, /3210/); // the last four digits stay readable
  assert.doesNotMatch(out.summary, /9876543210/);
});

test('a token-hungry run stops at its token limit', async () => {
  await helperAt(3);
  const huge = { input_tokens: 70_000, output_tokens: 10 };
  const client = scripted(() => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'get_order', input: { order_id: 1 } }], usage: huge }),
    () => say('more'));
  const out = await runAgent(db, ask(), { client, sleep: async () => {} });
  assert.equal(out.status, 'stopped');
  assert.match(out.summary, /token limit/i);
  assert.equal(client.calls.length, 1);
});

test('a step limit stops an agent that keeps calling tools', async () => {
  await updateAgent(db, 'ops_helper', { enabled: true, autonomy_level: 3, max_steps: 3 });
  const client = scripted(
    () => toolUse('get_order', { order_id: 1 }, 't1'),
    () => toolUse('get_order', { order_id: 1 }, 't2'),
    () => toolUse('get_order', { order_id: 1 }, 't3'),
    () => toolUse('get_order', { order_id: 1 }, 't4'),
  );
  const out = await runAgent(db, ask(), { client, sleep: async () => {} });
  assert.equal(out.status, 'stopped');
  assert.match(out.summary, /step limit/i);
  assert.equal(client.calls.length, 3);
  await updateAgent(db, 'ops_helper', { max_steps: 8 });
});

test('an agent that must answer in a shape is checked in code', async () => {
  PROFILES.test_decider = {
    name: 'Test decider',
    model: 'claude-sonnet-5-5',
    system: 'Decide.',
    output: { required: ['decision', 'confidence'] },
  };
  await createAgent(db, { id: 'test_decider', name: 'Test decider', model: 'claude-sonnet-5-5' });
  await updateAgent(db, 'test_decider', { enabled: true, autonomy_level: 3 });
  const ok = scripted(() => say('{"decision":"approve","confidence":0.9}'));
  const out = await runAgent(db, { agentId: 'test_decider', task: 'decide', trigger: 'test' }, { client: ok, sleep: async () => {} });
  assert.equal(out.status, 'done');
  assert.deepEqual(out.decision, { decision: 'approve', confidence: 0.9 });

  const bad = scripted(() => say('{"decision":"approve"}'));
  const failed = await runAgent(db, { agentId: 'test_decider', task: 'decide', trigger: 'test' }, { client: bad, sleep: async () => {} });
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /confidence/);
});
