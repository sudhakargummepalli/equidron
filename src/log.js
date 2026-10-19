// Structured logs and error reports. Each log line is one JSON object, masked, with the id of
// the request (or job) it belongs to, so a line in Netlify's logs can be traced to a request.
// Errors also go into error_log (Ops → System) and, when SENTRY_DSN is set, to Sentry.
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import { mask } from './mask.js';

const current = new AsyncLocalStorage();

export const newRequestId = () => crypto.randomUUID();
export const withRequestId = (id, fn) => current.run({ id }, fn);
export const requestId = () => current.getStore()?.id ?? null;

export function log(level, message, fields = {}) {
  const line = JSON.stringify(mask({ at: new Date().toISOString(), level, message, request_id: requestId(), ...fields }));
  (level === 'error' ? console.error : console.log)(line);
}

// Call it outside any transaction that is failing, so the record isn't rolled back with it.
export async function reportError(db, source, err, fields = {}) {
  const message = mask(String(err?.message ?? err)).slice(0, 2000);
  const stack = mask(String(err?.stack ?? '')).slice(0, 8000);
  log('error', message, { source, ...fields });
  try {
    await db.query('INSERT INTO error_log (source, request_id, message, stack) VALUES (?,?,?,?)', [source, requestId(), message, stack]);
  } catch (e) {
    log('error', 'Could not record an error in error_log.', { reason: e.message });
  }
  await sendToSentry(source, err, message, stack).catch((e) => log('error', 'Could not send an error to Sentry.', { reason: e.message }));
}

// Sentry's envelope endpoint, without the SDK. The DSN looks like https://KEY@HOST/PROJECT.
async function sendToSentry(source, err, message, stack) {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  const u = new URL(dsn);
  const eventId = crypto.randomUUID().replace(/-/g, '');
  const event = {
    event_id: eventId, timestamp: Date.now() / 1000, level: 'error', platform: 'node',
    environment: process.env.CONTEXT || 'local', tags: { source }, extra: { request_id: requestId() },
    exception: { values: [{ type: err?.name || 'Error', value: message }] }, message: { formatted: stack.split('\n').slice(0, 5).join('\n') },
  };
  const body = [JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() }), JSON.stringify({ type: 'event' }), JSON.stringify(event)].join('\n');
  await fetch(`${u.protocol}//${u.host}/api${u.pathname}/envelope/`, {
    method: 'POST', body, signal: AbortSignal.timeout(3000),
    headers: { 'Content-Type': 'application/x-sentry-envelope', 'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${u.username}, sentry_client=equidron/1.0` },
  });
}
