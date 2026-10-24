// The marketplace's own rules (returns, refunds, delivery, fees), as versioned documents.
//
// Why a table and not a paragraph in a prompt: a policy changes on a Tuesday, and an agent must
// quote the version it used. Every agent reads the active version of each kind at the start of a
// run, so changing a number is a database change with an author and a date, and a decision can
// name the version it followed.
import { all, one, run } from './db.js';
import { AppError } from './errors.js';

export const KINDS = ['returns', 'refunds', 'delivery', 'fees'];

// The rules as they are in the code today, so the first version can never contradict the app:
// the referral fee is 10% (orders.REFERRAL_FEE_RATE), shipping is ₹40 below the free threshold,
// a return is allowed inside the product's own window, and a shipment two days late is escalated.
export const DEFAULTS = {
  returns: [
    'An item can be returned inside the return window shown on its product page (usually 10 days from delivery).',
    'It must be unused, with its tags and invoice, in the same condition it arrived.',
    'Grocery items cannot be returned once opened.',
    'One return per item: a second request for the same item needs a person.',
  ],
  refunds: [
    'A refund goes back to the original payment method, after the item is received and checked.',
    'The refund amount is the price paid for the returned quantity; shipping is not refunded unless the item was wrong or damaged.',
    'An agent may refund up to ₹2,000 without a person. Above that, it must ask for approval and say why.',
    'A refund is never issued before the return is received, except for an item that never arrived.',
  ],
  delivery: [
    'The delivery estimate on the order page is the promise; it shows an India date.',
    'A shipment more than two days past its estimate is late: the seller is nudged and an Ops task is raised.',
    'A delivery attempt that fails is retried once; after that the customer chooses a new date or cancels.',
    'An order is delivered when its last shipment is delivered; partial deliveries are shown per shipment.',
  ],
  fees: [
    'Equidron charges a referral fee of 10% of the item price.',
    'Shipping is ₹40 per order below the free-shipping threshold, and free above it.',
    'The referral fee and any refund of it appear on the seller ledger, one line per order item.',
    'Payouts to a seller are settled after the return window closes.',
  ],
};

// A policy is a list of rules. Blank lines are dropped, so an empty policy is refused rather than
// stored as whitespace.
const asText = (body) => {
  const lines = (Array.isArray(body) ? body : String(body ?? '').split('\n'))
    .map((line) => String(line).replace(/^[-•]\s*/, '').trim())
    .filter(Boolean);
  return lines.map((line) => `- ${line}`).join('\n');
};

// Put version 1 of each kind in place once. Called when the database is opened, so an existing
// database gains the policies on its next start rather than needing a migration with text in it.
export async function ensurePolicies(db) {
  for (const kind of KINDS) {
    const existing = await one(db, 'SELECT 1 AS x FROM policies WHERE kind = ? LIMIT 1', kind);
    if (existing) continue;
    await run(db, 'INSERT INTO policies (kind, version, body, active, created_by) VALUES (?, 1, ?, true, ?)',
      kind, asText(DEFAULTS[kind]), 'code');
  }
}

// The active version of every kind, newest kind first as declared: used to build the prompt block.
export async function activePolicies(db) {
  const rows = await all(db, 'SELECT kind, version, body FROM policies WHERE active ORDER BY kind');
  const byKind = new Map(rows.map((r) => [r.kind, r]));
  return KINDS.filter((k) => byKind.has(k)).map((k) => byKind.get(k));
}

// A policy change is a new row; the old one stops being active in the same transaction, and the
// partial unique index makes two active versions impossible even if two people publish at once.
export async function publishPolicy(db, kind, body, { by = null } = {}) {
  if (!KINDS.includes(kind)) throw new AppError(400, `There is no policy called "${kind}".`);
  const text = asText(body);
  if (!text) throw new AppError(400, 'A policy cannot be empty.');
  const latest = await one(db, 'SELECT COALESCE(MAX(version), 0) AS v FROM policies WHERE kind = ?', kind);
  const version = Number(latest.v) + 1;
  await run(db, 'UPDATE policies SET active = false WHERE kind = ? AND active', kind);
  await run(db, 'INSERT INTO policies (kind, version, body, active, created_by) VALUES (?, ?, ?, true, ?)', kind, version, text, by);
  return await one(db, 'SELECT * FROM policies WHERE kind = ? AND version = ?', kind, version);
}

// The block that goes into every agent's prompt. Short on purpose: a policy is a rule, not a
// document, and a long block costs tokens on every single run.
export async function policyText(db) {
  const policies = await activePolicies(db);
  if (!policies.length) return '';
  const parts = policies.map((p) => `${p.kind} (v${p.version}):\n${p.body}`);
  return `MARKETPLACE POLICIES — follow these, and name the version when you decide something:\n\n${parts.join('\n\n')}`;
}
