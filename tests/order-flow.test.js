// Core flow tests for Equidron.  Run:  node --test tests/
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { settings } from '../src/auth.js';
import * as catalog from '../src/catalog.js';
import { all, one, run, scalar, transaction } from '../src/db.js';
import { AppError } from '../src/errors.js';
import * as listings from '../src/listings.js';
import * as orders from '../src/orders.js';
import { createServer, openDatabase } from '../src/server.js';

settings.pbkdf2Rounds = 1000; // keep the seeded accounts fast to create in tests

let db;
let asha;
let ashaAddr;

const uid = (email) => one(db, 'SELECT id FROM users WHERE email = ?', email).id;
const seller = (name) => one(db, 'SELECT id FROM sellers WHERE name = ?', name).id;
const offer = (titlePrefix, sellerName) => one(db, `SELECT o.id FROM offers o JOIN products p ON p.id = o.product_id
  JOIN sellers s ON s.id = o.seller_id WHERE p.title LIKE ? AND s.name = ?`, titlePrefix + '%', sellerName).id;
const inv = (offerId) => {
  const r = one(db, 'SELECT SUM(on_hand) AS h, SUM(reserved) AS r FROM inventory WHERE offer_id = ?', offerId);
  return [r.h, r.r];
};
const tx = (fn) => transaction(db, fn);

function buy(offerId, qty = 1, { method = 'card', token = 'tok_sim_visa_ok', user = asha, address = ashaAddr } = {}) {
  return tx(() => {
    orders.addToCart(db, user, offerId, qty);
    return orders.placeOrder(db, user, address, method, token);
  });
}

function advance(order, stages, actor = 'ops') {
  tx(() => {
    for (const sh of order.shipments) for (let i = 0; i < stages; i++) orders.advanceShipment(db, sh.id, actor);
  });
  return orders.getOrder(db, order.id);
}

const throwsApp = (fn, status) => assert.throws(fn, (e) => e instanceof AppError && (status === undefined || e.status === status));

beforeEach(() => {
  db = openDatabase(':memory:');
  asha = uid('asha@example.com');
  ashaAddr = one(db, 'SELECT id FROM addresses WHERE user_id = ?', asha).id;
});

describe('search and catalogue', () => {
  test('search ranks relevant in-stock phones first', () => {
    const results = catalog.search(db, 'phone', null, 'relevance', 'Bengaluru');
    for (const r of results.slice(0, 3)) assert.ok(r.category === 'Phones' && !r.title.includes('Charger'), r.title);
    const outOfStock = results.flatMap((r, i) => (r.in_stock ? [] : [i]));
    const inStockPhones = results.flatMap((r, i) => (r.in_stock && r.title.includes('Smartphone') ? [i] : []));
    assert.ok(outOfStock.length && Math.max(...inStockPhones) < Math.min(...outOfStock));
  });

  test('product page shows several sellers and one featured offer', () => {
    const pid = one(db, "SELECT id FROM products WHERE title LIKE 'Orbit Nova X5 5G%'").id;
    const p = catalog.productDetail(db, pid, 'Bengaluru');
    assert.equal(p.offers.length, 3);
    assert.equal(new Set(p.offers.map((o) => o.seller_name)).size, 3);
    const featured = p.offers.filter((o) => o.is_featured);
    assert.equal(featured.length, 1);
    assert.equal(featured[0].condition, 'new');
    assert.ok(featured[0].available > 0);
  });

  test('city-restricted offer is not deliverable elsewhere', () => {
    const pid = one(db, "SELECT id FROM products WHERE title LIKE 'Zenix Fold%'").id;
    assert.equal(catalog.productDetail(db, pid, 'Mumbai').offers[0].deliverable, true);
    assert.equal(catalog.productDetail(db, pid, 'Chennai').offers[0].deliverable, false);
  });
});

describe('seller listings', () => {
  const NEW = {
    title: 'Bassline Max Party Speaker 40W', brand: 'Bassline', category: 'Audio',
    description: 'A big portable party speaker with 40W output and RGB lights.',
    specs: { Output: '40 W' }, images: ['https://example.com/speaker.jpg'], price: '4999',
    quantity: 10, handling_days: 1, fulfilment: 'seller', ships_to: ['ALL'],
  };

  test('new listing is held until approved', () => {
    const sub = tx(() => listings.submit(db, seller('TechBazaar Hub'), { ...NEW }));
    assert.equal(sub.status, 'pending');
    assert.deepEqual(catalog.search(db, 'party'), []);
    tx(() => listings.decide(db, sub.id, true, 'Looks good'));
    const found = catalog.search(db, 'party');
    assert.equal(found.length, 1);
    assert.equal(found[0].featured_offer.price_paise, 499900);
  });

  test('rejected listing never goes live', () => {
    tx(() => {
      const sub = listings.submit(db, seller('TechBazaar Hub'), { ...NEW });
      listings.decide(db, sub.id, false, 'Image is a stock photo');
    });
    assert.deepEqual(catalog.search(db, 'party'), []);
  });

  test('stock change goes live but a big price change waits', () => {
    const sid = seller('TechBazaar Hub');
    const oid = offer('Bassline Mini', 'TechBazaar Hub');
    const base = { offer_id: oid, price: '1499', mrp: '2499', quantity: 77, handling_days: 1, ships_to: ['ALL'] };
    assert.equal(tx(() => listings.submit(db, sid, base)).status, 'approved');
    assert.equal(inv(oid)[0], 77);
    assert.equal(tx(() => listings.submit(db, sid, { ...base, price: '999' })).status, 'pending');
    assert.equal(scalar(db, 'SELECT price_paise FROM offers WHERE id = ?', oid), 149900);
  });

  test('content changes and restricted terms are reviewed', () => {
    const sub = tx(() => listings.submit(db, seller('TechBazaar Hub'), {
      offer_id: offer('Bassline Mini', 'TechBazaar Hub'), price: '1499', quantity: 50,
      title: 'Bassline Mini Bluetooth Speaker replica edition',
    }));
    assert.equal(sub.status, 'pending');
    assert.ok(sub.review_reasons.some((r) => r.includes('title')));
    assert.ok(sub.review_reasons.some((r) => r.includes('restricted')));
  });

  test('invalid listing is rejected with field errors', () => {
    assert.throws(() => listings.submit(db, seller('TechBazaar Hub'), { ...NEW, price: '-5', images: ['ftp://nope'], category: 'Toys' }),
      (e) => e.status === 400 && JSON.stringify(Object.keys(e.details.fields).sort()) === '["category","images","price"]');
  });

  test("seller cannot edit another seller's listing", () => {
    throwsApp(() => listings.submit(db, seller('UrbanCart Retail'),
      { offer_id: offer('Bassline Mini', 'TechBazaar Hub'), price: '1', quantity: 1 }), 403);
  });
});

describe('checkout and orders', () => {
  test('card order end to end', () => {
    const oid = offer('Aeron Book 14', 'TechBazaar Hub');
    const [onHand, reserved] = inv(oid);
    let order = buy(oid, 2).order;
    assert.deepEqual([order.status, order.payment_status, order.fulfilment_status], ['confirmed', 'authorized', 'not_started']);
    assert.equal(order.payment.captured_paise, 0);
    assert.deepEqual(inv(oid), [onHand, reserved + 2]);
    assert.deepEqual(orders.getCart(db, asha).items, []);

    order = advance(order, 3); // picking, packed, shipped
    assert.equal(order.fulfilment_status, 'shipped');
    assert.equal(order.payment_status, 'captured');
    assert.deepEqual(inv(oid), [onHand - 2, reserved]);
    assert.ok(order.shipments[0].tracking_no.startsWith('EQ'));

    order = advance(order, 3); // in transit, out for delivery, delivered
    assert.deepEqual([order.status, order.fulfilment_status], ['completed', 'delivered']);
    const sale = 2 * 5499000;
    const ledger = orders.sellerLedger(db, seller('TechBazaar Hub'));
    assert.equal(ledger.balance_paise, 299900 - 29990 + sale - sale / 10); // includes the seeded earbuds sale
    const notes = all(db, 'SELECT message FROM notifications WHERE user_id = ?', asha).map((n) => n.message);
    assert.ok(notes.some((m) => m.includes('was delivered')));
  });

  test('declined payment releases stock and keeps the cart', () => {
    const oid = offer('Aeron Book 14', 'TechBazaar Hub');
    const before = inv(oid);
    const res = buy(oid, 1, { token: 'tok_sim_declined' });
    assert.equal(res.result, 'payment_failed');
    assert.equal(res.order.payment_status, 'declined');
    assert.equal(res.order.fulfilment_status, 'cancelled');
    assert.deepEqual(inv(oid), before);
    assert.equal(orders.getCart(db, asha).items.length, 1);
  });

  test('checkout revalidates price', () => {
    const oid = offer('Aeron Book 14', 'TechBazaar Hub');
    tx(() => orders.addToCart(db, asha, oid, 1));
    run(db, 'UPDATE offers SET price_paise = 5299000 WHERE id = ?', oid);
    let res = tx(() => orders.placeOrder(db, asha, ashaAddr, 'card', 'tok_sim_visa_ok'));
    assert.equal(res.result, 'issues');
    assert.deepEqual(res.issues.map((i) => i.type), ['price_changed']);
    res = tx(() => orders.placeOrder(db, asha, ashaAddr, 'card', 'tok_sim_visa_ok')); // customer has now seen the new price
    assert.equal(res.result, 'placed');
    assert.equal(res.order.subtotal_paise, 5299000);
  });

  test('checkout revalidates stock and delivery', () => {
    const oid = offer('Zenix Fold', 'UrbanCart Retail');
    const chennai = tx(() => {
      orders.addToCart(db, asha, oid, 2);
      return orders.addAddress(db, asha, { name: 'Asha', line1: '1 Beach Rd', city: 'Chennai', pincode: '600001', phone: '9800000009' });
    });
    run(db, 'UPDATE inventory SET on_hand = 1 WHERE offer_id = ?', oid);
    const res = tx(() => orders.placeOrder(db, asha, chennai, 'card', 'tok_sim_visa_ok'));
    assert.equal(res.result, 'issues');
    assert.deepEqual(res.issues.map((i) => i.type).sort(), ['insufficient_stock', 'not_deliverable']);
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM orders WHERE user_id = ?', asha), 2); // nothing beyond the two seeded orders
  });

  test('order splits across warehouses when needed', () => {
    const oid = offer('Orbit Nova X5 5G', 'Lakshmi Mobiles & Electronics');
    const blr = one(db, "SELECT id FROM warehouses WHERE code = 'BLR1'").id;
    run(db, 'UPDATE inventory SET on_hand = 2 WHERE offer_id = ? AND warehouse_id = ?', oid, blr);
    const order = buy(oid, 5).order;
    const split = order.shipments.map((s) => [s.warehouse_name, s.items.reduce((n, i) => n + i.qty, 0)]).sort();
    assert.deepEqual(split, [['Equidron FC Bengaluru', 2], ['Equidron FC Hyderabad', 3]]);
    assert.equal(order.shipments.reduce((n, s) => n + s.amount_paise, 0), order.total_paise);
  });

  test('cancel before dispatch voids the authorization', () => {
    const oid = offer('Aeron Book 14', 'TechBazaar Hub');
    const before = inv(oid);
    let order = advance(buy(oid, 1).order, 2); // packed, not shipped
    order = tx(() => orders.cancelOrder(db, asha, order.id));
    assert.deepEqual([order.status, order.payment_status], ['cancelled', 'voided']);
    assert.deepEqual(inv(oid), before);
  });

  test('cannot cancel after shipping', () => {
    const order = advance(buy(offer('Aeron Book 14', 'TechBazaar Hub'), 1).order, 3);
    throwsApp(() => orders.cancelOrder(db, asha, order.id), 409);
  });

  test('cash on delivery is collected at delivery', () => {
    let order = buy(offer('Kitchora 750W', 'GreenLeaf Home Store'), 1, { method: 'cod', token: 'cod' }).order;
    assert.equal(order.payment_status, 'cod_pending');
    order = advance(order, 5);
    assert.equal(order.payment_status, 'cod_pending');
    order = advance(order, 1);
    assert.equal(order.payment_status, 'cod_collected');
    assert.equal(order.payment.captured_paise, order.total_paise);
  });

  test('raw card numbers are refused', () => {
    assert.throws(() => buy(offer('Aeron Book 14', 'TechBazaar Hub'), 1, { token: '4111 1111 1111 1111' }),
      (e) => e instanceof AppError && e.message.includes('never accepted'));
  });

  test('seller can only dispatch their own shipments', () => {
    const order = buy(offer('Kitchora 750W', 'GreenLeaf Home Store'), 1).order;
    const sh = order.shipments[0].id;
    throwsApp(() => orders.advanceShipment(db, sh, 'seller', seller('TechBazaar Hub')), 403);
    tx(() => { for (let i = 0; i < 3; i++) orders.advanceShipment(db, sh, 'seller', seller('GreenLeaf Home Store')); });
    throwsApp(() => orders.advanceShipment(db, sh, 'seller', seller('GreenLeaf Home Store')), 403); // carrier stages belong to Equidron
  });
});

describe('returns and settlement', () => {
  const deliveredOrder = () => one(db, "SELECT id FROM orders WHERE user_id = ? AND status = 'completed'", asha).id;

  test('return refunds, restocks and debits the seller', () => {
    let order = orders.getOrder(db, deliveredOrder(), asha);
    const item = order.shipments.flatMap((s) => s.items).find((i) => i.title.startsWith('Sonique'));
    const balBefore = orders.sellerLedger(db, item.seller_id).balance_paise;
    const stockBefore = inv(item.offer_id)[0];
    const refunded = tx(() => {
      const rid = orders.requestReturn(db, asha, order.id, item.id, 1, 'Damaged or defective');
      return orders.receiveReturn(db, rid, true);
    });
    assert.equal(refunded, item.unit_price_paise);
    order = orders.getOrder(db, order.id, asha);
    assert.equal(order.payment_status, 'partially_refunded');
    assert.equal(order.payment.refunded_paise, refunded);
    assert.equal(inv(item.offer_id)[0], stockBefore + 1);
    assert.equal(orders.sellerLedger(db, item.seller_id).balance_paise, balBefore - refunded + Math.round(refunded / 10));
    throwsApp(() => orders.requestReturn(db, asha, order.id, item.id, 1, 'Again'), 409); // already fully returned
  });

  test('items can only be returned after delivery', () => {
    const order = buy(offer('Aeron Book 14', 'TechBazaar Hub'), 1).order;
    throwsApp(() => orders.requestReturn(db, asha, order.id, order.shipments[0].items[0].id, 1, 'Changed my mind'), 409);
  });

  test('grocery is not returnable', () => {
    const order = advance(buy(offer('Malnad Estate', 'GreenLeaf Home Store'), 1).order, 6);
    const item = order.shipments[0].items[0];
    assert.equal(item.returnable, false);
    throwsApp(() => orders.requestReturn(db, asha, order.id, item.id, 1, 'No longer needed'), 409);
  });

  test('settlement pays out positive balances', () => {
    const payouts = tx(() => orders.runSettlement(db));
    assert.deepEqual(payouts.map((p) => p.seller_name).sort(), ['PageTurner Books', 'TechBazaar Hub']);
    for (const p of payouts) assert.equal(orders.sellerLedger(db, p.seller_id).balance_paise, 0);
  });
});

describe('HTTP API', () => {
  let server;
  let base;

  beforeEach(async () => {
    server = createServer(db, { quiet: true });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(() => new Promise((resolve) => server.close(resolve)));

  // A tiny cookie-keeping client.
  function client() {
    const jar = {};
    return async (method, path, body) => {
      const headers = { 'Content-Type': 'application/json' };
      if (Object.keys(jar).length) headers.Cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : method === 'POST' ? '{}' : undefined });
      const set = res.headers.get('set-cookie');
      if (set) {
        const [kv] = set.split(';');
        const [k, v] = kv.split('=');
        if (v) jar[k] = v; else delete jar[k];
      }
      return [res.status, await res.json()];
    };
  }

  test('logins are separated by role', async () => {
    const c = client();
    const creds = { email: 'techbazaar.seller@example.com', password: 'equidron-demo' };
    assert.equal((await c('POST', '/api/shop/login', creds))[0], 403);
    assert.equal((await c('POST', '/api/seller/login', creds))[0], 200);
    assert.equal((await c('GET', '/api/shop/cart'))[0], 401);
    assert.equal((await c('GET', '/api/ops/submissions'))[0], 401);
    assert.equal((await c('GET', '/api/seller/listings'))[0], 200);
  });

  test('customer order flow over HTTP', async () => {
    const shop = client();
    const ops = client();
    assert.equal((await shop('POST', '/api/shop/login', { email: 'rahul@example.com', password: 'equidron-demo' }))[0], 200);
    const [, found] = await shop('GET', '/api/shop/search?q=phone&city=Delhi');
    const [, detail] = await shop('GET', `/api/shop/products/${found.results[0].id}?city=Delhi`);
    const featured = detail.offers.find((o) => o.is_featured);
    await shop('POST', '/api/shop/cart', { offer_id: featured.id, qty: 1 });
    const [, addrs] = await shop('GET', '/api/shop/addresses');
    const [, preview] = await shop('POST', '/api/shop/checkout/preview', { address_id: addrs[0].id });
    assert.equal(preview.ok, true);
    let [status] = await shop('POST', '/api/shop/orders', { address_id: addrs[0].id, payment_method: 'card', payment_token: 'tok_sim_insufficient_funds' });
    assert.equal(status, 402);
    let order;
    [status, order] = await shop('POST', '/api/shop/orders', { address_id: addrs[0].id, payment_method: 'upi', payment_token: 'upi_sim_ok@equidron' });
    assert.equal(status, 201);
    assert.equal(order.payment_status, 'captured');

    await ops('POST', '/api/ops/login', { email: 'ops@example.com', password: 'equidron-demo' });
    for (let i = 0; i < 6; i++) await ops('POST', '/api/ops/shipments/advance-all');
    [, order] = await shop('GET', `/api/shop/orders/${order.id}`);
    assert.deepEqual([order.status, order.fulfilment_status], ['completed', 'delivered']);
    assert.equal((await shop('GET', '/api/shop/orders/1'))[0], 404); // Asha's order is not Rahul's
  });

  test('POST requires JSON', async () => {
    const res = await fetch(base + '/api/shop/login', { method: 'POST', body: 'email=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(res.status, 415);
  });

  test('static pages and placeholder images are served', async () => {
    const page = await fetch(base + '/shop/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Equidron Store/);
    const img = await fetch(base + '/img/p1-1.svg');
    assert.match(img.headers.get('content-type'), /image\/svg\+xml/);
    assert.equal((await fetch(base + '/../app.js')).status, 404);
  });
});
