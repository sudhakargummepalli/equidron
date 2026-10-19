// The audit trail: who did what, people and agents alike (audit_log).
//
// handleApi runs every request inside actingAs(), so service functions can call
// audit() without being told who is acting. A write request whose service functions
// recorded nothing gets one row for the request itself, so every change is traced.
import { AsyncLocalStorage } from 'node:async_hooks';
import { all, dumps, run } from './db.js';

export const SYSTEM = Object.freeze({ type: 'system', id: 'system' });
export const ANONYMOUS = Object.freeze({ type: 'user', id: 'anonymous' });

const current = new AsyncLocalStorage();

// actor: { type: 'user' | 'agent' | 'system', id, userId?, runId? }
export function actingAs(actor, fn) {
  return current.run({ actor, written: 0 }, fn);
}

// Once a request knows who signed in (or who just signed in), it names them here.
export function setActor(actor) {
  const scope = current.getStore();
  if (scope) scope.actor = actor;
}

export const userActor = (user) => ({ type: user.role === 'agent' ? 'agent' : 'user', id: String(user.id), userId: user.id });

export function actor() {
  return current.getStore()?.actor ?? SYSTEM;
}

// The signed-in person's user id, for columns such as decided_by.
export function actorUserId() {
  const a = actor();
  return Number.isInteger(a.userId) ? a.userId : null;
}

export const auditsWritten = () => current.getStore()?.written ?? 0;

export async function audit(db, action, entity, entityId, before = null, after = null) {
  const scope = current.getStore();
  const a = scope?.actor ?? SYSTEM;
  await run(db, `INSERT INTO audit_log (actor_type, actor_id, run_id, action, entity, entity_id, before, after)
                 VALUES (?,?,?,?,?,?,?,?)`,
  a.type, String(a.id), a.runId ?? null, action, entity, String(entityId),
  before == null ? null : dumps(before), after == null ? null : dumps(after));
  if (scope) scope.written++;
}

const SECRET_KEYS = /pass|token|code|otp|secret/i;

// A request body fit for the audit log: secrets dropped (masking happens when it is shown or logged).
export function safeBody(body) {
  return Object.fromEntries(Object.entries(body || {}).filter(([k]) => !SECRET_KEYS.test(k)));
}

export async function listAudit(db, { entity = null, limit = 200 } = {}) {
  let sql = `SELECT a.*, u.name AS actor_name FROM audit_log a
             LEFT JOIN users u ON a.actor_type <> 'system' AND u.id::text = a.actor_id`;
  const params = [];
  if (entity) { sql += ' WHERE a.entity = ?'; params.push(entity); }
  return await all(db, `${sql} ORDER BY a.id DESC LIMIT ${Number(limit) || 200}`, ...params);
}
