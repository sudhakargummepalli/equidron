// Fraud and risk: a rule score, the signals behind it, and one sentence a person can read.
//
// The rules are code, not a model's opinion, so the same order always scores the same. The agent
// that uses this may hold an order, ask for prepayment or flag it; it may never cancel or ban
// anyone — those are a person's decisions, and the roadmap says so.
import { all, changes, loads, now, one, run } from './db.js';
import { badRequest, notFound } from './errors.js';

// Points and the reason a person sees. Keep the wording short: it is shown on the order page.
export const RULES = [
  {
    code: 'new_account', points: 25,
    why: 'The account is less than a week old.',
    test: ({ accountAgeDays }) => accountAgeDays != null && accountAgeDays < 7,
  },
  {
    code: 'high_value', points: 20,
    why: 'The order is over ₹50,000.',
    test: ({ totalPaise }) => totalPaise > 5_000_000,
  },
  {
    code: 'cod_high_value', points: 20,
    why: 'Cash on delivery over ₹20,000.',
    test: ({ totalPaise, method }) => method === 'cod' && totalPaise > 2_000_000,
  },
  {
    code: 'cancellations', points: 15,
    why: 'More than three orders were cancelled in the last month.',
    test: ({ cancelled30d }) => cancelled30d > 3,
  },
  {
    code: 'failed_payments', points: 20,
    why: 'More than two payments failed before.',
    test: ({ failedPayments }) => failedPayments > 2,
  },
  {
    code: 'velocity', points: 15,
    why: 'More than five orders in the last hour.',
    test: ({ ordersLastHour }) => ordersLastHour > 5,
  },
  {
    code: 'new_city', points: 10,
    why: 'Delivering to a city this customer has never used.',
    test: ({ cityIsNew }) => cityIsNew === true,
  },
  {
    code: 'bulk_quantity', points: 10,
    why: 'More than five of one item in a single order.',
    test: ({ maxQty }) => maxQty > 5,
  },
];

export const HOLD_AT = 60; // hold the order for a person
export const PREPAID_AT = 30; // ask for prepayment instead of cash on delivery

export const band = (points) => (points >= HOLD_AT ? 'high' : points >= PREPAID_AT ? 'medium' : 'low');

// Pure: same facts in, same answer out. The caller reads the facts once.
export function score(facts) {
  const signals = RULES.filter((r) => {
    try { return Boolean(r.test(facts)); } catch { return false; }
  }).map((r) => ({ code: r.code, points: r.points, why: r.why }));
  const points = signals.reduce((n, s) => n + s.points, 0);
  const level = band(points);
  const explanation = signals.length
    ? `${level === 'high' ? 'Hold' : level === 'medium' ? 'Ask for prepayment' : 'Allow'}: ${signals.map((s) => s.why).join(' ')}`
    : 'Allow: nothing unusual about this order.';
  return { score: points, band: level, signals, explanation };
}

// The facts for one order, read from the tables the shop already keeps.
export async function factsFor(db, orderId) {
  const o = await one(db, `SELECT o.*, u.created_at AS user_created FROM orders o JOIN users u ON u.id = o.user_id
                           WHERE o.id = ?`, Number(orderId));
  if (!o) throw notFound('Order');
  const city = loads(o.address, {}).city ?? null;
  const [cancelled, failed, lastHour, cities, qty] = await Promise.all([
    one(db, `SELECT COUNT(*) AS n FROM orders WHERE user_id = ? AND status = 'cancelled'
             AND created_at > now() - interval '30 days'`, o.user_id),
    one(db, `SELECT COUNT(*) AS n FROM payments p JOIN orders x ON x.id = p.order_id
             WHERE x.user_id = ? AND p.status IN ('failed', 'declined')`, o.user_id),
    one(db, `SELECT COUNT(*) AS n FROM orders WHERE user_id = ? AND created_at > now() - interval '1 hour'`, o.user_id),
    all(db, 'SELECT DISTINCT address FROM orders WHERE user_id = ?', o.user_id),
    one(db, 'SELECT COALESCE(MAX(qty), 0) AS n FROM order_items WHERE order_id = ?', o.id),
  ]);
  const knownCities = new Set(cities.map((r) => loads(r.address, {}).city ?? null));
  const accountAgeDays = o.user_created ? (Date.now() - new Date(o.user_created).getTime()) / 86_400_000 : null;
  return {
    orderId: Number(o.id), totalPaise: Number(o.total_paise), method: o.payment_method,
    accountAgeDays, cancelled30d: Number(cancelled.n), failedPayments: Number(failed.n),
    ordersLastHour: Number(lastHour.n), cityIsNew: knownCities.size > 1 && !knownCities.has(city),
    maxQty: Number(qty.n),
  };
}

export async function assess(db, orderId) {
  const facts = await factsFor(db, orderId);
  return { ...score(facts), facts };
}

// A hold is a row, not a flag: it says who held it, why, and what the score was, and releasing it
// leaves the record in place. Nothing here cancels an order.
export async function hold(db, orderId, { reason, by = null } = {}) {
  const o = await one(db, 'SELECT id, status FROM orders WHERE id = ?', Number(orderId));
  if (!o) throw notFound('Order');
  if (!reason || !String(reason).trim()) throw badRequest('A hold needs a reason a person can read.');
  const result = await assess(db, o.id);
  const fresh = await changes(db, `INSERT INTO order_holds (order_id, status, reason, score, signals, created_by, created_at)
                                   VALUES (?, 'active', ?, ?, ?, ?, ?)
                                   ON CONFLICT DO NOTHING`,
  o.id, String(reason).slice(0, 300), result.score, JSON.stringify(result.signals), by, now());
  return { order_id: Number(o.id), held: Boolean(fresh), score: result.score, band: result.band, explanation: result.explanation };
}

export async function release(db, orderId, { by = null, note = null } = {}) {
  const h = await one(db, "SELECT * FROM order_holds WHERE order_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1", Number(orderId));
  if (!h) throw notFound('Hold');
  await run(db, "UPDATE order_holds SET status = 'released', released_by = ?, released_at = ?, release_note = ? WHERE id = ?",
    by, now(), note, h.id);
  return { order_id: Number(orderId), released: true, hold_id: Number(h.id) };
}

export async function openHolds(db, limit = 50) {
  return await all(db, `SELECT h.*, o.total_paise, o.status AS order_status FROM order_holds h
                        JOIN orders o ON o.id = h.order_id WHERE h.status = 'active'
                        ORDER BY h.id DESC LIMIT ?`, limit);
}
