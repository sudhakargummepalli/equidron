// The Netlify setup keeps the SQLite file in a blob store. These tests use an
// in-memory stand-in for Netlify Blobs and two handler "instances" with separate
// /tmp copies, like two warm serverless containers.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { settings } from '../src/auth.js';
import { makeBlobHandler } from '../src/blob-backed.js';

settings.pbkdf2Rounds = 1000;

function memoryStore() {
  const data = new Map();
  let version = 0;
  return {
    async getMetadata(key) { return data.has(key) ? { etag: data.get(key).etag } : null; },
    async get(key) { return data.has(key) ? data.get(key).bytes.buffer.slice(0) : null; },
    async set(key, bytes) { data.set(key, { bytes: new Uint8Array(bytes), etag: `v${++version}` }); },
  };
}

const tmp = (name) => path.join(os.tmpdir(), `equidron-test-${process.pid}-${name}.db`);
const files = [tmp('a'), tmp('b')];
after(() => { for (const f of files) rmSync(f, { force: true }); });

function call(handler, method, p, body, cookie) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  return handler(new Request('https://equidron.example' + p, { method, headers, body: body ? JSON.stringify(body) : undefined }));
}

test('writes from one function instance are visible to another', async () => {
  const store = memoryStore();
  const a = makeBlobHandler(() => store, files[0]);
  const b = makeBlobHandler(() => store, files[1]);

  const login = await call(a, 'POST', '/api/shop/login', { email: 'asha@example.com', password: 'equidron-demo' });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(login.headers.get('set-cookie'), /Secure/);

  const search = await (await call(b, 'GET', '/api/shop/search?q=laptop')).json();
  const offerId = search.results[0].featured_offer.id;
  assert.equal((await call(b, 'POST', '/api/shop/cart', { offer_id: offerId, qty: 1 }, cookie)).status, 200);

  const cart = await (await call(a, 'GET', '/api/shop/cart', null, cookie)).json();
  assert.deepEqual(cart.items.map((i) => i.offer_id), [offerId]);

  const img = await call(a, 'GET', '/img/p1-1.svg');
  assert.match(img.headers.get('content-type'), /image\/svg\+xml/);
  a.close();
  b.close();
});
