// The Telegram bot: linking by one-time code, the answers it gives each role, and the rule that
// one customer can never see another's order through a chat.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { handleApi } from '../src/api.js';
import { settings } from '../src/auth.js';
import { one, run } from '../src/db.js';
import { openDatabase } from '../src/server.js';
import { handleUpdate, issueLinkCode, linkFor, replyFor, webhookReply } from '../src/telegram.js';

settings.fastHashing = true;
process.env.EQUIDRON_SEED_DEMO = '1';
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_WEBHOOK_SECRET = 'test-secret';

let db;
let asha;
let rahul;
let sellerUser;
let rahulOrderId;
before(async () => {
  db = await openDatabase('memory');
  asha = await one(db, "SELECT id, name, role FROM users WHERE email = 'asha@example.com'");
  rahul = await one(db, "SELECT id, name, role FROM users WHERE email = 'rahul@example.com'");
  sellerUser = await one(db, `SELECT u.id, u.name, u.role FROM users u JOIN sellers s ON s.user_id = u.id
                              WHERE u.email = 'techbazaar.seller@example.com'`);

  // One order for Rahul, so we can try to read it from Asha's chat.
  const address = JSON.stringify({ name: 'Rahul', line1: '2 Road', city: 'Delhi', pincode: '110001', phone: '9000000000' });
  rahulOrderId = await run(db, `INSERT INTO orders (user_id, address, status, payment_status, fulfilment_status, payment_method,
                                subtotal_paise, shipping_paise, total_paise, created_at, updated_at)
                                VALUES (?, ?, 'confirmed', 'captured', 'pending', 'card', 100000, 0, 100000, now(), now())`,
  rahul.id, address);
});
after(async () => { await db?.close(); });

function capture() {
  const messages = [];
  return { messages, send: async (chatId, text) => { messages.push({ chatId, text }); } };
}
const update = (chatId, text) => ({ update_id: 1, message: { message_id: 1, chat: { id: chatId, type: 'private' }, from: { id: chatId }, text } });
const say = async (chatId, text) => {
  const c = capture();
  await handleUpdate(db, update(chatId, text), { send: c.send });
  return c.messages.map((m) => m.text).join('\n');
};

test('an unlinked chat is told how to link, and can still search products', async () => {
  const orders = await say(1001, '/orders');
  assert.match(orders, /not linked/i);
  assert.match(orders, /\/start 123456/);

  const products = await say(1001, '/products laptop');
  assert.match(products, /Found \d+ for "laptop"/);
  assert.match(products, /₹/);
});

test('a one-time code links the chat to the account, and can only be used once', async () => {
  const { code, expires_in_seconds } = await issueLinkCode(db, asha);
  assert.match(code, /^\d{6}$/);
  assert.equal(expires_in_seconds, 600);

  assert.match(await say(2002, '/start 000000'), /not right/i);
  assert.match(await say(2002, `/start ${code}`), /Linked to Asha Rao/);
  const link = await linkFor(db, 2002);
  assert.equal(link.user_id, asha.id);
  assert.equal(link.role, 'customer');

  // The same code cannot link a second chat.
  assert.match(await say(2003, `/start ${code}`), /not right/i);
  assert.equal(await linkFor(db, 2003), null);
});

test('a customer sees their own orders, and never another customer’s', async () => {
  const list = await say(2002, '/orders');
  assert.match(list, /Your last \d order/);

  const mine = (await one(db, 'SELECT id FROM orders WHERE user_id = ? ORDER BY id LIMIT 1', asha.id)).id;
  const detail = await say(2002, `/order ${mine}`);
  assert.match(detail, new RegExp(`Order #${mine}`));
  assert.match(detail, /Total/);

  const theirs = await say(2002, `/order ${rahulOrderId}`);
  assert.match(theirs, /could not find/i);
  assert.doesNotMatch(theirs, /1000/); // no trace of Rahul's total
});

test('a seller sees only their own order lines', async () => {
  const { code } = await issueLinkCode(db, sellerUser);
  assert.match(await say(3003, `/start ${code}`), /Linked to .*\(seller\)/);

  const list = await say(3003, '/orders');
  assert.ok(/Orders to act on|Nothing is waiting/.test(list), list);

  // Rahul's order has no items at all, so nothing of this seller's is in it.
  const detail = await say(3003, `/order ${rahulOrderId}`);
  assert.match(detail, /could not find order .* among your items/i);
  assert.doesNotMatch(detail, /Sonique/);
});

test('product questions work for a linked customer too', async () => {
  const found = await say(2002, '/products laptop');
  assert.match(found, /laptop/i);
  const number = /\/product (\d+)/.exec(found)?.[1];
  if (number) {
    const one1 = await say(2002, `/product ${number}`);
    assert.match(one1, /₹/);
  }
});

test('abuse in a chat is refused by the same guardrail as the website', async () => {
  const reply = await say(2002, 'you are an idiot');
  assert.match(reply, /respectful/i);
  const event = await one(db, "SELECT * FROM guardrail_events WHERE area = 'telegram' ORDER BY id DESC LIMIT 1");
  assert.equal(event.role, 'customer');
  assert.equal(event.severity, 'refuse');
});

test('/unlink removes the link but changes nothing about the account', async () => {
  assert.match(await say(2002, '/unlink'), /no longer linked/i);
  assert.equal(await linkFor(db, 2002), null);
  assert.match(await say(2002, '/orders'), /not linked/i);
  const stillThere = await one(db, 'SELECT COUNT(*) AS n FROM orders WHERE user_id = ?', asha.id);
  assert.ok(Number(stillThere.n) > 0, 'the account still has its orders');
});

test('the webhook needs its secret, and answers 200 when it is right', async () => {
  const noSecret = await webhookReply(db, { headers: {}, body: update(4004, '/help') });
  assert.equal(noSecret.status, 403);
  const wrong = await webhookReply(db, { headers: { 'x-telegram-bot-api-secret-token': 'nope' }, body: update(4004, '/help') });
  assert.equal(wrong.status, 403);

  const c = capture();
  const ok = await webhookReply(db, { headers: { 'x-telegram-bot-api-secret-token': 'test-secret' }, body: update(4004, '/help'), send: c.send });
  assert.equal(ok.status, 200);
  assert.match(c.messages[0].text, /\/orders/);
});

test('the link-code route needs a signed-in customer and returns a command', async () => {
  const cookies = {};
  const call = async (method, path, body) => {
    const out = await handleApi(db, { method, path, query: new URLSearchParams(), body, cookies });
    if (out.setCookie) {
      const [k, v] = out.setCookie.split(';')[0].split('=');
      if (v) cookies[k] = v; else delete cookies[k];
    }
    return out;
  };
  assert.equal((await call('POST', '/api/shop/telegram/link-code')).status, 401);
  assert.equal((await call('POST', '/api/shop/login', { email: 'asha@example.com', password: 'equidron-demo' })).status, 200);
  const out = await call('POST', '/api/shop/telegram/link-code');
  assert.equal(out.status, 200);
  assert.match(out.payload.command, /^\/start \d{6}$/);
  assert.equal(out.payload.expires_in_seconds, 600);
});

test('replyFor works without a chat link for public product data only', async () => {
  assert.match(await replyFor(db, { chatId: 5005, text: '/help' }), /\/products/);
  assert.match(await replyFor(db, { chatId: 5005, text: '/order 1' }), /not linked/i);
});
