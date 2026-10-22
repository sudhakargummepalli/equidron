// Sending the outbox through SMTP: a fake mailer stands in for Gmail, so no test ever sends a
// real email. Covers delivered, retried, failed for good, and what happens with no settings.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { all, one, run } from '../src/db.js';
import { runsOutsideTransaction } from '../src/jobs.js';
import { deliverOutbox, MAX_ATTEMPTS, needsDelivery, smtpConfigured } from '../src/mailer.js';
import { openDatabase } from '../src/server.js';

// Each block gets its own database, so one block's leftover rows cannot change another's counts.
let db;

const ENV = { SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_USER: 'bot@example.test', SMTP_PASS: 'not-a-real-password', MAIL_FROM: 'Equidron <no-reply@example.test>' };

function configure() {
  for (const [k, v] of Object.entries(ENV)) process.env[k] = v;
}
function unconfigure() {
  for (const k of Object.keys(ENV)) delete process.env[k];
}

async function addMail(fields = {}) {
  const mail = { to: 'asha@example.com', subject: `Test ${Math.random().toString(36).slice(2, 8)}`, body: 'Hello from a test.', ...fields };
  mail.id = await run(db, "INSERT INTO outbox (user_id, channel, to_address, subject, body, at) VALUES (NULL, 'email', ?, ?, ?, now())",
    mail.to, mail.subject, mail.body);
  return mail;
}

// A fake mailer: records every call and can be told to fail.
function fakeMailer({ failTimes = 0 } = {}) {
  const calls = [];
  let failures = 0;
  return {
    calls,
    async send(to, subject, body) {
      calls.push({ to, subject, body });
      if (failures < failTimes) { failures++; throw new Error('550 mailbox unavailable'); }
      return { messageId: 'fake' };
    },
  };
}

const row = (id) => one(db, 'SELECT status, attempts, last_error, sent_at FROM outbox WHERE id = ?', id);

test('the job kind runs outside the database transaction, like an agent run', () => {
  assert.equal(runsOutsideTransaction('email:deliver'), true);
});

describe('with no SMTP settings', () => {
  before(async () => { db = await openDatabase('memory'); unconfigure(); });
  after(async () => { await db.close(); configure(); });

  test('nothing is sent, the message stays pending, and the call says it was skipped', async () => {
    assert.equal(smtpConfigured(), false);
    const mail = await addMail();
    const mailer = fakeMailer();
    const out = await deliverOutbox(db, { mailer: mailer.send });

    assert.equal(out.skipped, true);
    assert.equal(mailer.calls.length, 0, 'no email is attempted without settings');
    const after1 = await row(mail.id);
    assert.equal(after1.status, 'pending');
    assert.equal(Number(after1.attempts), 0, 'a skip is not an attempt');
  });
});

describe('with SMTP settings', () => {
  before(async () => { db = await openDatabase('memory'); configure(); });
  after(async () => { await db.close(); });

  test('a waiting message is sent once and marked sent', async () => {
    const mail = await addMail({ to: 'rahul@example.com', subject: 'Your order is confirmed', body: 'Order #42 is confirmed.' });
    const mailer = fakeMailer();
    const out = await deliverOutbox(db, { mailer: mailer.send });

    assert.equal(out.sent, 1);
    assert.equal(mailer.calls.length, 1);
    assert.deepEqual(mailer.calls[0], { to: 'rahul@example.com', subject: 'Your order is confirmed', body: 'Order #42 is confirmed.' });
    const sent = await row(mail.id);
    assert.equal(sent.status, 'sent');
    assert.ok(sent.sent_at, 'sent_at is recorded');
    assert.equal(Number(sent.attempts), 1);
  });

  test('a message already sent is never sent again', async () => {
    const mail = await addMail();
    const first = fakeMailer();
    await deliverOutbox(db, { mailer: first.send });
    const second = fakeMailer();
    await deliverOutbox(db, { mailer: second.send });

    assert.equal(first.calls.length, 1);
    assert.equal(second.calls.length, 0, 'the second run has nothing to do');
    assert.equal((await row(mail.id)).status, 'sent');
  });

  test('a failure is retried, then marked failed after the last attempt', async () => {
    const mail = await addMail({ subject: 'Will never arrive' });
    const mailer = fakeMailer({ failTimes: 99 });

    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      await deliverOutbox(db, { mailer: mailer.send });
      const now = await row(mail.id);
      assert.equal(now.status, 'pending', `still pending after attempt ${attempt}`);
      assert.equal(Number(now.attempts), attempt);
      assert.match(now.last_error, /550/, 'the reason is kept for Ops to read');
    }

    // The last attempt: it is given up on rather than retried for ever.
    await deliverOutbox(db, { mailer: mailer.send });
    const failed = await row(mail.id);
    assert.equal(failed.status, 'failed');
    assert.equal(Number(failed.attempts), MAX_ATTEMPTS);
    assert.match(failed.last_error, /550/);
    assert.equal(mailer.calls.length, MAX_ATTEMPTS, 'one call per attempt');

    // A failed message is not picked up again.
    await deliverOutbox(db, { mailer: mailer.send });
    assert.equal(mailer.calls.length, MAX_ATTEMPTS);
    // And it is still visible in Ops, with the reason.
    const listed = await all(db, "SELECT * FROM outbox WHERE status = 'failed'");
    assert.ok(listed.some((m) => m.id === mail.id));
  });

  test('the tick queues one delivery a minute, and none when nothing is pending', async () => {
    const { tick } = await import('../src/jobs.js');
    const at = new Date('2026-10-22T09:00:00Z');

    const mail = await addMail({ subject: 'Queued by the tick' });
    const first = await tick(db, { at });
    assert.ok(first.enqueued.includes('email:deliver'), 'a pending message queues delivery');

    const sameMinute = await tick(db, { at });
    assert.ok(!sameMinute.enqueued.includes('email:deliver'), 'the same minute cannot queue twice');

    const mailer = fakeMailer();
    await deliverOutbox(db, { mailer: mailer.send });
    assert.equal((await row(mail.id)).status, 'sent');

    const later = await tick(db, { at: new Date(at.getTime() + 60_000) });
    assert.ok(!later.enqueued.includes('email:deliver'), 'nothing pending, so no job');
  });

  test('a row left in sending by a dead worker is picked up once its claim is old', async () => {
    const mail = await addMail({ subject: 'Abandoned mid-send' });
    // A worker claimed it, then died: 'sending', with an old claim.
    await run(db, "UPDATE outbox SET status = 'sending', attempts = 1, claimed_at = now() - interval '11 minutes' WHERE id = ?", mail.id);
    assert.equal(await needsDelivery(db), true, 'the tick must still queue a delivery');

    const mailer = fakeMailer();
    const out = await deliverOutbox(db, { mailer: mailer.send });
    assert.equal(out.sent, 1, 'the abandoned row is sent, not stranded');
    assert.equal((await row(mail.id)).status, 'sent');

    // A fresh claim (younger than the timeout) is left alone, so a live worker keeps its row.
    const busy = await addMail({ subject: 'Still being sent' });
    await run(db, "UPDATE outbox SET status = 'sending', attempts = 1, claimed_at = now() WHERE id = ?", busy.id);
    const second = fakeMailer();
    await deliverOutbox(db, { mailer: second.send });
    assert.equal(second.calls.length, 0, 'a recent claim is not stolen');
    assert.equal((await row(busy.id)).status, 'sending');

    assert.equal(await needsDelivery(db), false, 'nothing left to do');
  });
});
