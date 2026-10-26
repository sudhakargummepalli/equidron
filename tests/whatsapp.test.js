// Phase 10: WhatsApp. Opt-in only, a simulated provider by default, an HTTP adapter that fails
// closed, and a webhook that answers a status question with a status.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { handleApi } from '../src/api.js';
import { settings } from '../src/auth.js';
import { all, one, run } from '../src/db.js';
import { dispatch, work } from '../src/jobs.js';
import { emit } from '../src/events.js';
import { sendWhatsApp } from '../src/job-kinds.js';
import * as whatsapp from '../src/whatsapp.js';
import { openDatabase } from '../src/server.js';

settings.fastHashing = true;
process.env.EQUIDRON_SEED_DEMO = '1';

let db;
let asha;
let order;
before(async () => {
  db = await openDatabase('memory');
  asha = await one(db, "SELECT id FROM users WHERE email = 'asha@example.com'");
  order = await one(db, 'SELECT id, total_paise FROM orders WHERE user_id = ? ORDER BY id LIMIT 1', asha.id);
  delete process.env.WHATSAPP_PROVIDER;
  delete process.env.WHATSAPP_TOKEN;
  delete process.env.WHATSAPP_PHONE_ID;
});
after(async () => { await db?.close(); });

test('a number is valid only if it looks like an Indian mobile', () => {
  assert.equal(whatsapp.validPhone('9800000001'), true);
  assert.equal(whatsapp.validPhone('919800000001'), true);
  assert.equal(whatsapp.validPhone('5800000001'), false, 'starts 6-9');
  assert.equal(whatsapp.validPhone('98000'), false);
  assert.equal(whatsapp.validPhone('+91 98000 00001'), true, 'spaces and + are cleaned');
});

test('nothing is sent to a person who has not opted in', async () => {
  const out = await sendWhatsApp(db, 'order.placed', order.id);
  assert.deepEqual(out, { skipped: 'not opted in' });
  assert.equal((await all(db, 'SELECT id FROM whatsapp_messages')).length, 0);
});

test('opting in saves the number, and opting out stops the messages', async () => {
  await whatsapp.optIn(db, asha.id, '9800000001');
  let user = await one(db, 'SELECT whatsapp_phone, whatsapp_opt_in_at FROM users WHERE id = ?', asha.id);
  assert.equal(user.whatsapp_phone, '919800000001', 'stored with the country code, the way it is looked up');
  assert.ok(user.whatsapp_opt_in_at);
  assert.equal(whatsapp.optedIn(user), true);

  await whatsapp.optOut(db, asha.id);
  user = await one(db, 'SELECT whatsapp_phone, whatsapp_opt_in_at FROM users WHERE id = ?', asha.id);
  assert.equal(user.whatsapp_opt_in_at, null);
  assert.equal(whatsapp.optedIn(user), false);
});

test('the simulated provider records a message with its status', async () => {
  await whatsapp.optIn(db, asha.id, '9800000001');
  const out = await whatsapp.send(db, { userId: asha.id, phone: '9800000001', body: 'Your order is on its way.' });
  assert.equal(out.status, 'sent');
  const row = await one(db, 'SELECT * FROM whatsapp_messages WHERE id = ?', out.message_id);
  assert.equal(row.direction, 'out');
  assert.equal(row.phone, '919800000001', 'the country code is added');
  assert.equal(row.status, 'sent');
});

test('the twilio provider also fails closed, and is the no-Meta-app route', async () => {
  process.env.WHATSAPP_PROVIDER = 'twilio';
  assert.equal(whatsapp.configured(), false);
  await assert.rejects(() => whatsapp.send(db, { phone: '9148315033', body: 'hi' }), /not configured/);
  // With values present it is considered configured; the send itself is not made here.
  process.env.TWILIO_ACCOUNT_SID = 'ACtest';
  process.env.TWILIO_AUTH_TOKEN = 'token';
  process.env.TWILIO_WHATSAPP_FROM = 'whatsapp:+14155238886';
  assert.equal(whatsapp.configured(), true);
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_WHATSAPP_FROM;
  process.env.WHATSAPP_PROVIDER = 'simulated';
});

test('the http provider fails closed without a token', async () => {
  process.env.WHATSAPP_PROVIDER = 'http';
  assert.equal(whatsapp.configured(), false);
  const before = (await all(db, 'SELECT id FROM whatsapp_messages')).length;
  await assert.rejects(() => whatsapp.send(db, { phone: '9800000001', body: 'hi' }), /not configured/);
  // Refused before anything is written: no message was attempted, so there is nothing to record.
  assert.equal((await all(db, 'SELECT id FROM whatsapp_messages')).length, before);
  process.env.WHATSAPP_PROVIDER = 'simulated';
});

test('a placed order sends the customer a WhatsApp message', async () => {
  await emit(db, 'order.placed', 'order', order.id, { total_paise: order.total_paise, payment_method: 'cod', shipments: 1 });
  await dispatch(db);
  await work(db, { seconds: 20 });
  const rows = await all(db, "SELECT body FROM whatsapp_messages WHERE direction = 'out' AND body LIKE '%confirmed%'");
  assert.ok(rows.length, 'a confirmation was sent: ' + JSON.stringify((await all(db, 'SELECT body FROM whatsapp_messages ORDER BY id')).map((r) => r.body)));
  assert.match(rows.at(-1).body, new RegExp(`order #${order.id} is confirmed`));
});

test('the webhook needs its secret, keeps the message, and answers a status question', async () => {
  process.env.WHATSAPP_WEBHOOK_SECRET = 'wa-secret';
  const hook = (headers, body) => handleApi(db, { method: 'POST', path: '/api/webhooks/whatsapp', query: new URLSearchParams(), body, cookies: {}, headers });
  const payload = (text) => ({
    entry: [{ changes: [{ value: { messages: [{ from: '919800000001', id: 'wamid.1', type: 'text', text: { body: text } }] } }] }],
  });

  assert.equal((await hook({}, payload(`order ${order.id}`))).status, 403);
  const ok = await hook({ 'x-whatsapp-secret': 'wa-secret' }, payload(`where is order ${order.id}`));
  assert.equal(ok.status, 200);
  assert.equal(ok.payload.handled, 1);

  const inbound = await one(db, "SELECT * FROM whatsapp_messages WHERE direction = 'in' ORDER BY id DESC LIMIT 1");
  assert.match(inbound.body, /where is order/);
  assert.equal(inbound.user_id, asha.id, 'the reply is tied to the account that opted in');
  const answer = await one(db, "SELECT * FROM whatsapp_messages WHERE direction = 'out' ORDER BY id DESC LIMIT 1");
  assert.match(answer.body, new RegExp(`Order #${order.id}`));

  // STOP opts the person out.
  await hook({ 'x-whatsapp-secret': 'wa-secret' }, payload('STOP'));
  assert.equal((await one(db, 'SELECT whatsapp_opt_in_at FROM users WHERE id = ?', asha.id)).whatsapp_opt_in_at, null);
  delete process.env.WHATSAPP_WEBHOOK_SECRET;
});

test('the verification GET answers only with the right token', async () => {
  process.env.WHATSAPP_VERIFY_TOKEN = 'verify-me';
  const get = (query) => handleApi(db, { method: 'GET', path: '/api/webhooks/whatsapp', query: new URLSearchParams(query), body: null, cookies: {}, headers: {} });
  assert.equal((await get({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '123' })).status, 403);
  const ok = await get({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '123' });
  assert.equal(ok.status, 200);
  assert.equal(ok.text, '123', 'the challenge comes back as plain text');
  delete process.env.WHATSAPP_VERIFY_TOKEN;
});
