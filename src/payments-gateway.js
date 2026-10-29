// Phase 8: capturing a Razorpay payment onto an order that is waiting for one.
//
// The order matters and each step exists to close a hole:
//   verifySignature  — the pair (order, payment) really came from Razorpay
//   fetchPayment     — Razorpay's own amount, not the one a browser claims
//   guard + UPDATE   — the status change happens once, even if the webhook and the browser both land
import { all, changes, now, one, run } from './db.js';
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
  const payment = razorpay.simulateLive()
    ? { id: paymentId, order_id: orderRef || null, amount: null, currency: 'INR', status: 'captured' }
    : await razorpay.fetchPayment(paymentId);
  const gatewayOrderId = orderRef || payment.order_id;
  if (!payment.order_id) throw badRequest('Razorpay did not report an order for this payment.');
  if (gatewayOrderId && payment.order_id !== gatewayOrderId) throw badRequest('That payment belongs to a different Razorpay order.');

  // The signature is only checked when the browser sends one; the webhook is signed as a whole.
  // A simulated live capture has no real signature to check; a real one always does.
  if (source === 'browser' && !razorpay.simulateLive() && !razorpay.verifySignature({ orderId: gatewayOrderId, paymentId, signature })) {
    throw badRequest('The payment signature did not match.');
  }
  if (payment.status !== 'captured' && payment.status !== 'authorized') {
    throw badRequest(`Razorpay says this payment is ${payment.status}.`);
  }

  const order = await one(db, 'SELECT * FROM orders WHERE id = ?', orderId);
  if (!order) throw notFound('Order');
  // A real gateway reports the amount, and a mismatch stops the capture. The simulated live mode has
  // no gateway to ask, so it uses the order's own amount: honest for a demo, never for real money.
  const paidPaise = payment.amount == null ? Number(order.total_paise) : Number(payment.amount);
  if (paidPaise !== Number(order.total_paise)) {
    throw badRequest('The amount paid does not match the order.');
  }

  // Exactly once: the guarded UPDATE is the lock, so a webhook and a browser cannot both capture.
  const won = await changes(db, `UPDATE payments SET status = 'captured', captured_paise = ?, provider_ref = ?, updated_at = ?
                                 WHERE order_id = ? AND captured_paise = 0`,
  paidPaise, payment.id, now(), order.id);
  if (!won) return { already: true, order_id: Number(order.id) };

  await run(db, `INSERT INTO payment_events (payment_id, kind, amount_paise, note, at)
                  SELECT id, 'capture', ?, ?, ? FROM payments WHERE order_id = ?`,
  paidPaise, `Razorpay ${payment.id} captured.`, now(), order.id);
  await run(db, "UPDATE orders SET status = 'confirmed' WHERE id = ? AND status IN ('payment_pending', 'payment_failed')", order.id);
  await syncPaymentStatus(db, order.id);
  await emit(db, 'payment.captured', 'order', order.id, { amount_paise: paidPaise, method: 'razorpay' });
  await audit(db, 'payment.captured', 'order', order.id, null, { provider: 'razorpay', mode: razorpay.mode(), payment_id: payment.id, paise: paidPaise, source });
  return { captured: true, order_id: Number(order.id), amount_paise: paidPaise };
}

// The safety net. Webhooks get lost, and a browser can die after paying. Every so often we ask the
// gateway about the orders that are still waiting, and capture what it says is paid.
export async function reconcile(db, { olderThanMinutes = 15 } = {}) {
  const waiting = await all(db, `SELECT p.order_id, p.provider_ref
                                FROM payments p
                                WHERE p.method = 'razorpay' AND p.captured_paise = 0 AND p.provider_ref IS NOT NULL
                                  AND p.created_at < now() - (? || ' minutes')::interval
                                ORDER BY p.id LIMIT 25`, String(Number(olderThanMinutes) || 15));
  let captured = 0;
  const errors = [];
  for (const row of waiting) {
    try {
      const payments = await razorpay.listPaymentsForOrder(row.provider_ref);
      const paid = payments.find((x) => x.status === 'captured') ?? payments.find((x) => x.status === 'authorized');
      if (!paid) continue;
      const out = await capture(db, { orderId: Number(row.order_id), paymentId: paid.id, orderRef: row.provider_ref, source: 'reconcile' });
      if (out.captured) captured += 1;
    } catch (e) {
      errors.push({ order_id: Number(row.order_id), error: String(e.message).slice(0, 160) });
    }
  }
  return { checked: waiting.length, captured, errors };
}

export async function orderIdForGatewayOrder(db, gatewayOrderId) {
  const row = await one(db, 'SELECT order_id FROM payments WHERE provider_ref = ?', gatewayOrderId);
  return row ? Number(row.order_id) : null;
}
