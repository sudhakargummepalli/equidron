// The incidents dashboard: it must say "all clear" only when it really is, go critical when a
// job has died or an agent run failed, and count what the tables actually hold.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { handleApi } from '../src/api.js';
import { createUser, settings } from '../src/auth.js';
import { run, scalar } from '../src/db.js';
import { snapshot } from '../src/incidents.js';
import { openDatabase } from '../src/server.js';

settings.fastHashing = true;
process.env.EQUIDRON_SEED_DEMO = '1';

let db;
before(async () => { db = await openDatabase('memory'); });
after(async () => { await db?.close(); });

test('a healthy demo database is all clear', async () => {
  const s = await snapshot(db);
  assert.equal(s.status, 'ok');
  assert.equal(s.totals.dead_jobs, 0);
  assert.equal(s.totals.failed_runs, 0);
  assert.equal(s.totals.errors, 0);
  assert.equal(s.paused, false);
  assert.equal(s.checks.length, 11);
  assert.ok(s.checks.every((c) => c.label && c.link));
  // Nothing recent to show yet, so the page stays short.
  assert.deepEqual(s.recent.errors, []);
  assert.deepEqual(s.recent.dead_jobs, []);
});

test('an error in the last day is attention, and is listed', async () => {
  await run(db, "INSERT INTO error_log (source, message) VALUES ('test', 'the courier API is down')");
  const s = await snapshot(db);
  assert.equal(s.status, 'attention');
  assert.equal(s.totals.errors, 1);
  assert.match(s.recent.errors[0].message, /courier/);
});

test('a dead job makes the dashboard critical', async () => {
  await run(db, "INSERT INTO jobs (kind, status, attempts, last_error) VALUES ('test:broken', 'dead', 5, 'gave up')");
  const s = await snapshot(db);
  assert.equal(s.status, 'critical');
  assert.equal(s.totals.dead_jobs, 1);
  assert.equal(s.recent.dead_jobs[0].kind, 'test:broken');
});

test('a failed agent run is critical too, and appears with its reason', async () => {
  await run(db, `INSERT INTO agent_runs (agent_id, trigger, subject, status, error)
                 VALUES ('ops_helper', 'test', 'case:1', 'failed', 'the model call failed (500)')`);
  const s = await snapshot(db);
  assert.equal(s.status, 'critical');
  assert.equal(s.totals.failed_runs, 1);
  assert.match(s.recent.failed_runs[0].error, /model call failed/);
});

test('a guardrail refusal is attention, a flag alone is not', async () => {
  await run(db, `INSERT INTO guardrail_events (role, area, rule, severity) VALUES ('customer', 'shop', 'abuse', 'flag')`);
  const flaggedOnly = await snapshot(db);
  assert.equal(flaggedOnly.totals.guardrail_flags >= 1, true);
  assert.equal(flaggedOnly.totals.guardrail_refusals, 0);

  await run(db, `INSERT INTO guardrail_events (role, area, rule, severity) VALUES ('customer', 'shop', 'prompt_injection', 'refuse')`);
  const refused = await snapshot(db);
  assert.equal(refused.status, 'critical'); // the earlier dead job is still there
  assert.equal(refused.totals.guardrail_refusals, 1);
  assert.ok(refused.checks.some((c) => c.key === 'guardrail_refusals' && c.count === 1 && c.link === '#/guardrails'));
});

test('operational counts match direct SQL', async () => {
  const s = await snapshot(db);
  const late = await scalar(db, `SELECT COUNT(*) FROM shipments WHERE eta IS NOT NULL AND eta < ?
                                 AND status NOT IN ('delivered', 'cancelled')`, s.at.slice(0, 10));
  assert.equal(s.totals.late_shipments, late);
  assert.equal(s.totals.open_tasks, await scalar(db, "SELECT COUNT(*) FROM ops_tasks WHERE status = 'open'"));
  assert.equal(s.totals.approvals_waiting, await scalar(db, "SELECT COUNT(*) FROM approvals WHERE status = 'pending'"));
  assert.equal(s.totals.pending_submissions, await scalar(db, "SELECT COUNT(*) FROM submissions WHERE status = 'pending'"));
});

test('pause all shows as attention even if nothing else is wrong', async () => {
  const clean = await openDatabase('memory', { reset: true });
  try {
    await run(clean, `INSERT INTO settings (key, value) VALUES ('agents.paused', 'true')`);
    const s = await snapshot(clean);
    assert.equal(s.status, 'attention');
    assert.equal(s.paused, true);
  } finally {
    await clean.close();
  }
});

// ---------------------------------------------------------------- the Ops route

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
  return call;
}

test('the incidents page is admin-only and serves the snapshot', async () => {
  await createUser(db, 'guardrail.viewer@example.com', 'Support (test)', 'a-long-password', 'ops', false, { permissions: ['support'] });
  const support = client();
  assert.equal((await support('POST', '/api/ops/login', { email: 'guardrail.viewer@example.com', password: 'a-long-password' })).status, 200);
  assert.equal((await support('GET', '/api/ops/incidents')).status, 403);

  const admin = client();
  assert.equal((await admin('POST', '/api/ops/login', { email: 'ops@example.com', password: 'equidron-demo' })).status, 200);
  const out = await admin('GET', '/api/ops/incidents');
  assert.equal(out.status, 200);
  assert.equal(out.payload.status, 'critical');
  assert.ok(out.payload.recent.dead_jobs.length >= 1);
});
