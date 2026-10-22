// Analytics for Ops: who sells the most, what each seller earns each quarter, and which
// customers deserve a promotion because they have spent more than the threshold in a year.
//
// Everything is counted from orders and order items that already exist, bucketed by the India
// day, and computed on read. There is no copy of the numbers anywhere, so the page cannot
// disagree with the orders it is describing.
//
// Money stays in integer paise here; the page divides by 100 only to display it.
import { all, indiaDate } from './db.js';

// A customer who has paid for more than this in the window is worth a promotion.
export const PROMOTE_THRESHOLD_PAISE = 5_000_000; // Rs 50,000

// What counts as a sale: an order that was not cancelled and whose money was actually taken
// (card captured at dispatch, UPI at checkout, cash on delivery at the door).
const SALE = "o.status <> 'cancelled' AND o.payment_status = 'captured'";

// The window, in whole months, ending with the current one. `months: 12` means the last twelve
// months, starting on the first day of the month eleven months ago.
export function range(months = 12, now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
  return { months, from: start.toISOString(), to: end.toISOString() };
}

// 1. Which seller gets the most orders.
export async function ordersBySeller(db, { from, to }) {
  return (await all(db, `SELECT s.id AS seller_id, s.name AS seller,
                                COUNT(DISTINCT o.id) AS orders,
                                COALESCE(SUM(oi.unit_price_paise * oi.qty), 0) AS revenue_paise
                         FROM order_items oi
                         JOIN orders o ON o.id = oi.order_id
                         JOIN sellers s ON s.id = oi.seller_id
                         WHERE o.created_at >= ? AND o.created_at < ? AND ${SALE}
                         GROUP BY s.id, s.name
                         ORDER BY orders DESC, revenue_paise DESC`, from, to))
    .map((r) => ({ ...r, orders: Number(r.orders), revenue_paise: Number(r.revenue_paise) }));
}

// 2. Revenue per seller per quarter, newest quarter first. Also the winner of each quarter,
//    which is the question the owner actually asks.
export async function revenueByQuarter(db, { from, to }) {
  const rows = (await all(db, `SELECT to_char(o.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-"Q"Q') AS quarter,
                                     s.id AS seller_id, s.name AS seller,
                                     COUNT(DISTINCT o.id) AS orders,
                                     COALESCE(SUM(oi.unit_price_paise * oi.qty), 0) AS revenue_paise
                              FROM order_items oi
                              JOIN orders o ON o.id = oi.order_id
                              JOIN sellers s ON s.id = oi.seller_id
                              WHERE o.created_at >= ? AND o.created_at < ? AND ${SALE}
                              GROUP BY 1, 2, 3
                              ORDER BY 1 DESC, revenue_paise DESC`, from, to))
    .map((r) => ({ ...r, orders: Number(r.orders), revenue_paise: Number(r.revenue_paise) }));

  const quarters = {};
  for (const r of rows) {
    quarters[r.quarter] ??= { quarter: r.quarter, revenue_paise: 0, sellers: [] };
    quarters[r.quarter].revenue_paise += r.revenue_paise;
    quarters[r.quarter].sellers.push(r);
  }
  // The top three sellers in each quarter are enough for a dashboard; the full list is a table.
  return {
    rows,
    summary: Object.values(quarters)
      .sort((a, b) => (a.quarter < b.quarter ? 1 : -1))
      .map((q) => ({
        quarter: q.quarter,
        revenue_paise: q.revenue_paise,
        top_seller: q.sellers[0]?.seller ?? null,
        top_seller_paise: q.sellers[0]?.revenue_paise ?? 0,
        top_seller_share: q.revenue_paise ? Math.round((q.sellers[0].revenue_paise / q.revenue_paise) * 1000) / 10 : 0,
        sellers: q.sellers.slice(0, 3),
      })),
  };
}

// 3. Customers to promote: paid more than the threshold in the window.
export async function customersToPromote(db, { from, to }, threshold = PROMOTE_THRESHOLD_PAISE) {
  const rows = (await all(db, `SELECT u.id AS user_id, u.name,
                                      COUNT(DISTINCT o.id) AS orders,
                                      COALESCE(SUM(o.total_paise), 0) AS spend_paise,
                                      MAX(o.created_at) AS last_order_at
                               FROM orders o JOIN users u ON u.id = o.user_id
                               WHERE o.created_at >= ? AND o.created_at < ? AND ${SALE}
                               GROUP BY u.id, u.name
                               HAVING COALESCE(SUM(o.total_paise), 0) >= ?
                               ORDER BY spend_paise DESC`, from, to, threshold))
    .map((r) => ({ ...r, orders: Number(r.orders), spend_paise: Number(r.spend_paise) }));
  return { threshold_paise: threshold, customers: rows };
}

export async function snapshot(db, { months = 12, now = new Date(), threshold = PROMOTE_THRESHOLD_PAISE } = {}) {
  const r = range(months, now);
  const [bySeller, quarterly, promote] = await Promise.all([
    ordersBySeller(db, r),
    revenueByQuarter(db, r),
    customersToPromote(db, r, threshold),
  ]);
  const totals = {
    orders: bySeller.reduce((n, s) => n + s.orders, 0),
    revenue_paise: bySeller.reduce((n, s) => n + s.revenue_paise, 0),
    sellers: bySeller.length,
  };
  return {
    range: { ...r, label: `last ${months} month${months === 1 ? '' : 's'}` },
    totals,
    orders_by_seller: bySeller,
    // The one-line answers, so the page can lead with them.
    top_seller_by_orders: bySeller[0] ?? null,
    quarterly,
    promote,
    generated_at: new Date().toISOString(),
    first_day: indiaDate(new Date(r.from)),
  };
}
