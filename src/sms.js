// Phase 10: SMS.
//
// SMS is the channel with the strictest rules in India: every commercial message must carry a
// registered DLT template id and a registered sender, and the customer must be able to stop it.
// So the template id is part of every send, and an opt-out is permanent until the person asks to
// come back.
//
// The providers follow the same shape as WhatsApp: `simulated` records the message locally,
// `twilio` and `msg91` are real adapters that fail closed when their keys are missing.
import { all, now, one, run } from './db.js';
import { badRequest } from './errors.js';
import { validPhone } from './whatsapp.js';

export const PROVIDERS = ['simulated', 'twilio', 'msg91'];
export const providerName = () => (process.env.SMS_PROVIDER || 'simulated').toLowerCase();

const digits = (phone) => String(phone || '').replace(/[^0-9]/g, '');
const withCountry = (phone) => {
  const d = digits(phone);
  return d.length === 10 ? `91${d}` : d;
};

export const configured = () => {
  const provider = providerName();
  if (provider === 'simulated') return true;
  if (provider === 'twilio') return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_SMS_FROM);
  if (provider === 'msg91') return Boolean(process.env.MSG91_AUTH_KEY && process.env.MSG91_SENDER_ID && process.env.SMS_DLT_TEMPLATE_ID);
  return false;
};

// A message body the networks accept: one segment, no emoji, no line breaks.
export function shorten(text, limit = 160) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

export const optedOut = (user) => Boolean(user?.sms_opt_out_at);

export async function optOut(db, userId) {
  await run(db, 'UPDATE users SET sms_opt_out_at = ? WHERE id = ?', now(), userId);
  return { opted_out: true };
}
export async function optIn(db, userId) {
  await run(db, 'UPDATE users SET sms_opt_out_at = NULL WHERE id = ?', userId);
  return { opted_out: false };
}

export async function send(db, { userId = null, phone, body, templateId = null } = {}) {
  if (!validPhone(phone)) throw badRequest('An Indian mobile number is ten digits and starts with 6–9.');
  const text = shorten(body);
  if (!text) throw badRequest('An SMS needs text.');
  if (!configured()) throw badRequest('SMS is not configured for this provider. See .env.');

  // In India a commercial SMS without a registered template is rejected by the operator, so on
  // anything but the simulator the template is required.
  const template = templateId ?? process.env.SMS_DLT_TEMPLATE_ID ?? null;
  if (providerName() !== 'simulated' && !template) {
    throw badRequest('A DLT template id is required to send SMS in India. Set SMS_DLT_TEMPLATE_ID.');
  }

  const to = withCountry(phone);
  const id = await run(db, `INSERT INTO sms_messages (user_id, phone, body, template_id, status, created_at)
                            VALUES (?, ?, ?, ?, 'queued', ?)`, userId, to, text, template, now());
  try {
    let ref = null;
    if (providerName() === 'twilio') ref = await twilioSend(to, text);
    else if (providerName() === 'msg91') ref = await msg91Send(to, template);
    await run(db, "UPDATE sms_messages SET status = 'sent', provider_ref = ? WHERE id = ?", ref, id);
    return { message_id: Number(id), status: 'sent', provider_ref: ref };
  } catch (e) {
    await run(db, "UPDATE sms_messages SET status = 'failed', error = ? WHERE id = ?", String(e.message).slice(0, 300), id);
    throw e;
  }
}

// Order messages, kept short enough for one segment where possible.
export const ORDER_TEMPLATES = {
  'order.placed': (o) => `Equidron: order #${o.id} confirmed, Rs ${(o.total_paise / 100).toFixed(2)}. We will SMS you when it ships.`,
  'shipment.status_changed': (o) => `Equidron: order #${o.id} is ${String(o.status).replace(/_/g, ' ')}.`,
  'order.cancelled': (o) => `Equidron: order #${o.id} cancelled. Any payment is returned to the same method.`,
  'payment.captured': (o) => `Equidron: payment received for order #${o.id}. No action needed.`,
  'return.requested': (o) => `Equidron: return #${o.return_id} approved for order #${o.id}. A courier will collect it.`,
  'return.received': (o) => `Equidron: refund of Rs ${(Number(o.refund_paise || 0) / 100).toFixed(2)} issued for order #${o.id}.`,
  'return.rejected': (o) => `Equidron: return #${o.return_id} for order #${o.id} was not approved. Reply here for help.`,
  'arriving_today': (o) => `Equidron: order #${o.id} arrives today. Please keep your phone reachable for the courier.`,
};

// The number we SMS: the phone on the order's delivery address, not an account field.
export async function phoneFor(db, userId) {
  const row = await one(db, 'SELECT phone FROM addresses WHERE user_id = ? ORDER BY id LIMIT 1', userId);
  return row?.phone ?? null;
}

export async function recent(db, limit = 30) {
  return await all(db, 'SELECT * FROM sms_messages ORDER BY id DESC LIMIT ?', Math.min(100, Math.max(1, Number(limit) || 30)));
}

async function twilioSend(to, text) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_SMS_FROM;
  if (!sid || !token || !from) throw badRequest('SMS is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_SMS_FROM.');
  const form = new URLSearchParams({ To: `+${to}`, From: from, Body: text });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const text2 = await res.text();
  let parsed;
  try { parsed = JSON.parse(text2); } catch { parsed = {}; }
  if (!res.ok) throw badRequest(`The SMS provider refused the message (${res.status}). ${parsed.message ?? ''}`.trim());
  return parsed.sid ?? null;
}

async function msg91Send(to, templateId) {
  const key = process.env.MSG91_AUTH_KEY;
  const sender = process.env.MSG91_SENDER_ID;
  if (!key || !sender) throw badRequest('SMS is not configured. Set MSG91_AUTH_KEY and MSG91_SENDER_ID.');
  const res = await fetch('https://control.msg91.com/api/v5/flow/', {
    method: 'POST',
    headers: { authkey: key, 'content-type': 'application/json' },
    body: JSON.stringify({ flow_id: templateId, sender, recipients: [{ mobiles: to }] }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  if (!res.ok || String(parsed.type ?? '').toLowerCase() === 'error') {
    throw badRequest(`The SMS provider refused the message (${res.status}). ${parsed.message ?? ''}`.trim());
  }
  return parsed.request_id ?? null;
}
