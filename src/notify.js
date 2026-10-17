import { all, now, run } from './db.js';

export function notify(db, userId, message, link = null) {
  run(db, 'INSERT INTO notifications (user_id, message, link, at) VALUES (?,?,?,?)', userId, message, link, now());
}

export function listFor(db, userId, limit = 50) {
  return all(db, 'SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?', userId, limit);
}

export function markRead(db, userId) {
  run(db, 'UPDATE notifications SET is_read = 1 WHERE user_id = ?', userId);
}
