// Phase 8: capturing a Razorpay payment onto an order that is waiting for one.
//
// The order matters and each step exists to close a hole:
//   verifySignature  — the pair (order, payment) really came from Razorpay
//   fetchPayment     — Razorpay's own amount, not the one a browser claims
//   guard + UPDATE   — the status change happens once, even if the webhook and the browser both land
import { changes, now, one, run } from './db.js';
import { emit } from './events.js';
import { badRequest, notFound } from './errors.js';
import * as razorpay from './razorpay.js';
import { audit } from './audit.js';
import { syncPaymentStatus } from './orders.js';

export async function startForOrder(db, userId, orderId) {
  const order = await one(db, `SELECT o.id, o.user_id, o.total_paise, o.payment_status, p.provider_ref, p.status AS pay_status
                                FROM orders o LEFT JOIN payments p ON p.order_id = o.id
                                WHERE o.id = ? AND o.user_id = ?`, orderId, userId);
  if (!order) throw notFound('Order');
  if (order.payment_status === 'captured') throw badRequest('This order is already paid.');
  // One gateway order per shop order: a second click reuses it rather than creating a second charge.
  if (order.provider_ref && order.pay_status !== 'declined') {
    return { key_id: razorpay.keyId(), order_id: order.provider_ref, amount: Number(order.total_paise), currency: 'INR', reused: true };
  }
  const created = await razorpay.createOrder({ amountPaise: Number(order.total_paise), receipt: `order_${order.id}`, notes: { order_id: String(order.id) } });
  await run(db, 'UPDATE payments SET provider_ref = ?, status = ?, updated_at = ? WHERE order_id = ?', created.order_id, 'created', now(), order.id);
  return { key_id: razorpay.keyId(), order_id: created.order_id, amount: created.amount, currency: created.currency, reused: false };
}

// Called by the browser after the modal succeeds, and by the webhook when it arrives first.
export async function capture(db, { orderId, paymentId, signature, orderRef = null, source = 'browser' } = {}) {
  const payment = await razorpay.fetchPayment(paymentId);
  const gatewayOrderId = orderRef || payment.order_id;
  if (!payment.order_id) throw badRequest('Razorpay did not report an order for this payment.');
  if (gatewayOrderId && payment.order_id !== gatewayOrderId) throw badRequest('That payment belongs to a different Razorpay order.');

  // The signature is only checked when the browser sends one; the webhook is signed as a whole.
  if (source === 'browser' && !razorpay.verifySignature({ orderId: gatewayOrderId, paymentId, signature })) {
    throw badRequest('The payment signature did not match.');
  }
  if (payment.status !== 'captured' && payment.status !== 'authorized') {
    throw badRequest(`Razorpay says this payment is ${payment.status}.`);
  }

  const order = await one(db, 'SELECT * FROM orders WHERE id = ?', orderId);
  if (!order) throw notFound('Order');
  if (Number(payment.amount) !== Number(order.total_paise)) {
    throw badRequest('The amount paid does not match the order.');
  }

  // Exactly once: the guarded UPDATE is the lock, so a webhook and a browser cannot both capture.
  const won = await changes(db, `UPDATE payments SET status = 'captured', captured_paise = ?, provider_ref = ?, updated_at = ?
                                 WHERE order_id = ? AND captured_paise = 0`,
  Number(payment.amount), payment.id, now(), order.id);
  if (!won) return { already: true, order_id: Number(order.id) };

  await run(db, `INSERT INTO payment_events (payment_id, kind, amount_paise, note, at)
                  SELECT id, 'capture', ?, ?, ? FROM payments WHERE order_id = ?`,
  Number(payment.amount), `Razorpay ${payment.id} captured.`, now(), order.id);
  await run(db, "UPDATE orders SET status = 'confirmed' WHERE id = ? AND status IN ('payment_pending', 'payment_failed')", order.id);
  await syncPaymentStatus(db, order.id);
  await emit(db, 'payment.captured', 'order', order.id, { amount_paise: Number(payment.amount), method: 'razorpay' });
  await audit(db, 'payment.captured', 'order', order.id, null, { provider: 'razorpay', payment_id: payment.id, paise: Number(payment.amount), source });
  return { captured: true, order_id: Number(order.id), amount_paise: Number(payment.amount) };
}

export async function orderIdForGatewayOrder(db, gatewayOrderId) {
  const row = await one(db, 'SELECT order_id FROM payments WHERE provider_ref = ?', gatewayOrderId);
  return row ? Number(row.order_id) : null;
}
