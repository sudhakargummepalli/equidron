// The agent platform: the Phase 4 tables, the tool registry, the policy check, the runtime,
// approvals and the Ops views behind them. The model is always the scripted stand-in, so these
// tests cost nothing and need no network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import * as auth from '../src/auth.js';
import { settings } from '../src/auth.js';
import { handleApi } from '../src/api.js';
import {
  allPaused, createAgent, getAgent, listAgents, pauseAll, spendToday, updateAgent,
} from '../src/agents/agents.js';
import { costOf, routeModel } from '../src/agents/models.js';
import { checkInput, executeTool, registerTool, tool, toolDefsFor, toolsFor } from '../src/agents/tools.js';
import { connect, initSchema, one, run, scalar, SCHEMA, TABLES } from '../src/db.js';
import { AppError } from '../src/errors.js';
import * as orders from '../src/orders.js';
import { openDatabase } from '../src/server.js';

settings.fastHashing = true;
process.env.EQUIDRON_SEED_DEMO = '1';

const MIGRATION = readFileSync(new URL('../netlify/database/migrations/20261022000000_agents.sql', import.meta.url), 'utf8');

// A throwaway database with the full schema and no sample data, so each test starts from nothing.
async function emptyDatabase() {
  const db = await connect('memory');
  await initSchema(db);
  return db;
}

const addUser = (db, email, role = 'agent') =>
  run(db, "INSERT INTO users (email, name, role, pw_salt, pw_hash, created_at) VALUES (?, 'A', ?, 's', 'h', now())", email, role);

// The sample shop, for the tool tests: real orders and shipments to act on.
let shop;
before(async () => {
  shop = await openDatabase('memory');
});
after(async () => {
  await shop?.close();
});

test('the Phase 4 migration builds the six agent tables and can run twice', async () => {
  const db = await connect('memory');
  try {
    // The schema as it stood before Phase 4, i.e. what the Netlify database already has.
    await db.exec(SCHEMA.slice(0, SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS agents')));
    await db.exec(MIGRATION);
    const tables = ['agents', 'agent_runs', 'agent_steps', 'approvals', 'eval_cases', 'eval_results'];
    for (const t of tables) assert.ok(TABLES.includes(t), `${t} is part of SCHEMA`);

    // Running it again changes nothing: every statement is IF NOT EXISTS.
    await db.exec(MIGRATION);
    for (const t of tables) {
      assert.equal(await scalar(db, `SELECT COUNT(*) FROM ${t}`), 0, t);
    }
  } finally {
    await db.close();
  }
});

test('a new agent starts switched off, at L1 shadow, with a daily budget', async () => {
  const db = await emptyDatabase();
  try {
    const uid = await addUser(db, 'demo@agents.equidron.invalid');
    await run(db, `INSERT INTO agents (id, name, user_id, model) VALUES ('demo', 'Demo agent', ?, 'claude-sonnet-5-5')`, uid);
    const agent = await one(db, "SELECT * FROM agents WHERE id = 'demo'");
    assert.equal(agent.enabled, false); // off until a person turns it on
    assert.equal(agent.autonomy_level, 1); // shadow mode
    assert.equal(agent.max_steps, 8);
    assert.equal(agent.effort, 'low');
    assert.equal(agent.daily_budget_usd, 2); // NUMERIC arrives as a number
    assert.equal(await scalar(db, 'SELECT COUNT(*) FROM agents WHERE autonomy_level = 9'), 0);
  } finally {
    await db.close();
  }
});

test('the platform refuses an impossible agent, run, step or approval', async () => {
  const db = await emptyDatabase();
  try {
    const uid = await addUser(db, 'demo@agents.equidron.invalid');
    await run(db, `INSERT INTO agents (id, name, user_id, model) VALUES ('demo', 'Demo', ?, 'm')`, uid);
    await assert.rejects(
      run(db, `INSERT INTO agents (id, name, user_id, model, autonomy_level) VALUES ('bad', 'Bad', ?, 'm', 5)`, uid),
      /check constraint/i); // L0-L4 only
    await assert.rejects(
      run(db, "INSERT INTO agents (id, name, user_id, model) VALUES ('orphan', 'Orphan', 9999, 'm')"),
      /foreign key/i); // an agent must have its own user account
    const runId = await run(db, `INSERT INTO agent_runs (agent_id, trigger, status) VALUES ('demo', 'chat', 'running')`);
    await assert.rejects(
      run(db, `INSERT INTO agent_runs (agent_id, trigger, status) VALUES ('demo', 'chat', 'sleeping')`),
      /check constraint/i); // a run is running, done, waiting, failed or stopped
    await assert.rejects(
      run(db, 'INSERT INTO agent_steps (run_id, step, kind) VALUES (?, 1, ?)', runId, 'thinking'),
      /check constraint/i);
    await assert.rejects(
      run(db, `INSERT INTO approvals (agent_id, tool, payload, risk, reason, idempotency_key)
               VALUES ('demo', 'refund', '{}', 'cheap', 'test', 'k1')`),
      /check constraint/i); // read, write, money or irreversible
  } finally {
    await db.close();
  }
});

test('every run, step and approval is tied to an agent, and approvals default to pending', async () => {
  const db = await emptyDatabase();
  try {
    const uid = await addUser(db, 'demo@agents.equidron.invalid');
    await run(db, `INSERT INTO agents (id, name, user_id, model) VALUES ('demo', 'Demo', ?, 'm')`, uid);
    const runId = await run(db, `INSERT INTO agent_runs (agent_id, trigger, status, subject, input_tokens, output_tokens, cost_usd)
                                 VALUES ('demo', 'event:return.requested', 'running', 'return:57', 1200, 300, 0.0125)`);
    const r = await one(db, 'SELECT * FROM agent_runs WHERE id = ?', runId);
    assert.equal(r.cost_usd, 0.0125); // NUMERIC(10,5) keeps the fraction of a cent
    assert.equal(r.subject, 'return:57');
    await run(db, `INSERT INTO agent_steps (run_id, step, kind, tool, input, output, decision)
                   VALUES (?, 1, 'tool', 'get_order', '{"order_id":42}', '{"status":"confirmed"}', 'execute')`, runId);
    const step = await one(db, 'SELECT * FROM agent_steps WHERE run_id = ?', runId);
    assert.deepEqual(step.input, { order_id: 42 }); // JSONB comes back as an object
    assert.equal(step.decision, 'execute');

    const approval = await run(db, `INSERT INTO approvals (run_id, agent_id, tool, payload, risk, amount_paise, reason, idempotency_key)
                                    VALUES (?, 'demo', 'refund_return', '{"return_id":57}', 'money', 150000, 'Damaged item', 'run:1:refund')`,
      runId);
    const a = await one(db, 'SELECT * FROM approvals WHERE id = ?', approval);
    assert.equal(a.status, 'pending');
    assert.equal(a.amount_paise, 150000);
    // The same key twice is refused, which is what makes an approval run exactly once.
    await assert.rejects(
      run(db, `INSERT INTO approvals (agent_id, tool, payload, risk, reason, idempotency_key)
               VALUES ('demo', 'refund_return', '{}', 'money', 'again', 'run:1:refund')`),
      /unique|duplicate/i);
  } finally {
    await db.close();
  }
});

test('eval cases keep fixtures, expectations and tests tags', async () => {
  const db = await emptyDatabase();
  try {
    const uid = await addUser(db, 'demo@agents.equidron.invalid');
    await run(db, `INSERT INTO agents (id, name, user_id, model) VALUES ('demo', 'Demo', ?, 'm')`, uid);
    const caseId = await run(db, `INSERT INTO eval_cases (agent_id, name, fixture, expected, tags)
                                  VALUES ('demo', 'late shipment', '{"days_late":4}', '{"decision":"nudge"}', ARRAY['edge','injection'])`);
    const c = await one(db, 'SELECT * FROM eval_cases WHERE id = ?', caseId);
    assert.deepEqual(c.tags, ['edge', 'injection']);
    assert.deepEqual(c.expected, { decision: 'nudge' });
    await run(db, `INSERT INTO eval_results (case_id, model, passed, actual, cost_usd)
                   VALUES (?, 'm', true, '{"decision":"nudge"}', 0.0004)`, caseId);
    assert.equal(await scalar(db, 'SELECT passed FROM eval_results WHERE case_id = ?', caseId), true);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------- agents as accounts

test('an agent gets its own account, which can never sign in', async () => {
  const agent = await createAgent(shop, { id: 'demo_reader', name: 'Demo reader', model: 'claude-haiku-5-5' });
  assert.equal(agent.enabled, false);
  assert.equal(agent.autonomy_level, 1);
  assert.equal((await one(shop, 'SELECT role FROM users WHERE id = ?', agent.user_id)).role, 'agent');
  assert.match((await one(shop, 'SELECT email FROM users WHERE id = ?', agent.user_id)).email, /@agents\.equidron\.invalid$/);
  // No page asks for the 'agent' role, so every sign-in attempt is refused. The password is
  // random and thrown away, but even knowing it would not help.
  await assert.rejects(auth.login(shop, 'demo_reader@agents.equidron.invalid', 'anything', 'ops'),
    (e) => e instanceof AppError && [401, 403].includes(e.status));
  await assert.rejects(createAgent(shop, { id: 'demo_reader', name: 'Again', model: 'm' }),
    (e) => e instanceof AppError && e.status === 409);
});

test('only the switches a person controls can be changed, and only to sane values', async () => {
  await createAgent(shop, { id: 'demo_writer', name: 'Demo writer', model: 'claude-sonnet-5-5' });
  const on = await updateAgent(shop, 'demo_writer', { enabled: true, autonomy_level: 3, daily_budget_usd: 1.5, max_steps: 6 });
  assert.equal(on.enabled, true);
  assert.equal(on.autonomy_level, 3);
  assert.equal(on.daily_budget_usd, 1.5);
  assert.equal(on.max_steps, 6);
  await assert.rejects(updateAgent(shop, 'demo_writer', { autonomy_level: 5 }), (e) => e.status === 400);
  await assert.rejects(updateAgent(shop, 'demo_writer', { daily_budget_usd: -1 }), (e) => e.status === 400);
  // An empty box on the page must not read as "budget 0", which would switch the agent off.
  await assert.rejects(updateAgent(shop, 'demo_writer', { daily_budget_usd: null }), (e) => e.status === 400);
  assert.equal((await getAgent(shop, 'demo_writer')).daily_budget_usd, 1.5); // unchanged by the refused edits
  await assert.rejects(updateAgent(shop, 'nobody', { enabled: true }), (e) => e.status === 404);
  assert.ok((await listAgents(shop)).some((a) => a.id === 'demo_writer'));
});

test('pause all is a database switch, off by default', async () => {
  assert.equal(await allPaused(shop), false);
  await pauseAll(shop, true);
  assert.equal(await allPaused(shop), true);
  await pauseAll(shop, false);
  assert.equal(await allPaused(shop), false);
});

test('spend today adds up the runs, and only today’s runs', async () => {
  await createAgent(shop, { id: 'demo_spender', name: 'Demo spender', model: 'm' });
  const before = await spendToday(shop, 'demo_spender');
  await run(shop, `INSERT INTO agent_runs (agent_id, trigger, status, cost_usd) VALUES ('demo_spender', 'chat', 'done', 0.25)`);
  await run(shop, `INSERT INTO agent_runs (agent_id, trigger, status, cost_usd, started_at)
                   VALUES ('demo_spender', 'chat', 'done', 99, now() - interval '3 days')`);
  assert.equal(await spendToday(shop, 'demo_spender'), Math.round((before + 0.25) * 1e5) / 1e5);
});

// ---------------------------------------------------------------- model routing and cost

test('routing picks a model per kind of work, and cost comes from the usage', () => {
  assert.equal(routeModel('simple'), 'claude-haiku-5-5');
  assert.equal(routeModel('default'), 'claude-sonnet-5-5');
  assert.equal(routeModel('deep'), 'claude-opus-5-5');
  assert.equal(routeModel('nonsense'), 'claude-sonnet-5-5');
  // 1M input + 1M output at Sonnet prices.
  assert.equal(costOf('claude-sonnet-5-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 }), 18);
  assert.equal(costOf('claude-haiku-5-5', { input_tokens: 2000, output_tokens: 500 }), 0.0045);
  assert.equal(costOf('a-model-nobody-priced', { input_tokens: 1000, output_tokens: 1000 }), 0); // never invent a price
});

// ---------------------------------------------------------------- the tool registry

test('only the tools an agent is allowed are offered to it', () => {
  assert.deepEqual(toolDefsFor('demo_reader'), []); // not registered for it at all
  const ops = toolDefsFor('ops_helper').map((t) => t.name).sort();
  assert.deepEqual(ops, ['advance_shipment', 'get_order', 'refund_return']);
  const chat = toolDefsFor('store_assistant').map((t) => t.name).sort();
  // Phase 6 gave the chat assistant the cart and two "propose" tools. The proposals change
  // nothing themselves: the customer taps a card, and the normal API does the work.
  assert.deepEqual(chat, ['add_to_cart', 'get_my_order', 'get_product', 'list_my_orders',
    'propose_cancel', 'propose_return', 'search_products', 'update_cart']);
  // It still cannot move money or do anything irreversible.
  assert.ok(toolsFor('store_assistant').every((t) => t.risk === 'read' || t.risk === 'write'));
  // What the model sees is the schema and nothing about risk or limits.
  assert.equal(Object.hasOwn(toolDefsFor('ops_helper')[0], 'risk'), false);
  assert.ok(toolsFor('ops_helper').every((t) => t.agents.includes('ops_helper')));
});

test('a tool declaration is checked when it is registered, not when it runs', () => {
  assert.throws(() => registerTool({ name: 'bad_risk', risk: 'cheap', agents: ['x'], description: 'd', input_schema: {}, run() {} }),
    /Unknown risk/);
  assert.throws(() => registerTool({ name: 'no_agents', risk: 'read', agents: [], description: 'd', input_schema: {}, run() {} }),
    /allowed to use/);
  assert.throws(() => registerTool({ name: 'money_without_amount', risk: 'money', agents: ['x'], description: 'd', input_schema: {}, run() {} }),
    /amount/);
  assert.throws(() => registerTool({ name: 'get_order', risk: 'read', agents: ['x'], description: 'd', input_schema: {}, run() {} }),
    /registered twice/);
});

test('tool input is checked strictly before a service function sees it', () => {
  const t = tool('advance_shipment');
  assert.throws(() => checkInput(t, { shipment_id: 1 }), /needs "reason"/);
  assert.throws(() => checkInput(t, { shipment_id: 'one', reason: 'x' }), /whole number/);
  assert.throws(() => checkInput(t, { shipment_id: 1, reason: 'x', extra: 1 }), /not a field/);
  assert.throws(() => checkInput(t, { shipment_id: 1, reason: 'x'.repeat(201) }), /too long/);
  assert.deepEqual(checkInput(t, { shipment_id: 1, reason: 'late' }), { shipment_id: 1, reason: 'late' });
});

test('opening the database creates the built-in agents, off and in shadow mode', async () => {
  const helper = await getAgent(shop, 'ops_helper');
  assert.ok(helper, 'ops_helper exists after openDatabase');
  assert.equal(helper.enabled, false); // a deploy never switches an agent on by itself
  assert.equal(helper.autonomy_level, 1);
  assert.ok((await one(shop, 'SELECT 1 AS x FROM users WHERE id = ? AND role = ?', helper.user_id, 'agent')));
});

test('a write tool moves a real shipment, and the same idempotency key never moves it twice', async () => {
  const agent = await getAgent(shop, 'ops_helper');
  const active = await one(shop, `SELECT id, status FROM shipments WHERE status NOT IN ('delivered', 'cancelled') ORDER BY id LIMIT 1`);
  const call = { name: 'advance_shipment', input: { shipment_id: active.id, reason: 'The courier picked it up.' } };
  const key = `demo:${active.id}:advance`;
  const first = await executeTool(shop, agent, call, key);
  assert.equal(first.replayed, false);
  const after = await one(shop, 'SELECT status FROM shipments WHERE id = ?', active.id);
  assert.notEqual(after.status, active.status); // it really moved

  const again = await executeTool(shop, agent, call, key);
  assert.equal(again.replayed, true); // the key was already used
  assert.deepEqual(again.result, first.result);
  assert.equal((await one(shop, 'SELECT status FROM shipments WHERE id = ?', active.id)).status, after.status); // and not twice
});

test('a refused action rolls back with its key, so a retry is still possible', async () => {
  const agent = await getAgent(shop, 'ops_helper');
  const delivered = await one(shop, "SELECT id FROM shipments WHERE status = 'delivered' ORDER BY id LIMIT 1");
  const call = { name: 'advance_shipment', input: { shipment_id: delivered.id, reason: 'try again' } };
  const key = `demo:${delivered.id}:refused`;
  await assert.rejects(executeTool(shop, agent, call, key), (e) => e instanceof AppError && e.status === 409);
  assert.equal(await scalar(shop, 'SELECT COUNT(*) FROM idempotency_keys WHERE key = ?', key), 0);
});

test('a money tool knows its amount, so a limit can be enforced', async () => {
  const asha = (await one(shop, "SELECT id FROM users WHERE email = 'asha@example.com'")).id;
  const order = await one(shop, `SELECT o.id, oi.id AS item_id, oi.unit_price_paise AS paise FROM orders o
                                 JOIN order_items oi ON oi.order_id = o.id WHERE o.user_id = ? LIMIT 1`, asha);
  const rid = await orders.requestReturn(shop, asha, order.id, order.item_id, 1, 'Arrived damaged.');
  assert.equal(await tool('refund_return').amount(shop, { return_id: rid }), order.paise);
  assert.equal(await tool('refund_return').autoLimitPaise, 200_000);
});

// ---------------------------------------------------------------- the Ops routes

// A cookie-keeping client over handleApi, as tests/accounts.test.js uses.
function opsClient() {
  const cookies = {};
  const call = async (method, path, body) => {
    const out = await handleApi(shop, { method, path, query: new URLSearchParams(), body, cookies });
    if (out.setCookie) {
      const [k, v] = out.setCookie.split(';')[0].split('=');
      if (v) cookies[k] = v; else delete cookies[k];
    }
    return out;
  };
  return call;
}

async function staffClient(email, permissions) {
  await auth.createUser(shop, email, 'Staff (test)', 'a-long-password', 'ops', false, { permissions });
  const c = opsClient();
  assert.equal((await c('POST', '/api/ops/login', { email, password: 'a-long-password' })).status, 200);
  return c;
}

test('the agent pages are admin-only, and an approval runs through the API exactly once', async () => {
  const support = await staffClient('support.agents@example.com', ['support']);
  for (const path of ['/api/ops/agents', '/api/ops/approvals', '/api/ops/agent-runs']) {
    assert.equal((await support('GET', path)).status, 403, path);
  }
  assert.equal((await support('POST', '/api/ops/agents/pause-all', { paused: true })).status, 403);

  const admin = opsClient();
  assert.equal((await admin('POST', '/api/ops/login', { email: 'ops@example.com', password: 'equidron-demo' })).status, 200);

  const listed = await admin('GET', '/api/ops/agents');
  assert.equal(listed.status, 200);
  assert.ok(listed.payload.agents.some((a) => a.id === 'ops_helper'));
  assert.equal(listed.payload.paused, false);
  assert.equal(listed.payload.levels['3'], 'act within limits');

  // The switches a person changes, through the API the page uses.
  const saved = await admin('POST', '/api/ops/agents/ops_helper', { enabled: true, autonomy_level: 3, daily_budget_usd: 0.5 });
  assert.equal(saved.status, 200);
  assert.equal(saved.payload.autonomy_level, 3);
  assert.equal(saved.payload.daily_budget_usd, 0.5);
  assert.equal((await admin('POST', '/api/ops/agents/nobody', { enabled: true })).status, 404);
  assert.equal((await admin('POST', '/api/ops/agents/ops_helper', { autonomy_level: 9 })).status, 400);

  // An approval made by the runtime, decided through the endpoint.
  const sh = await one(shop, `SELECT id, status FROM shipments WHERE status NOT IN ('delivered', 'cancelled') ORDER BY id DESC LIMIT 1`);
  const approvalId = await run(shop, `INSERT INTO approvals (agent_id, tool, payload, risk, reason, idempotency_key)
                                       VALUES ('ops_helper', 'advance_shipment', ?, 'write', 'Test approval', 'api:test:1')`,
    JSON.stringify({ shipment_id: sh.id, reason: 'Testing the API' }));
  const decided = await admin('POST', `/api/ops/approvals/${approvalId}/decide`, { approve: true, note: 'ok' });
  assert.equal(decided.status, 200);
  assert.equal(decided.payload.executed, true);
  assert.notEqual((await one(shop, 'SELECT status FROM shipments WHERE id = ?', sh.id)).status, sh.status);

  // Deciding it again is refused, and runs nothing.
  const again = await admin('POST', `/api/ops/approvals/${approvalId}/decide`, { approve: true });
  assert.equal(again.status, 409);
  const audited = await one(shop, "SELECT * FROM audit_log WHERE action = 'approval.approved' AND entity_id = ?", String(approvalId));
  assert.ok(audited, 'the decision is in the audit trail');
  assert.match(audited.actor_id, /^\d+$/);

  // Pause all, and the switch is visible on the overview the nav uses.
  assert.equal((await admin('POST', '/api/ops/agents/pause-all', { paused: true })).payload.paused, true);
  assert.equal((await admin('GET', '/api/ops/overview')).payload.agents_paused, true);
  await admin('POST', '/api/ops/agents/pause-all', { paused: false });
});

test('a run shows up on the Agent runs pages, step by step', async () => {
  const admin = opsClient();
  await admin('POST', '/api/ops/login', { email: 'ops@example.com', password: 'equidron-demo' });
  const adminUser = (await admin('GET', '/api/ops/me')).payload.user;
  const runId = await run(shop, `INSERT INTO agent_runs (agent_id, trigger, subject, status, input_tokens, output_tokens, cost_usd)
                                 VALUES ('ops_helper', 'ops', 'api test', 'done', 1200, 300, 0.009)`);
  await run(shop, `INSERT INTO agent_steps (run_id, step, kind, tool, input, output, decision)
                   VALUES (?, 1, 'tool', 'get_order', '{"order_id":7}', '{"status":"confirmed"}', 'execute')`, runId);

  const list = await admin('GET', '/api/ops/agent-runs');
  assert.equal(list.status, 200);
  const row = list.payload.runs.find((r) => r.id === Number(runId));
  assert.ok(row);
  assert.equal(row.steps, 1);
  assert.equal(row.cost_usd, 0.009);

  const oneRun = await admin('GET', `/api/ops/agent-runs/${runId}`);
  assert.equal(oneRun.status, 200);
  assert.equal(oneRun.payload.run.agent_id, 'ops_helper');
  assert.equal(oneRun.payload.steps[0].tool, 'get_order');
  assert.deepEqual(oneRun.payload.steps[0].input, { order_id: 7 });
  assert.ok(adminUser);
});
