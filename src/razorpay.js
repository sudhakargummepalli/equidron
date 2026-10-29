// Phase 8: Razorpay, in test mode.
//
// Three jobs, and the order matters:
//   createOrder  — ask Razorpay for a gateway order; the browser never sees the secret
//   verify       — check Razorpay's signature over "<order>|<payment>", then trust nothing else
//   fetchPayment — ask Razorpay what it actually captured, and compare the paise with our order
//
// The secret lives only in the environment. If it is missing, every call refuses: a payment
// endpoint that fails open is a free-money endpoint.
import crypto from 'node:crypto';
import { badRequest } from './errors.js';

const API = 'https://api.razorpay.com/v1';
export const MIN_PAISE = 100; // ₹1: Razorpay's floor

// A third mode, for demonstrating the live path without a live account: every gateway call is answered
// locally, with ids that say what they are. Real money still needs Razorpay's own KYC.
export const simulateLive = () => process.env.RAZORPAY_SIMULATE_LIVE === '1';
export const mode = () => (simulateLive() ? 'live-simulated' : 'test');
const simId = (prefix) => `${prefix}_simlive_${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;

export const keyId = () => process.env.RAZORPAY_KEY_ID || null;
export const enabled = () => Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);

function auth() {
  const id = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!id || !secret) throw badRequest('Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.');
  return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
}

async function call(method, path, body = null) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: auth(), 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
  if (!res.ok) {
    // 401 from Razorpay means our keys are wrong, and that must not look like a customer error.
    const status = res.status === 401 ? 502 : 502;
    throw badRequest(`Razorpay refused the request (${res.status}). ${payload.error?.description ?? payload.message ?? ''}`.trim());
  }
  return payload;
}

export async function createOrder({ amountPaise, receipt, notes = {} } = {}) {
  const amount = Number(amountPaise);
  if (!Number.isInteger(amount) || amount < MIN_PAISE) throw badRequest(`An amount must be at least ${MIN_PAISE} paise.`);
  const body = {
    amount,
    currency: 'INR',
    receipt: String(receipt).slice(0, 40),
    payment_capture: 1,
    notes,
  };
  if (simulateLive()) {
    const order = { id: simId('order'), amount, currency: 'INR', receipt: body.receipt, status: 'created' };
    return { order_id: order.id, amount, currency: 'INR', receipt: order.receipt };
  }
  const order = await call('POST', '/orders', body);
  return { order_id: order.id, amount: Number(order.amount), currency: order.currency, receipt: order.receipt };
}

// Razorpay signs "<razorpay_order_id>|<razorpay_payment_id>" with the key secret. Same bytes, same
// secret, same hash: equal means the pair really came from Razorpay for this order.
export function verifySignature({ orderId, paymentId, signature } = {}) {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) throw badRequest('Razorpay is not configured.');
  if (!orderId || !paymentId || !signature) throw badRequest('order id, payment id and signature are required.');
  const expected = crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The authoritative amount: what Razorpay says it captured, never what a request body claims.
export async function fetchPayment(paymentId) {
  if (!paymentId) throw badRequest('A payment id is required.');
  if (simulateLive() && String(paymentId).includes('_simlive_')) {
    const amount = Number(process.env.RAZORPAY_SIMULATE_LIVE_AMOUNT || 0);
    return { id: paymentId, order_id: null, amount, currency: 'INR', status: 'captured', method: 'card' };
  }
  const payment = await call('GET', `/payments/${encodeURIComponent(paymentId)}`);
  return {
    id: payment.id,
    order_id: payment.order_id,
    amount: Number(payment.amount),
    currency: payment.currency,
    status: payment.status,
    method: payment.method ?? null,
  };
}

// The webhook is signed over the raw body, so the caller must hand us the bytes it received.
export function verifyWebhook(rawBody, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return false;
  if (!rawBody || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function listPaymentsForOrder(orderId) {
  if (!orderId) throw badRequest('A gateway order id is required.');
  const out = await call('GET', `/orders/${encodeURIComponent(orderId)}/payments`);
  const items = Array.isArray(out.items) ? out.items : [];
  return items.map((x) => ({ id: x.id, status: x.status, amount: Number(x.amount), order_id: x.order_id }));
}

export async function refund(paymentId, amountPaise) {
  if (simulateLive() && String(paymentId).includes('_simlive_')) {
    return { refund_id: simId('rfnd'), amount: Number(amountPaise) || 0, status: 'processed' };
  }
  const body = Number.isInteger(Number(amountPaise)) ? { amount: Number(amountPaise) } : {};
  const out = await call('POST', `/payments/${encodeURIComponent(paymentId)}/refund`, body);
  return { refund_id: out.id, amount: Number(out.amount), status: out.status };
}
