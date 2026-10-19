// Bank-statement payment checks: the statement reader, each matching rule, the order
// flow and the checkout API. Uses the bundled FICTIONAL sample statement.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { settings } from '../src/auth.js';
import { one, transaction } from '../src/db.js';
import { AppError } from '../src/errors.js';
import * as orders from '../src/orders.js';
import { provider } from '../src/payments.js';
import { createServer, openDatabase } from '../src/server.js';
import { checkReference, loadStatement, parseCsv, readStatement } from '../src/statement.js';

settings.fastHashing = true; // cheap password hashing, so the sample accounts are quick to create
process.env.EQUIDRON_SEED_DEMO = '1'; // the sample accounts sign in with the shared demo password

let db;
let asha;
let ashaAddr;
let bassline; // TechBazaar's Bassline Mini at Rs 1,499 (free delivery, so the order total is 1,499)
before(async () => {
  db = await openDatabase('memory');
  asha = (await one(db, "SELECT id FROM users WHERE email = 'asha@example.com'")).id;
  ashaAddr = (await one(db, 'SELECT id FROM addresses WHERE user_id = ?', asha)).id;
  bassline = (await one(db, `SELECT o.id FROM offers o JOIN products p ON p.id = o.product_id JOIN sellers s ON s.id = o.seller_id
                             WHERE p.title LIKE 'Bassline Mini%' AND s.name = 'TechBazaar Hub'`)).id;
});
after(() => db.close());

const rupees = orders.inr;
const buy = (ref, offerId = bassline) => transaction(db, async () => {
  await orders.addToCart(db, asha, offerId, 1);
  return orders.placeOrder(db, asha, ashaAddr, 'bank', ref);
});

test('reads a CSV with quoted commas and finds columns by name', () => {
  assert.deepEqual(parseCsv('a,"b, c",d\n1,"say ""hi""",3\n'), [['a', 'b, c', 'd'], ['1', 'say "hi"', '3']]);
  const rows = readStatement('Status,Reference No (UTR),Credit (INR)\nSUCCESS, ab12cd34 ,"1,499.00"\n');
  assert.deepEqual(rows, [{ ref: 'AB12CD34', creditPaise: 149900, debitPaise: 0, status: 'SUCCESS', narration: '' }]);
  assert.throws(() => readStatement('Date,Amount\n1,2\n'), /Reference/);
});

test('each statement rule gives the right answer', async () => {
  const rows = await loadStatement({ url: '' });
  const code = (ref, paise) => { const r = checkReference(rows, ref, paise, rupees); return r.ok ? 'ok' : r.code; };
  assert.equal(code('629104857312', 149900), 'ok');
  assert.equal(code(' smpln52026101100481 ', 5499000), 'ok'); // NEFT, case and spaces ignored
  assert.equal(code('629313377021', 649900), 'payment_failed');
  assert.equal(code('731946150903', 2799900), 'payment_pending');
  assert.equal(code('629515523370', 329900), 'payment_reversed');
  assert.equal(code('629313380456', 109900), 'amount_mismatch');
  assert.equal(code('629104857312', 150000), 'amount_mismatch');
  assert.equal(code('000000000000', 100), 'reference_not_found');
  assert.equal(code('RFD731845092266', 299900), 'reference_not_found'); // a refund paid out is not a payment in
});

test('a Google Sheet link is fetched, cached for 30 seconds, and a failure is a clear 503', async () => {
  let calls = 0;
  const csv = 'Reference,Credit,Status\nX1Y2Z3,10.00,SUCCESS\n';
  const fetchFn = async () => { calls++; return new Response(csv); };
  const url = 'https://docs.google.com/spreadsheets/d/e/sample/pub?output=csv';
  assert.equal((await loadStatement({ url, fetchFn }))[0].ref, 'X1Y2Z3');
  await loadStatement({ url, fetchFn });
  assert.equal(calls, 1);
  const down = async () => new Response('nope', { status: 500 });
  await assert.rejects(loadStatement({ url: `${url}&other`, fetchFn: down }), (e) => e instanceof AppError && e.status === 503);
});

test('card numbers are refused as references; bank references are accepted', () => {
  assert.throws(() => provider.checkToken('bank', '4111 1111 1111 1111'), /card number/);
  assert.throws(() => provider.checkToken('bank', 'abc'), /6-30 letters or digits/);
  assert.equal(provider.checkToken('bank', ' smpln52026101100481 '), 'SMPLN52026101100481');
  assert.equal(provider.checkToken('bank', '629104857312'), '629104857312');
});

test('a matching payment confirms the order; the same reference cannot pay twice', async () => {
  const first = await buy('629104857312');
  assert.equal(first.result, 'placed');
  assert.equal(first.order.payment_status, 'captured');
  assert.equal(first.order.payment.captured_paise, 149900);
  assert.match(first.order.payment.instrument, /629104857312/);

  const again = await buy('629104857312');
  assert.equal(again.result, 'payment_failed');
  assert.match(again.order.payment.decline_reason, new RegExp(`already used for order #${first.order.id}`));
  assert.equal((await orders.getCart(db, asha)).items.length, 1); // cart kept for another try
  await transaction(db, () => orders.setCartQty(db, asha, bassline, 0));
});

test('wrong amount, failed, pending and reversed payments are declined', async () => {
  for (const [ref, reason] of [['629313380456', /was ₹1,000.00, but this order is ₹1,499.00/], ['629313377021', /failed at the bank/],
    ['731946150903', /still pending/], ['629515523370', /reversed/], ['999999999999', /No payment with reference/]]) {
    const res = await buy(ref);
    assert.equal(res.result, 'payment_failed', ref);
    assert.match(res.order.payment.decline_reason, reason);
    await transaction(db, () => orders.setCartQty(db, asha, bassline, 0));
  }
});

test('cancelling a bank-transfer order refunds it', async () => {
  const kettle = (await one(db, "SELECT o.id FROM offers o JOIN products p ON p.id = o.product_id WHERE p.title LIKE 'Kitchora 1.5L%'")).id;
  const placed = await buy('629414402818', kettle);
  assert.equal(placed.result, 'placed');
  const cancelled = await transaction(db, () => orders.cancelOrder(db, asha, placed.order.id));
  assert.equal(cancelled.payment_status, 'refunded');
  assert.equal(cancelled.payment.refunded_paise, 89900);
  // A refunded payment still counts as used: it cannot pay for a new order.
  const reuse = await buy('629414402818', kettle);
  assert.equal(reuse.result, 'payment_failed');
  await transaction(db, () => orders.setCartQty(db, asha, kettle, 0));
});

test('checkout over HTTP checks the reference and explains a decline', async () => {
  const server = createServer(db, { quiet: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let cookie = '';
    const call = async (method, path, body) => {
      const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body ?? {}) });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return [res.status, await res.json()];
    };
    await call('POST', '/api/shop/login', { email: 'rahul@example.com', password: 'equidron-demo' });
    const [, addrs] = await fetch(`${base}/api/shop/addresses`, { headers: { Cookie: cookie } }).then(async (r) => [r.status, await r.json()]);
    const shoes = (await one(db, "SELECT o.id FROM offers o JOIN products p ON p.id = o.product_id WHERE p.title LIKE 'Stride Runner%'")).id;
    await call('POST', '/api/shop/cart', { offer_id: shoes, qty: 1 });
    const order = { address_id: addrs[0].id, payment_method: 'bank' };
    const [bad, declined] = await call('POST', '/api/shop/orders', { ...order, payment_token: '629104861175' });
    assert.equal(bad, 402);
    assert.match(declined.error, /couldn't confirm your payment: Payment 629104861175 was ₹18,999.00, but this order is ₹2,499.00/);
    const [ok, placed] = await call('POST', '/api/shop/orders', { ...order, payment_token: '629616645108' });
    assert.equal(ok, 201);
    assert.equal(placed.payment_status, 'captured');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
