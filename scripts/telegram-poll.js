// Local development helper: Telegram cannot reach http://localhost, so instead of a webhook
// this script asks Telegram for new messages and feeds them to the same handler the webhook
// uses. Run it next to `node app.js`:
//
//   node scripts/telegram-poll.js        (reads TELEGRAM_BOT_TOKEN from .env)
//
// It prints nothing but errors; replies are sent by the bot itself.
import path from 'node:path';
import { loadEnv } from '../src/env.js';
import { createSender, handleUpdate } from '../src/telegram.js';
import { openDatabase } from '../src/server.js';

loadEnv();
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Set TELEGRAM_BOT_TOKEN in your environment (or a local .env) first.');
  process.exit(1);
}

const target = process.env.DATABASE_URL || path.join('data', 'pg');
const db = await openDatabase(target);
const send = createSender();
let offset = 0;

const stop = async () => {
  await db.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

console.log('Listening for Telegram messages. Press Ctrl+C to stop.');
for (;;) {
  let updates = [];
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?timeout=25&offset=${offset}`, {
      signal: AbortSignal.timeout(40_000),
    });
    const body = await res.json();
    if (!body.ok) {
      console.error('getUpdates failed:', body.description || res.status);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    updates = body.result || [];
  } catch (e) {
    console.error('getUpdates error:', e.message);
    await new Promise((r) => setTimeout(r, 5000));
    continue;
  }
  for (const update of updates) {
    offset = update.update_id + 1;
    try {
      await handleUpdate(db, update, { send });
      console.log('handled update', update.update_id);
    } catch (e) {
      console.error('update failed:', e.message);
    }
  }
}
