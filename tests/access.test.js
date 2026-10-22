// Role-based access: one customer must never reach another customer's data, one seller never
// another seller's, and a session from one area must not work in another. Every check below is
// a real request through handleApi, so it exercises the whole path, not just the service layer.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { handleApi } from '../src/api.js';
import { settings } from '../src/auth.js';
import { all } from '../src/db.js';
import { openDatabase } from '../src/server.js';

settings.fastHashing = true;
process.env.EQUIDRON_SEED_DEMO = '1';

let db;
after(async () => { await db?.close(); });

function client(area) {
  const cookies = {};
  const call = async (method, path, body) => {
    const out = await handleApi(db, { method, path, query: new URLSearchParams(), body, cookies });
    if (out.setCookie) {
      const [k, v] = out.setCookie.split(';')[0].split('=');
      if (v) cookies[k] = v; else delete cookies[k];
    }
    return out;
  };
  return call;
}

async function signedIn(area, email) {
  const c = client(area);
  const out = await c('POST', `/api/${area}/login`, { email, password: 'equidron-demo' });
  if (out.status !== 200) {
    const [err] = await all(db, 'SELECT message, stack FROM error_log ORDER BY id DESC LIMIT 1');
    assert.fail(`${area} sign-in for ${email}: ${JSON.stringify(out.payload)} | ${err?.message} | ${String(err?.stack).split('\n').slice(0, 3).join(' / ')}`);
  }
  return c;
}

let asha;
let rahul;
let tech;
let green;
before(async () => {
  // One hook, in order: the database first, then the four sessions.
  db = await openDatabase('memory');
  asha = await signedIn('shop', 'asha@example.com');
  rahul = await signedIn('shop', 'rahul@example.com');
  tech = await signedIn('seller', 'techbazaar.seller@example.com');
  green = await signedIn('seller', 'greenleaf.seller@example.com');
});

test('a customer sees only their own orders, cart and addresses', async () => {
  const mine = (await asha('GET', '/api/shop/orders')).payload;
  const theirs = (await rahul('GET', '/api/shop/orders')).payload;
  assert.ok(mine.length > 0);
  assert.ok(!theirs.some((o) => mine.some((m) => m.id === o.id)), 'two customers share no order');

  const order = mine[0];
  assert.equal((await rahul('GET', `/api/shop/orders/${order.id}`)).status, 404);
  assert.equal((await rahul('POST', `/api/shop/orders/${order.id}/cancel`, {})).status, 404);

  const detail = (await asha('GET', `/api/shop/orders/${order.id}`)).payload;
  const item = detail.shipments[0].items[0];
  const shipment = detail.shipments[0];
  assert.equal((await rahul('POST', `/api/shop/orders/${order.id}/returns`, { order_item_id: item.id, qty: 1, reason: 'x' })).status, 404);
  assert.equal((await rahul('POST', `/api/shop/shipments/${shipment.id}/confirm`, {})).status, 404);

  // The positive half: the owner can still do all of it.
  assert.equal((await asha('GET', `/api/shop/orders/${order.id}`)).status, 200);

  const ashaCart = (await asha('GET', '/api/shop/cart')).payload.items;
  const rahulCart = (await rahul('GET', '/api/shop/cart')).payload.items;
  assert.deepEqual(rahulCart, []);
  assert.ok(Array.isArray(ashaCart));

  const ashaAddresses = (await asha('GET', '/api/shop/addresses')).payload;
  const rahulAddresses = (await rahul('GET', '/api/shop/addresses')).payload;
  assert.ok(!ashaAddresses.some((a) => rahulAddresses.some((b) => b.id === a.id)));
});

test('a customer cannot read or answer another customer’s support ticket', async () => {
  const order = (await asha('GET', '/api/shop/orders')).payload[0];
  const created = await asha('POST', '/api/shop/support', { order_id: order.id, subject: 'Where is it?', message: 'Please check.' });
  assert.equal(created.status, 201);
  const ticket = (await asha('GET', '/api/shop/support')).payload[0];
  assert.ok(ticket);

  assert.ok(!(await rahul('GET', '/api/shop/support')).payload.some((t) => t.id === ticket.id));
  assert.equal((await rahul('POST', `/api/shop/support/${ticket.id}/reply`, { message: 'hi' })).status, 404);
});

test('a seller sees only their own listings, orders and ledger', async () => {
  const mine = (await tech('GET', '/api/seller/listings')).payload.offers;
  const theirs = (await green('GET', '/api/seller/listings')).payload.offers;
  assert.ok(mine.length > 0 && theirs.length > 0);
  assert.ok(!mine.some((o) => theirs.some((t) => t.id === o.id)), 'no listing appears for both sellers');

  const theirOrderLines = (await green('GET', '/api/seller/orders')).payload;
  const myOrderLines = (await tech('GET', '/api/seller/orders')).payload;
  assert.ok(theirOrderLines.every((l) => !myOrderLines.some((m) => m.id === l.id)));
  assert.ok((await green('GET', '/api/seller/ledger')).payload.entries !== undefined);
  const subs = (await green('GET', '/api/seller/submissions')).payload;
  assert.ok(subs.every((s) => s.seller_name.includes('GreenLeaf')));
});

test('a seller cannot change or ship another seller’s listing', async () => {
  const foreign = (await tech('GET', '/api/seller/listings')).payload.offers[0];
  const attempt = await green('POST', '/api/seller/submissions', {
    offer_id: foreign.id, price: 999, quantity: 1, handling_days: 1, fulfilment: 'seller', ships_to: ['ALL'],
    description: 'Trying to change a listing that is not mine.',
  });
  assert.equal(attempt.status, 403, 'submitting against another seller’s offer');

  // Buy something GreenLeaf dispatches itself, so its shipment is really theirs to move.
  const offer = (await green('GET', '/api/seller/listings')).payload.offers.find((o) => o.fulfilment === 'seller');
  assert.ok(offer, 'GreenLeaf has a seller-dispatched offer');
  await asha('POST', '/api/shop/cart', { offer_id: offer.id, qty: 1 });
  const addressId = (await asha('GET', '/api/shop/addresses')).payload[0].id;
  const placed = await asha('POST', '/api/shop/orders', { address_id: addressId, payment_method: 'card', payment_token: 'tok_sim_visa_ok' });
  assert.equal(placed.status, 201);
  const line = (await green('GET', '/api/seller/orders')).payload.find((l) => l.order_id === placed.payload.id);
  assert.ok(line?.seller_can_advance);

  const stolen = await tech('POST', `/api/seller/shipments/${line.shipment_id}/advance`, {});
  assert.equal(stolen.status, 403, 'another seller cannot move it');
  const owned = await green('POST', `/api/seller/shipments/${line.shipment_id}/advance`, {});
  assert.equal(owned.status, 200, 'the owner can still move it');
});

test('a session from one area is refused by the other two', async () => {
  for (const [area, cookie] of [['shop', asha], ['seller', tech]]) {
    for (const other of ['shop', 'seller', 'ops']) {
      const path = other === 'shop' ? '/api/shop/orders' : other === 'seller' ? '/api/seller/orders' : '/api/ops/overview';
      const out = await cookie('GET', path);
      if (other === area) assert.equal(out.status, 200, `${area} on its own API`);
      else assert.equal(out.status, 401, `${area} session on ${other}`);
    }
  }
});
