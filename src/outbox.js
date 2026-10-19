// The outbox: messages Equidron would send by email. Until a real email provider is
// connected (Phase 10), nothing leaves the app: messages wait here, and an Ops admin
// can read them on the Outbox page, so sign-up and password-reset codes can be tried.
import { all, now, run } from './db.js';

export async function sendEmail(db, userId, to, subject, body) {
  await run(db, 'INSERT INTO outbox (user_id, channel, to_address, subject, body, at) VALUES (?,?,?,?,?,?)',
    userId, 'email', to, subject, body, now());
}

export async function listOutbox(db) {
  return await all(db, 'SELECT * FROM outbox ORDER BY id DESC LIMIT 100');
}
