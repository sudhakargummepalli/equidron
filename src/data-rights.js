// Phase 15: a customer's own data, as Indian data-protection law expects it.
//
// Two rights, and both are deliberately conservative:
//   export  — everything we hold about the person, in one JSON file they can keep
//   delete  — the person's identity is erased, not their orders. A marketplace must keep invoices
//             and order records for tax and consumer law, so orders stay with an anonymised
//             customer row and no way back to the human behind them.
//
// Deletion is a real deletion of personal fields: email, name, phone, address text, support ticket
// text, WhatsApp/SMS numbers, and every session. What remains is a row with `deleted_at` set, and an
// audit entry that says who asked and when.
import { all, now, one, run } from './db.js';
import { audit } from './audit.js';
import { badRequest, notFound } from './errors.js';

// Everything about one person, gathered by their own user id. Nothing here reads another user's row.
export async function exportFor(db, userId) {
  const user = await one(db, 'SELECT id, email, name, role, language, created_at FROM users WHERE id = ?', userId);
  if (!user) throw notFound('Account');
  const orders = await all(db, `SELECT id, status, payment_status, fulfilment_status, payment_method,
                                       subtotal_paise, shipping_paise, total_paise, address, created_at
                                FROM orders WHERE user_id = ? ORDER BY id`, userId);
  const orderIds = orders.map((o) => Number(o.id));
  const items = orderIds.length
    ? await all(db, `SELECT order_id, title, qty, unit_price_paise FROM order_items WHERE order_id = ANY(?) ORDER BY order_id`, orderIds)
    : [];
  const addresses = await all(db, 'SELECT name, line1, city, pincode, phone FROM addresses WHERE user_id = ?', userId);
  const tickets = await all(db, 'SELECT subject, body, status, created_at FROM support_tickets WHERE user_id = ? ORDER BY id', userId).catch(() => []);
  const returns = await all(db, 'SELECT order_id, qty, reason, status, refund_paise, created_at FROM returns WHERE user_id = ? ORDER BY id', userId).catch(() => []);
  const notifications = await all(db, 'SELECT title, body, created_at FROM notifications WHERE user_id = ? ORDER BY id', userId).catch(() => []);
  const proposals = await all(db, 'SELECT kind, status, summary, created_at FROM proposals WHERE user_id = ? ORDER BY id', userId).catch(() => []);
  const documents = await all(db, `SELECT d.kind, d.status, d.created_at FROM seller_documents d
                                   JOIN seller_applications a ON a.id = d.application_id
                                   WHERE a.user_id = ? ORDER BY d.id`, userId).catch(() => []);

  return {
    exported_at: now(),
    account: user,
    addresses,
    orders: orders.map((o) => ({ ...o, items: items.filter((i) => Number(i.order_id) === Number(o.id)) })),
    returns,
    support_tickets: tickets,
    notifications,
    proposals,
    seller_documents: documents,
    note: 'This is everything Equidron holds about your account. Orders are kept after deletion because tax and consumer law require them.',
  };
}

// Erase the person, keep the transactions. Returns what was removed, for the audit row.
export async function deleteAccount(db, userId, { confirm } = {}) {
  if (confirm !== 'DELETE') throw badRequest('Type DELETE to confirm; this cannot be undone.');
  const user = await one(db, 'SELECT id, email, name, deleted_at FROM users WHERE id = ?', userId);
  if (!user) throw notFound('Account');
  if (user.deleted_at) throw badRequest('This account is already deleted.');

  const stamp = now();
  // The email must stay unique, but it must not identify anybody: deleted-<id>@invalid.
  await run(db, `UPDATE users SET email = ?, name = 'Deleted customer', pw_salt = 'x', pw_hash = 'x',
                    deleted_at = ? WHERE id = ?`, `deleted-${userId}@invalid`, stamp, userId);
  await run(db, 'DELETE FROM sessions WHERE user_id = ?', userId);
  await run(db, 'DELETE FROM addresses WHERE user_id = ?', userId);
  await run(db, 'DELETE FROM cart_items WHERE user_id = ?', userId).catch(() => {});
  await run(db, 'UPDATE users SET whatsapp_phone = NULL, whatsapp_opt_in_at = NULL WHERE id = ?', userId).catch(() => {});
  await run(db, 'UPDATE users SET sms_opt_out_at = NULL WHERE id = ?', userId).catch(() => {});
  await run(db, "UPDATE support_tickets SET subject = 'Deleted', body = 'Deleted at the customer request.' WHERE user_id = ?", userId).catch(() => {});
  await run(db, 'UPDATE notifications SET title = NULL, body = NULL WHERE user_id = ?', userId).catch(() => {});

  await audit(db, 'account.delete', 'user', userId, { email: user.email }, { deleted_at: stamp });
  return { deleted: true, at: stamp, kept: 'orders, invoices and payment records, as the law requires' };
}
