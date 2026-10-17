// JSON API for the three interfaces, independent of the HTTP layer so the same
// routes run in the local server (src/server.js) and the Netlify Function.
//
// API areas and the session role each one accepts:
//   /api/shop/...    customer   (cookie eq_shop,   Path=/api/shop)
//   /api/seller/...  seller     (cookie eq_seller, Path=/api/seller)
//   /api/ops/...     ops        (cookie eq_ops,    Path=/api/ops)
import * as auth from './auth.js';
import * as catalog from './catalog.js';
import { one, scalar, transaction } from './db.js';
import { AppError } from './errors.js';
import * as listings from './listings.js';
import * as notify from './notify.js';
import * as orders from './orders.js';
import { PAYMENT_OPTIONS } from './payments.js';

export const AREAS = { shop: 'customer', seller: 'seller', ops: 'ops' };
const SAMPLE_NOTICE = 'Sample data: every seller, product, customer and order here is fictional. Payments are simulated.';
const ROUTES = [];

function route(method, area, pattern, fn, isPublic = false) {
  ROUTES.push({ method, area, pattern: new RegExp(`^${pattern}$`), fn, isPublic });
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
  route('POST', area, '/login', (c) => {
    const token = auth.login(c.db, c.body.email, c.body.password, role);
    return new Reply(200, { user: auth.userForToken(c.db, token, role) }, [area, token]);
  }, true);
  route('POST', area, '/logout', (c) => {
    if (c.token) auth.logout(c.db, c.token);
    return new Reply(200, { ok: true }, [area, '']);
  }, true);
  route('GET', area, '/me', (c) => ({ user: c.user }), true);
  route('GET', area, '/notifications', (c) => notify.listFor(c.db, c.user.id));
  route('POST', area, '/notifications/read', (c) => {
    notify.markRead(c.db, c.user.id);
    return { ok: true };
  });
}

// ---------------------------------------------------------------- shop (customer)

route('GET', 'shop', '/meta', () => ({
  cities: catalog.CITIES, categories: catalog.CATEGORIES, payment_options: PAYMENT_OPTIONS,
  sample_notice: SAMPLE_NOTICE, rank_weights: catalog.RANK_WEIGHTS,
}), true);

route('POST', 'shop', '/register', (c) => {
  const b = c.body;
  auth.createUser(c.db, b.email, b.name, b.password, 'customer');
  const token = auth.login(c.db, b.email, b.password, 'customer');
  return new Reply(201, { user: auth.userForToken(c.db, token, 'customer') }, ['shop', token]);
}, true);

route('GET', 'shop', '/search', (c) => ({
  city: c.city(),
  results: catalog.search(c.db, c.q('q', ''), c.q('category') || null, c.q('sort', 'relevance'), c.city()),
}), true);

route('GET', 'shop', '/products/(\\d+)', (c, pid) => catalog.productDetail(c.db, int(pid), c.city()), true);
route('GET', 'shop', '/cart', (c) => orders.getCart(c.db, c.user.id));
route('POST', 'shop', '/cart', (c) => {
  orders.addToCart(c.db, c.user.id, int(c.body.offer_id ?? 0), c.body.qty ?? 1);
  return orders.getCart(c.db, c.user.id);
});
route('PUT', 'shop', '/cart/(\\d+)', (c, offerId) => {
  orders.setCartQty(c.db, c.user.id, int(offerId), c.body.qty ?? 0);
  return orders.getCart(c.db, c.user.id);
});
route('DELETE', 'shop', '/cart/(\\d+)', (c, offerId) => {
  orders.setCartQty(c.db, c.user.id, int(offerId), 0);
  return orders.getCart(c.db, c.user.id);
});
route('GET', 'shop', '/addresses', (c) => orders.listAddresses(c.db, c.user.id));
route('POST', 'shop', '/addresses', (c) => {
  orders.addAddress(c.db, c.user.id, c.body);
  return new Reply(201, orders.listAddresses(c.db, c.user.id));
});
route('POST', 'shop', '/checkout/preview', (c) => orders.checkoutPreview(c.db, c.user.id, c.body.address_id));
route('POST', 'shop', '/orders', (c) => {
  const b = c.body;
  const res = orders.placeOrder(c.db, c.user.id, b.address_id, b.payment_method, b.payment_token);
  if (res.result === 'issues') {
    return new Reply(409, { error: 'Your cart changed since you last looked. Please review the updates.',
      details: { issues: res.issues, totals: res.totals } });
  }
  if (res.result === 'payment_failed') {
    return new Reply(402, { error: `Payment was declined (${res.order.payment.decline_reason}). Nothing was charged and your cart is saved.`,
      details: { order: res.order } });
  }
  return new Reply(201, res.order);
});
route('GET', 'shop', '/orders', (c) => orders.listOrders(c.db, c.user.id));
route('GET', 'shop', '/orders/(\\d+)', (c, oid) => orders.getOrder(c.db, int(oid), c.user.id));
route('POST', 'shop', '/orders/(\\d+)/cancel', (c, oid) => orders.cancelOrder(c.db, c.user.id, int(oid)));
route('POST', 'shop', '/orders/(\\d+)/returns', (c, oid) => {
  const b = c.body;
  orders.requestReturn(c.db, c.user.id, int(oid), int(b.order_item_id ?? 0), b.qty ?? 1, b.reason);
  return new Reply(201, orders.getOrder(c.db, int(oid), c.user.id));
});
route('POST', 'shop', '/shipments/(\\d+)/confirm', (c, sid) => {
  orders.confirmDelivery(c.db, c.user.id, int(sid));
  return { ok: true };
});
route('GET', 'shop', '/support', (c) => orders.listTickets(c.db, c.user.id));
route('POST', 'shop', '/support', (c) => {
  orders.createTicket(c.db, c.user.id, c.body.order_id, c.body.subject, c.body.message);
  return new Reply(201, orders.listTickets(c.db, c.user.id));
});
route('POST', 'shop', '/support/(\\d+)/reply', (c, tid) => {
  orders.replyTicket(c.db, int(tid), 'customer', c.body.message, false, c.user.id);
  return orders.listTickets(c.db, c.user.id);
});

// ---------------------------------------------------------------- Seller Central

route('GET', 'seller', '/meta', () => ({
  cities: catalog.CITIES, categories: catalog.CATEGORIES, sample_notice: SAMPLE_NOTICE,
  price_review_threshold: listings.PRICE_REVIEW_THRESHOLD,
}));
route('GET', 'seller', '/dashboard', (c) => {
  const sid = c.user.seller_id;
  const data = listings.sellerListings(c.db, sid);
  const items = orders.sellerOrders(c.db, sid);
  return {
    active_listings: data.offers.filter((o) => o.status === 'active').length,
    low_stock: data.offers.filter((o) => o.status === 'active' && o.available < 5),
    pending_reviews: listings.listSubmissions(c.db, sid, 'pending').length,
    to_dispatch: items.filter((i) => i.seller_can_advance && i.order_status === 'confirmed').length,
    open_orders: items.filter((i) => i.order_status === 'confirmed').length,
    balance_paise: orders.sellerLedger(c.db, sid).balance_paise,
  };
});
route('GET', 'seller', '/listings', (c) => listings.sellerListings(c.db, c.user.seller_id));
route('GET', 'seller', '/catalog', (c) => listings.catalogLookup(c.db, c.q('q', '')));
route('GET', 'seller', '/submissions', (c) => listings.listSubmissions(c.db, c.user.seller_id));
route('POST', 'seller', '/submissions', (c) => new Reply(201, listings.submit(c.db, c.user.seller_id, c.body)));
route('GET', 'seller', '/orders', (c) => orders.sellerOrders(c.db, c.user.seller_id));
route('POST', 'seller', '/shipments/(\\d+)/advance', (c, sid) => orders.advanceShipment(c.db, int(sid), 'seller', c.user.seller_id));
route('GET', 'seller', '/ledger', (c) => orders.sellerLedger(c.db, c.user.seller_id));

// ---------------------------------------------------------------- Equidron Ops

route('GET', 'ops', '/overview', (c) => {
  const n = (sql) => scalar(c.db, sql);
  return {
    pending_reviews: n("SELECT COUNT(*) FROM submissions WHERE status = 'pending'"),
    active_shipments: n("SELECT COUNT(*) FROM shipments WHERE status NOT IN ('delivered', 'cancelled')"),
    open_returns: n("SELECT COUNT(*) FROM returns WHERE status = 'pickup_scheduled'"),
    open_tickets: n("SELECT COUNT(*) FROM support_tickets WHERE status = 'open'"),
    unsettled_paise: n('SELECT COALESCE(SUM(amount_paise), 0) FROM seller_ledger'),
    sample_notice: SAMPLE_NOTICE,
  };
});
route('GET', 'ops', '/submissions', (c) => listings.listSubmissions(c.db, null, c.q('status') || null));
route('POST', 'ops', '/submissions/(\\d+)/decide', (c, sid) =>
  listings.decide(c.db, int(sid), Boolean(c.body.approve), String(c.body.note || '').trim()));
route('GET', 'ops', '/shipments', (c) => orders.listShipments(c.db, c.q('all') !== '1'));
route('POST', 'ops', '/shipments/(\\d+)/advance', (c, sid) => orders.advanceShipment(c.db, int(sid), 'ops'));
route('POST', 'ops', '/shipments/advance-all', (c) => {
  const active = orders.listShipments(c.db);
  for (const s of active) orders.advanceShipment(c.db, s.id, 'ops');
  return { advanced: active.length };
});
route('GET', 'ops', '/returns', (c) => orders.listReturns(c.db));
route('POST', 'ops', '/returns/(\\d+)/receive', (c, rid) =>
  ({ refunded_paise: orders.receiveReturn(c.db, int(rid), c.body.restock !== false) }));
route('POST', 'ops', '/returns/(\\d+)/reject', (c, rid) => {
  orders.rejectReturn(c.db, int(rid), String(c.body.note || '').trim());
  return { ok: true };
});
route('GET', 'ops', '/support', (c) => orders.listTickets(c.db));
route('POST', 'ops', '/support/(\\d+)/reply', (c, tid) => {
  orders.replyTicket(c.db, int(tid), 'ops', c.body.message, Boolean(c.body.close));
  return orders.listTickets(c.db);
});
route('POST', 'ops', '/settlement/run', (c) => ({ payouts: orders.runSettlement(c.db) }));

// ---------------------------------------------------------------- dispatch

// Handle one API call. query is a URLSearchParams; cookies a plain object.
// Returns {status, payload, setCookie} where setCookie is a Set-Cookie header value or null.
export function handleApi(db, { method, path, query, body, cookies }) {
  try {
    const m = /^\/api\/(shop|seller|ops)(\/.*)$/.exec(path);
    if (!m) throw new AppError(404, 'Unknown API endpoint.');
    const [, area, sub] = m;
    for (const r of ROUTES) {
      if (r.area !== area || r.method !== method) continue;
      const pm = r.pattern.exec(sub);
      if (!pm) continue;
      const token = cookies[`eq_${area}`] || null;
      const user = auth.userForToken(db, token, AREAS[area]);
      if (!user && !r.isPublic) throw new AppError(401, 'Please sign in.');
      const ctx = {
        db, user, body: body || {}, token,
        q: (name, fallback = null) => (query.has(name) ? query.get(name) : fallback),
        city() {
          const city = this.q('city');
          if (catalog.CITIES.includes(city)) return city;
          if (user && user.role === 'customer') {
            const a = one(db, 'SELECT city FROM addresses WHERE user_id = ? ORDER BY id LIMIT 1', user.id);
            return a ? a.city : null;
          }
          return null;
        },
      };
      const result = method === 'GET' ? r.fn(ctx, ...pm.slice(1)) : transaction(db, () => r.fn(ctx, ...pm.slice(1)));
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
    console.error(e);
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

export function placeholderSvg(db, name) {
  const m = /^p(\d+)-(\d+)$/.exec(name);
  const p = m && one(db, 'SELECT title, brand, category FROM products WHERE id = ?', Number(m[1]));
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
