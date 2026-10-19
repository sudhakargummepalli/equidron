// Events, the job queue and the worker: an event makes one job per listener, failing jobs
// retry with growing delays and end as dead, two workers never run the same job, a crashed
// job is picked up again, and the scheduled tick, backups and health check work.
//
// With TEST_DATABASE_URL (CI) this runs on a real PostgreSQL server, which it wipes first.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { handleApi } from '../src/api.js';
import * as auth from '../src/auth.js';
import { exportAll, restoreInto } from '../src/backup.js';
import { all, connect, initSchema, one, scalar, transaction } from '../src/db.js';
import * as jobs from '../src/jobs.js';
import * as orders from '../src/orders.js';
import { openDatabase } from '../src/server.js';
import { handleWorkerRequest } from '../src/worker.js';

auth.settings.fastHashing = true;
process.env.EQUIDRON_SEED_DEMO = '1';
process.env.EQUIDRON_BACKUP_DIR = path.join(os.tmpdir(), 'equidron-test-backups'); // the weekly backup job runs here

const target = process.env.TEST_DATABASE_URL || 'memory';
let db;
let asha;
let ashaAddr;
let speaker;
before(async () => {
  db = await openDatabase(target, { reset: target !== 'memory', maxConnections: 10 });
  asha = (await one(db, "SELECT id FROM users WHERE email = 'asha@example.com'")).id;
  ashaAddr = (await one(db, 'SELECT id FROM addresses WHERE user_id = ?', asha)).id;
  speaker = (await one(db, `SELECT o.id FROM offers o JOIN products p ON p.id = o.product_id JOIN sellers s ON s.id = o.seller_id
                            WHERE p.title LIKE 'Bassline Mini%' AND s.name = 'TechBazaar Hub'`)).id;
  await jobs.work(db); // the seed's own events (sample orders) are dealt with first
});
after(() => db.close());

const buy = () => transaction(db, async () => {
  await orders.addToCart(db, asha, speaker, 1);
  return orders.placeOrder(db, asha, ashaAddr, 'card', 'tok_sim_visa_ok');
});
const jobsFor = (kind) => all(db, 'SELECT * FROM jobs WHERE kind = ? ORDER BY id', kind);

test('placing an order records order.placed, and its job runs exactly once', async () => {
  const { order } = await buy();
  const events = await all(db, "SELECT * FROM events WHERE type = 'order.placed' AND entity_id = ?", order.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].entity, 'order');
  assert.equal(events[0].payload.total_paise, order.total_paise);

  assert.ok(await jobs.dispatch(db) >= 1);
  assert.equal(await jobs.dispatch(db), 0); // nothing new: each event is dispatched once
  const mine = (await jobsFor('email:order_confirmation')).filter((j) => j.payload.entity_id === order.id);
  assert.equal(mine.length, 1);

  await jobs.work(db);
  await jobs.work(db);
  const job = await one(db, 'SELECT * FROM jobs WHERE id = ?', mine[0].id);
  assert.equal(job.status, 'done');
  assert.equal(job.attempts, 1);
  const mails = await all(db, "SELECT * FROM outbox WHERE subject LIKE ? AND to_address = 'asha@example.com'", `%order #${order.id}%`);
  assert.equal(mails.length, 1);
});

test('the same event dispatched twice at once still makes one job', async () => {
  const { order } = await buy();
  await Promise.all([jobs.dispatch(db), jobs.dispatch(db)]);
  const mine = (await jobsFor('email:order_confirmation')).filter((j) => j.payload.entity_id === order.id);
  assert.equal(mine.length, 1);
  await jobs.work(db);
});

test('a failing job retries with growing delays, then ends as dead', async () => {
  let calls = 0;
  jobs.registerHandler('test:always_fails', async () => { calls++; throw new Error('the courier API is down (test)'); });
  const id = await jobs.enqueue(db, 'test:always_fails', { n: 1 }, { maxAttempts: 3 });
  const delays = [];
  for (let i = 0; i < 3; i++) {
    await jobs.work(db);
    const j = await one(db, 'SELECT *, EXTRACT(EPOCH FROM (run_after - now())) AS wait FROM jobs WHERE id = ?', id);
    delays.push(j.wait);
    if (j.status !== 'dead') {
      assert.equal(j.status, 'failed');
      await db.query("UPDATE jobs SET run_after = now() - interval '1 second' WHERE id = $1", [id]); // skip the wait
    }
  }
  const job = await one(db, 'SELECT * FROM jobs WHERE id = ?', id);
  assert.equal(job.status, 'dead');
  assert.equal(job.attempts, 3);
  assert.equal(calls, 3);
  assert.match(job.last_error, /courier API is down/);
  assert.ok(delays[1] > delays[0] * 1.5, `delays should grow: ${delays}`);
  assert.ok(await scalar(db, "SELECT COUNT(*) FROM error_log WHERE source = 'job:test:always_fails'") >= 3);
});

test('two workers never run the same job', async () => {
  const seen = [];
  jobs.registerHandler('test:count', async (_db, payload) => { seen.push(payload.n); await new Promise((r) => setTimeout(r, 5)); });
  for (let n = 0; n < 12; n++) await jobs.enqueue(db, 'test:count', { n });
  await Promise.all([jobs.work(db), jobs.work(db)]);
  assert.deepEqual([...seen].sort((a, b) => a - b), [...Array(12).keys()]);
});

test('a job whose worker crashed is picked up again when its lease runs out', async () => {
  jobs.registerHandler('test:once', async () => {});
  const id = await jobs.enqueue(db, 'test:once', {});
  const first = await jobs.claim(db, { leaseSeconds: 60 });
  assert.equal(first.id, id);
  assert.equal(await jobs.claim(db), null); // still leased to the first worker
  await db.query("UPDATE jobs SET locked_until = now() - interval '1 second' WHERE id = $1", [id]); // ...which died
  const again = await jobs.claim(db);
  assert.equal(again.id, id);
  assert.equal(again.attempts, 2);
  await jobs.finish(db, again);
  assert.equal((await one(db, 'SELECT status FROM jobs WHERE id = ?', id)).status, 'done');
});

test('a dead job can be retried from Ops', async () => {
  jobs.registerHandler('test:flaky', async (_db, payload) => { if (!payload.fixed) throw new Error('not yet'); });
  const id = await jobs.enqueue(db, 'test:flaky', {}, { maxAttempts: 1 });
  await jobs.work(db);
  assert.equal((await one(db, 'SELECT status FROM jobs WHERE id = ?', id)).status, 'dead');
  const ops = {};
  const call = (method, path, body) => handleApi(db, { method, path, query: new URLSearchParams(), body, cookies: ops });
  const login = await call('POST', '/api/ops/login', { email: 'ops@example.com', password: 'equidron-demo' });
  ops.eq_ops = login.setCookie.split(';')[0].split('=')[1];
  await db.query("UPDATE jobs SET payload = '{\"fixed\": true}' WHERE id = $1", [id]);
  assert.equal((await call('POST', `/api/ops/jobs/${id}/retry`, {})).status, 200);
  await jobs.work(db);
  assert.equal((await one(db, 'SELECT status FROM jobs WHERE id = ?', id)).status, 'done');
  const system = (await call('GET', '/api/ops/system')).payload;
  assert.ok('queued' in system.jobs);
  assert.ok(Array.isArray(system.errors));
});

test('the tick queues the shipment simulator once per slot, and the simulator moves shipments', async () => {
  const { order } = await buy();
  const at = new Date('2026-10-21T10:02:00Z');
  await jobs.tick(db, { at });
  await jobs.tick(db, { at: new Date('2026-10-21T10:04:00Z') }); // the same five-minute slot
  const slot = (await jobsFor('simulator:advance_shipments')).filter((j) => j.dedupe_key.endsWith(String(Math.floor(at / 300_000))));
  assert.equal(slot.length, 1);
  const before = (await orders.getOrder(db, order.id)).shipments[0].status;
  await jobs.work(db);
  const afterwards = (await orders.getOrder(db, order.id)).shipments[0].status;
  assert.notEqual(afterwards, before);
});

test('switches: paused jobs wait, and the simulator can be turned off', async () => {
  await jobs.setSetting(db, 'jobs.paused', true);
  const out = await jobs.tick(db, { at: new Date('2026-10-21T11:00:00Z') });
  assert.equal(out.paused, true);
  assert.equal((await jobs.work(db)).done, 0);
  await jobs.setSetting(db, 'jobs.paused', false);
  await jobs.setSetting(db, 'simulator.enabled', false);
  const queued = await jobs.tick(db, { at: new Date('2026-10-21T11:10:00Z') });
  assert.ok(!queued.enqueued.includes('simulator:advance_shipments'));
  await jobs.setSetting(db, 'simulator.enabled', true);
  await jobs.work(db);
});

test('a backup holds every table and restores into an empty database', async () => {
  const dump = await exportAll(db);
  assert.ok(dump.tables.orders.length > 0);
  const fresh = await connect('memory');
  await initSchema(fresh);
  await restoreInto(fresh, dump);
  for (const t of ['users', 'products', 'orders', 'audit_log', 'jobs']) {
    assert.equal(await scalar(fresh, `SELECT COUNT(*) FROM ${t}`), dump.tables[t].length, t);
  }
  // Ids carry on after the restore instead of clashing.
  const ticket = await transaction(fresh, () => orders.createTicket(fresh, asha, null, 'After restore', 'Hello'));
  assert.ok(ticket > Math.max(0, ...dump.tables.support_tickets.map((t) => Number(t.id))));
  await fresh.close();
});

test('the worker needs the secret header', async () => {
  const req = (secret) => new Request('https://example.test/.netlify/functions/worker-background', {
    method: 'POST', headers: secret ? { 'x-worker-secret': secret } : {} });
  assert.equal((await handleWorkerRequest(req(null), { db, secret: 'test-secret-value', seconds: 1 })).status, 401);
  assert.equal((await handleWorkerRequest(req('wrong'), { db, secret: 'test-secret-value', seconds: 1 })).status, 401);
  assert.equal((await handleWorkerRequest(req('x'), { db, secret: '', seconds: 1 })).status, 503); // not set up
  const ok = await handleWorkerRequest(req('test-secret-value'), { db, secret: 'test-secret-value', seconds: 1 });
  assert.equal(ok.status, 200);
});

test('/api/health reports the database and the queue, and every answer has a request id', async () => {
  const out = await handleApi(db, { method: 'GET', path: '/api/health', query: new URLSearchParams(), cookies: {} });
  assert.equal(out.status, 200);
  assert.equal(out.payload.database, 'ok');
  assert.equal(typeof out.payload.jobs.queued, 'number');
  assert.equal(typeof out.payload.jobs.dead, 'number');
  assert.match(out.requestId, /^[0-9a-f-]{36}$/);
});
