// Analytics: orders per seller, revenue per seller per quarter, and which customers deserve a
// promotion. The numbers must equal the orders they describe, so each test also checks the SQL
// it replaces.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { handleApi } from '../src/api.js';
import { ordersBySeller, revenueByQuarter, customersToPromote, snapshot, range, PROMOTE_THRESHOLD_PAISE } from '../src/analytics.js';
import { settings } from '../src/auth.js';
import { one, run, scalar } from '../src/db.js';
import { openDatabase } from '../src/server.js';

settings.fastHashing = true;
process.env.EQUIDRON_SEED_DEMO = '1';

let db;
let asha;
let rahul;
let sellers;
let offer;
before(async () => {
  db = await openDatabase('memory');
  asha = await one(db, "SELECT id, name FROM users WHERE email = 'asha@example.com'");
  rahul = await one(db, "SELECT id, name FROM users WHERE email = 'rahul@example.com'");
  sellers = await one(db, 'SELECT id FROM sellers ORDER BY id LIMIT 1');
  offer = await one(db, 'SELECT id, product_id FROM offers ORDER BY id LIMIT 1');
});
after(async () => { await db?.close(); });

// One order with one line, so revenue and counts are easy to reason about.
async function addOrder({ userId, sellerId, created, totalPaise, status = 'confirmed', payment = 'captured', qty = 1 }) {
  const address = JSON.stringify({ name: 'Test', line1: '1 Road', city: 'Pune', pincode: '411001', phone: '9000000000' });
  const orderId = await run(db, `INSERT INTO orders (user_id, address, status, payment_status, fulfilment_status, payment_method,
                                 subtotal_paise, shipping_paise, total_paise, created_at, updated_at)
                                 VALUES (?, ?, ?, ?, 'pending', 'card', ?, 0, ?, ?, ?)`,
  userId, address, status, payment, totalPaise, totalPaise, created, created);
  const warehouse = await one(db, 'SELECT id FROM warehouses ORDER BY id LIMIT 1');
  await run(db, `INSERT INTO order_items (order_id, offer_id, product_id, seller_id, warehouse_id, title, qty, unit_price_paise)
                 VALUES (?, ?, ?, ?, ?, 'Test item', ?, ?)`,
  orderId, offer.id, offer.product_id, sellerId, warehouse.id, qty, Math.round(totalPaise / qty));
  return orderId;
}

const day = (iso) => `${iso}T10:00:00Z`;

test('the window is whole months, starting eleven months before this one for 12', () => {
  const r = range(12, new Date('2026-10-22T06:00:00Z'));
  assert.equal(r.from, '2025-11-01T00:00:00.000Z');
  assert.equal(r.to, '2026-11-01T00:00:00.000Z');
  assert.equal(range(1, new Date('2026-10-22T06:00:00Z')).from, '2026-10-01T00:00:00.000Z');
});

test('orders by seller counts only sales, and the leader comes first', async () => {
  const other = await one(db, 'SELECT id FROM sellers WHERE id <> ? ORDER BY id LIMIT 1', sellers.id);
  await addOrder({ userId: asha.id, sellerId: sellers.id, created: day('2026-10-02'), totalPaise: 10_000 });
  await addOrder({ userId: asha.id, sellerId: sellers.id, created: day('2026-10-03'), totalPaise: 20_000 });
  await addOrder({ userId: rahul.id, sellerId: other.id, created: day('2026-10-04'), totalPaise: 5_000 });
  // These two must not count: one cancelled, one not paid yet.
  await addOrder({ userId: asha.id, sellerId: sellers.id, created: day('2026-10-05'), totalPaise: 99_999, status: 'cancelled' });
  await addOrder({ userId: asha.id, sellerId: sellers.id, created: day('2026-10-06'), totalPaise: 88_888, payment: 'authorized' });

  const rows = await ordersBySeller(db, range(12, new Date('2026-10-22T06:00:00Z')));
  const mine = rows.find((r) => r.seller_id === sellers.id);
  // The seed already has orders for this seller, so compare with the database rather than a fixed number.
  const expected = await one(db, `SELECT COUNT(DISTINCT o.id) AS n FROM orders o JOIN order_items oi ON oi.order_id = o.id
                                  WHERE oi.seller_id = ? AND o.status <> 'cancelled' AND o.payment_status = 'captured'
                                    AND o.created_at >= ? AND o.created_at < ?`,
  sellers.id, range(12, new Date('2026-10-22T06:00:00Z')).from, range(12, new Date('2026-10-22T06:00:00Z')).to);
  assert.equal(mine.orders, Number(expected.n));
  assert.equal(rows[0].orders, Math.max(...rows.map((r) => r.orders)));
});

test('revenue is split by calendar quarter, and each quarter names its best seller', async () => {
  const other = await one(db, 'SELECT id FROM sellers WHERE id <> ? ORDER BY id LIMIT 1', sellers.id);
  await addOrder({ userId: asha.id, sellerId: sellers.id, created: day('2026-08-10'), totalPaise: 500_000 });
  await addOrder({ userId: asha.id, sellerId: other.id, created: day('2026-08-11'), totalPaise: 100_000 });
  await addOrder({ userId: asha.id, sellerId: other.id, created: day('2026-10-10'), totalPaise: 700_000 });

  const q = await revenueByQuarter(db, range(24, new Date('2026-10-22T06:00:00Z')));
  const q3 = q.summary.find((s) => s.quarter === '2026-Q3');
  const q4 = q.summary.find((s) => s.quarter === '2026-Q4');
  assert.ok(q3 && q4, 'both quarters are present');
  assert.equal(q3.top_seller, (await one(db, 'SELECT name FROM sellers WHERE id = ?', sellers.id)).name);
  assert.ok(q3.top_seller_paise >= 500_000);
  assert.ok(q3.top_seller_share > 0 && q3.top_seller_share <= 100);
  // The same seller's line appears once per quarter.
  const lines = q.rows.filter((r) => r.seller_id === other.id && (r.quarter === '2026-Q3' || r.quarter === '2026-Q4'));
  assert.equal(lines.length, 2);
});

test('customers to promote: 50,000 or more of paid orders in the window', async () => {
  const r = range(12, new Date('2026-10-22T06:00:00Z'));
  const before = await customersToPromote(db, r);
  const already = before.customers.length;

  // Rahul: two paid orders crossing the line; Asha: one cancelled order that must not count.
  await addOrder({ userId: rahul.id, sellerId: sellers.id, created: day('2026-09-01'), totalPaise: 3_000_000 });
  await addOrder({ userId: rahul.id, sellerId: sellers.id, created: day('2026-09-02'), totalPaise: 2_500_001 });
  await addOrder({ userId: asha.id, sellerId: sellers.id, created: day('2026-09-03'), totalPaise: 9_000_000, status: 'cancelled' });

  const after = await customersToPromote(db, r);
  const rahulRow = after.customers.find((c) => c.user_id === rahul.id);
  assert.ok(rahulRow, 'Rahul crossed the threshold');
  assert.ok(rahulRow.spend_paise >= PROMOTE_THRESHOLD_PAISE);
  // Rahul may already have a seeded order, so compare with the database, not with a guess.
  const expectedOrders = await scalar(db, `SELECT COUNT(DISTINCT o.id) FROM orders o
                                           WHERE o.user_id = ? AND o.status <> 'cancelled' AND o.payment_status = 'captured'
                                             AND o.created_at >= ? AND o.created_at < ?`, rahul.id, r.from, r.to);
  assert.equal(rahulRow.orders, Number(expectedOrders));
  assert.equal(after.threshold_paise, 5_000_000);
  assert.ok(after.customers.length >= already + 1);

  // A higher threshold moves people out again: the list is really computed from the amount.
  const high = await customersToPromote(db, r, 10_000_000);
  assert.ok(high.customers.length <= after.customers.length);
  // The cancelled order did not push Asha over: her spend is below the cancelled amount.
  const ashaRow = after.customers.find((c) => c.user_id === asha.id);
  if (ashaRow) assert.ok(ashaRow.spend_paise < 9_000_000);
});

test('the snapshot carries all three answers', async () => {
  const s = await snapshot(db, { months: 12, now: new Date('2026-10-22T06:00:00Z') });
  assert.ok(s.orders_by_seller.length > 0);
  assert.ok(s.totals.orders >= s.orders_by_seller[0].orders);
  assert.ok(s.top_seller_by_orders);
  assert.ok(s.quarterly.rows.length > 0);
  assert.ok(Array.isArray(s.promote.customers));
  assert.equal(s.promote.threshold_paise, PROMOTE_THRESHOLD_PAISE);
  assert.equal(s.first_day, '2025-11-01');
});

// ---------------------------------------------------------------- the Ops route

function client() {
  const cookies = {};
  return async (method, path, body) => {
    const [p, search] = path.split('?');
    const out = await handleApi(db, { method, path: p, query: new URLSearchParams(search || ''), body, cookies });
    if (out.setCookie) {
      const [k, v] = out.setCookie.split(';')[0].split('=');
      if (v) cookies[k] = v; else delete cookies[k];
    }
    return out;
  };
}

test('the analytics page is admin-only and clamps the range', async () => {
  assert.equal((await client()('GET', '/api/ops/analytics')).status, 401);

  const admin = client();
  assert.equal((await admin('POST', '/api/ops/login', { email: 'ops@example.com', password: 'equidron-demo' })).status, 200);
  const out = await admin('GET', '/api/ops/analytics?months=12');
  assert.equal(out.status, 200);
  assert.ok(out.payload.orders_by_seller.length > 0);
  assert.equal(out.payload.range.months, 12);

  const clamped = await admin('GET', '/api/ops/analytics?months=999');
  assert.equal(clamped.status, 200);
  assert.equal(clamped.payload.range.months, 60);
});
