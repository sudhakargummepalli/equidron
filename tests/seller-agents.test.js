// Phase 7: the seller agents' tool rules. The price band belongs to the seller: inside it the
// agent may move a price, outside it the tool refuses (never clamps), and the band can be set only
// through the seller's own service call. No tool may reach another seller's listing.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { getAgent } from '../src/agents/agents.js';
import { owns, tool } from '../src/agents/tools.js';
import { settings } from '../src/auth.js';
import { all, one } from '../src/db.js';
import * as listings from '../src/listings.js';
import { openDatabase } from '../src/server.js';

settings.fastHashing = true;
process.env.EQUIDRON_SEED_DEMO = '1';

let db;
let techbazaar;
let greenleaf;
let offer;
before(async () => {
  db = await openDatabase('memory');
  // The two seeded sellers: one owns the offer under test, the other must never see it.
  techbazaar = await one(db, `SELECT s.id FROM sellers s JOIN users u ON u.id = s.user_id
                              WHERE u.email = 'techbazaar.seller@example.com'`);
  greenleaf = await one(db, `SELECT s.id FROM sellers s JOIN users u ON u.id = s.user_id
                             WHERE u.email = 'greenleaf.seller@example.com'`);
  offer = await one(db, 'SELECT * FROM offers WHERE seller_id = ? ORDER BY id LIMIT 1', techbazaar.id);
  assert.ok(offer, 'the sample seller has an offer');
});
after(async () => { await db?.close(); });

test('both seller agents start switched off, at L1', async () => {
  for (const id of ['catalog_builder', 'pricing_copilot']) {
    const agent = await getAgent(db, id);
    assert.equal(agent.enabled, false, `${id} is off`);
    assert.equal(agent.autonomy_level, 1, `${id} is in shadow`);
  }
  // The pricing agent holds a write tool, and no money tool.
  assert.ok(owns('pricing_copilot', 'set_listing_price'));
  assert.ok(!owns('pricing_copilot', 'refund_return'));
  // The catalogue agent only reads.
  assert.ok(owns('catalog_builder', 'draft_listing'));
  assert.ok(!owns('catalog_builder', 'set_listing_price'));
});

test('a price without a band is refused, and nothing changes', async () => {
  const setPrice = tool('set_listing_price');
  await assert.rejects(() => setPrice.run(db, { sellerId: techbazaar.id }, {
    offer_id: offer.id, price_paise: 500_000, reason: 'Cheaper for the weekend.',
  }), /no price band/);
  assert.equal(Number((await one(db, 'SELECT price_paise FROM offers WHERE id = ?', offer.id)).price_paise), Number(offer.price_paise));
});

test('the band is set by the seller, and must contain the current price', async () => {
  const current = Number(offer.price_paise);
  await assert.rejects(() => listings.setPriceBand(db, techbazaar.id, offer.id, {
    floorPaise: current + 1000, ceilingPaise: current + 5000, autoPricing: true,
  }), /must sit inside the band/);
  await assert.rejects(() => listings.setPriceBand(db, techbazaar.id, offer.id, {
    floorPaise: current, ceilingPaise: current - 1000, autoPricing: true,
  }), /minimum price cannot be above/);

  const band = await listings.setPriceBand(db, techbazaar.id, offer.id, {
    floorPaise: Math.round(current * 0.9), ceilingPaise: Math.round(current * 1.1), autoPricing: true,
  });
  assert.equal(Number(band.price_floor_paise), Math.round(current * 0.9));
  assert.equal(band.auto_pricing, true);
});

test('a price outside the band is refused, not clamped', async () => {
  const setPrice = tool('set_listing_price');
  const o = await one(db, 'SELECT * FROM offers WHERE id = ?', offer.id);
  const tooLow = Number(o.price_floor_paise) - 1;
  await assert.rejects(() => setPrice.run(db, { sellerId: techbazaar.id }, {
    offer_id: offer.id, price_paise: tooLow, reason: 'Trying to undercut.',
  }), /outside the seller’s band/);
  assert.equal(Number((await one(db, 'SELECT price_paise FROM offers WHERE id = ?', offer.id)).price_paise), Number(o.price_paise));
});

test('a price inside the band goes through the normal submission rules', async () => {
  const o = await one(db, 'SELECT * FROM offers WHERE id = ?', offer.id);
  const inside = Number(o.price_floor_paise) + 100;
  const out = await tool('set_listing_price').run(db, { sellerId: techbazaar.id }, {
    offer_id: offer.id, price_paise: inside, reason: 'Small drop inside the band.',
  });
  assert.equal(out.status, 'approved', 'a small change inside the band is applied at once');
  assert.equal(Number((await one(db, 'SELECT price_paise FROM offers WHERE id = ?', offer.id)).price_paise), inside);
  // The submission is on record, like any other listing change.
  assert.ok(await one(db, 'SELECT 1 AS x FROM submissions WHERE id = ?', out.submission_id));
});

test('automatic pricing off means the agent leaves the price alone', async () => {
  await listings.setPriceBand(db, techbazaar.id, offer.id, {
    floorPaise: 100_000, ceilingPaise: 10_000_000, autoPricing: false,
  });
  await assert.rejects(() => tool('set_listing_price').run(db, { sellerId: techbazaar.id }, {
    offer_id: offer.id, price_paise: 200_000, reason: 'Should not happen.',
  }), /Automatic pricing is switched off/);
});

test('no seller can reach another seller’s listing, through any of the tools', async () => {
  const ctx = { sellerId: greenleaf.id };
  await assert.rejects(() => tool('get_listing').run(db, ctx, { offer_id: offer.id }), /another seller/);
  await assert.rejects(() => tool('set_listing_price').run(db, ctx, {
    offer_id: offer.id, price_paise: 100_000, reason: 'Trying another seller.',
  }), /another seller/);
  // Without a seller in the context (a customer session, say) every tool refuses.
  await assert.rejects(() => tool('get_listing').run(db, {}, { offer_id: offer.id }), /Seller Central/);
});

test('the catalogue draft is checked against the real rules and writes nothing', async () => {
  const draft = tool('draft_listing');
  const bad = await draft.run(db, { sellerId: techbazaar.id }, { title: 'x', price: 10 });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.title, 'the title error is reported');
  assert.ok(bad.errors.description, 'the description error is reported');

  const good = await draft.run(db, { sellerId: techbazaar.id }, {
    title: 'Sample USB-C Charger 65W', brand: 'Sample', category: 'Audio', description: 'A compact 65 watt USB-C charger with two ports and a braided cable.',
    price: 2499, quantity: 10, specs: { Ports: '2' }, images: ['/img/p10-1.svg'], ships_to: ['ALL'], fulfilment: 'equidron',
  });
  assert.equal(good.valid, true, JSON.stringify(good.errors));
  assert.equal(good.draft.price_paise, 249900);
  // Nothing was created by the draft.
  assert.equal(await one(db, "SELECT 1 AS x FROM products WHERE title = 'Sample USB-C Charger 65W'"), null);
});

test('low stock lists only that seller’s offers', async () => {
  const rows = await tool('low_stock_listings').run(db, { sellerId: techbazaar.id }, { at_or_below: 1_000_000 });
  const ids = rows.map((r) => r.offer_id);
  const mine = (await all(db, 'SELECT id FROM offers WHERE seller_id = ?', techbazaar.id)).map((o) => Number(o.id));
  assert.ok(rows.length > 0);
  for (const id of ids) assert.ok(mine.includes(id), `offer ${id} belongs to this seller`);
});
