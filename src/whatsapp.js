// Phase 10: WhatsApp.
//
// Three rules, all borrowed from the rest of the app:
//   - Only a person who opted in is ever messaged. A phone number on file is not consent.
//   - The provider is chosen by the environment and fails closed: choosing `http` without a token
//     and a phone number id refuses to send, rather than dropping a message silently.
//   - Every message, in and out, is kept with its status and the provider's reference, because a
//     business message that a customer says they never got is a question someone will ask.
//
// The HTTP adapter speaks the Meta Cloud API shape (POST /{phone-number-id}/messages with a bearer
// token). A different BSP (Gupshup, Twilio) changes this one file, not the callers.
import { all, now, one, run } from './db.js';
import { badRequest } from './errors.js';

export const PROVIDERS = ['simulated', 'http', 'twilio'];
export const providerName = () => (process.env.WHATSAPP_PROVIDER || 'simulated').toLowerCase();
export const configured = () => {
  const provider = providerName();
  if (provider === 'simulated') return true;
  if (provider === 'twilio') return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_WHATSAPP_FROM);
  return Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID);
};

const normalise = (phone) => String(phone || '').replace(/[^0-9]/g, '');

// A number we can message: 10 Indian digits, or the same with the 91 country code.
export function validPhone(phone) {
  const digits = normalise(phone);
  return /^[6-9][0-9]{9}$/.test(digits) || /^91[6-9][0-9]{9}$/.test(digits);
}
const withCountry = (phone) => {
  const digits = normalise(phone);
  return digits.length === 10 ? `91${digits}` : digits;
};

export const optedIn = (user) => Boolean(user && user.whatsapp_phone && user.whatsapp_opt_in_at);

export async function optIn(db, userId, phone) {
  if (!validPhone(phone)) throw badRequest('A WhatsApp number is ten digits and starts with 6–9.');
  const stored = withCountry(phone);
  await run(db, 'UPDATE users SET whatsapp_phone = ?, whatsapp_opt_in_at = ? WHERE id = ?', stored, now(), userId);
  return { phone: stored, opted_in: true };
}

export async function optOut(db, userId) {
  await run(db, 'UPDATE users SET whatsapp_opt_in_at = NULL WHERE id = ?', userId);
  return { opted_in: false };
}

// Send one message. The row is written before the call, so a provider failure is visible.
export async function send(db, { userId = null, phone, body, template = null } = {}) {
  if (!validPhone(phone)) throw badRequest('A WhatsApp number is ten digits and starts with 6–9.');
  const text = String(body || '').trim();
  if (!text) throw badRequest('A WhatsApp message needs text.');
  if (!configured()) throw badRequest('WhatsApp is not configured for this provider. See .env.');

  const to = withCountry(phone);
  const id = await run(db, `INSERT INTO whatsapp_messages (user_id, phone, direction, template, body, status, created_at)
                            VALUES (?, ?, 'out', ?, ?, 'queued', ?)`, userId, to, template, text.slice(0, 4000), now());
  try {
    let ref = null;
    if (providerName() === 'http') ref = await httpSend(to, text, template);
    else if (providerName() === 'twilio') ref = await twilioSend(to, text);
    await run(db, "UPDATE whatsapp_messages SET status = 'sent', provider_ref = ? WHERE id = ?", ref, id);
    return { message_id: Number(id), status: 'sent', provider_ref: ref };
  } catch (e) {
    await run(db, "UPDATE whatsapp_messages SET status = 'failed', error = ? WHERE id = ?", String(e.message).slice(0, 300), id);
    throw e;
  }
}

// The order messages. Plain text on purpose: a template must be pre-approved by Meta before a
// business may start a conversation, so until that is done these are the text a sandbox accepts.
export const ORDER_TEMPLATES = {
  'order.placed': (o) => `Your Equidron order #${o.id} is confirmed. Total ₹${(o.total_paise / 100).toFixed(2)}. We will tell you here when it ships.`,
  'payment.captured': (o) => `Payment received for order #${o.id}.`,
  'order.cancelled': (o) => `Order #${o.id} was cancelled. Any money taken is being returned to the same method.`,
  'shipment.status_changed': (o) => `Order #${o.id} is now ${String(o.status).replace(/_/g, ' ')}.`,
};

// What a message from a customer gets back. Deliberately small: this is not the assistant, it is a
// status check, and anything else is pointed at the ticket desk.
export function replyFor(text) {
  // One to seven digits: the demo's order numbers are small, and the answer is always scoped to
  // the sender's own account, so a wrong guess cannot show someone else's order.
  const id = /\b(\d{1,7})\b/.exec(String(text || ''));
  if (id) return { orderId: Number(id[1]) };
  if (/\b(stop|unsubscribe)\b/i.test(text)) return { optOut: true };
  return { help: true };
}

export async function orderStatusText(db, orderId, userId) {
  const o = await one(db, 'SELECT id, status, payment_status, total_paise FROM orders WHERE id = ? AND user_id = ?', orderId, userId);
  if (!o) return 'I could not find that order on your account. Reply with the order number, or open a ticket in the store.';
  return `Order #${o.id}: ${o.status}, payment ${o.payment_status}, ₹${(o.total_paise / 100).toFixed(2)}.`;
}

export async function recordInbound(db, { phone, body, providerRef = null } = {}) {
  const from = withCountry(phone);
  const user = await one(db, 'SELECT id FROM users WHERE whatsapp_phone = ?', from);
  const id = await run(db, `INSERT INTO whatsapp_messages (user_id, phone, direction, body, status, provider_ref, created_at)
                            VALUES (?, ?, 'in', ?, 'received', ?, ?)`, user?.id ?? null, from, String(body || '').slice(0, 4000), providerRef, now());
  return { message_id: Number(id), user_id: user?.id ?? null, phone: from };
}

export async function conversation(db, phone, limit = 50) {
  return await all(db, 'SELECT * FROM whatsapp_messages WHERE phone = ? ORDER BY id DESC LIMIT ?', withCountry(phone), limit);
}

// Twilio's WhatsApp API. Form-encoded, basic auth, and the same fail-closed rule.
async function twilioSend(to, text) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  if (!sid || !token || !from) {
    throw badRequest('Twilio WhatsApp is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_WHATSAPP_FROM.');
  }
  const form = new URLSearchParams({
    To: `whatsapp:+${to}`,
    From: from.startsWith('whatsapp:') ? from : `whatsapp:${from}`,
    Body: text,
  });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.text();
  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = {}; }
  if (!res.ok) throw badRequest(`Twilio refused the message (${res.status}). ${parsed.message ?? ''}`.trim());
  return parsed.sid ?? null;
}

// Meta's Cloud API. Fail closed: no token or phone number id means no send.
async function httpSend(to, text, template) {
  const base = process.env.WHATSAPP_BASE_URL || 'https://graph.facebook.com/v20.0';
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  if (!token || !phoneId) throw badRequest('WhatsApp is not configured. Set WHATSAPP_TOKEN and WHATSAPP_PHONE_ID.');
  const payload = template
    ? { messaging_product: 'whatsapp', to, type: 'template', template: { name: template, language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'en' } } }
    : { messaging_product: 'whatsapp', to, type: 'text', text: { preview_url: false, body: text } };
  const res = await fetch(`${base.replace(/\/$/, '')}/${phoneId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.text();
  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = {}; }
  if (!res.ok) throw badRequest(`WhatsApp refused the message (${res.status}). ${parsed.error?.message ?? ''}`.trim());
  return parsed.messages?.[0]?.id ?? null;
}
