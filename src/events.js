// The outbox of things that happened. Service functions call emit() inside their own
// transaction, so an event exists exactly when its change does: if the change rolls back,
// so does the event. jobs.dispatch() later turns each event into work for its listeners.
//
// Payloads hold ids, amounts and statuses only, never personal details: a job reads fresh
// data with the ids when it runs.
import { run } from './db.js';

export const EVENT_TYPES = [
  'order.placed', 'order.cancelled', 'payment.captured', 'shipment.status_changed',
  'return.requested', 'return.received', 'submission.created', 'ticket.created', 'ticket.message',
];

export async function emit(db, type, entity, entityId, payload = {}) {
  if (!EVENT_TYPES.includes(type)) throw new Error(`Unknown event type ${type}.`);
  await run(db, 'INSERT INTO events (type, entity, entity_id, payload) VALUES (?,?,?,?)', type, entity, entityId, JSON.stringify(payload));
}
