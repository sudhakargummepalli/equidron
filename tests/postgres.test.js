// Database layer and Netlify handler tests, run against PGlite (real PostgreSQL
// compiled to WebAssembly, in-process), so no database server is needed.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { settings } from '../src/auth.js';
import { connect, initSchema, one, run, scalar, SCHEMA, toPostgres, transaction } from '../src/db.js';
import { makePostgresHandler } from '../src/fetch-handler.js';
import DATA from '../src/sample-data.json' with { type: 'json' };
import { seed } from '../src/seed.js';

settings.fastHashing = true; // cheap password hashing, so the sample accounts are quick to create
process.env.EQUIDRON_SEED_DEMO = '1'; // the sample accounts sign in with the shared demo password

test('? placeholders are numbered and LIKE ignores case', () => {
  assert.equal(toPostgres("SELECT * FROM t WHERE a = ? AND b LIKE ? AND c = '?'"),
    "SELECT * FROM t WHERE a = $1 AND b ILIKE $2 AND c = '?'");
});

test('inserts return ids, counts are numbers, failed transactions roll back', async () => {
  const db = await connect('memory');
  await initSchema(db);
  const add = (email) => run(db, "INSERT INTO users (email, name, role, pw_salt, pw_hash, created_at) VALUES (?, 'N', 'ops', 's', 'h', now())", email);
  assert.equal(await add('a@example.com'), 1);
  await assert.rejects(transaction(db, async () => {
    await add('b@example.com');
    throw new Error('boom');
  }));
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM users'), 1);
  assert.equal((await one(db, 'SELECT email FROM users WHERE email LIKE ?', 'A@%')).email, 'a@example.com');
  await db.close();
});

test('the Netlify Database schema migrations add up to the schema', () => {
  // Every migration except the data migrations (the sample laptops) is also in SCHEMA, in
  // order, after its comment lines. New schema changes go at the end of SCHEMA.
  const DATA_MIGRATIONS = ['20261017120000_sample_laptops.sql'];
  const dir = new URL('../netlify/database/migrations/', import.meta.url);
  const schemaMigrations = readdirSync(dir).filter((f) => f.endsWith('.sql') && !DATA_MIGRATIONS.includes(f)).sort()
    .map((f) => readFileSync(new URL(f, dir), 'utf8').replace(/\r\n/g, '\n').replace(/^(--.*\n)+/, '').trim());
  assert.equal(schemaMigrations.length, 10);
  assert.equal(schemaMigrations.join('\n'), SCHEMA.trim().replace(/\r\n/g, '\n'));
});

test('the sample laptops migration only fills databases seeded before the laptops existed', async () => {
  const migration = readFileSync(new URL('../netlify/database/migrations/20261017120000_sample_laptops.sql', import.meta.url), 'utf8');
  const titles = DATA.products.filter((p) => p.category === 'Laptops').slice(2).map((p) => p.title); // the first two predate it
  const counts = async (db) => ({
    products: await scalar(db, "SELECT COUNT(*) FROM products WHERE category = 'Laptops'"),
    offers: await scalar(db, "SELECT COUNT(*) FROM offers o JOIN products p ON p.id = o.product_id WHERE p.category = 'Laptops'"),
    units: await scalar(db, `SELECT COALESCE(SUM(i.on_hand), 0) FROM inventory i JOIN offers o ON o.id = i.offer_id
                             JOIN products p ON p.id = o.product_id WHERE p.category = 'Laptops'`),
  });

  const db = await connect('memory');
  await initSchema(db);
  await db.exec(migration); // empty database: the seed will load them, so nothing happens
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM products'), 0);

  await seed(db);
  const seeded = await counts(db);
  assert.equal(seeded.products, 102);
  await db.exec(migration); // already there: nothing happens
  assert.deepEqual(await counts(db), seeded);

  // A database seeded before the laptops were added. Migrations run in name order, so such a
  // database still had the column types from before Phase 2b: put back the old types of the
  // tables this migration writes, run it, then let the Phase 2b migration convert the result.
  const ids = `SELECT id FROM products WHERE title = ANY($1)`;
  await db.query(`DELETE FROM inventory WHERE offer_id IN (SELECT id FROM offers WHERE product_id IN (${ids}))`, [titles]);
  await db.query(`DELETE FROM offers WHERE product_id IN (${ids})`, [titles]);
  await db.query(`DELETE FROM products WHERE id IN (${ids})`, [titles]);
  assert.equal((await counts(db)).products, 2);
  await db.exec(`DROP INDEX IF EXISTS products_search; DROP INDEX IF EXISTS products_title_trgm;
    ALTER TABLE products ALTER COLUMN specs DROP DEFAULT, ALTER COLUMN specs TYPE text USING specs::text,
      ALTER COLUMN images DROP DEFAULT, ALTER COLUMN images TYPE text USING images::text,
      ALTER COLUMN is_sample DROP DEFAULT, ALTER COLUMN is_sample TYPE integer USING is_sample::int,
      ALTER COLUMN created_at TYPE text USING to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
    ALTER TABLE offers ALTER COLUMN ships_to DROP DEFAULT, ALTER COLUMN ships_to TYPE text USING ships_to::text,
      ALTER COLUMN is_sample DROP DEFAULT, ALTER COLUMN is_sample TYPE integer USING is_sample::int,
      ALTER COLUMN updated_at TYPE text USING to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`);
  await db.exec(migration);
  await db.exec(readFileSync(new URL('../netlify/database/migrations/20261020000000_types_and_search.sql', import.meta.url), 'utf8'));
  assert.deepEqual(await counts(db), seeded);
  const p = await one(db, 'SELECT id, images, is_sample FROM products WHERE title = ?', titles[0]);
  assert.deepEqual(p.images, [1, 2, 3].map((n) => `/img/p${p.id}-${n}.svg`));
  assert.equal(p.is_sample, true);
  await db.close();
});

test('the Netlify function answers 503 when it has no database', async () => {
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const { default: fn } = await import('../netlify/functions/api.mjs');
    const res = await fn(new Request('https://equidron.example/api/shop/meta'));
    assert.equal(res.status, 503);
  } finally {
    if (saved !== undefined) process.env.DATABASE_URL = saved;
  }
});

test('Netlify handler serves the API from Postgres', async () => {
  const handle = makePostgresHandler('memory');
  const call = (method, p, body, cookie) => handle(new Request('https://equidron.example' + p, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }));

  const login = await call('POST', '/api/seller/login', { email: 'techbazaar.seller@example.com', password: 'equidron-demo' });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { offers } = await (await call('GET', '/api/seller/listings', null, cookie)).json();
  const o = offers.find((x) => x.title.startsWith('Bassline Mini'));
  const sub = await call('POST', '/api/seller/submissions', {
    offer_id: o.id, price: o.price_paise / 100, mrp: o.mrp_paise / 100, quantity: 75, handling_days: 1, ships_to: ['ALL'],
  }, cookie);
  assert.equal((await sub.json()).status, 'approved');

  const search = await (await call('GET', '/api/shop/search?q=bassline')).json();
  assert.ok(search.results.some((r) => r.title.startsWith('Bassline Mini')));
  await handle.close();
});

test('the Phase 1 migration upgrades a database that already has data, and can run twice', async () => {
  const migration = readFileSync(new URL('../netlify/database/migrations/20261019000000_accounts_and_audit.sql', import.meta.url), 'utf8');
  const db = await connect('memory');
  await db.exec(SCHEMA.slice(0, SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS audit_log'))); // the schema before Phase 1
  const add = (email, role) => run(db, "INSERT INTO users (email, name, role, pw_salt, pw_hash, created_at) VALUES (?, 'N', ?, 's', 'h', 't')", email, role);
  await add('staff@example.com', 'ops');
  await add('shopper@example.com', 'customer');
  await db.exec(migration);
  await db.exec(migration);
  const staff = await one(db, "SELECT * FROM users WHERE email = 'staff@example.com'");
  assert.equal(staff.permissions, '["admin"]'); // existing staff keep full access
  assert.equal(staff.pw_algo, 'pbkdf2:120000');
  assert.equal(staff.email_verified, 1);
  assert.equal((await one(db, "SELECT permissions FROM users WHERE email = 'shopper@example.com'")).permissions, '[]');
  await add('agent-returns@agents.equidron.invalid', 'agent'); // the new role is allowed
  await assert.rejects(add('x@example.com', 'boss'));
  await db.close();
});
