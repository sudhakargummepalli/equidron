// The policy table: every risk level of tool, at every autonomy level, with amounts below and
// above the limit, plus a disabled agent, a foreign tool, the pause switch and a spent budget.
// This is the most important test in the project: it is what stops a helpful-sounding model
// from refunding money or deleting data.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { settings } from '../src/auth.js';
import { allPaused, createAgent, pauseAll, updateAgent } from '../src/agents/agents.js';
import { decide, explain, HARD_GATES } from '../src/agents/policy.js';
import { registerTool } from '../src/agents/tools.js';
import { connect, initSchema, one, run } from '../src/db.js';

settings.fastHashing = true;

let db;
let agent;

// Tools that stand in for every risk. They record whether anything ran, so a decision can be
// checked against reality and not only against the string the policy returned.
const ran = [];
const noop = (name) => ({ ran: 0, run() { this.ran++; ran.push(name); return { ok: true }; } });

const TOOLS = {
  t_read: noop('t_read'),
  t_write: noop('t_write'),
  t_money: noop('t_money'),
  t_irreversible: noop('t_irreversible'),
  send_bulk_message: noop('send_bulk_message'),
};

before(async () => {
  db = await connect('memory');
  await initSchema(db);
  registerTool({ name: 't_read', description: 'read', risk: 'read', agents: ['demo_policy'], input_schema: { type: 'object', properties: {} }, ...TOOLS.t_read });
  registerTool({
    name: 't_write', description: 'write', risk: 'write', agents: ['demo_policy'],
    input_schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] }, ...TOOLS.t_write,
  });
  registerTool({
    name: 't_money', description: 'money', risk: 'money', agents: ['demo_policy'], autoLimitPaise: 100_000,
    input_schema: { type: 'object', properties: { paise: { type: 'integer' }, reason: { type: 'string' } }, required: ['reason'] },
    amount: (d, input) => input.paise, ...TOOLS.t_money,
  });
  registerTool({
    name: 't_irreversible', description: 'irreversible', risk: 'irreversible', agents: ['demo_policy'],
    input_schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] }, ...TOOLS.t_irreversible,
  });
  registerTool({
    name: 'send_bulk_message', description: 'hard gate', risk: 'write', agents: ['demo_policy'],
    input_schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] }, ...TOOLS.send_bulk_message,
  });
  agent = await createAgent(db, { id: 'demo_policy', name: 'Policy demo', model: 'claude-sonnet-5-5' });
});

after(async () => {
  await db?.close();
});

// [level, tool, input, expected]
const TABLE = [
  // L0 off: nothing at all, not even a read.
  [0, 't_read', {}, 'deny'],
  [0, 't_write', { reason: 'x' }, 'deny'],

  // L1 shadow: reads run, everything that changes the world is recorded and not done.
  [1, 't_read', {}, 'execute'],
  [1, 't_write', { reason: 'x' }, 'shadow'],
  [1, 't_money', { reason: 'x', paise: 5000 }, 'shadow'],
  [1, 't_irreversible', { reason: 'x' }, 'shadow'],
  [1, 'send_bulk_message', { reason: 'x' }, 'shadow'],

  // L2 propose: every change needs a person, whatever its size or risk.
  [2, 't_read', {}, 'execute'],
  [2, 't_write', { reason: 'x' }, 'needs_approval'],
  [2, 't_money', { reason: 'x', paise: 5000 }, 'needs_approval'],
  [2, 't_irreversible', { reason: 'x' }, 'needs_approval'],
  [2, 'send_bulk_message', { reason: 'x' }, 'needs_approval'],

  // L3 act within limits: writes run, money runs only up to the limit, the rest waits.
  [3, 't_read', {}, 'execute'],
  [3, 't_write', { reason: 'x' }, 'execute'],
  [3, 't_money', { reason: 'x', paise: 99_999 }, 'execute'],
  [3, 't_money', { reason: 'x', paise: 100_000 }, 'execute'], // exactly at the limit is allowed
  [3, 't_money', { reason: 'x', paise: 100_001 }, 'needs_approval'],
  [3, 't_money', { reason: 'x' }, 'needs_approval'], // an amount nobody can work out is not small
  [3, 't_irreversible', { reason: 'x' }, 'needs_approval'],
  [3, 'send_bulk_message', { reason: 'x' }, 'needs_approval'],

  // L4 autonomous: everything except the hard gates.
  [4, 't_read', {}, 'execute'],
  [4, 't_write', { reason: 'x' }, 'execute'],
  [4, 't_money', { reason: 'x', paise: 100_001 }, 'needs_approval'],
  [4, 't_irreversible', { reason: 'x' }, 'execute'],
  [4, 'send_bulk_message', { reason: 'x' }, 'needs_approval'], // a hard gate is always a person
];

test('the policy table: tool risk × autonomy level × amount', async () => {
  for (const [level, tool, input, expected] of TABLE) {
    await updateAgent(db, 'demo_policy', { autonomy_level: level, enabled: level > 0 });
    const got = await decide(db, await one(db, "SELECT * FROM agents WHERE id = 'demo_policy'"), tool, input);
    assert.equal(got, expected, `L${level} ${tool} ${JSON.stringify(input)}`);
  }
  assert.deepEqual(ran, []); // deciding never runs anything
});

test('an agent that is off, or not the tool’s agent, gets nothing', async () => {
  await updateAgent(db, 'demo_policy', { autonomy_level: 3, enabled: true });
  const on = await one(db, "SELECT * FROM agents WHERE id = 'demo_policy'");
  assert.equal(await decide(db, on, 't_write', { reason: 'x' }), 'execute');
  assert.equal(await decide(db, { ...on, enabled: false }, 't_write', { reason: 'x' }), 'deny');
  // get_order belongs to the ops helper and the shop assistant, not this agent.
  assert.equal(await decide(db, on, 'get_order', { order_id: 1 }), 'deny');
  assert.equal(await decide(db, on, 'no_such_tool', {}), 'deny');
});

test('the big red button stops everything, reads included', async () => {
  await updateAgent(db, 'demo_policy', { autonomy_level: 3, enabled: true });
  const on = await one(db, "SELECT * FROM agents WHERE id = 'demo_policy'");
  await pauseAll(db, true);
  try {
    assert.equal(await allPaused(db), true);
    for (const [tool, input] of [['t_read', {}], ['t_write', { reason: 'x' }], ['t_money', { reason: 'x', paise: 1 }]]) {
      assert.equal(await decide(db, on, tool, input), 'deny', tool);
    }
  } finally {
    await pauseAll(db, false);
  }
});

test('a spent daily budget is a stop, not a warning', async () => {
  await createAgent(db, { id: 'demo_broke', name: 'Broke', model: 'm', dailyBudgetUsd: 1 });
  await updateAgent(db, 'demo_broke', { autonomy_level: 3, enabled: true });
  registerTool({
    name: 't_broke_read', description: 'read', risk: 'read', agents: ['demo_broke'],
    input_schema: { type: 'object', properties: {} }, run() { return {}; },
  });
  const broke = await one(db, "SELECT * FROM agents WHERE id = 'demo_broke'");
  assert.equal(await decide(db, broke, 't_broke_read', {}), 'execute'); // nothing spent yet

  // 99.9 cents of the dollar spent: still a fraction left.
  await run(db, `INSERT INTO agent_runs (agent_id, trigger, status, cost_usd) VALUES ('demo_broke', 'chat', 'done', 0.999)`);
  assert.equal(await decide(db, broke, 't_broke_read', {}), 'execute');

  await run(db, `INSERT INTO agent_runs (agent_id, trigger, status, cost_usd) VALUES ('demo_broke', 'chat', 'done', 0.001)`);
  assert.equal(await decide(db, broke, 't_broke_read', {}), 'deny'); // exactly spent: no more spending
});

test('every hard gate is always a person, at L4 too', async () => {
  assert.deepEqual([...HARD_GATES].sort(), ['ban_user', 'change_role', 'delete_data', 'run_payouts', 'send_bulk_message']);
  await updateAgent(db, 'demo_policy', { autonomy_level: 4, enabled: true });
  const top = await one(db, "SELECT * FROM agents WHERE id = 'demo_policy'");
  assert.equal(await decide(db, top, 'send_bulk_message', { reason: 'price change' }), 'needs_approval');
});

test('the approver gets a plain sentence about why it is waiting', async () => {
  await updateAgent(db, 'demo_policy', { autonomy_level: 3, enabled: true });
  const on = await one(db, "SELECT * FROM agents WHERE id = 'demo_policy'");
  assert.match(await explain(db, on, 't_money', { paise: 250_000, reason: 'x' }), /₹2500\.00/);
  assert.match(await explain(db, on, 'send_bulk_message', { reason: 'x' }), /hard gate/);
  assert.match(await explain(db, on, 't_irreversible', { reason: 'x' }), /cannot be undone/);
  assert.match(await explain(db, on, 'nope', {}), /does not exist/);
});
