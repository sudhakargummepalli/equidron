// Scheduled every minute (production deploys only; scheduled functions get 30 seconds):
// turns new events into jobs, queues the shipment simulator and the weekly backup, then wakes
// the background worker, which runs the jobs. Without WORKER_SECRET the worker stays off.
import { tick } from '../../src/jobs.js';
import { log, reportError } from '../../src/log.js';
import { netlifyDatabase } from '../../src/netlify-db.js';

export default async () => {
  let db;
  try {
    db = await netlifyDatabase();
    const out = await tick(db);
    const secret = process.env.WORKER_SECRET;
    if (!secret) {
      log('warn', 'WORKER_SECRET is not set, so jobs are queued but not run.');
    } else if (!out.paused) {
      const url = new URL('/.netlify/functions/worker-background', process.env.URL);
      const res = await fetch(url, { method: 'POST', headers: { 'x-worker-secret': secret }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) log('error', 'The worker did not start.', { status: res.status });
    }
  } catch (e) {
    if (db) await reportError(db, 'tick', e);
    else log('error', e.message, { source: 'tick' });
  }
};

export const config = { schedule: '* * * * *' };
