// Phase 13: the Ops Manager. It may retry, pause and escalate; the tools to unpause, raise a limit
// or change a permission do not exist. A scripted model stands in, so nothing calls a real one.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { getAgent, updateAgent } from '../src/agents/agents.js';
import { owns, tool, toolDefsFor } from '../src/agents/tools.js';
import { settings } from '../src/auth.js';
import { all, one, run } from '../src/db.js';
import { tick } from '../src/jobs.js';
import { runOpsManager } from '../src/job-kinds.js';
import { openDatabase } from '../src/server.js';

settings.fastHashing = true;
process.env.EQUIDRON_SEED_DEMO = '1';

let db;
before(async () => { db = await openDatabase('memory'); });
after(async () => { await db?.close(); });

const usage = { input_tokens: 1200, output_tokens: 300 };
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

async function deadJob() {
  return await run(db, `INSERT INTO jobs (kind, payload, status, attempts, max_attempts, run_after, last_error, created_at)
                        VALUES ('email:order_confirmation', '{}', 'dead', 5, 5, now(), 'boom', now())`);
}

test('the Ops Manager starts off, at L1, on the strongest model with low effort', async () => {
  const agent = await getAgent(db, 'ops_manager');
  assert.equal(agent.enabled, false);
  assert.equal(agent.autonomy_level, 1);
  assert.equal(agent.model, 'claude-opus-5-5');
  assert.equal(agent.effort, 'low');
});

test('it can retry, pause and escalate — and has no tool to unpause or raise a limit', async () => {
  for (const name of ['ops_trouble', 'retry_job', 'pause_agent', 'escalate_to_person']) {
    assert.ok(owns('ops_manager', name), name);
  }
  const names = toolDefsFor('ops_manager').map((t) => t.name);
  for (const forbidden of ['unpause', 'unpause_agent', 'set_budget', 'set_limit', 'grant_permission', 'cancel_order']) {
    assert.ok(!names.includes(forbidden), `${forbidden} must not be offered`);
  }
});

test('ops_trouble reports the queue, and retry_job puts a dead job back', async () => {
  const id = await deadJob();
  const trouble = await tool('ops_trouble').run(db, {});
  assert.ok(trouble.jobs.some((j) => j.job_id === id && j.status === 'dead'));

  const retried = await tool('retry_job').run(db, {}, { job_id: id, reason: 'A timeout, worth one more try.' });
  assert.equal(retried.retried, true);
  const job = await one(db, 'SELECT status, attempts FROM jobs WHERE id = ?', id);
  assert.equal(job.status, 'queued');
  assert.equal(Number(job.attempts), 0);
  // Retrying a job that is already queued changes nothing.
  const again = await tool('retry_job').run(db, {}, { job_id: id, reason: 'Again.' });
  assert.equal(again.retried, false);
});

test('pausing an agent is recorded, and the agent cannot pause itself', async () => {
  const before = await getAgent(db, 'fulfilment_watch');
  assert.equal(before.enabled, false);
  await updateAgent(db, 'fulfilment_watch', { enabled: true });
  const out = await tool('pause_agent').run(db, {}, {
    agent_id: 'fulfilment_watch', note: 'It nudged the same seller three times.', reason: 'Behaving outside its job.',
  });
  assert.equal(out.enabled, false);
  assert.equal((await getAgent(db, 'fulfilment_watch')).enabled, false);
  const auditRow = await one(db, "SELECT * FROM audit_log WHERE action = 'agent.pause' ORDER BY id DESC LIMIT 1");
  assert.equal(auditRow.after.note, 'It nudged the same seller three times.');

  await assert.rejects(() => tool('pause_agent').run(db, {}, {
    agent_id: 'ops_manager', note: 'Pausing myself.', reason: 'Should be refused.',
  }), /cannot pause yourself/);
});

test('escalating writes an Ops task a person can act on', async () => {
  const out = await tool('escalate_to_person').run(db, {}, {
    subject: 'Courier API is down',
    body: 'Three shipments have not moved for six hours; the carrier API returns 503. Re-route them or tell customers.',
    reason: 'Not something I can fix.',
  });
  assert.equal(out.escalated, true);
  const task = await one(db, "SELECT * FROM ops_tasks WHERE kind = 'ops_escalation' ORDER BY id DESC LIMIT 1");
  assert.equal(task.subject, 'Courier API is down');
  assert.match(task.body, /503/);
});

test('a run with a dead job retries it and finishes', async () => {
  await updateAgent(db, 'ops_manager', { enabled: true, autonomy_level: 3 });
  const id = await deadJob();
  const client = scripted(
    () => callTool('ops_trouble', {}),
    () => callTool('retry_job', { job_id: id, reason: 'One more try for a 503.' }),
    () => say('Retried one dead job.'),
  );
  const out = await runOpsManager(db, { client });
  assert.equal(out.status, 'done');
  assert.equal((await one(db, 'SELECT status FROM jobs WHERE id = ?', id)).status, 'queued');
  // The prompt carries the marketplace policies, like every other agent's.
  assert.match(client.calls[0].system, /MARKETPLACE POLICIES/);
  await updateAgent(db, 'ops_manager', { enabled: false });
});

test('nothing wrong means no model call at all', async () => {
  await run(db, "DELETE FROM jobs WHERE status IN ('dead', 'failed')");
  await run(db, "UPDATE agent_runs SET status = 'done' WHERE status = 'failed'");
  await updateAgent(db, 'ops_manager', { enabled: true, autonomy_level: 3 });
  const client = scripted(() => say('must not run'));
  const out = await runOpsManager(db, { client });
  assert.deepEqual(out, { skipped: 'nothing wrong' });
  assert.equal(client.calls.length, 0);
  await updateAgent(db, 'ops_manager', { enabled: false });
});

test('the tick queues it at most once per quarter hour', async () => {
  const at = new Date('2026-10-25T09:00:00Z');
  const first = await tick(db, { at });
  assert.ok(first.enqueued.includes('agent:ops_manager'));
  const again = await tick(db, { at });
  assert.ok(!again.enqueued.includes('agent:ops_manager'), 'the same quarter hour cannot queue twice');
  const later = await tick(db, { at: new Date(at.getTime() + 15 * 60_000) });
  assert.ok(later.enqueued.includes('agent:ops_manager'));
  const jobs = await all(db, "SELECT id FROM jobs WHERE kind = 'agent:ops_manager'");
  assert.ok(jobs.length >= 2);
});
