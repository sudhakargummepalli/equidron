// Notifications: the customer hears about every state their order passes through, and the seller
// hears when a listing is added, edited or decided. Each one becomes one row in the outbox, which
// is what the Outbox page shows until a real email provider is connected.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { settings } from '../src/auth.js';
import { all, one } from '../src/db.js';
import { emit } from '../src/events.js';
import * as emails from '../src/emails.js';
import { dispatch, work } from '../src/jobs.js';
import * as listings from '../src/listings.js';
import { openDatabase } from '../src/server.js';

settings.fastHashing = true;
process.env.EQUIDRON_SEED_DEMO = '1';

let db;
let asha;
let seller;
let offer;
let order;
let shipment;
before(async () => {
  db = await openDatabase('memory');
  asha = await one(db, "SELECT id, email, name FROM users WHERE email = 'asha@example.com'");
  seller = await one(db, `SELECT s.id, u.email, u.name FROM sellers s JOIN users u ON u.id = s.user_id
                          WHERE u.email = 'techbazaar.seller@example.com'`);
  offer = await one(db, 'SELECT * FROM offers WHERE seller_id = ? ORDER BY id LIMIT 1', seller.id);
  order = await one(db, `SELECT id, total_paise FROM orders WHERE user_id = ? AND status <> 'cancelled' ORDER BY id LIMIT 1`, asha.id);
  shipment = await one(db, `SELECT id, status, order_id FROM shipments WHERE order_id = ? AND status <> 'pending' ORDER BY id LIMIT 1`, order.id);
});
after(async () => { await db?.close(); });

// Run the queue: events become jobs, jobs become outbox rows.
const drain = async () => { await dispatch(db); await work(db, { seconds: 30 }); };
const inboxFor = async (address) => await all(db, 'SELECT subject, body FROM outbox WHERE to_address = ? ORDER BY id', address);
const subjectsFor = async (address) => (await inboxFor(address)).map((m) => m.subject);

test('the wording is fixed for every courier stage', () => {
  for (const stage of ['packed', 'shipped', 'in_transit', 'out_for_delivery', 'delivered']) {
    assert.ok(emails.STAGE_WORDS[stage], `no wording for ${stage}`);
  }
  // 'pending' is deliberately silent: the confirmation already said the order was received.
  assert.equal(emails.STAGE_WORDS.pending, undefined);
});

test('a placed order gets a confirmation, and the payment gets its own email', async () => {
  await emit(db, 'order.placed', 'order', order.id, { total_paise: order.total_paise, payment_method: 'card', shipments: 1 });
  await emit(db, 'payment.captured', 'order', order.id, { amount_paise: order.total_paise, method: 'upi' });
  await drain();

  const messages = await inboxFor(asha.email);
  const confirmation = messages.find((m) => m.subject === `Your Equidron order #${order.id} is confirmed`);
  assert.ok(confirmation, 'confirmation email');
  assert.match(confirmation.body, /Items: \d+/);
  assert.match(confirmation.body, /Total: ₹/);
  assert.ok(messages.some((m) => m.subject === `Payment received for order #${order.id}`), 'payment email');
});

test('each shipment stage emails the customer with its tracking and expected date', async () => {
  await emit(db, 'shipment.status_changed', 'shipment', shipment.id, { order_id: shipment.order_id, from: 'packed', to: shipment.status });
  await drain();

  const messages = await inboxFor(asha.email);
  const match = messages.find((m) => m.subject === `${emails.STAGE_WORDS[shipment.status]} — order #${order.id}`);
  assert.ok(match, `an email for stage ${shipment.status}`);
  if (shipment.tracking_no) assert.match(match.body, new RegExp(String(shipment.tracking_no)));
});

test('two stage changes sent in one tick produce two different emails, not the same one twice', async () => {
  // The row is already delivered; the events still say packed and shipped, and the emails must
  // follow the events. Reading the row's status twice produced a duplicate in the live run.
  const before = (await subjectsFor(asha.email)).length;
  await emit(db, 'shipment.status_changed', 'shipment', shipment.id, { order_id: shipment.order_id, from: 'picking', to: 'packed' });
  await emit(db, 'shipment.status_changed', 'shipment', shipment.id, { order_id: shipment.order_id, from: 'packed', to: 'shipped' });
  await drain();

  const added = (await subjectsFor(asha.email)).slice(before);
  assert.equal(added.length, 2, 'exactly two emails');
  assert.deepEqual(added.map((s) => s.replace(` — order #${order.id}`, '')).sort(),
    [emails.STAGE_WORDS.packed, emails.STAGE_WORDS.shipped].sort());
});

test('a cancelled order emails the customer', async () => {
  await emit(db, 'order.cancelled', 'order', order.id, { by: 'customer' });
  await drain();
  assert.ok((await subjectsFor(asha.email)).includes(`Order #${order.id} was cancelled`));
});

test('adding or editing a listing emails the seller, and so does the decision', async () => {
  const before = (await subjectsFor(seller.email)).length;
  // No content change and the same price: this is approved immediately, without a reviewer.
  const sub = await listings.submit(db, seller.id, {
    offer_id: offer.id, price: offer.price_paise / 100, quantity: 4, ships_to: ['ALL'],
  });
  await drain();

  const messages = await inboxFor(seller.email);
  assert.equal(messages.length, before + 2, 'one receipt and one decision');
  assert.ok(messages.some((m) => /^Your update ".+" is live$/.test(m.subject)), 'the receipt says it is live');
  assert.ok(messages.some((m) => /^Listing approved: /.test(m.subject)), 'the decision email');
  assert.equal(sub.status, 'approved');
});

test('a held listing says it is being reviewed, and a rejection carries the reason', async () => {
  // Changing the title is a content change, so a person must look at it.
  const held = await listings.submit(db, seller.id, {
    offer_id: offer.id, price: offer.price_paise / 100, quantity: 4, ships_to: ['ALL'],
    title: `${offer.title} — updated`,
  });
  await drain();
  const reviewed = (await inboxFor(seller.email)).find((m) => /is being reviewed$/.test(m.subject));
  assert.ok(reviewed, 'the receipt says it is being reviewed');
  assert.match(reviewed.body, /in review/i);

  await listings.decide(db, held.id, false, 'The title does not match the product.');
  await drain();
  const rejected = (await inboxFor(seller.email)).find((m) => /^Listing rejected: /.test(m.subject));
  assert.ok(rejected, 'a rejection email');
  assert.match(rejected.body, /The title does not match the product\./);
});

test('dispatching twice does not send the same email twice', async () => {
  const count = (await inboxFor(asha.email)).length;
  await dispatch(db);
  await dispatch(db);
  await work(db, { seconds: 10 });
  assert.equal((await inboxFor(asha.email)).length, count);
});
