// Sending email through Gmail SMTP, and draining the outbox.
//
// Every setting comes from the environment (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS,
// MAIL_FROM); none of them is written here. When they are missing the mailer reports that it is
// not configured and the outbox is left exactly as it is, which is how the app behaved before
// delivery existed.
import nodemailer from 'nodemailer';
import { all, one, run } from './db.js';
import { log } from './log.js';

// One attempt plus up to three retries; after that the message is marked failed and stays visible.
export const MAX_ATTEMPTS = 4;
// A row claimed by a worker that died is claimed again after this long, so a crash cannot strand it.
const CLAIM_TIMEOUT_MINUTES = 10;

const settings = () => ({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  user: process.env.SMTP_USER,
  pass: process.env.SMTP_PASS,
  from: process.env.MAIL_FROM,
});

export const smtpConfigured = () => {
  const s = settings();
  return Boolean(s.host && s.user && s.pass && s.from);
};

// One pooled transport, reused for every message, with bounded waits. Both parts matter: a
// transport per message paid a TLS handshake per email (about 3 s each, so a batch of 20 took
// minutes), and a connection with no timeout could hang a whole batch in 'sending'.
//
// On a machine whose TLS is inspected (a corporate proxy re-signs the certificate chain), Node
// refuses the connection with 'self-signed certificate in certificate chain'. Start the app with
// `node --use-system-ca app.js` so Node trusts the operating system's certificate store. Never
// fix this by turning verification off: the SMTP password travels inside that connection.
let pooled = null;
let pooledKey = '';

function transport() {
  const s = settings();
  const key = `${s.host}|${s.port}|${s.user}`;
  if (pooled && pooledKey === key) return pooled;
  pooled = nodemailer.createTransport({
    host: s.host,
    port: s.port || 587,
    secure: (s.port || 587) === 465, // 465 is TLS from the first byte; 587 upgrades with STARTTLS
    auth: { user: s.user, pass: s.pass },
    pool: true,
    maxConnections: 3,
    maxMessages: 50,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  pooledKey = key;
  return pooled;
}

// Drop the pool (tests, shutdown, or after a settings change).
export function closeMailer() {
  if (pooled) pooled.close();
  pooled = null;
  pooledKey = '';
}

// The one place that touches the network. Kept small so a test can hand in its own implementation.
export async function sendEmail(to, subject, body) {
  if (!smtpConfigured()) throw new Error('SMTP is not configured.');
  const s = settings();
  const info = await transport().sendMail({ from: s.from, to, subject, text: body });
  return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
}

// Claim a small batch. The guarded UPDATE means two workers never take the same row, and a row
// left in 'sending' by a crash is picked up again after CLAIM_TIMEOUT_MINUTES.
async function claim(db, limit) {
  return await all(db, `UPDATE outbox SET status = 'sending', attempts = attempts + 1, claimed_at = now()
                        WHERE id IN (SELECT id FROM outbox
                                     WHERE status = 'pending'
                                        OR (status = 'sending' AND claimed_at < now() - make_interval(mins => ?))
                                     ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED)
                        RETURNING id, to_address, subject, body, attempts`, CLAIM_TIMEOUT_MINUTES, limit);
}

const markSent = (db, id) =>
  run(db, "UPDATE outbox SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = ?", id);

const markRetry = (db, id, error) =>
  run(db, "UPDATE outbox SET status = 'pending', last_error = ? WHERE id = ?", error, id);

const markFailed = (db, id, error) =>
  run(db, "UPDATE outbox SET status = 'failed', last_error = ? WHERE id = ?", error, id);

// Send what is waiting. Each message is tried once here (the retries happen on later ticks), and a
// message that has used all its attempts is marked failed instead of being tried again.
export async function deliverOutbox(db, { mailer = sendEmail, limit = 20 } = {}) {
  if (!smtpConfigured()) {
    const waiting = await one(db, "SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'");
    log('warn', 'email delivery skipped: SMTP is not configured', {
      pending: Number(waiting.n),
      // SMTP_PORT is not listed: it falls back to 587, so it is not the reason for skipping.
      missing: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'].filter((k) => !process.env[k]),
    });
    return { skipped: true, sent: 0, failed: 0, retried: 0, pending: Number(waiting.n) };
  }

  const batch = await claim(db, limit);
  let sent = 0;
  let retried = 0;
  let failed = 0;
  for (const mail of batch) {
    try {
      await mailer(mail.to_address, mail.subject, mail.body);
      await markSent(db, mail.id);
      sent++;
    } catch (e) {
      // The address and the body are personal data: the error is masked before it is stored.
      const why = String(e?.message ?? 'unknown error').slice(0, 300);
      if (Number(mail.attempts) >= MAX_ATTEMPTS) {
        await markFailed(db, mail.id, why);
        failed++;
      } else {
        await markRetry(db, mail.id, why);
        retried++;
      }
      log('warn', 'email delivery failed', { outbox_id: Number(mail.id), attempts: Number(mail.attempts), reason: why });
    }
  }
  if (sent || retried || failed) log('info', 'email delivery', { sent, retried, failed });
  return { skipped: false, sent, retried, failed, pending: 0 };
}
