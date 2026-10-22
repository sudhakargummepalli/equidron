// Guardrails: rules that run in code, for each role, before anything reaches the database or a
// model. They are not prompt instructions — a customer, seller or staff member who types the
// wrong thing is stopped here whether or not a model would have noticed.
//
// Two outcomes are possible, and they are deliberately different:
//   refuse  the request stops, with a plain sentence for the person (and nobody is charged)
//   flag    the request goes ahead, and the event is recorded for Ops to look at
//
// Every refusal and every flag is written to guardrail_events, so Ops can see what the rules
// stopped, for which role, and why. Text kept in that table is masked first.
import { all, one, run } from './db.js';
import { AppError } from './errors.js';
import { mask } from './mask.js';

export const ROLES = ['customer', 'seller', 'ops', 'agent', 'system'];
export const SEVERITIES = ['flag', 'refuse'];

// The rules a person can be stopped or flagged by, with the sentence they see. Ops shows these
// names, so keep them stable and readable.
export const RULES = {
  card_number: { severity: 'refuse', message: "Please don't type a card number here. Payments are taken on the payment page, never in a message." },
  prompt_injection: { severity: 'refuse', message: "That message looks like an attempt to change the assistant's instructions. Please ask your question in plain words." },
  abuse: { severity: 'refuse', message: 'Please keep it respectful. Tell us what went wrong and we will help.' },
  contact_details: { severity: 'flag', message: '' },
  seller_listing_text: { severity: 'flag', message: '' },
  seller_rate: { severity: 'refuse', message: "You've sent a lot of listing changes in the last hour. Please wait a little before sending more." },
  staff_bulk: { severity: 'refuse', message: 'That would change too many records at once. Do it in smaller batches.' },
};

// Phrases that try to give an assistant new instructions. Kept narrow on purpose: "system
// requirements" is a product specification, "ignore your rules" is an attack.
const INJECTION = [
  /\b(ignore|disregard|forget)\s+(all\s+|any\s+)?(of\s+)?(your\s+|the\s+)?(previous\s+|prior\s+|above\s+)?(instructions|rules|prompt|directions)\b/i,
  /\byou are now\b/i,
  /\bsystem\s*:/i,
  /\b(jailbreak|developer mode|do anything now|dan mode)\b/i,
  /\bapprove\s+(this|the)\s+(listing|refund|order|submission)\b/i,
  /<\/?\s*(script|iframe|object)\b/i,
];

const ABUSE = /\b(fuck|fucking|bitch|bastard|asshole|motherfucker|idiot|moron|kill you)\b/i;

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE = /(?:\+?91[ -]?)?\b[6-9]\d{4}[ -]?\d{5}\b/;

function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

const hasCardNumber = (text) => (text.match(/(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g) || [])
  .some((m) => luhn(m.replace(/\D/g, '')));

// Look at one piece of text. Pure: no database, so the tests can cover it directly.
export function inspect({ role, text }) {
  const t = String(text || '');
  if (!t) return { verdict: 'allow' };
  if (hasCardNumber(t)) return decide('card_number', role);
  if (INJECTION.some((re) => re.test(t))) return decide('prompt_injection', role);
  if (ABUSE.test(t)) return decide('abuse', role);
  if (EMAIL.test(t) || PHONE.test(t)) return decide('contact_details', role);
  return { verdict: 'allow' };
}

// A seller's listing text is different from a chat message: sellers legitimately describe
// systems, and an odd phrase should be looked at by a reviewer rather than block their work.
// Injection or abuse in a listing is therefore always a flag, never a refusal.
function decide(rule, role) {
  if (role === 'seller' && (rule === 'prompt_injection' || rule === 'abuse')) {
    return { verdict: 'flag', rule: 'seller_listing_text', severity: 'flag', message: '' };
  }
  const r = RULES[rule];
  return { verdict: r.severity, rule, severity: r.severity, message: r.message };
}

export async function record(db, { role, area, rule, severity, actorId = null, detail = null }) {
  await run(db, `INSERT INTO guardrail_events (role, area, rule, severity, actor_id, detail) VALUES (?,?,?,?,?,?)`,
    ROLES.includes(role) ? role : 'system', String(area).slice(0, 40), String(rule).slice(0, 60), severity,
    actorId == null ? null : String(actorId), detail == null ? null : JSON.stringify(mask(detail)));
}

// Screen a piece of text for a role and act on the verdict: refusals throw (so nothing is
// stored or sent), flags are recorded and the request continues.
export async function guardText(db, { role, area, user = null, text, where = 'text' }) {
  const result = inspect({ role, text });
  if (result.verdict === 'allow') return result;
  await record(db, {
    role, area, rule: result.rule, severity: result.verdict, actorId: user?.id ?? null,
    detail: { where, snippet: String(text).slice(0, 200) },
  });
  if (result.verdict === 'refuse') throw new AppError(400, result.message);
  return result;
}

// The two chats: the message is screened before the daily count and before the model is called.
export const guardChat = (db, { role, area, user, text }) => guardText(db, { role, area, user, text, where: 'chat' });

// A seller's submitted listing text. A flag means a person must look at it, so the caller adds
// a review reason; nothing is refused here.
export async function guardListing(db, { sellerId, title = '', description = '' }) {
  const result = inspect({ role: 'seller', text: `${title} ${description}` });
  if (result.verdict === 'allow') return result;
  await record(db, {
    role: 'seller', area: 'seller', rule: result.rule, severity: result.verdict, actorId: sellerId,
    detail: { where: 'listing', title: String(title).slice(0, 120), snippet: String(description).slice(0, 200) },
  });
  return result;
}

// How many listing changes a seller may submit in an hour. Counted from the rows themselves,
// so it cannot drift from what actually happened.
export const SELLER_CHANGES_PER_HOUR = 10;
export async function guardSellerRate(db, sellerId) {
  const n = Number(await one(db, `SELECT COUNT(*) AS n FROM submissions
                                 WHERE seller_id = ? AND created_at > now() - interval '1 hour'`, sellerId).then((r) => r.n));
  if (n >= SELLER_CHANGES_PER_HOUR) {
    await record(db, { role: 'seller', area: 'seller', rule: 'seller_rate', severity: 'refuse', actorId: sellerId, detail: { last_hour: n } });
    throw new AppError(429, RULES.seller_rate.message);
  }
  return n;
}

// A cap on a bulk staff action: one click must never touch an unbounded number of records.
export const STAFF_BULK_LIMIT = 50;
export function capBulk(count, { limit = STAFF_BULK_LIMIT, label = 'records' } = {}) {
  if (Number(count) > limit) {
    throw new AppError(400, `That would change ${count} ${label} at once (the limit is ${limit}). Do it in smaller batches.`);
  }
  return Number(count);
}

// What Ops sees.
export const recent = (db, limit = 100) => all(db,
  'SELECT id, role, area, rule, severity, actor_id, detail, at FROM guardrail_events ORDER BY id DESC LIMIT ?', Number(limit) || 100);

export async function counts(db) {
  const byRule = await all(db, 'SELECT rule, severity, COUNT(*) AS n FROM guardrail_events GROUP BY rule, severity ORDER BY n DESC');
  const lastDay = await one(db, `SELECT COUNT(*) AS n FROM guardrail_events WHERE at > now() - interval '24 hours'`);
  return { by_rule: byRule.map((r) => ({ ...r, n: Number(r.n) })), last_24_hours: Number(lastDay.n) };
}
