// The job queue: work to do later, with retries, leases and switches.
//
//   dispatch()  turns new events into jobs, one per listener (LISTENERS), never twice.
//   tick()      runs every minute (Netlify scheduled function, or app.js locally): dispatches,
//               and queues the shipment simulator and the weekly backup.
//   work()      claims ready jobs one at a time and runs them, until none are left or time is up.
//
// A job is claimed with FOR UPDATE SKIP LOCKED, so two workers never take the same one, and
// holds a lease (locked_until): if its worker dies, the job is claimed again once the lease
// runs out. A failing job waits longer each time (1, 2, 4 ... minutes) and after max_attempts
// it is dead: it stays in Ops → System until a person retries it.
// A handler runs in one transaction with marking its job done, so a finished job never runs again.
import { actingAs } from './audit.js';
import { all, changes, indiaDate, indiaHour, now, one, run, scalar, transaction } from './db.js';
import { AGENT_KINDS, BUILT_IN, EXTERNAL_KINDS } from './job-kinds.js';
import { log, reportError, withRequestId } from './log.js';
import { mask } from './mask.js';
import { needsDelivery } from './mailer.js';

// One entry per kind: { fn, outsideTransaction }. A handler normally runs inside the job's
// transaction, together with marking the job done. An agent handler cannot: a run waits
// minutes on a model, and holding a transaction that long is wrong. Those run outside, keep
// their own short writes, and the job is marked done afterwards.
const HANDLERS = new Map([
  ...Object.entries(BUILT_IN).map(([kind, fn]) => [kind, { fn, outsideTransaction: false }]),
  // Kind to a service outside the database (SMTP): the same reason agents run outside.
  ...Object.entries(EXTERNAL_KINDS).map(([kind, fn]) => [kind, { fn, outsideTransaction: true }]),
  ...Object.entries(AGENT_KINDS).map(([kind, fn]) => [kind, { fn, outsideTransaction: true }]),
]);

// handler(db, payload, job) runs inside the job's transaction unless outsideTransaction is set.
export function registerHandler(kind, handler, { outsideTransaction = false } = {}) {
  HANDLERS.set(kind, { fn: handler, outsideTransaction });
}

export const runsOutsideTransaction = (kind) => HANDLERS.get(kind)?.outsideTransaction === true;

// Who reacts to which event. Each listener gets its own job for each event.
export const LISTENERS = {
  'order.placed': ['email:order_confirmation', 'whatsapp:order_event', 'sms:order_event'],
  // Every later state of an order also emails the customer: the payment, each courier stage, a
  // cancellation, and the return that may follow a delivery.
  'payment.captured': ['email:order_event', 'whatsapp:order_event', 'sms:order_event'],
  'shipment.status_changed': ['email:order_event', 'whatsapp:order_event', 'sms:order_event'],
  'order.cancelled': ['email:order_event', 'whatsapp:order_event', 'sms:order_event'],
  'return.requested': ['email:order_event', 'agent:returns', 'sms:order_event'],
  'return.received': ['email:order_event', 'sms:order_event'],
  'return.rejected': ['email:order_event', 'sms:order_event'],
  // A seller hears about their own listing: when it is added or edited, and when it is decided.
  'submission.created': ['agent:listing_review', 'email:seller_listing'],
  'submission.decided': ['email:seller_listing'],
  // Support answers a new ticket and any new customer message on one. Its own reply emits
  // ticket.message too, so the handler checks who wrote last before starting a run.
  'ticket.created': ['agent:support'],
  'ticket.message': ['agent:support'],
};

// ---------------------------------------------------------------- settings (switches)

export const SETTINGS = { 'jobs.paused': false, 'simulator.enabled': true };

export async function getSetting(db, key, fallback = SETTINGS[key]) {
  const row = await one(db, 'SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : fallback;
}

export async function setSetting(db, key, value) {
  await run(db, `INSERT INTO settings (key, value, updated_at) VALUES (?,?, now())
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, key, JSON.stringify(value));
}

export async function allSettings(db) {
  const stored = Object.fromEntries((await all(db, "SELECT key, value FROM settings WHERE key NOT LIKE 'worker.%'")).map((r) => [r.key, r.value]));
  return { ...SETTINGS, ...stored };
}

// ---------------------------------------------------------------- the queue

// The new job's id, or null when a job with this dedupe key already exists.
export async function enqueue(db, kind, payload = {}, { dedupeKey = null, runAfter = null, maxAttempts = 5 } = {}) {
  const rows = await all(db, `INSERT INTO jobs (kind, payload, dedupe_key, run_after, max_attempts)
                              VALUES (?,?,?, COALESCE(?::timestamptz, now()), ?)
                              ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
  kind, JSON.stringify(payload), dedupeKey, runAfter, maxAttempts);
  return rows[0] ? Number(rows[0].id) : null;
}

export async function dispatch(db, limit = 200) {
  return await transaction(db, async () => {
    // SKIP LOCKED: two dispatchers at once take different events; the dedupe key is a second guard.
    const events = await all(db, 'SELECT * FROM events WHERE dispatched_at IS NULL ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED', limit);
    for (const e of events) {
      for (const kind of LISTENERS[e.type] || []) {
        // The event's own payload travels with the job: a message about a change must describe
        // that change, not whatever the row says later (two stage changes can arrive together).
        await enqueue(db, kind, { event_id: Number(e.id), type: e.type, entity: e.entity, entity_id: e.entity_id, data: e.payload },
          { dedupeKey: `${kind}:event:${e.id}` });
      }
      await run(db, 'UPDATE events SET dispatched_at = now() WHERE id = ?', e.id);
    }
    return events.length;
  });
}

export async function claim(db, { leaseSeconds = 300 } = {}) {
  return await transaction(db, async () => {
    const [job] = await all(db, `UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_until = now() + make_interval(secs => ?)
      WHERE id = (SELECT id FROM jobs
                  WHERE (status IN ('queued', 'failed') AND run_after <= now()) OR (status = 'running' AND locked_until < now())
                  ORDER BY run_after, id LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING *`, leaseSeconds);
    return job ? { ...job, id: Number(job.id) } : null;
  });
}

export async function finish(db, job) {
  await run(db, "UPDATE jobs SET status = 'done', locked_until = NULL, finished_at = now(), last_error = NULL WHERE id = ? AND status = 'running'", job.id);
}

// 'done', 'failed' (will retry) or 'dead'.
export async function runClaimed(db, job) {
  const entry = HANDLERS.get(job.kind);
  try {
    if (!entry) throw new Error(`No handler for job kind "${job.kind}".`);
    if (entry.outsideTransaction) {
      // An agent run: no transaction around the model calls. The run keeps its own short
      // writes, and the job is marked done or failed afterwards.
      await actingAs({ type: 'system', id: `job:${job.kind}` }, () => entry.fn(db, job.payload, job));
      await transaction(db, () => finish(db, job));
    } else {
      await transaction(db, () => actingAs({ type: 'system', id: `job:${job.kind}` }, async () => {
        await entry.fn(db, job.payload, job);
        await finish(db, job);
      }));
    }
    return 'done';
  } catch (e) {
    const dead = job.attempts >= job.max_attempts;
    const wait = Math.min(30 * 2 ** job.attempts, 3600); // 1, 2, 4, 8 ... minutes, at most an hour
    await run(db, `UPDATE jobs SET status = ?, locked_until = NULL, last_error = ?, run_after = now() + make_interval(secs => ?),
                   finished_at = ? WHERE id = ?`,
    dead ? 'dead' : 'failed', mask(String(e?.message ?? e)).slice(0, 2000), dead ? 0 : wait, dead ? now() : null, job.id);
    await reportError(db, `job:${job.kind}`, e, { job_id: job.id, attempt: job.attempts, dead });
    return dead ? 'dead' : 'failed';
  }
}

// Run ready jobs until none are left, `seconds` have passed, or `maxJobs` have run.
export async function work(db, { seconds = 20, maxJobs = 500 } = {}) {
  const counts = { done: 0, failed: 0, dead: 0, paused: false };
  if (await getSetting(db, 'jobs.paused')) return { ...counts, paused: true };
  const deadline = Date.now() + seconds * 1000;
  for (let n = 0; n < maxJobs && Date.now() < deadline; n++) {
    const job = await claim(db);
    if (!job) break;
    counts[await withRequestId(`job-${job.id}`, () => runClaimed(db, job))]++;
  }
  return counts;
}

// ---------------------------------------------------------------- the minute tick

const SIMULATOR_EVERY_MS = 5 * 60_000;
const HOUR_MS = 3_600_000;
const BRIEF_FROM_IST_MINUTES = 8 * 60; // 08:00 IST, when the owner reads it

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const week = Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export async function tick(db, { at = new Date() } = {}) {
  if (await getSetting(db, 'jobs.paused')) return { paused: true, dispatched: 0, enqueued: [] };
  const dispatched = await dispatch(db);
  const enqueued = [];
  await transaction(db, async () => {
    if (await getSetting(db, 'simulator.enabled')) {
      const slot = Math.floor(at.getTime() / SIMULATOR_EVERY_MS);
      if (await enqueue(db, 'simulator:advance_shipments', {}, { dedupeKey: `simulator:${slot}`, maxAttempts: 1 })) {
        enqueued.push('simulator:advance_shipments');
      }
    }
    if (await enqueue(db, 'backup:weekly', {}, { dedupeKey: `backup:${isoWeek(at)}`, maxAttempts: 3 })) enqueued.push('backup:weekly');
    // Fulfilment Watch: once an hour. A dedupe key per hour means a tick every minute still
    // produces exactly one run.
    const hour = Math.floor(at.getTime() / HOUR_MS);
    if (await enqueue(db, 'agent:fulfilment_watch', {}, { dedupeKey: `fulfilment:${hour}` })) enqueued.push('agent:fulfilment_watch');
    // The morning brief: once per India day, from 08:00. Enqueued by the tick rather than a
    // 30 2 * * * cron so it also happens locally, and catches up if the app was down at 08:00.
    const ist = new Date(at.getTime() + 5.5 * HOUR_MS);
    if (ist.getUTCHours() * 60 + ist.getUTCMinutes() >= BRIEF_FROM_IST_MINUTES) {
      const day = indiaDate(at);
      if (await enqueue(db, 'agent:daily_brief', {}, { dedupeKey: `brief:${day}`, maxAttempts: 2 })) enqueued.push('agent:daily_brief');
    }
    // Deliver the outbox: once a minute, and only when something is waiting — including a row a
    // dead worker left in 'sending' past its claim timeout, which must not be stranded. The
    // dedupe key is the minute itself, so a tick that runs twice does not queue two deliveries.
    const minute = Math.floor(at.getTime() / 60_000);
    if (await needsDelivery(db)) {
      if (await enqueue(db, 'email:deliver', {}, { dedupeKey: `email:${minute}`, maxAttempts: 1 })) enqueued.push('email:deliver');
    }
    // 08:00 IST: text the people whose order is due today. The dedupe key is the day itself.
    if (indiaHour(at) === 8 && (await enqueue(db, 'sms:arriving_today', {}, { dedupeKey: `sms:arriving:${indiaDate(at)}`, maxAttempts: 1 }))) enqueued.push('sms:arriving_today');
    // The Ops Manager looks at the queue every fifteen minutes. It is queued every quarter hour
    // whatever the state: the handler itself decides cheaply whether there is anything to look at.
    const quarter = Math.floor(at.getTime() / (15 * 60_000));
    if (await enqueue(db, 'agent:ops_manager', {}, { dedupeKey: `ops_manager:${quarter}`, maxAttempts: 1 })) enqueued.push('agent:ops_manager');
    await setSetting(db, 'tick.last', at.toISOString());
  });
  if (dispatched || enqueued.length) log('info', 'tick', { dispatched, enqueued });
  return { paused: false, dispatched, enqueued };
}

// ---------------------------------------------------------------- what Ops sees

export async function queueStats(db) {
  const counts = Object.fromEntries((await all(db, 'SELECT status, COUNT(*) AS n FROM jobs GROUP BY status')).map((r) => [r.status, r.n]));
  const oldest = await one(db, `SELECT EXTRACT(EPOCH FROM (now() - MIN(run_after))) AS age FROM jobs
                                WHERE status IN ('queued', 'failed') AND run_after <= now()`);
  return {
    queued: counts.queued || 0, running: counts.running || 0, failed: counts.failed || 0, dead: counts.dead || 0, done: counts.done || 0,
    oldest_ready_seconds: oldest?.age == null ? null : Math.round(Number(oldest.age)),
  };
}

export async function retry(db, jobId) {
  const job = await one(db, "SELECT * FROM jobs WHERE id = ? AND status IN ('dead', 'failed') FOR UPDATE", jobId);
  if (!job) return false;
  await run(db, "UPDATE jobs SET status = 'queued', attempts = 0, run_after = now(), last_error = NULL, finished_at = NULL WHERE id = ?", jobId);
  return true;
}
