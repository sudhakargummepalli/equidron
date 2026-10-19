// The background worker's front door. Only the tick (which knows WORKER_SECRET) may start it,
// and at most WORKER_SLOTS copies run at once: each copy holds a slot row in settings, which
// it gives back when done (or which expires, if the copy died).
import crypto from 'node:crypto';
import { all, run } from './db.js';
import { work } from './jobs.js';

const WORKER_SLOTS = 2;
const SLOT_MINUTES = 15; // a background function lives at most 15 minutes

const sameSecret = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

async function takeSlot(db) {
  for (let n = 0; n < WORKER_SLOTS; n++) {
    const key = `worker.slot.${n}`;
    const got = await all(db, `INSERT INTO settings (key, value, updated_at) VALUES (?, jsonb_build_object('until', now() + make_interval(mins => ?)), now())
                               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
                               WHERE (settings.value->>'until')::timestamptz < now() RETURNING key`, key, SLOT_MINUTES);
    if (got.length) return key;
  }
  return null;
}

export async function handleWorkerRequest(request, { db, secret = process.env.WORKER_SECRET || '', seconds = 13 * 60 } = {}) {
  if (!secret) return Response.json({ error: 'WORKER_SECRET is not set, so the worker stays off.' }, { status: 503 });
  if (!sameSecret(request.headers.get('x-worker-secret') || '', secret)) return Response.json({ error: 'Not allowed.' }, { status: 401 });
  const slot = await takeSlot(db);
  if (!slot) return Response.json({ skipped: 'Enough workers are already running.' });
  try {
    return Response.json(await work(db, { seconds }));
  } finally {
    await run(db, "UPDATE settings SET value = jsonb_build_object('until', now()), updated_at = now() WHERE key = ?", slot);
  }
}
