// Point the bot at this deployment. Run it once after a deploy:
//
//   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... node scripts/telegram-setup.js https://your-site.netlify.app
//
// It sets the webhook to <site>/api/telegram and tells Telegram to send the secret header that
// src/telegram.js checks. The secrets live in your environment / Netlify variables, never here.
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const base = process.argv[2];

if (!token || !secret || !base) {
  console.error('Usage: TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... node scripts/telegram-setup.js https://your-site');
  process.exit(1);
}

const url = `${base.replace(/\/$/, '')}/api/telegram`;
const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url, secret_token: secret, allowed_updates: ['message'] }),
});
const body = await res.json();
console.log(body.ok ? `Webhook set to ${url}` : `Failed: ${body.description || res.status}`);

const info = await (await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`)).json();
if (info.ok) console.log('Webhook info:', JSON.stringify(info.result));
