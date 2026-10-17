// Database layer and Netlify handler tests, run against PGlite (real PostgreSQL
// compiled to WebAssembly, in-process), so no database server is needed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settings } from '../src/auth.js';
import { connect, initSchema, one, run, scalar, toPostgres, transaction } from '../src/db.js';
import { makePostgresHandler } from '../src/fetch-handler.js';

settings.pbkdf2Rounds = 1000;

test('? placeholders are numbered and LIKE ignores case', () => {
  assert.equal(toPostgres("SELECT * FROM t WHERE a = ? AND b LIKE ? AND c = '?'"),
    "SELECT * FROM t WHERE a = $1 AND b ILIKE $2 AND c = '?'");
});

test('inserts return ids, counts are numbers, failed transactions roll back', async () => {
  const db = await connect('memory');
  await initSchema(db);
  const add = (email) => run(db, "INSERT INTO users (email, name, role, pw_salt, pw_hash, created_at) VALUES (?, 'N', 'ops', 's', 'h', 't')", email);
  assert.equal(await add('a@example.com'), 1);
  await assert.rejects(transaction(db, async () => {
    await add('b@example.com');
    throw new Error('boom');
  }));
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM users'), 1);
  assert.equal((await one(db, 'SELECT email FROM users WHERE email LIKE ?', 'A@%')).email, 'a@example.com');
  await db.close();
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
