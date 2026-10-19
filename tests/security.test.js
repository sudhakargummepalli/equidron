// Security headers (Netlify and the local server agree), Subresource Integrity on the
// AngularJS script, and the demo switch: without EQUIDRON_SEED_DEMO=1 there is no shared password.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { handleApi } from '../src/api.js';
import { settings } from '../src/auth.js';
import { one } from '../src/db.js';
import { SECURITY_HEADERS } from '../src/security-headers.js';
import { createServer, openDatabase } from '../src/server.js';

settings.fastHashing = true;

test('netlify.toml sends the same security headers as the local server', () => {
  const toml = readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');
  const start = toml.indexOf('[headers.values]');
  const block = toml.slice(start, toml.indexOf('[[', start));
  const sent = Object.fromEntries([...block.matchAll(/^\s+([A-Za-z-]+) = "(.*)"$/gm)].map((m) => [m[1], m[2]]));
  assert.deepEqual(sent, SECURITY_HEADERS);
  assert.match(SECURITY_HEADERS['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.doesNotMatch(SECURITY_HEADERS['Content-Security-Policy'], /unsafe-eval/);
});

test('every page pins AngularJS with Subresource Integrity and runs it without eval', () => {
  for (const page of ['shop', 'seller', 'ops']) {
    const html = readFileSync(new URL(`../static/${page}/index.html`, import.meta.url), 'utf8');
    const tags = html.match(/<script src="https:[^>]+>/g);
    assert.equal(tags.length, 1, page);
    assert.match(tags[0], /integrity="sha512-[A-Za-z0-9+/=]{88}" crossorigin="anonymous"/, page);
    assert.match(html, /ng-csp="no-unsafe-eval"/, page);
  }
});

test('the local server sends the security headers', async () => {
  process.env.EQUIDRON_SEED_DEMO = '1';
  const db = await openDatabase('memory');
  const server = createServer(db, { quiet: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/shop/`);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(res.headers.get(name), value, name);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await db.close();
  }
});

test('without demo mode the sample accounts have no shared password and cannot sign in', async () => {
  process.env.EQUIDRON_SEED_DEMO = '0';
  const db = await openDatabase('memory');
  try {
    const call = (path, body) => handleApi(db, { method: 'POST', path, query: new URLSearchParams(), body, cookies: {} });
    for (const [area, email] of [['shop', 'asha@example.com'], ['seller', 'techbazaar.seller@example.com'], ['ops', 'ops@example.com']]) {
      const out = await call(`/api/${area}/login`, { email, password: 'equidron-demo' });
      assert.ok([401, 403].includes(out.status), `${area}: ${out.status}`);
    }
    // The catalogue still loads; only the accounts are closed.
    assert.ok((await one(db, "SELECT COUNT(*) AS n FROM products WHERE status = 'live'")).n > 100);
    const me = await handleApi(db, { method: 'GET', path: '/api/shop/me', query: new URLSearchParams(), cookies: {} });
    assert.equal(me.payload.demo, false);
  } finally {
    await db.close();
    process.env.EQUIDRON_SEED_DEMO = '1';
  }
});
