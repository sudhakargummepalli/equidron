// JSON API for the three interfaces, independent of the HTTP layer so the same
// routes run in the local server (src/server.js) and the Netlify Function.
//
// API areas and the session role each one accepts:
//   /api/shop/...    customer   (cookie eq_shop,   Path=/api/shop)
//   /api/seller/...  seller     (cookie eq_seller, Path=/api/seller)
//   /api/ops/...     ops        (cookie eq_ops,    Path=/api/ops)
import * as assistant from './assistant.js';
import { ANONYMOUS, actingAs, audit, auditsWritten, listAudit, safeBody, setActor, userActor } from './audit.js';
import * as auth from './auth.js';
import * as catalog from './catalog.js';
import { one, scalar, transaction } from './db.js';
import { AppError } from './errors.js';
import * as listings from './listings.js';
import { mask } from './mask.js';
import * as notify from './notify.js';
import * as orders from './orders.js';
import { answerSeller } from './seller-assistant.js';
import { PAYMENT_OPTIONS } from './payments.js';
import { loadStatement } from './statement.js';

export const AREAS = { shop: 'customer', seller: 'seller', ops: 'ops' };
const SAMPLE_NOTICE = 'Sample data: every seller, product, customer and order here is fictional. Payments are simulated.';
const ROUTES = [];

// readOnly: a non-GET route that writes nothing, so it runs outside a transaction
// (the assistant waits seconds on the model and must not hold the write lock).
// prepare(body): slow work done before the transaction; its result is ctx.prepared.
// Each write route also has an audit name, used when its service functions record nothing:
// POST /orders/(\d+)/cancel in shop is "shop.orders.cancel" on entity "orders".
function route(method, area, pattern, fn, isPublic = false, { readOnly = false, prepare = null } = {}) {
  const words = pattern.split('/').filter((s) => s && !s.startsWith('('));
  const action = [area, ...words].join('.') + (method === 'POST' ? '' : `.${method.toLowerCase()}`);
  ROUTES.push({ method, area, pattern: new RegExp(`^${pattern}$`), fn, isPublic, readOnly, prepare, action, entity: words[0] || area });
}

class Reply {
  constructor(status, payload, cookie = null) {
    Object.assign(this, { status, payload, cookie });
  }
}

const int = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new AppError(400, 'Invalid request: expected a whole number.');
  return n;
};

// ---------------------------------------------------------------- shared auth routes

for (const area of Object.keys(AREAS)) {
  const role = AREAS[area];
  route('POST', area, '/login', async (c) => {
    let token;
    try {
      token = await auth.login(c.db, c.body.email, c.body.password, role);
    } catch (e) {
      // Answered, not thrown, so the record of the failed attempt is kept.
      if (!(e instanceof AppError) || e.status !== 401) throw e;
      await audit(c.db, 'auth.login_failed', 'user', mask(String(c.body.email || '').trim().toLowerCase()), null, { area });
      return new Reply(401, { error: e.message });
    }
    const user = await auth.userForToken(c.db, token, role);
    setActor(userActor(user));
    await audit(c.db, 'auth.login', 'user', user.id, null, { area });
    return new Reply(200, { user }, [area, token]);
  }, true);
  route('POST', area, '/logout', async (c) => {
    if (c.token) await auth.logout(c.db, c.token);
    return new Reply(200, { ok: true }, [area, '']);
  }, true);
  route('GET', area, '/me', async (c) => ({ user: c.user }), true);
  route('GET', area, '/notifications', async (c) => await notify.listFor(c.db, c.user.id));
  route('POST', area, '/notifications/read', async (c) => {
    await notify.markRead(c.db, c.user.id);
    return { ok: true };
  });
}

// ---------------------------------------------------------------- shop (customer)

route('GET', 'shop', '/meta', async () => ({
  cities: catalog.CITIES, categories: catalog.CATEGORIES, payment_options: PAYMENT_OPTIONS,
  sample_notice: SAMPLE_NOTICE, rank_weights: catalog.RANK_WEIGHTS,
}), true);

route('POST', 'shop', '/register', async (c) => {
  const b = c.body;
  await auth.createUser(c.db, b.email, b.name, b.password, 'customer');
  const token = await auth.login(c.db, b.email, b.password, 'customer');
  return new Reply(201, { user: await auth.userForToken(c.db, token, 'customer') }, ['shop', token]);
}, true);

route('GET', 'shop', '/search', async (c) => ({
  city: await c.city(),
  results: await catalog.search(c.db, c.q('q', ''), c.q('category') || null, c.q('sort', 'relevance'), await c.city()),
}), true);

route('GET', 'shop', '/products/(\\d+)', async (c, pid) => await catalog.productDetail(c.db, int(pid), await c.city()), true);
route('GET', 'shop', '/cart', async (c) => await orders.getCart(c.db, c.user.id));
route('POST', 'shop', '/cart', async (c) => {
  await orders.addToCart(c.db, c.user.id, int(c.body.offer_id ?? 0), c.body.qty ?? 1);
  return await orders.getCart(c.db, c.user.id);
});
route('PUT', 'shop', '/cart/(\\d+)', async (c, offerId) => {
  await orders.setCartQty(c.db, c.user.id, int(offerId), c.body.qty ?? 0);
  return await orders.getCart(c.db, c.user.id);
});
route('DELETE', 'shop', '/cart/(\\d+)', async (c, offerId) => {
  await orders.setCartQty(c.db, c.user.id, int(offerId), 0);
  return await orders.getCart(c.db, c.user.id);
});
route('GET', 'shop', '/addresses', async (c) => await orders.listAddresses(c.db, c.user.id));
route('POST', 'shop', '/addresses', async (c) => {
  await orders.addAddress(c.db, c.user.id, c.body);
  return new Reply(201, await orders.listAddresses(c.db, c.user.id));
});
route('POST', 'shop', '/checkout/preview', async (c) => await orders.checkoutPreview(c.db, c.user.id, c.body.address_id));
route('POST', 'shop', '/orders', async (c) => {
  const b = c.body;
  const res = await orders.placeOrder(c.db, c.user.id, b.address_id, b.payment_method, b.payment_token, { statement: c.prepared });
  if (res.result === 'issues') {
    return new Reply(409, { error: 'Your cart changed since you last looked. Please review the updates.',
      details: { issues: res.issues, totals: res.totals } });
  }
  if (res.result === 'payment_failed') {
    const why = res.order.payment.decline_reason;
    return new Reply(402, {
      error: b.payment_method === 'bank'
        ? `We couldn't confirm your payment: ${why} Your cart is saved.`
        : `Payment was declined (${why}). Nothing was charged and your cart is saved.`,
      details: { order: res.order },
    });
  }
  return new Reply(201, res.order);
}, false, {
  // A bank-transfer order is checked against the bank statement: fetch it before the
  // transaction so the database lock isn't held during the network call.
  prepare: (body) => (body.payment_method === 'bank' ? loadStatement() : null),
});
route('GET', 'shop', '/orders', async (c) => await orders.listOrders(c.db, c.user.id));
route('GET', 'shop', '/orders/(\\d+)', async (c, oid) => await orders.getOrder(c.db, int(oid), c.user.id));
route('POST', 'shop', '/orders/(\\d+)/cancel', async (c, oid) => await orders.cancelOrder(c.db, c.user.id, int(oid)));
route('POST', 'shop', '/orders/(\\d+)/returns', async (c, oid) => {
  const b = c.body;
  await orders.requestReturn(c.db, c.user.id, int(oid), int(b.order_item_id ?? 0), b.qty ?? 1, b.reason);
  return new Reply(201, await orders.getOrder(c.db, int(oid), c.user.id));
});
route('POST', 'shop', '/shipments/(\\d+)/confirm', async (c, sid) => {
  await orders.confirmDelivery(c.db, c.user.id, int(sid));
  return { ok: true };
});
route('GET', 'shop', '/support', async (c) => await orders.listTickets(c.db, c.user.id));
route('POST', 'shop', '/support', async (c) => {
  await orders.createTicket(c.db, c.user.id, c.body.order_id, c.body.subject, c.body.message);
  return new Reply(201, await orders.listTickets(c.db, c.user.id));
});
route('POST', 'shop', '/support/(\\d+)/reply', async (c, tid) => {
  await orders.replyTicket(c.db, int(tid), 'customer', c.body.message, false, c.user.id);
  return await orders.listTickets(c.db, c.user.id);
});

route('GET', 'shop', '/assistant', async () => ({ available: assistant.isAvailable() }), true);
route('POST', 'shop', '/assistant', async (c) =>
  assistant.answer(c.db, {
    user: c.user, city: await c.city(), voice: c.body.voice === true, language: c.body.language === 'te' ? 'te' : 'en',
  }, c.body.messages), false, { readOnly: true });

// ---------------------------------------------------------------- Seller Central

route('GET', 'seller', '/meta', async () => ({
  cities: catalog.CITIES, categories: catalog.CATEGORIES, sample_notice: SAMPLE_NOTICE,
  price_review_threshold: listings.PRICE_REVIEW_THRESHOLD,
}));
route('GET', 'seller', '/dashboard', async (c) => {
  const sid = c.user.seller_id;
  const data = await listings.sellerListings(c.db, sid);
  const items = await orders.sellerOrders(c.db, sid);
  return {
    active_listings: data.offers.filter((o) => o.status === 'active').length,
    low_stock: data.offers.filter((o) => o.status === 'active' && o.available < 5),
    pending_reviews: (await listings.listSubmissions(c.db, sid, 'pending')).length,
    to_dispatch: items.filter((i) => i.seller_can_advance && i.order_status === 'confirmed').length,
    open_orders: items.filter((i) => i.order_status === 'confirmed').length,
    balance_paise: (await orders.sellerLedger(c.db, sid)).balance_paise,
  };
});
route('GET', 'seller', '/listings', async (c) => await listings.sellerListings(c.db, c.user.seller_id));
route('GET', 'seller', '/catalog', async (c) => await listings.catalogLookup(c.db, c.q('q', '')));
route('GET', 'seller', '/submissions', async (c) => await listings.listSubmissions(c.db, c.user.seller_id));
route('POST', 'seller', '/submissions', async (c) => new Reply(201, await listings.submit(c.db, c.user.seller_id, c.body)));
route('GET', 'seller', '/orders', async (c) => await orders.sellerOrders(c.db, c.user.seller_id));
route('POST', 'seller', '/shipments/(\\d+)/advance', async (c, sid) => await orders.advanceShipment(c.db, int(sid), 'seller', c.user.seller_id));
route('GET', 'seller', '/ledger', async (c) => await orders.sellerLedger(c.db, c.user.seller_id));
route('GET', 'seller', '/assistant', async () => ({ available: assistant.isAvailable() }));
route('POST', 'seller', '/assistant', async (c) => answerSeller(c.db, { user: c.user, voice: c.body.voice === true, language: c.body.language === 'te' ? 'te' : 'en' }, c.body.messages), false, { readOnly: true });

// ---------------------------------------------------------------- Equidron Ops

route('GET', 'ops', '/overview', async (c) => {
  const n = (sql) => scalar(c.db, sql);
  return {
    pending_reviews: await n("SELECT COUNT(*) FROM submissions WHERE status = 'pending'"),
    active_shipments: await n("SELECT COUNT(*) FROM shipments WHERE status NOT IN ('delivered', 'cancelled')"),
    open_returns: await n("SELECT COUNT(*) FROM returns WHERE status = 'pickup_scheduled'"),
    open_tickets: await n("SELECT COUNT(*) FROM support_tickets WHERE status = 'open'"),
    unsettled_paise: await n('SELECT COALESCE(SUM(amount_paise), 0) FROM seller_ledger'),
    sample_notice: SAMPLE_NOTICE,
  };
});
route('GET', 'ops', '/submissions', async (c) => await listings.listSubmissions(c.db, null, c.q('status') || null));
route('POST', 'ops', '/submissions/(\\d+)/decide', async (c, sid) =>
  await listings.decide(c.db, int(sid), Boolean(c.body.approve), String(c.body.note || '').trim(), c.user.id));
route('GET', 'ops', '/shipments', async (c) => await orders.listShipments(c.db, c.q('all') !== '1'));
route('POST', 'ops', '/shipments/(\\d+)/advance', async (c, sid) => await orders.advanceShipment(c.db, int(sid), 'ops'));
route('POST', 'ops', '/shipments/advance-all', async (c) => {
  const active = await orders.listShipments(c.db);
  for (const s of active) await orders.advanceShipment(c.db, s.id, 'ops');
  return { advanced: active.length };
});
route('GET', 'ops', '/returns', async (c) => await orders.listReturns(c.db));
route('POST', 'ops', '/returns/(\\d+)/receive', async (c, rid) =>
  ({ refunded_paise: await orders.receiveReturn(c.db, int(rid), c.body.restock !== false, c.user.id) }));
route('POST', 'ops', '/returns/(\\d+)/reject', async (c, rid) => {
  await orders.rejectReturn(c.db, int(rid), String(c.body.note || '').trim(), c.user.id);
  return { ok: true };
});
route('GET', 'ops', '/support', async (c) => await orders.listTickets(c.db));
route('POST', 'ops', '/support/(\\d+)/reply', async (c, tid) => {
  await orders.replyTicket(c.db, int(tid), 'ops', c.body.message, Boolean(c.body.close));
  return await orders.listTickets(c.db);
});
route('POST', 'ops', '/settlement/run', async (c) => ({ payouts: await orders.runSettlement(c.db) }));
route('GET', 'ops', '/audit', async (c) => mask(await listAudit(c.db, { entity: c.q('entity') || null })));

// ---------------------------------------------------------------- dispatch

// Handle one API call. query is a URLSearchParams; cookies a plain object.
// Returns {status, payload, setCookie} where setCookie is a Set-Cookie header value or null.
export async function handleApi(db, { method, path, query, body, cookies }) {
  try {
    const m = /^\/api\/(shop|seller|ops)(\/.*)$/.exec(path);
    if (!m) throw new AppError(404, 'Unknown API endpoint.');
    const [, area, sub] = m;
    for (const r of ROUTES) {
      if (r.area !== area || r.method !== method) continue;
      const pm = r.pattern.exec(sub);
      if (!pm) continue;
      // Reads run directly; anything else runs as one transaction.
      const prepared = r.prepare ? await r.prepare(body || {}) : null;
      const writes = method !== 'GET' && !r.readOnly;
      const scope = writes ? (fn) => transaction(db, fn) : (fn) => fn();
      const result = await actingAs(ANONYMOUS, () => scope(async () => {
        const token = cookies[`eq_${area}`] || null;
        const user = await auth.userForToken(db, token, AREAS[area]);
        if (!user && !r.isPublic) throw new AppError(401, 'Please sign in.');
        if (user) setActor(userActor(user));
        const ctx = {
          db, user, body: body || {}, token, prepared,
          q: (name, fallback = null) => (query.has(name) ? query.get(name) : fallback),
          async city() {
            const city = this.q('city');
            if (catalog.CITIES.includes(city)) return city;
            if (user && user.role === 'customer') {
              const a = await one(db, 'SELECT city FROM addresses WHERE user_id = ? ORDER BY id LIMIT 1', user.id);
              return a ? a.city : null;
            }
            return null;
          },
        };
        const out = await r.fn(ctx, ...pm.slice(1));
        if (writes && !auditsWritten()) await audit(db, r.action, r.entity, pm[1] ?? '-', null, { request: safeBody(body) });
        return out;
      }));
      const reply = result instanceof Reply ? result : new Reply(200, result);
      let setCookie = null;
      if (reply.cookie) {
        const [a, tok] = reply.cookie;
        setCookie = `eq_${a}=${tok}; Path=/api/${a}; HttpOnly; SameSite=Lax${tok ? '' : '; Max-Age=0'}`;
      }
      return { status: reply.status, payload: reply.payload, setCookie };
    }
    throw new AppError(404, 'Unknown API endpoint.');
  } catch (e) {
    if (e instanceof AppError) {
      const payload = { error: e.message };
      if (e.details != null) payload.details = e.details;
      return { status: e.status, payload, setCookie: null };
    }
    console.error(mask(e?.stack || String(e)));
    return { status: 500, payload: { error: 'Something went wrong on our side. Please try again.' }, setCookie: null };
  }
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ---------------------------------------------------------------- placeholder product images

const CATEGORY_STYLE = {
  Phones: ['#1f4e79', '📱'], Laptops: ['#3d3b8e', '💻'], Audio: ['#7a2e5a', '🎧'], Wearables: ['#0f6b5c', '⌚'],
  'Home & Kitchen': ['#8a5a14', '🍳'], Books: ['#5b3a29', '📚'], Grocery: ['#4f6b18', '☕'], Fashion: ['#8c2f39', '👟'],
};
const VIEW_LABELS = { 1: 'Front', 2: 'Back', 3: 'Detail' };
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' })[ch]);

export async function placeholderSvg(db, name) {
  const m = /^p(\d+)-(\d+)$/.exec(name);
  const p = m && await one(db, 'SELECT title, brand, category FROM products WHERE id = ?', Number(m[1]));
  let color; let icon; let brand; let label; let lines;
  if (p) {
    [color, icon] = CATEGORY_STYLE[p.category] || ['#444', '📦'];
    brand = p.brand;
    label = VIEW_LABELS[Number(m[2])] || 'View';
    lines = [];
    let line = '';
    for (const w of p.title.split(/\s+/)) {
      if (line.length + w.length > 26 && line) {
        lines.push(line);
        line = w;
      } else line = `${line} ${w}`.trim();
    }
    lines = [...lines, line].slice(0, 3);
  } else {
    [color, icon, brand, label, lines] = ['#555', '📦', 'Seller image', 'Placeholder', [name.replace(/-/g, ' ')]];
  }
  const text = lines.map((t, i) =>
    `<text x="200" y="${300 + 24 * i}" font-size="17" text-anchor="middle" fill="#fff" opacity=".92">${esc(t)}</text>`).join('');
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400">' +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${color}"/>` +
    '<stop offset="1" stop-color="#111827"/></linearGradient></defs>' +
    '<rect width="400" height="400" fill="url(#g)"/>' +
    `<text x="200" y="190" font-size="110" text-anchor="middle">${icon}</text>` +
    `<text x="200" y="262" font-size="26" font-weight="700" text-anchor="middle" fill="#fff" font-family="sans-serif">${esc(brand)}</text>` +
    `<g font-family="sans-serif">${text}</g>` +
    `<text x="16" y="28" font-size="13" fill="#fff" opacity=".7" font-family="sans-serif">${esc(label)} · sample image</text></svg>`;
}
