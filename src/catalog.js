// Customer-facing catalogue: search ranking, product pages and seller offers.
import { all, isoDate, loads, one } from './db.js';
import { notFound } from './errors.js';

export const CITIES = ['Bengaluru', 'Chennai', 'Delhi', 'Hyderabad', 'Kolkata', 'Mumbai', 'Pune'];
export const CATEGORIES = ['Phones', 'Laptops', 'Audio', 'Wearables', 'Home & Kitchen', 'Books', 'Grocery', 'Fashion'];

const SYNONYMS = {
  phone: ['smartphone', 'mobile'],
  mobile: ['phone', 'smartphone'],
  smartphone: ['phone', 'mobile'],
  laptop: ['notebook'],
  notebook: ['laptop'],
  headphone: ['earbud', 'earphone', 'headset'],
  earbud: ['earphone', 'headphone'],
  earphone: ['earbud', 'headphone'],
  watch: ['smartwatch'],
  smartwatch: ['watch'],
  tv: ['television'],
};
const ACCESSORY_TERMS = new Set(['charger', 'case', 'cover', 'cable', 'protector', 'adapter', 'strap']);
const FIELD_WEIGHTS = [['title', 3.0], ['brand', 2.5], ['category', 2.0], ['specs', 1.0], ['description', 0.5]];
// Weights of the ranking factors. Each factor is normalised to 0..1.
export const RANK_WEIGHTS = { relevance: 0.55, availability: 0.2, customer_experience: 0.15, delivery_speed: 0.1 };

function stem(word) {
  word = word.toLowerCase();
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

export function tokenize(text) {
  return (String(text || '').toLowerCase().match(/[a-z0-9]+/g) || []).map(stem);
}

export function shipsTo(offer) {
  const t = loads(offer.ships_to, ['ALL']);
  return t && t.length ? t : ['ALL'];
}

export function isDeliverable(offer, city) {
  const targets = shipsTo(offer);
  return targets.includes('ALL') || (city != null && targets.includes(city));
}

export function stockByWarehouse(db, offerId) {
  return all(db, `SELECT w.id AS warehouse_id, w.code, w.name, w.city, w.kind, i.on_hand, i.reserved,
                         i.on_hand - i.reserved AS available
                  FROM inventory i JOIN warehouses w ON w.id = i.warehouse_id
                  WHERE i.offer_id = ? ORDER BY w.id`, offerId);
}

// Handling time plus transit: next day within the same city, else three days.
export function deliveryDays(offer, stock, city) {
  const inCity = stock.some((s) => s.available > 0 && s.city === city);
  return offer.handling_days + (inCity ? 1 : 3);
}

export function etaDate(days, today = new Date()) {
  const d = new Date(today);
  d.setDate(d.getDate() + days);
  return isoDate(d);
}

// Offers for many products with their stock, in two queries: productId -> offers, each with .stock.
async function loadOffers(db, productIds, includeInactive = false) {
  const byProduct = new Map(productIds.map((id) => [id, []]));
  if (!productIds.length) return byProduct;
  let sql = `SELECT o.*, s.name AS seller_name, s.rating AS seller_rating, s.rating_count AS seller_rating_count
             FROM offers o JOIN sellers s ON s.id = o.seller_id WHERE o.product_id = ANY(?)`;
  if (!includeInactive) sql += " AND o.status = 'active'";
  const offers = await all(db, sql + ' ORDER BY o.price_paise, o.id', productIds);
  const stock = new Map(offers.map((o) => [o.id, []]));
  if (offers.length) {
    const rows = await all(db, `SELECT i.offer_id, w.id AS warehouse_id, w.code, w.name, w.city, w.kind, i.on_hand, i.reserved,
                                       i.on_hand - i.reserved AS available
                                FROM inventory i JOIN warehouses w ON w.id = i.warehouse_id
                                WHERE i.offer_id = ANY(?) ORDER BY w.id`, offers.map((o) => o.id));
    for (const { offer_id: offerId, ...row } of rows) stock.get(offerId).push(row);
  }
  for (const o of offers) {
    o.stock = stock.get(o.id);
    byProduct.get(o.product_id).push(o);
  }
  return byProduct;
}

// All live offers for a product with stock, delivery promise and featured flag.
export async function describeOffers(db, productId, city = null, includeInactive = false) {
  return summarizeOffers((await loadOffers(db, [productId], includeInactive)).get(productId), city);
}

function summarizeOffers(offers, city) {
  for (const o of offers) {
    const { stock } = o;
    delete o.stock;
    o.available = stock.reduce((n, s) => n + Math.max(s.available, 0), 0);
    o.deliverable = isDeliverable(o, city);
    o.delivery_days = deliveryDays(o, stock, city);
    o.eta = etaDate(o.delivery_days);
    o.ships_to = shipsTo(o);
    o.fulfilment_label = o.fulfilment === 'equidron' ? 'Fulfilled by Equidron' : 'Dispatched by seller';
    o.is_featured = false;
  }
  let buyable = offers.filter((o) => o.available > 0 && o.deliverable);
  // New-condition offers win the featured slot; renewed ones only when no new offer can ship.
  const fresh = buyable.filter((o) => o.condition === 'new');
  if (fresh.length) buyable = fresh;
  if (buyable.length) {
    // Featured offer: lowest price, adjusted for slower delivery and weaker seller rating.
    const key = (o) => o.price_paise * (1 + 0.03 * (o.delivery_days - 2)) * (1 + 0.04 * (5 - o.seller_rating));
    buyable.reduce((best, o) => (key(o) < key(best) ? o : best)).is_featured = true;
  }
  return offers;
}

export function productCard(p) {
  return { ...p, specs: loads(p.specs, {}), images: loads(p.images, []) };
}

function relevance(product, queryTokens, queryText) {
  if (!queryTokens.length) return 0;
  const specs = loads(product.specs, {});
  const fields = {
    title: new Set(tokenize(product.title)),
    brand: new Set(tokenize(product.brand)),
    category: new Set(tokenize(product.category)),
    specs: new Set(tokenize(Object.entries(specs).map(([k, v]) => `${k} ${v}`).join(' '))),
    description: new Set(tokenize(product.description)),
  };
  let total = 0;
  for (const tok of queryTokens) {
    let best = 0;
    const variants = [[tok, 1.0], ...(SYNONYMS[tok] || []).map((s) => [s, 0.8])];
    for (const [variant, factor] of variants) {
      for (const [field, weight] of FIELD_WEIGHTS) {
        if (fields[field].has(variant)) best = Math.max(best, weight * factor);
      }
    }
    total += best;
  }
  let score = total / (3.0 * queryTokens.length);
  if (queryText && product.title.toLowerCase().includes(queryText.toLowerCase())) score += 0.2;
  // Query intent: "phone" means the phone itself, so accessories rank below
  // the main product unless the shopper asked for an accessory.
  const titleIsAccessory = [...fields.title].some((t) => ACCESSORY_TERMS.has(t));
  const askedForAccessory = queryTokens.some((t) => ACCESSORY_TERMS.has(t));
  if (titleIsAccessory && !askedForAccessory) score *= 0.6;
  return Math.min(score, 1.0);
}

const round = (x, places) => Math.round(x * 10 ** places) / 10 ** places;

export async function search(db, q = '', category = null, sort = 'relevance', city = null, limit = 60) {
  const queryTokens = tokenize(q);
  let sql = "SELECT * FROM products WHERE status = 'live'";
  const params = [];
  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }
  const matches = [];
  for (const p of await all(db, sql, ...params)) {
    const rel = relevance(p, queryTokens, String(q || '').trim());
    if (!queryTokens.length || rel >= 0.15) matches.push([p, rel]);
  }
  const offersByProduct = await loadOffers(db, matches.map(([p]) => p.id));
  const results = [];
  for (const [p, rel] of matches) {
    const offers = summarizeOffers(offersByProduct.get(p.id), city);
    if (!offers.length) continue;
    const featured = offers.find((o) => o.is_featured) || null;
    const inStock = offers.some((o) => o.available > 0);
    const availability = featured ? 1.0 : inStock ? 0.3 : 0.0;
    const confidence = Math.min(1.0, Math.log10(p.review_count + 1) / 3.0);
    const bestSeller = Math.max(...offers.map((o) => o.seller_rating));
    const cx = 0.6 * (p.rating / 5.0) * confidence + 0.4 * (bestSeller / 5.0);
    const speed = featured ? 2.0 / featured.delivery_days : 0;
    const factors = {
      relevance: round(rel, 3),
      availability,
      customer_experience: round(cx, 3),
      delivery_speed: round(Math.min(speed, 1.0), 3),
    };
    const score = Object.entries(factors).reduce((s, [k, v]) => s + RANK_WEIGHTS[k] * v, 0);
    const card = productCard(p);
    Object.assign(card, {
      score: round(score, 4),
      factors,
      offer_count: offers.length,
      in_stock: inStock,
      deliverable: featured !== null,
      featured_offer: featured && Object.fromEntries(
        ['id', 'price_paise', 'mrp_paise', 'seller_name', 'eta', 'delivery_days', 'fulfilment_label'].map((k) => [k, featured[k]])),
      min_price_paise: Math.min(...offers.map((o) => o.price_paise)),
    });
    results.push(card);
  }

  const price = (r) => (r.featured_offer ? r.featured_offer.price_paise : r.min_price_paise);
  const stockFirst = (a, b) => Number(!a.in_stock) - Number(!b.in_stock);
  if (sort === 'price_asc') results.sort((a, b) => stockFirst(a, b) || price(a) - price(b));
  else if (sort === 'price_desc') results.sort((a, b) => stockFirst(a, b) || price(b) - price(a));
  else if (sort === 'rating') results.sort((a, b) => stockFirst(a, b) || b.rating - a.rating || b.review_count - a.review_count);
  else results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

export async function productDetail(db, productId, city = null) {
  const p = await one(db, "SELECT * FROM products WHERE id = ? AND status = 'live'", productId);
  if (!p) throw notFound('Product');
  const card = productCard(p);
  card.offers = await describeOffers(db, productId, city);
  if (!card.offers.length) throw notFound('Product');
  card.city = city;
  return card;
}
