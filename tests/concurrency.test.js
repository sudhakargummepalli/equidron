// Many writers at once. Without the global write lock, the database itself must keep stock,
// refunds and checkouts right when requests arrive together.
//
// With TEST_DATABASE_URL set (GitHub Actions runs a PostgreSQL service), these run against a
// real server, where transactions really overlap. Without it they run on PGlite, which runs
// one transaction at a time: still a check of the logic, but not of the races.
// The database at TEST_DATABASE_URL is wiped first, so point it only at a throwaway database.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { handleApi } from '../src/api.js';
import * as auth from '../src/auth.js';
import { all, one, scalar, transaction } from '../src/db.js';
import { AppError } from '../src/errors.js';
import * as orders from '../src/orders.js';
import { openDatabase } from '../src/server.js';

auth.settings.fastHashing = true;
process.env.EQUIDRON_SEED_DEMO = '1';

const target = process.env.TEST_DATABASE_URL || 'memory';
const real = target !== 'memory';
let db;
let offer; // TechBazaar's Bassline Mini: free delivery, ships everywhere
let template; // an address to copy for new customers

before(async () => {
  db = await openDatabase(target, { reset: real, maxConnections: 10 });
  offer = (await one(db, `SELECT o.id FROM offers o JOIN products p ON p.id = o.product_id JOIN sellers s ON s.id = o.seller_id
                          WHERE p.title LIKE 'Bassline Mini%' AND s.name = 'TechBazaar Hub'`)).id;
  template = await one(db, "SELECT a.* FROM addresses a JOIN users u ON u.id = a.user_id WHERE u.email = 'asha@example.com'");
});
after(() => db.close());

let made = 0;
async function customers(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const n2 = ++made;
    await transaction(db, async () => {
      const id = await auth.createUser(db, `buyer${n2}@example.com`, `Buyer ${n2}`, 'buyer-password', 'customer');
      await orders.addAddress(db, id, { name: `Buyer ${n2}`, line1: template.line1, city: template.city, pincode: template.pincode, phone: template.phone });
      out.push({ id, address: (await one(db, 'SELECT id FROM addresses WHERE user_id = ?', id)).id });
    });
  }
  return out;
}

// Leave exactly `units` sellable units of the offer, all in one warehouse.
async function leaveStock(units) {
  await transaction(db, async () => {
    const rows = await all(db, 'SELECT warehouse_id FROM inventory WHERE offer_id = ? ORDER BY warehouse_id', offer);
    await db.query('UPDATE inventory SET on_hand = reserved WHERE offer_id = ?', [offer]);
    await db.query('UPDATE inventory SET on_hand = reserved + ? WHERE offer_id = ? AND warehouse_id = ?', [units, offer, rows[0].warehouse_id]);
  });
}

const available = () => scalar(db, 'SELECT SUM(on_hand - reserved) FROM inventory WHERE offer_id = ?', offer);

test(`20 checkouts at once for the last 5 units give exactly 5 orders (${real ? 'PostgreSQL server' : 'PGlite'})`, async () => {
  const buyers = await customers(20);
  for (const b of buyers) await transaction(db, () => orders.addToCart(db, b.id, offer, 1));
  await leaveStock(5);
  const results = await Promise.allSettled(buyers.map((b) =>
    transaction(db, () => orders.placeOrder(db, b.id, b.address, 'card', 'tok_sim_visa_ok'))));
  const placed = results.filter((r) => r.status === 'fulfilled' && r.value.result === 'placed');
  const refused = results.filter((r) => (r.status === 'fulfilled' && r.value.result === 'issues')
    || (r.status === 'rejected' && r.reason instanceof AppError && r.reason.status === 409));
  const other = results.filter((r) => !placed.includes(r) && !refused.includes(r));
  assert.deepEqual(other.map((r) => r.reason?.stack || r.value), []);
  assert.equal(placed.length, 5);
  assert.equal(refused.length, 15);
  assert.equal(await available(), 0); // never negative: the CHECK constraint would have refused it anyway
  // A buyer who missed out keeps their cart, so they can try again later.
  const missed = buyers[results.indexOf(refused[0])];
  assert.equal((await orders.getCart(db, missed.id)).items.length, 1);
});

test('the same checkout sent twice with one idempotency key creates one order', async () => {
  const [buyer] = await customers(1);
  await leaveStock(10);
  const cookies = {};
  const call = async (method, path, body) => {
    const out = await handleApi(db, { method, path, query: new URLSearchParams(), body, cookies });
    if (out.setCookie) cookies.eq_shop = out.setCookie.split(';')[0].split('=')[1];
    return out;
  };
  await call('POST', '/api/shop/login', { email: `buyer${made}@example.com`, password: 'buyer-password' });
  await call('POST', '/api/shop/cart', { offer_id: offer, qty: 1 });
  const order = { address_id: buyer.address, payment_method: 'card', payment_token: 'tok_sim_visa_ok', idempotency_key: 'checkout-7f3a9c' };
  const [first, second] = await Promise.all([call('POST', '/api/shop/orders', order), call('POST', '/api/shop/orders', order)]);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(second.payload.id, first.payload.id);
  const third = await call('POST', '/api/shop/orders', order); // later still the same answer
  assert.equal(third.payload.id, first.payload.id);
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM orders WHERE user_id = ?', buyer.id), 1);
  assert.equal(await available(), 9);
  // A key too short to be unique is refused before anything happens.
  const bad = await call('POST', '/api/shop/orders', { ...order, idempotency_key: 'x' });
  assert.equal(bad.status, 400);
});

test('two people refunding the same return at once refund it only once', async () => {
  const [buyer] = await customers(1);
  await leaveStock(10);
  const placed = await transaction(db, async () => {
    await orders.addToCart(db, buyer.id, offer, 1);
    return orders.placeOrder(db, buyer.id, buyer.address, 'card', 'tok_sim_visa_ok');
  });
  await transaction(db, async () => {
    for (const sh of placed.order.shipments) for (let i = 0; i < 6; i++) await orders.advanceShipment(db, sh.id, 'ops');
  });
  const item = placed.order.shipments[0].items[0];
  const rid = await transaction(db, () => orders.requestReturn(db, buyer.id, placed.order.id, item.id, 1, 'Damaged or defective'));
  const results = await Promise.allSettled([1, 2].map(() => transaction(db, () => orders.receiveReturn(db, rid, true))));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.ok(results.some((r) => r.status === 'rejected' && r.reason.status === 409));
  assert.equal(await scalar(db, "SELECT COUNT(*) FROM payment_events pe JOIN payments p ON p.id = pe.payment_id WHERE p.order_id = ? AND pe.kind = 'refund'", placed.order.id), 1);
});

test('adding the same item from two tabs at once adds both', async () => {
  const [buyer] = await customers(1);
  await Promise.all([1, 2].map(() => transaction(db, () => orders.addToCart(db, buyer.id, offer, 1))));
  assert.equal((await orders.getCart(db, buyer.id)).items[0].qty, 2);
});

test('settlement run twice at once pays each balance once', async () => {
  const before = await scalar(db, "SELECT COUNT(*) FROM seller_ledger WHERE kind = 'payout'");
  const runs = await Promise.all([1, 2].map(() => transaction(db, () => orders.runSettlement(db))));
  const sellers = runs.flat().map((p) => p.seller_id);
  assert.ok(sellers.length > 0);
  assert.equal(new Set(sellers).size, sellers.length); // nobody paid twice
  assert.equal(await scalar(db, "SELECT COUNT(*) FROM seller_ledger WHERE kind = 'payout'"), before + sellers.length);
});
