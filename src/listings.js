// Seller Central listing management: validation, review rules and approval.
//
// A seller never edits live data directly. Every change becomes a submission.
// Submissions that only touch stock, handling time or a small price change are
// approved automatically; anything else waits for an Equidron reviewer. Live
// listings stay unchanged until the submission is approved.
import { CATEGORIES, CITIES, stockByWarehouse } from './catalog.js';
import { all, dumps, loads, now, one, run } from './db.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { actorUserId, audit } from './audit.js';
import { emit } from './events.js';
import { guardListing, guardSellerRate } from './guardrails.js';
import { notify } from './notify.js';

export const PRICE_REVIEW_THRESHOLD = 0.2;
export const RESTRICTED_TERMS = ['replica', 'counterfeit', 'first copy', 'fake', 'duplicate', 'imitation'];
const CONTENT_FIELDS = ['title', 'brand', 'category', 'description', 'specs', 'images'];
const JSON_FIELDS = new Set(['specs', 'images']);
const IMAGE_RE = /^(https:\/\/\S+|\/img\/[A-Za-z0-9_\-]+\.svg)$/;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function toPaise(value, field, errors, required = true) {
  if (value === undefined || value === null || value === '') {
    if (required) errors[field] = 'Required.';
    return null;
  }
  const s = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    errors[field] = s.startsWith('-') ? 'Must be between ₹1 and ₹10,00,000.' : 'Enter a number, like 1299 or 1299.50.';
    return null;
  }
  const [rupees, frac = ''] = s.split('.');
  if (frac.replace(/0+$/, '').length > 2) {
    errors[field] = 'Use at most two decimal places.';
    return null;
  }
  const paise = Number(rupees) * 100 + Number((frac + '00').slice(0, 2));
  if (paise < 100 || paise > 100_000_000) {
    errors[field] = 'Must be between ₹1 and ₹10,00,000.';
    return null;
  }
  return paise;
}

function toInt(value, field, errors, lo, hi) {
  const s = String(value ?? '').trim();
  if (!/^-?\d+$/.test(s)) {
    errors[field] = 'Enter a whole number.';
    return null;
  }
  const n = Number(s);
  if (n < lo || n > hi) {
    errors[field] = `Must be between ${lo} and ${hi}.`;
    return null;
  }
  return n;
}

// Returns [cleanPayload, errors]. Product content is required only for new products.
export function validate(data, kind) {
  const errors = {};
  const clean = {};
  const needContent = kind === 'new_product';

  for (const [field, lo, hi] of [['title', 5, 200], ['brand', 1, 60], ['description', 20, 5000]]) {
    const value = String(data[field] || '').trim();
    if (!value) {
      if (needContent) errors[field] = 'Required.';
      continue;
    }
    if (value.length < lo || value.length > hi) errors[field] = `Must be ${lo}–${hi} characters.`;
    clean[field] = value;
  }
  if (data.category || needContent) {
    if (!CATEGORIES.includes(data.category)) errors.category = 'Choose a category.';
    else clean.category = data.category;
  }
  if (has(data, 'specs') || needContent) {
    const specs = data.specs || {};
    if (typeof specs !== 'object' || Array.isArray(specs) || Object.values(specs).some((v) => typeof v !== 'string')) {
      errors.specs = 'Specifications must be name/value text pairs.';
    } else if (Object.keys(specs).length > 30) {
      errors.specs = 'At most 30 specifications.';
    } else {
      clean.specs = {};
      for (const [k, v] of Object.entries(specs)) if (k.trim() && v.trim()) clean.specs[k.trim()] = v.trim();
    }
  }
  if (has(data, 'images') || needContent) {
    const images = (Array.isArray(data.images) ? data.images : []).filter((i) => typeof i === 'string' && i.trim()).map((i) => i.trim());
    if (images.length < 1 || images.length > 8) errors.images = 'Add 1–8 images.';
    else if (images.some((i) => !IMAGE_RE.test(i))) errors.images = 'Images must be https:// links (or built-in /img/*.svg placeholders).';
    else clean.images = images;
  }

  clean.price_paise = toPaise(data.price, 'price', errors);
  const mrp = toPaise(data.mrp, 'mrp', errors, false);
  clean.mrp_paise = mrp;
  if (mrp && clean.price_paise && clean.price_paise > mrp) errors.price = "Price can't be higher than the MRP.";
  clean.quantity = toInt(data.quantity, 'quantity', errors, 0, 100000);
  clean.handling_days = toInt(data.handling_days ?? 1, 'handling_days', errors, 0, 10);
  const condition = data.condition ?? 'new';
  if (!['new', 'renewed'].includes(condition)) errors.condition = 'Condition must be new or renewed.';
  clean.condition = condition;
  if (kind !== 'update') {
    if (!['equidron', 'seller'].includes(data.fulfilment)) errors.fulfilment = 'Choose who ships this offer.';
    clean.fulfilment = data.fulfilment;
  }
  const targets = data.ships_to && data.ships_to.length ? data.ships_to : ['ALL'];
  if (!Array.isArray(targets) || targets.some((t) => t !== 'ALL' && !CITIES.includes(t))) {
    errors.ships_to = 'Choose ALL or cities from the list.';
  }
  clean.ships_to = Array.isArray(targets) && targets.includes('ALL') ? ['ALL'] : [...new Set(targets)].sort();
  return [clean, errors];
}

function restrictedTerms(payload) {
  const text = `${payload.title || ''} ${payload.description || ''}`.toLowerCase();
  return RESTRICTED_TERMS.filter((t) => text.includes(t));
}

async function homeWarehouse(db, sellerId, fulfilment) {
  if (fulfilment === 'seller') {
    return (await one(db, "SELECT id FROM warehouses WHERE kind = 'seller_dispatch' AND seller_id = ?", sellerId)).id;
  }
  const city = (await one(db, 'SELECT city FROM sellers WHERE id = ?', sellerId)).city;
  return (await one(db, "SELECT id FROM warehouses WHERE kind = 'equidron_fc' ORDER BY city = ? DESC, id LIMIT 1", city)).id;
}

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Validate a seller's change and either apply it now or hold it for review.
export async function submit(db, sellerId, data) {
  // Guardrail: how many changes this seller has sent in the last hour. Refused before any
  // validation work, and recorded so Ops can see it.
  await guardSellerRate(db, sellerId);
  let offer = null;
  let product = null;
  let kind;
  if (data.offer_id) {
    offer = await one(db, 'SELECT * FROM offers WHERE id = ?', Number(data.offer_id));
    if (!offer) throw notFound('Listing');
    if (offer.seller_id !== sellerId) throw forbidden('That listing belongs to another seller.');
    product = await one(db, 'SELECT * FROM products WHERE id = ?', offer.product_id);
    kind = 'update';
  } else if (data.product_id) {
    product = await one(db, "SELECT * FROM products WHERE id = ? AND status = 'live'", Number(data.product_id));
    if (!product) throw notFound('Product');
    kind = 'new_offer';
  } else {
    kind = 'new_product';
  }

  const [payload, errors] = validate(data, kind);
  if (kind === 'new_offer' && await one(db, 'SELECT 1 AS x FROM offers WHERE product_id = ? AND seller_id = ? AND condition = ?',
    product.id, sellerId, payload.condition)) {
    errors.product_id = 'You already sell this product in this condition. Edit that listing instead.';
  }
  if (Object.keys(errors).length) throw badRequest('Please fix the highlighted fields.', { fields: errors });

  const reasons = [];
  if (kind === 'new_product') reasons.push('New products are reviewed before they go live.');
  else if (kind === 'new_offer') reasons.push('New offers are reviewed before they go live.');
  else {
    const changed = [];
    for (const field of CONTENT_FIELDS) {
      if (!has(payload, field)) continue;
      const live = JSON_FIELDS.has(field) ? loads(product[field]) : product[field];
      if (!sameValue(payload[field], live)) changed.push(field);
      else delete payload[field];
    }
    if (changed.length) reasons.push(`Product content changed: ${changed.join(', ')}.`);
    const delta = Math.abs(payload.price_paise - offer.price_paise) / offer.price_paise;
    if (delta > PRICE_REVIEW_THRESHOLD) {
      reasons.push(`Price changed by ${Math.round(delta * 100)}% (changes over ${PRICE_REVIEW_THRESHOLD * 100}% are reviewed).`);
    }
  }
  const flagged = restrictedTerms(payload);
  if (flagged.length) reasons.push(`Contains restricted terms: ${flagged.join(', ')}.`);

  // Guardrail: text in a listing that reads like instructions to a reviewer, or abuse. It is
  // recorded, and it forces a person to look — a flagged listing must never be auto-approved.
  const guard = await guardListing(db, { sellerId, title: payload.title, description: payload.description });
  if (guard.verdict === 'flag') reasons.push('Guardrail: the listing text may be trying to instruct the reviewer. A person will look at it.');

  // A newer submission replaces an older one still waiting for review.
  if (offer) {
    await run(db, `UPDATE submissions SET status = 'rejected', reviewer_note = 'Replaced by a newer submission.', decided_at = ?
             WHERE offer_id = ? AND status = 'pending'`, now(), offer.id);
  }

  const subId = await run(db, `INSERT INTO submissions (seller_id, product_id, offer_id, kind, payload, status, review_reasons, created_at)
                         VALUES (?,?,?,?,?,'pending',?,?)`,
  sellerId, product ? product.id : null, offer ? offer.id : null, kind, dumps(payload), dumps(reasons), now());
  await emit(db, 'submission.created', 'submission', subId, { seller_id: sellerId, kind, held: reasons.length > 0 });
  if (!reasons.length) {
    await apply(db, subId);
    await run(db, "UPDATE submissions SET status = 'approved', auto_decided = true, decided_at = ?, reviewer_note = ? WHERE id = ?",
      now(), 'Approved automatically: no review needed.', subId);
    // The seller still hears the outcome, in the same way as when a person decides.
    await emit(db, 'submission.decided', 'submission', subId, { approved: true, auto: true });
  }
  return await getSubmission(db, subId);
}

async function apply(db, subId) {
  const sub = await one(db, 'SELECT * FROM submissions WHERE id = ?', subId);
  const p = loads(sub.payload);
  const sellerId = sub.seller_id;
  const ts = now();
  let productId = sub.product_id;
  let offerId = sub.offer_id;
  let fulfilment;

  if (sub.kind === 'new_product') {
    productId = await run(db, `INSERT INTO products (title, brand, category, description, specs, images, rating, review_count,
                                               return_window_days, status, created_at) VALUES (?,?,?,?,?,?,0,0,?, 'live', ?)`,
    p.title, p.brand, p.category, p.description, dumps(p.specs), dumps(p.images), p.category === 'Grocery' ? 0 : 10, ts);
  } else if (sub.kind === 'update') {
    for (const field of CONTENT_FIELDS) {
      if (has(p, field)) {
        await run(db, `UPDATE products SET ${field} = ? WHERE id = ?`, JSON_FIELDS.has(field) ? dumps(p[field]) : p[field], productId);
      }
    }
  }

  if (sub.kind === 'new_product' || sub.kind === 'new_offer') {
    offerId = await run(db, `INSERT INTO offers (product_id, seller_id, price_paise, mrp_paise, condition, fulfilment, handling_days,
                                           ships_to, status, updated_at) VALUES (?,?,?,?,?,?,?,?, 'active', ?)`,
    productId, sellerId, p.price_paise, p.mrp_paise, p.condition, p.fulfilment, p.handling_days, dumps(p.ships_to), ts);
    await run(db, 'UPDATE submissions SET product_id = ?, offer_id = ? WHERE id = ?', productId, offerId, subId);
    fulfilment = p.fulfilment;
  } else {
    await run(db, `UPDATE offers SET price_paise = ?, mrp_paise = ?, condition = ?, handling_days = ?, ships_to = ?,
                               status = 'active', updated_at = ? WHERE id = ?`,
    p.price_paise, p.mrp_paise, p.condition, p.handling_days, dumps(p.ships_to), ts, offerId);
    fulfilment = (await one(db, 'SELECT fulfilment FROM offers WHERE id = ?', offerId)).fulfilment;
  }

  // Quantity is the number of sellable units at the seller's home location.
  const home = await homeWarehouse(db, sellerId, fulfilment);
  // One statement, so a checkout reserving units at the same moment can't be overwritten.
  await run(db, `INSERT INTO inventory (offer_id, warehouse_id, on_hand, reserved) VALUES (?,?,?,0)
                 ON CONFLICT (offer_id, warehouse_id) DO UPDATE SET on_hand = inventory.reserved + EXCLUDED.on_hand`,
  offerId, home, p.quantity);
}

// decidedBy: the reviewer's user id, kept on the submission and in the audit log.
export async function decide(db, subId, approve, note = '', decidedBy = actorUserId()) {
  const sub = await one(db, 'SELECT * FROM submissions WHERE id = ? FOR UPDATE', subId); // two reviewers can't both decide
  if (!sub) throw notFound('Submission');
  if (sub.status !== 'pending') throw conflict(`This submission was already ${sub.status}.`);
  if (approve) await apply(db, subId);
  const status = approve ? 'approved' : 'rejected';
  await run(db, 'UPDATE submissions SET status = ?, reviewer_note = ?, decided_at = ?, decided_by = ? WHERE id = ?',
    status, note || null, now(), decidedBy, subId);
  await audit(db, approve ? 'submission.approve' : 'submission.reject', 'submission', subId,
    { status: sub.status }, { status, note: note || null, decided_by: decidedBy });
  const sellerUser = (await one(db, 'SELECT user_id FROM sellers WHERE id = ?', sub.seller_id)).user_id;
  const title = loads(sub.payload).title || await productTitle(db, sub.product_id);
  await notify(db, sellerUser, `Listing ${approve ? 'approved and live' : 'rejected'}: ${title}${note ? ' — ' + note : ''}`, '#/submissions');
  await emit(db, 'submission.decided', 'submission', subId, { approved: approve, note: note || null });
  return await getSubmission(db, subId);
}

async function productTitle(db, productId) {
  const r = await one(db, 'SELECT title FROM products WHERE id = ?', productId);
  return r ? r.title : 'listing';
}

export async function getSubmission(db, subId) {
  const s = await one(db, `SELECT sub.*, s.name AS seller_name, d.name AS decided_by_name FROM submissions sub
                         JOIN sellers s ON s.id = sub.seller_id LEFT JOIN users d ON d.id = sub.decided_by WHERE sub.id = ?`, subId);
  s.payload = loads(s.payload, {});
  s.review_reasons = loads(s.review_reasons, []);
  s.title = s.payload.title || await productTitle(db, s.product_id);
  if (s.product_id) {
    const p = await one(db, 'SELECT * FROM products WHERE id = ?', s.product_id);
    s.live_product = p ? Object.fromEntries(CONTENT_FIELDS.map((k) => [k, JSON_FIELDS.has(k) ? loads(p[k]) : p[k]])) : null;
  }
  if (s.offer_id) {
    const o = await one(db, 'SELECT price_paise, mrp_paise, handling_days, ships_to, condition, status FROM offers WHERE id = ?', s.offer_id);
    if (o) o.ships_to = loads(o.ships_to, ['ALL']);
    s.live_offer = o;
  }
  return s;
}

export async function listSubmissions(db, sellerId = null, status = null) {
  let sql = 'SELECT id FROM submissions WHERE 1=1';
  const params = [];
  if (sellerId) { sql += ' AND seller_id = ?'; params.push(sellerId); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  const out = [];
  for (const r of await all(db, sql + ' ORDER BY id DESC LIMIT 200', ...params)) out.push(await getSubmission(db, r.id));
  return out;
}

export async function sellerListings(db, sellerId) {
  const offers = await all(db, `SELECT o.*, p.title, p.brand, p.category, p.description, p.specs, p.images, p.status AS product_status
                          FROM offers o JOIN products p ON p.id = o.product_id WHERE o.seller_id = ? ORDER BY p.title`, sellerId);
  for (const o of offers) {
    o.specs = loads(o.specs, {});
    o.images = loads(o.images, []);
    o.ships_to = loads(o.ships_to, ['ALL']);
    o.stock = await stockByWarehouse(db, o.id);
    const home = await homeWarehouse(db, sellerId, o.fulfilment);
    o.home_warehouse_id = home;
    o.home_available = o.stock.filter((s) => s.warehouse_id === home).reduce((n, s) => n + s.available, 0);
    o.available = o.stock.reduce((n, s) => n + s.available, 0);
    const pending = await one(db, "SELECT id FROM submissions WHERE offer_id = ? AND status = 'pending'", o.id);
    o.pending_submission_id = pending ? pending.id : null;
  }
  const pendingNew = (await listSubmissions(db, sellerId, 'pending')).filter((s) => s.kind !== 'update');
  return { offers, pending_new: pendingNew };
}

export async function catalogLookup(db, q) {
  const like = `%${String(q || '').trim()}%`;
  return await all(db, `SELECT id, title, brand, category, images FROM products
                  WHERE status = 'live' AND (title LIKE ? OR brand LIKE ?) ORDER BY title LIMIT 20`, like, like);
}
