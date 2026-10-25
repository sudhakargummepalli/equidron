// Phase 6: the response timers and the one-tap rating. A ticket is due a first reply within four
// hours; the first staff reply stops that clock; closing records the resolution; the customer may
// rate it once, afterwards.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { handleApi } from '../src/api.js';
import { settings } from '../src/auth.js';
import { one, run } from '../src/db.js';
import * as orders from '../src/orders.js';
import { openDatabase } from '../src/server.js';

settings.fastHashing = true;
process.env.EQUIDRON_SEED_DEMO = '1';

let db;
let asha;
let rahul;
before(async () => {
  db = await openDatabase('memory');
  asha = await one(db, "SELECT id FROM users WHERE email = 'asha@example.com'");
  rahul = await one(db, "SELECT id FROM users WHERE email = 'rahul@example.com'");
});
after(async () => { await db?.close(); });

test('a new ticket is due a first reply four hours later', async () => {
  const id = await orders.createTicket(db, asha.id, null, 'Timer check', 'When will this be answered?');
  const t = await one(db, 'SELECT * FROM support_tickets WHERE id = ?', id);
  assert.ok(t.first_response_due_at, 'a deadline is set');
  const hours = (new Date(t.first_response_due_at) - new Date(t.created_at)) / 3_600_000;
  assert.ok(hours > 3.9 && hours < 4.1, `about four hours, got ${hours}`);
  const [row] = await orders.listTickets(db, asha.id);
  assert.equal(row.first_response_breached, false, 'not overdue yet');
});

test('the first staff reply stops the clock, and the status becomes answered', async () => {
  const id = await orders.createTicket(db, asha.id, null, 'Reply check', 'Any update?');
  await orders.replyTicket(db, id, 'ops', 'We are on it.', false);
  const t = await one(db, 'SELECT * FROM support_tickets WHERE id = ?', id);
  assert.ok(t.first_response_at, 'the first response is recorded');
  assert.equal(t.status, 'answered');
  // A second staff reply does not move the first-response time.
  await orders.replyTicket(db, id, 'ops', 'Still on it.', false);
  const again = await one(db, 'SELECT first_response_at FROM support_tickets WHERE id = ?', id);
  assert.deepEqual(again.first_response_at, t.first_response_at);
});

test('an agent reply counts as a first response too, and tells the customer', async () => {
  const id = await orders.createTicket(db, asha.id, null, 'Agent check', 'Please help.');
  await orders.replyTicket(db, id, 'support', 'Hello, I can help.', false);
  const t = await one(db, 'SELECT * FROM support_tickets WHERE id = ?', id);
  assert.ok(t.first_response_at);
  assert.equal(t.status, 'answered');
  const note = await one(db, 'SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1', asha.id);
  assert.match(note.message, /replied/i);
});

test('closing a ticket records when it was resolved', async () => {
  const id = await orders.createTicket(db, asha.id, null, 'Close check', 'Done?');
  await orders.replyTicket(db, id, 'ops', 'All sorted.', true);
  const t = await one(db, 'SELECT * FROM support_tickets WHERE id = ?', id);
  assert.equal(t.status, 'closed');
  assert.ok(t.resolved_at, 'the resolution time is kept');
});

test('a late reply is visible as a breach in the ops list', async () => {
  const id = await orders.createTicket(db, asha.id, null, 'Late reply', 'This one will be late.');
  // Push the deadline into the past, the way waiting would.
  await run(db, "UPDATE support_tickets SET first_response_due_at = now() - interval '1 hour' WHERE id = ?", id);
  await run(db, "UPDATE support_tickets SET first_response_at = now() WHERE id = ?", id);
  const rows = await orders.listTickets(db);
  const t = rows.find((r) => r.id === id);
  assert.equal(t.first_response_breached, true, 'answered after the deadline');
});

test('the rating: once, by the owner, only after the ticket closes', async () => {
  const id = await orders.createTicket(db, asha.id, null, 'Rating check', 'Please close this.');
  await assert.rejects(() => orders.rateTicket(db, asha.id, id, 5), /once it is closed/);

  await orders.replyTicket(db, id, 'ops', 'All done.', true);
  const rated = await orders.rateTicket(db, asha.id, id, 4);
  assert.equal(rated.rating, 4);
  assert.ok((await one(db, 'SELECT rated_at FROM support_tickets WHERE id = ?', id)).rated_at);

  await assert.rejects(() => orders.rateTicket(db, asha.id, id, 5), /already has your rating/);
  await assert.rejects(() => orders.rateTicket(db, rahul.id, id, 5), /Ticket/i);
  const fresh = await orders.createTicket(db, asha.id, null, 'Rating range', 'Close this too.');
  await orders.replyTicket(db, fresh, 'ops', 'Done.', true);
  await assert.rejects(() => orders.rateTicket(db, asha.id, fresh, 9), /1 to 5/);
});

test('the rating route takes the owner from the session, not the body', async () => {
  const id = await orders.createTicket(db, asha.id, null, 'Route rating', 'Closing now.');
  await orders.replyTicket(db, id, 'ops', 'Done.', true);

  const ashaCookies = {};
  const ashaCall = async (method, path, body) => {
    const out = await handleApi(db, { method, path, query: new URLSearchParams(), body, cookies: ashaCookies });
    if (out.setCookie) {
      const [k, v] = out.setCookie.split(';')[0].split('=');
      if (v) ashaCookies[k] = v; else delete ashaCookies[k];
    }
    return out;
  };
  assert.equal((await ashaCall('POST', '/api/shop/login', { email: 'asha@example.com', password: 'equidron-demo' })).status, 200);
  const ok = await ashaCall('POST', `/api/shop/support/${id}/rating`, { stars: 5, user_id: rahul.id });
  assert.equal(ok.status, 200);
  assert.equal(ok.payload.rating, 5);
  // Rahul, signed in, cannot rate a ticket that is not his.
  const rahulCookies = {};
  const rahulCall = async (method, path, body) => {
    const out = await handleApi(db, { method, path, query: new URLSearchParams(), body, cookies: rahulCookies });
    if (out.setCookie) {
      const [k, v] = out.setCookie.split(';')[0].split('=');
      if (v) rahulCookies[k] = v; else delete rahulCookies[k];
    }
    return out;
  };
  await rahulCall('POST', '/api/shop/login', { email: 'rahul@example.com', password: 'equidron-demo' });
  const other = await rahulCall('POST', `/api/shop/support/${id}/rating`, { stars: 1 });
  assert.equal(other.status, 404);
});
