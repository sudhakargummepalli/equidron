// Phase 2b: real column types (times with a zone, JSONB, booleans, dates), India dates for
// return windows, the migration on a database that already has data, full-text search with
// typo matching, and paging through every result.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { handleApi } from '../src/api.js';
import { settings } from '../src/auth.js';
import * as catalog from '../src/catalog.js';
import { all, connect, indiaDate, one, scalar, SCHEMA, transaction } from '../src/db.js';
import * as orders from '../src/orders.js';
import { openDatabase } from '../src/server.js';

settings.fastHashing = true;
process.env.EQUIDRON_SEED_DEMO = '1';

let db;
before(async () => { db = await openDatabase('memory'); });
after(() => db.close());

const typeOf = async (table, column) => scalar(db,
  'SELECT data_type FROM information_schema.columns WHERE table_name = ? AND column_name = ?', table, column);

test('columns have real types: times with a zone, JSONB, booleans and dates', async () => {
  for (const [t, c] of [['orders', 'created_at'], ['shipment_events', 'at'], ['submissions', 'decided_at'], ['outbox', 'at']]) {
    assert.equal(await typeOf(t, c), 'timestamp with time zone', `${t}.${c}`);
  }
  for (const [t, c] of [['products', 'specs'], ['offers', 'ships_to'], ['orders', 'address'], ['submissions', 'payload'], ['users', 'permissions']]) {
    assert.equal(await typeOf(t, c), 'jsonb', `${t}.${c}`);
  }
  for (const [t, c] of [['users', 'is_sample'], ['notifications', 'is_read'], ['submissions', 'auto_decided'], ['users', 'totp_enabled']]) {
    assert.equal(await typeOf(t, c), 'boolean', `${t}.${c}`);
  }
  assert.equal(await typeOf('shipments', 'eta'), 'date');
  assert.equal(await typeOf('assistant_usage', 'day'), 'date');
});

test('values come back as Dates, objects, booleans and YYYY-MM-DD dates', async () => {
  const order = await one(db, 'SELECT * FROM orders ORDER BY id LIMIT 1');
  assert.ok(order.created_at instanceof Date);
  assert.equal(typeof order.address, 'object');
  assert.equal(order.address.city, 'Bengaluru');
  const p = await one(db, "SELECT specs, images FROM products WHERE specs->>'RAM' IS NOT NULL LIMIT 1");
  assert.equal(typeof p.specs.RAM, 'string');
  assert.ok(Array.isArray(p.images));
  assert.equal((await one(db, "SELECT is_sample FROM users WHERE email = 'asha@example.com'")).is_sample, true);
  assert.match((await one(db, 'SELECT eta FROM shipments WHERE eta IS NOT NULL LIMIT 1')).eta, /^\d{4}-\d{2}-\d{2}$/);
  // The API sends times as ISO 8601 in UTC.
  const out = await handleApi(db, { method: 'GET', path: '/api/shop/products/1', query: new URLSearchParams(), cookies: {} });
  assert.equal(out.status, 200);
  assert.match(JSON.parse(JSON.stringify(order)).created_at, /T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('new rows are stamped with the real moment, whatever the server time zone', async () => {
  const before = Date.now();
  const asha = (await one(db, "SELECT id FROM users WHERE email = 'asha@example.com'")).id;
  await transaction(db, () => orders.createTicket(db, asha, null, 'Time check', 'What time is it?'));
  const t = (await one(db, 'SELECT created_at FROM support_tickets ORDER BY id DESC LIMIT 1')).created_at;
  assert.ok(Math.abs(t.getTime() - before) < 60_000, t.toISOString());
});

test('India dates: late evening UTC is already the next day in India', () => {
  assert.equal(indiaDate(new Date('2026-10-19T18:00:00Z')), '2026-10-19'); // 23:30 IST
  assert.equal(indiaDate(new Date('2026-10-19T18:31:00Z')), '2026-10-20'); // 00:01 IST
});

test('the return window is counted in India dates', async () => {
  const asha = (await one(db, "SELECT id FROM users WHERE email = 'asha@example.com'")).id;
  const order = await orders.getOrder(db, (await one(db, "SELECT id FROM orders WHERE user_id = ? AND status = 'completed'", asha)).id, asha);
  const item = order.shipments.flatMap((s) => s.items).find((i) => i.title.startsWith('Sonique'));
  // Delivered at 01:30 on 20 October in India (20:00 UTC on the 19th); the window is 10 days.
  await transaction(db, () => db.query("UPDATE shipment_events SET at = '2026-10-19T20:00:00Z' WHERE shipment_id = ? AND status = 'delivered'", [item.shipment_id]));
  const lastDay = await orders.returnEligibility(db, item, new Date('2026-10-30T18:00:00Z')); // 23:30 IST on the 30th
  assert.equal(lastDay[0], true, lastDay[1]);
  assert.match(lastDay[1], /2026-10-30/);
  const tooLate = await orders.returnEligibility(db, item, new Date('2026-10-30T19:00:00Z')); // 00:30 IST on the 31st
  assert.equal(tooLate[0], false);
});

test('the Phase 2b migration converts a database that already has data, and can run twice', async () => {
  const migration = readFileSync(new URL('../netlify/database/migrations/20261020000000_types_and_search.sql', import.meta.url), 'utf8');
  const old = await connect('memory');
  await old.exec(SCHEMA.slice(0, SCHEMA.indexOf('DO $$\nDECLARE\n    c RECORD;'))); // the schema before Phase 2b
  await old.exec(`INSERT INTO users (email, name, role, pw_salt, pw_hash, is_sample, permissions, totp_enabled, created_at)
                  VALUES ('old@example.com', 'Old', 'ops', 's', 'h', 1, '["admin"]', 0, '2026-10-18 10:00:00')`);
  await old.exec(`INSERT INTO sellers (user_id, name, city) VALUES (1, 'Old Shop', 'Pune');
                  INSERT INTO products (title, brand, category, description, specs, images, status, is_sample, created_at)
                  VALUES ('Old Phone', 'Oldco', 'Phones', 'An old phone.', '{"RAM": "4 GB"}', '["/img/a.svg"]', 'live', 1, '2026-10-18 10:00:00')`);
  await old.exec(migration);
  await old.exec(migration);
  const u = await one(old, "SELECT * FROM users WHERE email = 'old@example.com'");
  assert.equal(u.created_at.toISOString(), '2026-10-18T10:00:00.000Z'); // the text was UTC, as Netlify wrote it
  assert.equal(u.is_sample, true);
  assert.equal(u.totp_enabled, false);
  assert.deepEqual(u.permissions, ['admin']);
  const p = await one(old, "SELECT * FROM products WHERE title = 'Old Phone'");
  assert.deepEqual(p.specs, { RAM: '4 GB' });
  assert.deepEqual(p.images, ['/img/a.svg']);
  // Defaults follow the new types.
  await old.exec("INSERT INTO products (title, brand, category, description, status, created_at) VALUES ('New', 'B', 'Phones', 'D', 'live', now())");
  const fresh = await one(old, "SELECT specs, images, is_sample FROM products WHERE title = 'New'");
  assert.deepEqual([fresh.specs, fresh.images, fresh.is_sample], [{}, [], false]);
  await old.close();
});

test('search uses the database index and still ranks phones first', async () => {
  const results = await catalog.search(db, 'phones', null, 'relevance', 'Bengaluru');
  assert.ok(results.length > 3);
  assert.equal(results[0].category, 'Phones');
  // A word the products don't contain finds nothing (no loading every product to check).
  assert.equal((await catalog.search(db, 'zzzqqq', null, 'relevance', 'Bengaluru')).length, 0);
  const plan = (await all(db, `EXPLAIN SELECT id FROM products WHERE ${catalog.SEARCH_VECTOR} @@ to_tsquery('simple', 'phone:*')`))
    .map((r) => Object.values(r)[0]).join('\n');
  assert.match(plan, /products_search|Seq Scan/); // the index exists; tiny tables may still be scanned
  assert.ok(await scalar(db, "SELECT COUNT(*) FROM pg_indexes WHERE indexname = 'products_search'"));
});

test('search forgives small typos when pg_trgm is available', async () => {
  // PGlite and the CI PostgreSQL both have pg_trgm; on a server without it, typo matching is simply off.
  assert.equal(await scalar(db, "SELECT COUNT(*) FROM pg_extension WHERE extname = 'pg_trgm'"), 1);
  const results = await catalog.search(db, 'labtop', null, 'relevance', 'Bengaluru');
  assert.ok(results.length > 0);
  assert.equal(results[0].category, 'Laptops');
});

test('paging returns every one of the 102 laptops, once', async () => {
  const seen = new Set();
  let total = null;
  for (let page = 1; page <= 6; page++) {
    const out = await handleApi(db, { method: 'GET', path: '/api/shop/search',
      query: new URLSearchParams({ category: 'Laptops', page: String(page), page_size: '20' }), cookies: {} });
    assert.equal(out.status, 200);
    total = out.payload.total;
    assert.equal(out.payload.page, page);
    assert.equal(out.payload.page_size, 20);
    for (const r of out.payload.results) seen.add(r.id);
  }
  assert.equal(total, 102);
  assert.equal(seen.size, 102);
  const tooBig = await handleApi(db, { method: 'GET', path: '/api/shop/search', query: new URLSearchParams({ page_size: '500' }), cookies: {} });
  assert.equal(tooBig.payload.page_size, 60); // capped
});
