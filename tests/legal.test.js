// Phase 15: the legal templates. They exist, they say plainly that they are templates, and the
// store links to them - the three things a demo needs and a launch must not fake.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const page = (name) => readFileSync(new URL(`../static/legal/${name}.html`, import.meta.url), 'utf8');

test('the three pages exist and mark every value that must be replaced', () => {
  for (const name of ['privacy', 'terms', 'refunds']) {
    const html = page(name);
    assert.match(html, /<h1>/, name + ' has a title');
    assert.match(html, /class="warn"/, name + ' says it is a template');
    assert.match(html, /\[COMPANY NAME\]|\[EMAIL\]|\[CITY\]/, name + ' has a placeholder');
    assert.doesNotMatch(html, /lorem ipsum/i);
    assert.match(html, /Last updated: \d{1,2} \w+ \d{4}/, name + ' is dated');
  }
});

test('the legal pages say the things they must say', () => {
  const privacy = page('privacy');
  assert.match(privacy, /never your full card number/i);
  assert.match(privacy, /download everything we hold/i);
  assert.match(privacy, /kept as long as tax law requires/i);
  const terms = page('terms');
  assert.match(terms, /marketplace/i);
  assert.match(terms, /include GST/i);
  const refunds = page('refunds');
  assert.match(refunds, /five working days/i);
  assert.match(refunds, /Consumer Protection Act/);
});

test('the store links to all three, so they are reachable', () => {
  const shop = readFileSync(new URL('../static/shop/index.html', import.meta.url), 'utf8');
  for (const name of ['privacy', 'terms', 'refunds']) {
    assert.match(shop, new RegExp(`/legal/${name}\\.html`), name + ' is linked');
  }
});