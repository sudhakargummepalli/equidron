// The Telegram bot: customers and sellers ask about their own orders and about products, in a
// chat, and get an answer from the same service functions the website uses.
//
// Two rules shape it:
//   - A chat is linked to an account by a one-time code issued from a signed-in session. A bot
//     never asks for a password, and an unlinked chat can only ask for products (public data).
//   - Everything about an order is fetched with that account's id, so one customer can never
//     see another's order through the bot, exactly as on the website.
//
// It is a command bot, not a model: Telegram replies have to be fast and predictable, and the
// data is already shaped for a human. Free text is treated as a product search.
import crypto from 'node:crypto';
import { search, productDetail } from './catalog.js';
import { all, one, run } from './db.js';
import { AppError } from './errors.js';
import { guardText } from './guardrails.js';
import { sellerListings } from './listings.js';
import { log } from './log.js';
import { getOrder, inr, listOrders, sellerOrders } from './orders.js';

const CODE_TTL_SECONDS = 10 * 60;
const MAX_TEXT = 500; // a chat question, not a document
const MAX_REPLY = 3800; // Telegram's own limit is 4096

export const botConfigured = () => Boolean(process.env.TELEGRAM_BOT_TOKEN);
export const botUsername = () => process.env.TELEGRAM_BOT_USERNAME || null;

const hash = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');
const sameSecret = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ---------------------------------------------------------------- linking

// A six-digit code, valid for ten minutes, shown to the signed-in person on the website.
export async function issueLinkCode(db, user) {
  if (!['customer', 'seller'].includes(user.role)) {
    throw new AppError(400, 'Only a customer or a seller account can connect Telegram.');
  }
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await run(db, `INSERT INTO telegram_link_codes (user_id, code_hash, expires_at, attempts, created_at)
                 VALUES (?,?,?,0, now())
                 ON CONFLICT (user_id) DO UPDATE SET code_hash = EXCLUDED.code_hash,
                   expires_at = EXCLUDED.expires_at, attempts = 0, created_at = now()`,
  user.id, hash(code), Date.now() / 1000 + CODE_TTL_SECONDS);
  return { code, expires_in_seconds: CODE_TTL_SECONDS };
}

// `/start 123456`: the code is matched by its hash, so the table never holds a usable code.
export async function linkChat(db, chatId, code) {
  const row = await one(db, `SELECT c.user_id, c.expires_at, c.attempts, u.role, u.name
                             FROM telegram_link_codes c JOIN users u ON u.id = c.user_id
                             WHERE c.code_hash = ?`, hash(String(code).trim()));
  if (!row) {
    // Count the miss against every pending code from this chat is impossible; instead cap the
    // attempts per code so guessing is bounded.
    await run(db, 'UPDATE telegram_link_codes SET attempts = attempts + 1 WHERE attempts < 5');
    return { ok: false, message: 'That code is not right. Send the six digits shown on the website, or get a new code.' };
  }
  if (row.expires_at < Date.now() / 1000) {
    await run(db, 'DELETE FROM telegram_link_codes WHERE user_id = ?', row.user_id);
    return { ok: false, message: 'That code has expired. Get a fresh one from the website.' };
  }
  if (!['customer', 'seller'].includes(row.role)) {
    return { ok: false, message: 'This account cannot use the bot.' };
  }
  await run(db, `INSERT INTO telegram_links (chat_id, user_id, role, linked_at, last_seen_at)
                 VALUES (?,?,?, now(), now())
                 ON CONFLICT (chat_id) DO UPDATE SET user_id = EXCLUDED.user_id, role = EXCLUDED.role,
                   linked_at = now(), last_seen_at = now()`, chatId, row.user_id, row.role);
  await run(db, 'DELETE FROM telegram_link_codes WHERE user_id = ?', row.user_id);
  return { ok: true, message: `Linked to ${row.name} (${row.role}). You can ask:\n/orders — your orders\n/order 12 — one order\n/products laptop — find a product\n/help — everything else` };
}

export const unlink = (db, chatId) => run(db, 'DELETE FROM telegram_links WHERE chat_id = ?', chatId);
export const linkFor = (db, chatId) => one(db, 'SELECT * FROM telegram_links WHERE chat_id = ?', chatId);

// ---------------------------------------------------------------- replies

const HELP = `I can answer these:
/orders — your last orders
/order 12 — one order, with its shipments and tracking
/products laptop — search the catalogue
/product 75 — one product and every seller's price
/help — this list
/unlink — stop using this chat
Anything else you type is treated as a product search.`;

const NOT_LINKED = `This chat is not linked to an account yet.
Sign in on the website, choose "Connect Telegram", and send me the six-digit code like this:
/start 123456`;

const rupees = (paise) => (paise == null ? '—' : inr(paise));
const date = (value) => String(value ?? '').slice(0, 10);

async function customerCity(db, userId) {
  const a = await one(db, 'SELECT city FROM addresses WHERE user_id = ? ORDER BY id LIMIT 1', userId);
  return a?.city ?? null;
}

async function customerOrders(db, link) {
  const orders = await listOrders(db, link.user_id);
  if (!orders.length) return 'You have no orders yet. Browse the store, and your orders will show up here.';
  const lines = orders.slice(0, 5).map((o) => `#${o.id} · ${o.status} · ${o.payment_status} · ${rupees(o.total_paise)} · ${date(o.created_at)}`);
  return `Your last ${lines.length} order(s):\n${lines.join('\n')}\n\nSend /order <number> for the details.`;
}

async function customerOrder(db, link, id) {
  let order;
  try {
    order = await getOrder(db, Number(id), link.user_id); // scoped: someone else's id is "not found"
  } catch (e) {
    if (e instanceof AppError && e.status === 404) return `I could not find order ${id} on your account. Send /orders to list your orders.`;
    throw e;
  }
  const lines = [`Order #${order.id} · ${order.status} · payment ${order.payment_status}`, `Total ${rupees(order.total_paise)} · placed ${date(order.created_at)}`];
  for (const s of order.shipments) {
    const items = s.items.map((i) => `${i.title} × ${i.qty}`).join(', ');
    lines.push(`• ${s.status}${s.tracking_no ? ` · tracking ${s.tracking_no}` : ''}${s.eta ? ` · by ${date(s.eta)}` : ''}\n  ${items}`);
  }
  const returns = order.returns.length ? `\nReturns: ${order.returns.map((r) => `${r.title} (${r.status})`).join(', ')}` : '';
  return `${lines.join('\n')}${returns}\n\nSend /orders to see other orders.`;
}

async function sellerOpenOrders(db, link) {
  const seller = await one(db, 'SELECT id FROM sellers WHERE user_id = ?', link.user_id);
  if (!seller) return 'This account is not a seller any more.';
  const lines = (await sellerOrders(db, seller.id))
    .filter((l) => l.seller_can_advance || ['confirmed'].includes(l.order_status))
    .slice(0, 8);
  if (!lines.length) return 'Nothing is waiting for you: no order needs a dispatch right now.';
  return `Orders to act on:\n${lines.map((l) => `#${l.order_id} · order ${l.order_status} · ${l.shipment_status} · ${l.title} × ${l.qty}${l.seller_can_advance ? ` · next: ${l.next_stage}` : ''}`).join('\n')}\n\nSend /order <number> for the lines.`;
}

async function sellerOrder(db, link, id) {
  const seller = await one(db, 'SELECT id FROM sellers WHERE user_id = ?', link.user_id);
  if (!seller) return 'This account is not a seller any more.';
  const lines = (await sellerOrders(db, seller.id)).filter((l) => String(l.order_id) === String(id));
  if (!lines.length) return `I could not find order ${id} among your items. Send /orders to list them.`;
  const head = `Order #${id} · ${lines[0].order_status} · payment ${lines[0].payment_status}`;
  const body = lines.map((l) => `• ${l.title} × ${l.qty} · ${l.shipment_status}${l.tracking_no ? ` · ${l.tracking_no}` : ''} · to ${l.city}${l.seller_can_advance ? ` · next: ${l.next_stage}` : ''}`);
  return `${head}\n${body.join('\n')}\n\nDispatch from Seller Central → Orders.`;
}

async function productSearch(db, query, city) {
  const results = await search(db, String(query).slice(0, 80), null, 'relevance', city);
  if (!results.length) return `I found nothing for "${query}". Try a shorter word, such as "laptop" or "earbuds".`;
  const lines = results.slice(0, 5).map((p) => {
    const price = p.featured_offer ? rupees(p.featured_offer.price_paise) : rupees(p.min_price_paise);
    const stock = p.featured_offer ? 'in stock' : p.in_stock ? 'not deliverable here' : 'out of stock';
    return `• ${p.title} — ${price} · ${stock}`;
  });
  return `Found ${results.length} for "${query}":\n${lines.join('\n')}\n\nSend /product <number> for one product.`;
}

async function productOne(db, id, city) {
  let p;
  try {
    p = await productDetail(db, Number(id), city);
  } catch (e) {
    if (e instanceof AppError && e.status === 404) return `I could not find product ${id}.`;
    throw e;
  }
  const offers = p.offers.map((o) => `• ${o.seller_name} — ${rupees(o.price_paise)} · ${o.condition} · ${o.available ? 'in stock' : 'out of stock'}${o.deliverable ? '' : ' · not to your city'}`);
  return `${p.title}\n${p.brand} · ${p.category} · rated ${p.rating}\n\n${offers.join('\n')}\n\n${p.return_window_days ? `Returnable within ${p.return_window_days} days.` : 'Not returnable.'}`;
}

// One update in, one reply out. Pure enough to test with a captured `send`.
export async function replyFor(db, { chatId, text }) {
  const link = await linkFor(db, chatId);
  const [head, ...rest] = String(text).trim().split(/\s+/);
  const command = head.toLowerCase();
  const arg = rest.join(' ').trim();

  if (command === '/start' || command.startsWith('/start@')) {
    if (!arg) return `Hello! I can tell you about your own orders and about products.\n\n${link ? 'This chat is already linked. Send /orders or /products laptop.' : NOT_LINKED}`;
    const result = await linkChat(db, chatId, arg);
    return result.message;
  }
  if (command === '/help' || command.startsWith('/help@')) return HELP;
  if (command === '/unlink' || command.startsWith('/unlink@')) {
    await unlink(db, chatId);
    return 'This chat is no longer linked. Your account and orders are unchanged.';
  }

  if (command === '/products' || command === '/product') {
    // A product is public data, so an unlinked chat may search too.
    if (!arg) return 'Send a word to search for, for example: /products laptop';
    return command === '/product' && /^\d+$/.test(arg)
      ? await productOne(db, arg, link ? await customerCity(db, link.user_id) : null)
      : await productSearch(db, arg, link ? await customerCity(db, link.user_id) : null);
  }

  if (!link) return NOT_LINKED;

  if (command === '/orders') {
    return link.role === 'seller' ? await sellerOpenOrders(db, link) : await customerOrders(db, link);
  }
  if (command === '/order') {
    if (!/^\d+$/.test(arg)) return 'Send the order number, for example: /order 12';
    return link.role === 'seller' ? await sellerOrder(db, link, arg) : await customerOrder(db, link, arg);
  }

  // Anything else: a product search, which is the most useful thing a stray word can do.
  return await productSearch(db, arg || String(text).trim(), link ? await customerCity(db, link.user_id) : null);
}

// ---------------------------------------------------------------- transport

// Send one plain-text message. No parse_mode: text from the database must never be interpreted
// as Telegram markup. Not async: it returns the sender function itself, so `send(...)` works
// (an async function here would hand back a Promise and every call would fail).
export function createSender() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  return async (chatId, text) => {
    if (!token) return { ok: false, reason: 'no token' };
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, MAX_REPLY), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) log('warn', 'telegram sendMessage failed', { status: res.status });
      return { ok: res.ok };
    } catch (e) {
      log('warn', 'telegram sendMessage error', { reason: e?.message ?? 'unknown' });
      return { ok: false };
    }
  };
}

// One Telegram update: screen the text, answer it, send the answer. The sender defaults to the
// real one, so a caller that forgets to pass it still replies instead of throwing "send is not a
// function" (which is exactly what happened once, silently, in a log line).
export async function handleUpdate(db, update, { send = createSender() } = {}) {
  const message = update?.message;
  const text = String(message?.text ?? '').trim();
  if (!message || !text) return { replied: false };
  const chatId = message.chat?.id;
  if (!chatId) return { replied: false };
  if (message.chat.type && message.chat.type !== 'private') {
    await send(chatId, 'Please message me privately: I can only talk about the account this chat is linked to.');
    return { replied: true };
  }
  if (text.length > MAX_TEXT) {
    await send(chatId, `That is too long for a chat. Please keep it under ${MAX_TEXT} characters.`);
    return { replied: true };
  }

  const link = await linkFor(db, chatId);
  try {
    // The same guardrails as the website chat, with the role from the link.
    await guardText(db, { role: link?.role ?? 'customer', area: 'telegram', user: link ? { id: link.user_id } : null, text });
  } catch (e) {
    if (e instanceof AppError) {
      await send(chatId, e.message);
      return { replied: true, refused: true };
    }
    throw e;
  }

  const reply = await replyFor(db, { chatId, text });
  await send(chatId, reply);
  if (link) await run(db, 'UPDATE telegram_links SET last_seen_at = now() WHERE chat_id = ?', chatId);
  return { replied: true };
}

// The webhook: Telegram calls this. It must answer 200 quickly whatever happens, or Telegram
// retries; failures are logged, not thrown back at the caller.
export async function webhookReply(db, { headers = {}, body, send = null }) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || !botConfigured()) {
    return { status: 503, payload: { ok: false, error: 'Telegram is not configured on this deployment.' }, setCookie: null };
  }
  const given = headers['x-telegram-bot-api-secret-token'];
  if (!given || !sameSecret(given, secret)) {
    return { status: 403, payload: { ok: false, error: 'Forbidden.' }, setCookie: null };
  }
  try {
    await handleUpdate(db, body, { send: send ?? createSender() });
  } catch (e) {
    log('error', 'telegram update failed', { reason: e?.message ?? 'unknown' });
  }
  return { status: 200, payload: { ok: true }, setCookie: null };
}

// Long polling, for a local run. Telegram cannot call http://localhost, so the app asks Telegram
// for new messages instead. It runs inside the app's own process because PGlite allows one
// process per database folder: a second process would fight the server for it.
export function startPolling(db, { send = createSender() } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { stop() {} };
  let stopped = false;
  let offset = 0;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  (async () => {
    while (!stopped) {
      let updates = [];
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?timeout=25&offset=${offset}`, {
          signal: AbortSignal.timeout(40_000),
        });
        const body = await res.json();
        if (!body.ok) {
          log('warn', 'telegram getUpdates refused', { status: res.status, description: body.description ?? null });
          await sleep(5000);
          continue;
        }
        updates = body.result || [];
      } catch (e) {
        log('warn', 'telegram getUpdates error', { reason: e?.message ?? 'unknown' });
        await sleep(5000);
        continue;
      }
      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          await handleUpdate(db, update, { send });
          log('info', 'telegram update handled', { update_id: update.update_id });
        } catch (e) {
          log('error', 'telegram update failed', { update_id: update.update_id, reason: e?.message ?? 'unknown' });
        }
      }
    }
  })();

  return { stop() { stopped = true; } };
}
