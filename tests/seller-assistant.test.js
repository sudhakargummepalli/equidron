// Seller Central assistant tests, with a scripted stand-in for the Claude client.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { settings, userForToken, login } from '../src/auth.js';
import { one } from '../src/db.js';
import { answerSeller } from '../src/seller-assistant.js';
import { createServer, openDatabase } from '../src/server.js';

settings.pbkdf2Rounds = 1000;

let db;
const sellerUser = async (email) => userForToken(db, await login(db, email, 'equidron-demo', 'seller'), 'seller');
let techbazaar;
let greenleaf;
before(async () => {
  db = await openDatabase('memory');
  techbazaar = await sellerUser('techbazaar.seller@example.com');
  greenleaf = await sellerUser('greenleaf.seller@example.com');
});
after(() => db.close());

// Runs one question where the model calls `tool` with `input`, then returns the tool result
// the model saw and the final answer object.
async function lookup(user, tool, input, replyFrom = () => 'ok') {
  let seen;
  const client = {
    calls: 0,
    messages: {
      async create(params) {
        client.calls++;
        if (client.calls === 1) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name: tool, input }] };
        seen = params.messages.at(-1).content[0];
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: replyFrom(JSON.parse(seen.content)) }] };
      },
    },
  };
  const out = await answerSeller(db, { user }, [{ role: 'user', content: 'question' }], { client });
  return { result: JSON.parse(seen.content), isError: seen.is_error, out };
}

test("lists only the seller's own listings and links the ones it names", async () => {
  const { result, out } = await lookup(techbazaar, 'my_listings', { query: 'bassline' }, (r) => `Your ${r.listings[0].title} has ${r.listings[0].stock_available} in stock.`);
  assert.equal(result.listings.length, 1);
  const own = await one(db, `SELECT o.id FROM offers o JOIN products p ON p.id = o.product_id
                             WHERE p.title LIKE 'Bassline Mini%' AND o.seller_id = ?`, techbazaar.seller_id);
  assert.equal(result.listings[0].listing_id, own.id);
  assert.deepEqual(out.products, [{ id: own.id, title: result.listings[0].title }]);

  const theirs = await lookup(greenleaf, 'my_listings', { query: 'bassline' });
  assert.equal(theirs.result.listings.length, 0); // GreenLeaf doesn't sell it
});

test('explains why a submission is held for review', async () => {
  const { result } = await lookup(techbazaar, 'my_submissions', { status: 'pending' });
  const kestrel = result.find((s) => s.title.startsWith('Kestrel K20'));
  assert.ok(kestrel, 'the seeded new product is pending');
  assert.match(kestrel.held_because.join(' '), /New products are reviewed/);
});

test('shows which self-ship orders the seller must act on', async () => {
  const { result } = await lookup(greenleaf, 'my_orders', { only_open: true });
  assert.ok(result.length > 0);
  assert.ok(result.every((i) => i.item && i.order_id));
  // TechBazaar sees none of GreenLeaf's order lines.
  const other = await lookup(techbazaar, 'my_orders', { only_open: true });
  assert.ok(other.result.every((i) => !result.some((g) => g.order_id === i.order_id && g.item === i.item)));
});

test('compares offers and marks the seller\'s own', async () => {
  const pid = (await one(db, "SELECT id FROM products WHERE title LIKE 'Orbit Nova X5 5G%'")).id;
  const { result } = await lookup(techbazaar, 'compare_offers', { product_id: pid });
  assert.ok(result.length >= 2);
  assert.equal(result.filter((o) => o.yours).length, 1);
});

test('reports the balance from the ledger', async () => {
  const { result } = await lookup(techbazaar, 'my_payments', {});
  assert.match(result.unsettled_balance, /₹/);
});

test('spoken questions ask for a short reply that reads well aloud', async () => {
  const systems = [];
  const client = { messages: { async create(p) { systems.push(p.system); return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }; } } };
  const ask = [{ role: 'user', content: 'what is my balance' }];
  await answerSeller(db, { user: techbazaar, voice: true }, ask, { client });
  await answerSeller(db, { user: techbazaar }, ask, { client });
  assert.match(systems[0], /asked this by voice/);
  assert.doesNotMatch(systems[1], /by voice/);
});

test('the seller chat endpoint needs a seller session', async () => {
  const server = createServer(db, { quiet: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const post = (cookie) => fetch(`${base}/api/seller/assistant`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal((await post()).status, 401);
    // A customer's session cookie is for /api/shop only; even sent here it is not a seller session.
    const customer = await login(db, 'asha@example.com', 'equidron-demo', 'customer');
    assert.equal((await post(`eq_seller=${customer}`)).status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
