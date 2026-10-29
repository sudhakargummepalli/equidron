import { readFileSync } from 'node:fs';
// Proposals: the assistant suggests a change, the customer confirms it, and only then does the
// service function run. These tests hold the two halves that matter: proposing changes nothing,
// and confirming runs exactly once and only for the person who owns the proposal.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { handleApi } from '../src/api.js';
import { tool } from '../src/agents/tools.js';
import { settings } from '../src/auth.js';
import { all, one } from '../src/db.js';
import * as orders from '../src/orders.js';
import * as proposals from '../src/proposals.js';
import { openDatabase } from '../src/server.js';

settings.fastHashing = true;
process.env.EQUIDRON_SEED_DEMO = '1';

let db;
let asha;
let rahul;
let confirmedOrder;
before(async () => {
  db = await openDatabase('memory');
  asha = await one(db, "SELECT id, name FROM users WHERE email = 'asha@example.com'");
  rahul = await one(db, "SELECT id, name FROM users WHERE email = 'rahul@example.com'");
  // A fresh COD order: nothing has shipped, so it is cancellable (the seeded one already shipped).
  const addr = await one(db, 'SELECT id FROM addresses WHERE user_id = ? ORDER BY id LIMIT 1', asha.id);
  const offer = await one(db, "SELECT id FROM offers WHERE status = 'active' ORDER BY id LIMIT 1");
  await orders.addToCart(db, asha.id, offer.id, 1);
  const placed = await orders.placeOrder(db, asha.id, addr.id, 'cod');
  confirmedOrder = placed.order;
});
after(async () => { await db?.close(); });

const ctx = (userId) => ({ customerId: userId });

test('propose_cancel writes a card and changes no order', async () => {
  const before = await one(db, 'SELECT status FROM orders WHERE id = ?', confirmedOrder.id);
  const out = await tool('propose_cancel').run(db, ctx(asha.id), { order_id: confirmedOrder.id, reason: 'The customer asked to cancel.' });

  assert.ok(out.proposal_id);
  assert.equal(out.needs_confirmation, true);
  assert.match(out.summary, /Cancel order/);
  // Nothing happened to the order yet.
  assert.equal((await one(db, 'SELECT status FROM orders WHERE id = ?', confirmedOrder.id)).status, before.status);
  const p = await one(db, 'SELECT * FROM proposals WHERE id = ?', out.proposal_id);
  assert.equal(p.status, 'pending');
  assert.equal(p.kind, 'cancel_order');
});

test('confirming the card cancels the order, once', async () => {
  const { proposal_id: id } = await tool('propose_cancel').run(db, ctx(asha.id), { order_id: confirmedOrder.id, reason: 'Asking to cancel.' });
  const out = await proposals.confirm(db, asha.id, id);
  assert.equal(out.status, 'confirmed');
  assert.equal((await one(db, 'SELECT status FROM orders WHERE id = ?', confirmedOrder.id)).status, 'cancelled');

  // A second tap is refused instead of running the service twice.
  await assert.rejects(() => proposals.confirm(db, asha.id, id), /already confirmed/);
  // And the dismissal path cannot undo it.
  assert.equal((await proposals.dismiss(db, asha.id, id)).status, 'dismissed');
});

test('nobody can confirm a proposal that is not theirs', async () => {
  const { proposal_id: id } = await proposals.create(db, asha.id, 'cancel_order', { order_id: confirmedOrder.id }).then((proposalId) => ({ proposal_id: proposalId }));
  await assert.rejects(() => proposals.confirm(db, rahul.id, id), /not found/i);
  const still = await one(db, 'SELECT status FROM proposals WHERE id = ?', id);
  assert.equal(still.status, 'pending');
});

test('a delivered item can be proposed for return, and confirming opens the real return', async () => {
  // A delivered order item is the one case a return is allowed for.
  const delivered = await one(db, `SELECT oi.id AS item_id, oi.order_id, oi.title
                                   FROM order_items oi JOIN orders o ON o.id = oi.order_id
                                   WHERE o.user_id = ? AND o.status = 'completed' ORDER BY oi.id LIMIT 1`, asha.id);
  assert.ok(delivered, 'the sample data has a delivered order');
  const out = await tool('propose_return').run(db, ctx(asha.id), {
    order_id: delivered.order_id, order_item_id: delivered.item_id, qty: 1, reason: 'The item arrived damaged.',
  });
  assert.ok(out.proposal_id);
  assert.match(out.summary, /Return /);

  const result = await proposals.confirm(db, asha.id, out.proposal_id);
  assert.equal(result.status, 'confirmed');
  const ret = await one(db, 'SELECT * FROM returns WHERE id = ?', result.result.return_id);
  assert.equal(Number(ret.order_item_id), Number(delivered.item_id));
  assert.equal(ret.status, 'pickup_scheduled');
});

test('the cart tools work only for a signed-in customer', async () => {
  const offer = await one(db, "SELECT id FROM offers WHERE status = 'active' ORDER BY id LIMIT 1");
  await assert.rejects(() => tool('add_to_cart').run(db, {}, { offer_id: offer.id, reason: 'x' }), /signed in/);
  const added = await tool('add_to_cart').run(db, ctx(asha.id), { offer_id: offer.id, qty: 2, reason: 'Adding what they asked for.' });
  assert.ok(added.lines >= 1);
  const updated = await tool('update_cart').run(db, ctx(asha.id), { offer_id: offer.id, qty: 0, reason: 'Removing it again.' });
  assert.equal(updated.qty, 0);
});

test('the routes list, confirm and dismiss, scoped to the session', async () => {
  const cookies = {};
  const call = async (method, path, body) => {
    const out = await handleApi(db, { method, path, query: new URLSearchParams(), body, cookies });
    if (out.setCookie) {
      const [k, v] = out.setCookie.split(';')[0].split('=');
      if (v) cookies[k] = v; else delete cookies[k];
    }
    return out;
  };
  assert.equal((await call('POST', '/api/shop/login', { email: 'asha@example.com', password: 'equidron-demo' })).status, 200);

  const open = await one(db, 'SELECT id FROM orders WHERE user_id = ? ORDER BY id LIMIT 1', asha.id);
  const created = await proposals.create(db, asha.id, 'cancel_order', { order_id: open.id });
  const list = await call('GET', '/api/shop/proposals');
  assert.equal(list.status, 200);
  assert.ok(list.payload.some((p) => p.id === created));

  const dismissed = await call('POST', `/api/shop/proposals/${created}/dismiss`);
  assert.equal(dismissed.status, 200);
  assert.equal(dismissed.payload.status, 'dismissed');
  // Another customer's proposal id is simply not found through this session.
  const theirs = await proposals.create(db, rahul.id, 'cancel_order', { order_id: open.id });
  assert.equal((await call('POST', `/api/shop/proposals/${theirs}/confirm`)).status, 404);
  assert.equal((await one(db, 'SELECT status FROM proposals WHERE id = ?', theirs)).status, 'pending');
});

test('the chat shows a proposal card wired to confirm and dismiss', () => {
  const html = readFileSync(new URL('../static/common/chat.html', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../static/common/common.js', import.meta.url), 'utf8');
  assert.match(html, /proposal-card/, 'the card is in the chat');
  assert.match(html, /decideProposal\(p, true\)/);
  assert.match(html, /decideProposal\(p, false\)/);
  assert.match(js, /decideProposal = function/, 'the behaviour exists');
  assert.match(js, /\/proposals\/' \+ proposal\.id \+ \(accept \? '\/confirm' : '\/dismiss'\)/);
});
