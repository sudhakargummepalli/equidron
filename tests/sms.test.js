// Phase 10: SMS. A registered template is part of every real send, an opt-out is honoured, and a
// refused send is recorded rather than dropped.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { all, now, one, run } from '../src/db.js';
import { dispatch, work } from '../src/jobs.js';
import { emit } from '../src/events.js';
import { sendSms, smsArrivingToday } from '../src/job-kinds.js';
import * as sms from '../src/sms.js';
import { openDatabase } from '../src/server.js';

process.env.EQUIDRON_SEED_DEMO = '1';

let db;
let asha;
let order;
before(async () => {
  db = await openDatabase('memory');
  asha = await one(db, "SELECT id FROM users WHERE email = 'asha@example.com'");
  order = await one(db, 'SELECT id, total_paise FROM orders WHERE user_id = ? ORDER BY id LIMIT 1', asha.id);
  delete process.env.SMS_PROVIDER;
  delete process.env.SMS_DLT_TEMPLATE_ID;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_SMS_FROM;
});
after(async () => { await db?.close(); });

test('a message is cut to one segment, and a number must be an Indian mobile', async () => {
  assert.equal(sms.shorten('a'.repeat(200)).length, 160);
  await assert.rejects(() => sms.send(db, { phone: '12345', body: 'hi' }), /ten digits/);
  await assert.rejects(() => sms.send(db, { phone: '9148315033', body: '   ' }), /needs text/);
});

test('the simulated provider records the message with the template it would use', async () => {
  process.env.SMS_DLT_TEMPLATE_ID = '1107170000000001';
  const out = await sms.send(db, { userId: asha.id, phone: '9148315033', body: 'Equidron: order #1 confirmed.' });
  assert.equal(out.status, 'sent');
  const row = await one(db, 'SELECT * FROM sms_messages WHERE id = ?', out.message_id);
  assert.equal(row.phone, '919148315033');
  assert.equal(row.template_id, '1107170000000001');
  assert.equal(row.status, 'sent');
});

test('a real provider fails closed: keys, then the DLT template', async () => {
  process.env.SMS_PROVIDER = 'twilio';
  assert.equal(sms.configured(), false);
  await assert.rejects(() => sms.send(db, { phone: '9148315033', body: 'hi' }), /not configured/);

  process.env.TWILIO_ACCOUNT_SID = 'ACtest';
  process.env.TWILIO_AUTH_TOKEN = 'token';
  process.env.TWILIO_SMS_FROM = '+14155238886';
  assert.equal(sms.configured(), true);
  // In India, a commercial SMS without a registered template is refused by the operator.
  delete process.env.SMS_DLT_TEMPLATE_ID;
  await assert.rejects(() => sms.send(db, { phone: '9148315033', body: 'hi' }), /DLT template/);

  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_SMS_FROM;
  process.env.SMS_PROVIDER = 'simulated';
  process.env.SMS_DLT_TEMPLATE_ID = '1107170000000001';
});

test('opting out is remembered, and stops the next message', async () => {
  await sms.optOut(db, asha.id);
  assert.equal(sms.optedOut(await one(db, 'SELECT sms_opt_out_at FROM users WHERE id = ?', asha.id)), true);

  const before = (await all(db, 'SELECT id FROM sms_messages')).length;
  const out = await sendSms(db, 'order.placed', order.id);
  assert.deepEqual(out, { skipped: 'opted out' });
  assert.equal((await all(db, 'SELECT id FROM sms_messages')).length, before, 'nothing was sent');

  await sms.optIn(db, asha.id);
});

test('a placed order texts the phone on its delivery address', async () => {
  const phone = await sms.phoneFor(db, asha.id);
  assert.ok(phone, 'the sample address has a phone');
  await emit(db, 'order.placed', 'order', order.id, { total_paise: order.total_paise, payment_method: 'cod', shipments: 1 });
  await dispatch(db);
  await work(db, { seconds: 20 });
  const row = await one(db, 'SELECT * FROM sms_messages WHERE body LIKE ? ORDER BY id DESC LIMIT 1', '%confirmed%');
  assert.ok(row, 'a confirmation was sent');
  assert.equal(row.phone, phone.length === 10 ? `91${phone}` : phone);
  assert.match(row.body, new RegExp(`order #${order.id} confirmed`));
  assert.ok(row.body.length <= 160, 'one segment');
});

test('a payment, an approved return and a refund each send their own text', async () => {
  const orderId = order.id;
  await emit(db, 'payment.captured', 'order', orderId, { amount_paise: order.total_paise, method: 'upi' });
  await dispatch(db);
  await work(db, { seconds: 20 });
  const paid = await one(db, "SELECT * FROM sms_messages WHERE body LIKE '%payment received%' ORDER BY id DESC LIMIT 1");
  assert.ok(paid, 'the payment text went out');
  assert.match(paid.body, new RegExp(`order #${orderId}`));

  // A return: the template needs the return id and the refund, which come from separate tables.
  const item = await one(db, 'SELECT id, unit_price_paise FROM order_items WHERE order_id = ? LIMIT 1', orderId);
  const returnId = await run(db, "INSERT INTO returns (order_id, order_item_id, user_id, qty, reason, status, created_at, updated_at) VALUES (?,?,?,1,'changed mind','requested', now(), now())",
    orderId, item.id, asha.id);
  await emit(db, 'return.requested', 'return', returnId, { order_id: orderId, order_item_id: item.id, qty: 1 });
  await dispatch(db);
  await work(db, { seconds: 20 });
  // The newest message is the one this test caused: the job before it was the payment text.
  const approved = await one(db, 'SELECT * FROM sms_messages ORDER BY id DESC LIMIT 1');
  assert.match(approved.body, new RegExp(`return #${returnId}`));
});

test('the morning reminder texts only orders due today, once', async () => {
  const shipment = await one(db, "SELECT id, order_id FROM shipments WHERE status NOT IN ('delivered','cancelled','returned') ORDER BY id LIMIT 1");
  const today = new Date().toISOString().slice(0, 10);
  await run(db, 'UPDATE shipments SET eta = ? WHERE id = ?', today, shipment.id);
  const first = await smsArrivingToday(db, { at: new Date() });
  assert.ok(first.sent >= 1, 'at least the shipment due today was texted: ' + JSON.stringify(first));
  const reminder = await one(db, "SELECT * FROM sms_messages WHERE body LIKE '%arrives today%' ORDER BY id DESC LIMIT 1");
  assert.match(reminder.body, new RegExp(`order #${shipment.order_id}`));
  // Running again on the same day sends nothing.
  const second = await smsArrivingToday(db, { at: new Date() });
  assert.equal(second.sent, 0);
});
