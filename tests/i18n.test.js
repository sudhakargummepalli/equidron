// The i18n rules, enforced: the two dictionaries must have the same keys, no empty value, a real
// Telugu translation rather than a copy, and every key the pages ask for must exist.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = new URL('../static/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

// The dictionaries are browser scripts (window.EQ_STRINGS), so give them a window to write into.
// Both files share one window, the way the page loads them.
function loadAll() {
  const window = {};
  for (const file of ['en.js', 'te.js']) {
    // eslint-disable-next-line no-new-func
    new Function('window', readFileSync(join(ROOT, 'i18n', file), 'utf8'))(window);
  }
  return window.EQ_STRINGS;
}
const { en, te } = loadAll();

test('both dictionaries load and hold the same keys', () => {
  assert.ok(Object.keys(en).length > 20, 'the English dictionary has entries');
  const missingInTe = Object.keys(en).filter((k) => !(k in te));
  const extraInTe = Object.keys(te).filter((k) => !(k in en));
  assert.deepEqual(missingInTe, [], 'keys missing from te.js');
  assert.deepEqual(extraInTe, [], 'keys in te.js that en.js does not have');
});

test('no value is empty, and Telugu is actually translated', () => {
  // A handful of words are the same in both languages on purpose.
  const SAME = new Set(['common.english', 'common.telugu']);
  for (const key of Object.keys(en)) {
    assert.ok(String(en[key]).trim().length > 0, `empty English value: ${key}`);
    assert.ok(String(te[key]).trim().length > 0, `empty Telugu value: ${key}`);
    if (!SAME.has(key)) {
      assert.notEqual(te[key], en[key], `Telugu still English for ${key}`);
      // A Telugu value that contains no Telugu script is a copy with extra words.
      assert.match(te[key], /[\u0C00-\u0C7F]/, `Telugu value has no Telugu script: ${key}`);
    }
  }
});

// Every key the pages ask for, from `{{ 'key' | t }}` and `t('key')` in the static files.
function keysUsed() {
  const found = new Set();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(html|js)$/.test(name) || full.includes(`${join('static', 'i18n')}`)) continue;
      const text = readFileSync(full, 'utf8');
      for (const m of text.matchAll(/'([a-z][a-z0-9]*\.[a-z0-9_.]+)'\s*\|\s*t\b/g)) found.add(m[1]);
      for (const m of text.matchAll(/\beqT\('([a-z][a-z0-9]*\.[a-z0-9_.]+)'/g)) found.add(m[1]);
    }
  };
  walk(ROOT);
  return [...found];
}

test('every key the pages use exists in both dictionaries', () => {
  const used = keysUsed();
  assert.ok(used.length > 10, `the pages use a real set of keys, found ${used.length}`);
  for (const key of used) {
    assert.ok(key in en, `used but missing from en.js: ${key}`);
    assert.ok(key in te, `used but missing from te.js: ${key}`);
  }
});

test('the language switch and the t() helper exist, and the pages load them', () => {
  const i18n = readFileSync(join(ROOT, 'common', 'i18n.js'), 'utf8');
  assert.match(i18n, /window\.eqT = t/);
  assert.match(i18n, /window\.eqSetLang = setLang/);
  assert.match(i18n, /directive\('eqLangSwitch'/);
  assert.match(i18n, /filter\('t'/);
  for (const page of ['shop', 'seller', 'ops']) {
    const html = readFileSync(join(ROOT, page, 'index.html'), 'utf8');
    assert.match(html, /\/i18n\/en\.js/, `${page} loads en.js`);
    assert.match(html, /\/i18n\/te\.js/, `${page} loads te.js`);
    assert.match(html, /\/common\/i18n\.js/, `${page} loads i18n.js`);
  }
  // The store and Seller Central offer the switch; Ops stays English (staff-facing).
  for (const page of ['shop', 'seller']) {
    const html = readFileSync(join(ROOT, page, 'index.html'), 'utf8');
    assert.match(html, /eq-lang-switch/, `${page} has a language switch`);
  }
});

test('markup around an interpolation is intact on every page', () => {
  for (const page of ['shop', 'seller', 'ops']) {
    const html = readFileSync(join(ROOT, page, 'index.html'), 'utf8');
    // A swallowed '>' or '<' shows up as an interpolation glued to a closing tag or to an attribute.
    const swallowed = [...html.matchAll(/\}\}\/[A-Za-z0-9]+>|="[^"]*"\{\{/g)].map((m) => m[0]);
    assert.deepEqual(swallowed, [], page + ' has broken markup: ' + swallowed.slice(0, 3).join(' | '));
  }
});
