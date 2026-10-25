// Proposals: a change the assistant suggests, which only the customer can confirm.
//
// The chat agent may not cancel an order or open a return by itself. It writes a proposal, the
// shop shows a confirmation card, and the tap calls this module, which calls the same service
// function the buttons on the order page call. So the rule "the customer makes the change" is
// enforced by the shape of the code, not by the prompt.
import { all, now, one, run } from './db.js';
import { badRequest, conflict, notFound } from './errors.js';
import * as orders from './orders.js';

export const KINDS = ['cancel_order', 'return_item'];

export async function create(db, userId, kind, payload) {
  if (!KINDS.includes(kind)) throw badRequest(`There is no proposal called "${kind}".`);
  if (!payload || typeof payload !== 'object') throw badRequest('A proposal needs its details.');
  return await run(db, `INSERT INTO proposals (user_id, kind, payload, status, created_at)
                        VALUES (?, ?, ?, 'pending', ?)`, userId, kind, JSON.stringify(payload), now());
}

// What the customer sees: their own open proposals, newest first.
export async function listOpen(db, userId) {
  return await all(db, 'SELECT id, kind, payload, created_at FROM proposals WHERE user_id = ? AND status = ? ORDER BY id DESC', userId, 'pending');
}

export async function get(db, userId, id) {
  const p = await one(db, 'SELECT * FROM proposals WHERE id = ? AND user_id = ?', Number(id), userId);
  if (!p) throw notFound('Proposal');
  return p;
}

// The customer tapped "confirm". The guarded UPDATE means two taps (or a double-click) run once.
export async function confirm(db, userId, id) {
  const p = await one(db, 'SELECT * FROM proposals WHERE id = ? AND user_id = ? FOR UPDATE', Number(id), userId);
  if (!p) throw notFound('Proposal');
  if (p.status !== 'pending') throw conflict(`This proposal was already ${p.status}.`);

  let result;
  if (p.kind === 'cancel_order') {
    result = await orders.cancelOrder(db, userId, Number(p.payload.order_id));
  } else if (p.kind === 'return_item') {
    const returnId = await orders.requestReturn(db, userId, Number(p.payload.order_id), Number(p.payload.order_item_id),
      Number(p.payload.qty), String(p.payload.reason || 'The customer confirmed the return in the chat.'));
    result = { return_id: returnId };
  }
  await run(db, "UPDATE proposals SET status = 'confirmed', decided_at = ? WHERE id = ?", now(), p.id);
  return { proposal_id: Number(p.id), kind: p.kind, status: 'confirmed', result };
}

export async function dismiss(db, userId, id) {
  const p = await one(db, 'SELECT * FROM proposals WHERE id = ? AND user_id = ?', Number(id), userId);
  if (!p) throw notFound('Proposal');
  if (p.status === 'pending') {
    await run(db, "UPDATE proposals SET status = 'dismissed', decided_at = ? WHERE id = ?", now(), p.id);
  }
  return { proposal_id: Number(p.id), status: 'dismissed' };
}
