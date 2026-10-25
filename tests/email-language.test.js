// Emails in the customer's language: Telugu when the account asks for it, English otherwise, and a
// key that is missing in one language must fail here rather than at send time.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { handleApi } from '../src/api.js';
import { settings } from '../src/auth.js';
import { all, one, run } from '../src/db.js';
import { dispatch, work } from '../src/jobs.js';
import { emit } from '../src/events.js';
import { KEYS, LANGUAGES, TABLES, langOf, orderPlaced, shipmentUpdate, STAGE_WORDS, t } from '../src/emails.js';
import { openDatabase } from '../src/server.js';

settings.fastHashing = true;
process.env.EQUIDRON_SEED_DEMO = '1';

let db;
let asha;
let order;
before(async () => {
  db = await openDatabase('memory');
  asha = await one(db, "SELECT id, email FROM users WHERE email = 'asha@example.com'");
  order = await one(db, 'SELECT id, total_paise FROM orders WHERE user_id = ? ORDER BY id LIMIT 1', asha.id);
});
after(async () => { await db?.close(); });

test('every language has every key, and Telugu really is Telugu', () => {
  for (const lang of LANGUAGES) {
    for (const key of KEYS) {
      assert.ok(Object.prototype.hasOwnProperty.call(TABLES[lang], key), `${lang} is missing ${key}`);
      assert.ok(String(TABLES[lang][key]).trim().length > 0, `${lang}.${key} is empty`);
    }
    // The same key set, both ways.
    assert.deepEqual(Object.keys(TABLES[lang]).sort(), [...KEYS].sort());
  }
  // A Telugu value that contains no Telugu script is an English copy.
  for (const key of KEYS) assert.match(TABLES.te[key], /[\u0C00-\u0C7F]/, `te.${key} has no Telugu`);
  // Courier stages exist in both languages, and 'pending' is silent in both.
  for (const lang of LANGUAGES) {
    assert.equal(STAGE_WORDS[lang].pending, undefined);
    for (const stage of ['packed', 'shipped', 'in_transit', 'out_for_delivery', 'delivered']) {
      assert.ok(STAGE_WORDS[lang][stage], `${lang} has no wording for ${stage}`);
    }
  }
});

test('an unknown language falls back to English, and a missing key returns the key', () => {
  assert.equal(langOf('fr'), 'en');
  assert.equal(langOf(undefined), 'en');
  assert.equal(t('fr', 'total', { amount: '₹1' }), 'Total: ₹1');
  assert.equal(t('en', 'no.such.key'), 'no.such.key');
  const email = orderPlaced({ lang: 'fr', firstName: 'Asha', orderId: 7, totalPaise: 100, itemCount: 1 });
  assert.match(email.subject, /order #7 is confirmed/);
});

test('Telugu emails carry Telugu text and the same facts', () => {
  const en = orderPlaced({ lang: 'en', firstName: 'Asha Rao', orderId: 12, totalPaise: 95_990_00, itemCount: 2, city: 'Bengaluru' });
  const te = orderPlaced({ lang: 'te', firstName: 'Asha Rao', orderId: 12, totalPaise: 95_990_00, itemCount: 2, city: 'Bengaluru' });
  assert.match(te.subject, /ఆర్డర్ #12/);
  assert.match(te.body, /నమస్తే Asha/);
  assert.match(te.body, /₹95,990/); // the amount is the same number
  assert.notEqual(en.body, te.body);
  // The shipped email names the stage in Telugu.
  const shipped = shipmentUpdate({ lang: 'te', firstName: 'Asha', orderId: 12, stage: 'shipped', items: ['Book × 1'] });
  assert.match(shipped.subject, /పంపబడింది/);
  // The delivery note only appears for a delivered shipment.
  const delivered = shipmentUpdate({ lang: 'te', firstName: 'Asha', orderId: 12, stage: 'delivered', items: [] });
  assert.match(delivered.body, /రిటర్న్/);
});

test('the language route saves it for the signed-in account only', async () => {
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
  assert.equal((await call('POST', '/api/shop/language', { language: 'fr' })).status, 400);
  const saved = await call('POST', '/api/shop/language', { language: 'te' });
  assert.equal(saved.status, 200);
  assert.equal((await one(db, 'SELECT language FROM users WHERE id = ?', asha.id)).language, 'te');

  // The session decides whose row is written: a user_id in the body changes nothing.
  const rahul = await one(db, "SELECT id FROM users WHERE email = 'rahul@example.com'");
  await call('POST', '/api/shop/language', { language: 'en', user_id: rahul.id });
  assert.equal((await one(db, 'SELECT language FROM users WHERE id = ?', rahul.id)).language, 'en', 'the other account was untouched');
  assert.equal((await one(db, 'SELECT language FROM users WHERE id = ?', asha.id)).language, 'en', 'the session user changed, as asked');
  await call('POST', '/api/shop/language', { language: 'te' });
});

test('a real order sends its confirmation in the customer’s language', async () => {
  await run(db, "UPDATE users SET language = 'te' WHERE id = ?", asha.id);
  await emit(db, 'order.placed', 'order', order.id, { total_paise: order.total_paise, payment_method: 'cod', shipments: 1 });
  await dispatch(db);
  await work(db, { seconds: 20 });

  const mail = await one(db, 'SELECT * FROM outbox WHERE to_address = ? AND subject LIKE ? ORDER BY id DESC LIMIT 1',
    asha.email, '%ఆర్డర్%');
  assert.ok(mail, 'the confirmation went out in Telugu');
  assert.match(mail.body, /నమస్తే/);
  assert.match(mail.body, /మొత్తం/);

  // Switch back and the next one is English again.
  await run(db, "UPDATE users SET language = 'en' WHERE id = ?", asha.id);
  await emit(db, 'order.cancelled', 'order', order.id, { by: 'customer' });
  await dispatch(db);
  await work(db, { seconds: 20 });
  const english = await one(db, 'SELECT * FROM outbox WHERE to_address = ? AND subject LIKE ? ORDER BY id DESC LIMIT 1',
    asha.email, '%was cancelled%');
  assert.ok(english, 'the cancellation went out in English');
  assert.doesNotMatch(english.body, /[\u0C00-\u0C7F]/);
});
