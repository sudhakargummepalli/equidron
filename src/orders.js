// Cart, checkout, orders, payments, fulfilment, returns and seller settlement.
//
// Order lifecycle is tracked on three independent axes:
//   orders.status            confirmed | payment_failed | cancelled | completed
//   orders.payment_status    see payments.status (authorized, captured, cod_pending, refunded, ...)
//   orders.fulfilment_status not_started | processing | partially_shipped | shipped |
//                            partially_delivered | delivered | cancelled
// Payment authorization happens at checkout; capture happens when goods ship
// (card) or are delivered (cash on delivery). Each shipment moves through
// SHIPMENT_STAGES on its own.
//
// Every function here expects to run inside a transaction opened by the caller.
import crypto from 'node:crypto';
import { actorUserId, audit } from './audit.js';
import { emit } from './events.js';
import { CITIES, deliveryDays, etaDate, isDeliverable, stockByWarehouse } from './catalog.js';
import { addDays, all, changes, dumps, indiaDate, loads, lockNamed, now, one, run, scalar } from './db.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { notify } from './notify.js';
import { provider } from './payments.js';
import { checkReference, loadStatement } from './statement.js';

export const FREE_SHIPPING_FROM = 49_900;
export const SHIPPING_FEE = 4_000;
export const REFERRAL_FEE_RATE = 0.1;
const MAX_LINE_QTY = 10;
export const SHIPMENT_STAGES = ['pending', 'picking', 'packed', 'shipped', 'in_transit', 'out_for_delivery', 'delivered'];
const STAGE_NOTES = {
  pending: (w) => `Order received by ${w}.`,
  picking: (w) => `Picking items at ${w}.`,
  packed: (w) => `Packed and labelled at ${w}.`,
  shipped: (w) => `Handed to the carrier at ${w}.`,
  in_transit: () => 'In transit to the delivery hub.',
  out_for_delivery: () => 'Out for delivery.',
  delivered: () => 'Delivered. Signed for at the door.',
};
const SELLER_STAGES = new Set(['picking', 'packed', 'shipped']);
const stage = (s) => SHIPMENT_STAGES.indexOf(s);

export function inr(paise) {
  const rupees = Math.trunc(paise / 100);
  const p = String(Math.abs(paise % 100)).padStart(2, '0');
  let s = String(rupees);
  if (s.length > 3) {
    let head = s.slice(0, -3);
    const tail = s.slice(-3);
    const groups = [];
    while (head.length > 2) {
      groups.unshift(head.slice(-2));
      head = head.slice(0, -2);
    }
    if (head) groups.unshift(head);
    s = [...groups, tail].join(',');
  }
  return `₹${s}.${p}`;
}

// ---------------------------------------------------------------- cart

async function liveOffer(db, offerId) {
  return await one(db, `SELECT o.*, p.title, p.images, p.status AS product_status, s.name AS seller_name
                  FROM offers o JOIN products p ON p.id = o.product_id JOIN sellers s ON s.id = o.seller_id
                  WHERE o.id = ?`, offerId);
}

const sumAvailable = (stock) => stock.reduce((n, s) => n + Math.max(s.available, 0), 0);

function toQty(value) {
  const n = Number(value);
  if (!Number.isInteger(n)) throw badRequest('Quantity must be a whole number.');
  return n;
}

export async function addToCart(db, userId, offerId, qty = 1) {
  const offer = await liveOffer(db, offerId);
  if (!offer || offer.status !== 'active' || offer.product_status !== 'live') throw notFound('Offer');
  qty = toQty(qty);
  if (qty < 1 || qty > MAX_LINE_QTY) throw badRequest(`You can buy 1–${MAX_LINE_QTY} of each item.`);
  // One statement, so two tabs adding at once both count. Too many rolls the whole request back.
  const [{ qty: total }] = await all(db, `INSERT INTO cart_items (user_id, offer_id, qty, price_at_add_paise, added_at) VALUES (?,?,?,?,?)
    ON CONFLICT (user_id, offer_id) DO UPDATE SET qty = cart_items.qty + EXCLUDED.qty RETURNING qty`,
  userId, offerId, qty, offer.price_paise, now());
  if (total > MAX_LINE_QTY) throw badRequest(`You can buy 1–${MAX_LINE_QTY} of each item.`);
}

export async function setCartQty(db, userId, offerId, qty) {
  qty = toQty(qty);
  if (qty <= 0) await run(db, 'DELETE FROM cart_items WHERE user_id = ? AND offer_id = ?', userId, offerId);
  else if (qty > MAX_LINE_QTY) throw badRequest(`You can buy 1–${MAX_LINE_QTY} of each item.`);
  else await run(db, 'UPDATE cart_items SET qty = ? WHERE user_id = ? AND offer_id = ?', qty, userId, offerId);
}

function totals(subtotal) {
  const shipping = subtotal === 0 || subtotal >= FREE_SHIPPING_FROM ? 0 : SHIPPING_FEE;
  return { subtotal_paise: subtotal, shipping_paise: shipping, total_paise: subtotal + shipping, free_shipping_from_paise: FREE_SHIPPING_FROM };
}

// Cart with an *estimated* total at current prices. Nothing is reserved yet.
export async function getCart(db, userId) {
  const lines = [];
  for (const c of await all(db, 'SELECT * FROM cart_items WHERE user_id = ? ORDER BY added_at', userId)) {
    const o = await liveOffer(db, c.offer_id);
    const stock = await stockByWarehouse(db, c.offer_id);
    lines.push({
      offer_id: c.offer_id, product_id: o.product_id, title: o.title,
      image: (loads(o.images, []) || [])[0] ?? null, seller_name: o.seller_name, qty: c.qty,
      price_paise: o.price_paise, price_at_add_paise: c.price_at_add_paise,
      price_changed: o.price_paise !== c.price_at_add_paise,
      available: sumAvailable(stock),
      active: o.status === 'active' && o.product_status === 'live',
      line_total_paise: o.price_paise * c.qty,
    });
  }
  const subtotal = lines.filter((l) => l.active).reduce((n, l) => n + l.line_total_paise, 0);
  return { items: lines, estimate: totals(subtotal), count: lines.reduce((n, l) => n + l.qty, 0) };
}

// ---------------------------------------------------------------- addresses

export async function listAddresses(db, userId) {
  return await all(db, 'SELECT * FROM addresses WHERE user_id = ? ORDER BY id', userId);
}

export async function addAddress(db, userId, data) {
  const errors = {};
  for (const field of ['name', 'line1']) if (!String(data[field] || '').trim()) errors[field] = 'Required.';
  if (!CITIES.includes(data.city)) errors.city = 'Choose a city we deliver to.';
  if (!/^\d{6}$/.test(String(data.pincode ?? ''))) errors.pincode = 'Enter a 6-digit PIN code.';
  if (!/^\d{10}$/.test(String(data.phone ?? ''))) errors.phone = 'Enter a 10-digit phone number.';
  if (Object.keys(errors).length) throw badRequest('Please fix the highlighted fields.', { fields: errors });
  return await run(db, 'INSERT INTO addresses (user_id, name, line1, city, pincode, phone) VALUES (?,?,?,?,?,?)',
    userId, data.name.trim(), data.line1.trim(), data.city, String(data.pincode), String(data.phone));
}

async function address(db, userId, addressId) {
  const a = await one(db, 'SELECT * FROM addresses WHERE id = ? AND user_id = ?', Number(addressId) || 0, userId);
  if (!a) throw badRequest('Choose a delivery address.');
  return a;
}

// ---------------------------------------------------------------- checkout

// Re-check every cart line against live price, stock and delivery eligibility.
// Price changes are written back to the cart, so a customer who has seen the
// new price can place the order on the next attempt.
export async function revalidate(db, userId, addressId) {
  const addr = await address(db, userId, addressId);
  const city = addr.city;
  const issues = [];
  const lines = [];
  const cart = await all(db, 'SELECT * FROM cart_items WHERE user_id = ? ORDER BY added_at', userId);
  if (!cart.length) issues.push({ type: 'empty_cart', message: 'Your cart is empty.' });
  for (const c of cart) {
    const o = await liveOffer(db, c.offer_id);
    if (!o || o.status !== 'active' || o.product_status !== 'live') {
      issues.push({ type: 'unavailable', offer_id: c.offer_id, title: o && o.title,
        message: `${(o && o.title) || 'An item'} is no longer available.` });
      continue;
    }
    const stock = await stockByWarehouse(db, c.offer_id);
    const available = sumAvailable(stock);
    if (c.price_at_add_paise !== o.price_paise) {
      issues.push({ type: 'price_changed', offer_id: o.id, title: o.title,
        old_price_paise: c.price_at_add_paise, new_price_paise: o.price_paise,
        message: `${o.title} changed price from ${inr(c.price_at_add_paise)} to ${inr(o.price_paise)}.` });
      await run(db, 'UPDATE cart_items SET price_at_add_paise = ? WHERE user_id = ? AND offer_id = ?', o.price_paise, userId, o.id);
    }
    if (available < c.qty) {
      issues.push({ type: available === 0 ? 'out_of_stock' : 'insufficient_stock', offer_id: o.id, title: o.title,
        available, requested: c.qty,
        message: available ? `${o.title}: only ${available} left (you asked for ${c.qty}).` : `${o.title} is out of stock.` });
    }
    if (!isDeliverable(o, city)) {
      issues.push({ type: 'not_deliverable', offer_id: o.id, title: o.title,
        message: `${o.title} can't be delivered to ${city} by this seller.` });
    }
    lines.push({ offer: o, qty: c.qty, stock });
  }
  const subtotal = lines.reduce((n, l) => n + l.offer.price_paise * l.qty, 0);
  return { ok: !issues.length, issues, address: addr, lines, totals: totals(subtotal) };
}

export async function checkoutPreview(db, userId, addressId) {
  const check = await revalidate(db, userId, addressId);
  const city = check.address.city;
  return {
    ok: check.ok, issues: check.issues, totals: check.totals,
    items: check.lines.map((l) => ({
      offer_id: l.offer.id, title: l.offer.title, qty: l.qty, price_paise: l.offer.price_paise,
      seller_name: l.offer.seller_name, eta: etaDate(deliveryDays(l.offer, l.stock, city)),
    })),
  };
}

// Pick warehouses for qty units: same-city first, then the location with most stock.
// Another checkout took the last units first. The customer's cart is kept (the order rolls back).
const soldOut = (offer) => conflict(`Sorry, ${offer.title} just sold out. Your cart is saved: please review it.`, {
  issues: [{ type: 'out_of_stock', offer_id: offer.id, title: offer.title, message: `${offer.title} just sold out.` }],
});

function allocate(stock, qty, city, offer) {
  const picks = [];
  const ordered = [...stock].sort((a, b) =>
    Number(a.city !== city) - Number(b.city !== city) || b.available - a.available || a.warehouse_id - b.warehouse_id);
  for (const s of ordered) {
    if (qty === 0) break;
    const take = Math.min(qty, Math.max(s.available, 0));
    if (take) {
      picks.push([s, take]);
      qty -= take;
    }
  }
  if (qty) throw soldOut(offer);
  return picks;
}

// A payment the customer already made by UPI or bank transfer: approved only if Equidron's
// bank statement shows that reference paid in full for this order, and no other order used it.
async function authorizeBankTransfer(db, ref, total, statement) {
  const instrument = `UPI / bank transfer, ref ${ref}`;
  const check = checkReference(statement, ref, total, inr);
  if (!check.ok) return { approved: false, ref: null, declineReason: check.message, instrument };
  const used = await one(db, "SELECT order_id FROM payments WHERE method = 'bank' AND provider_ref = ? AND status != 'declined'", ref);
  if (used) return { approved: false, ref: null, declineReason: `Payment ${ref} was already used for order #${used.order_id}.`, instrument };
  return { approved: true, ref, declineReason: null, instrument };
}

// Revalidate, reserve stock, authorize payment. Returns {result, ...} where result is
// "issues" (nothing created), "payment_failed" (order recorded, stock released,
// cart kept) or "placed". statement: bank statement rows for method 'bank' (loaded here if not given).
export async function placeOrder(db, userId, addressId, method, token, { statement = null } = {}) {
  token = provider.checkToken(method, token);
  const check = await revalidate(db, userId, addressId);
  if (!check.ok) return { result: 'issues', issues: check.issues, totals: check.totals };
  const { address: addr, totals: t } = check;
  const city = addr.city;
  const ts = now();

  // Reserve the stock before anything else. The stock read above isn't locked, so another
  // checkout may take the same units first: each guarded UPDATE reserves only while enough is
  // still free, and if one changes nothing we stop and the transaction rolls back. Rows are
  // reserved in (offer, warehouse) order, so two checkouts always lock them in the same order
  // and can't deadlock.
  const plan = check.lines.map((line) => ({ line, picks: allocate(line.stock, line.qty, city, line.offer) }));
  const holds = plan.flatMap(({ line, picks }) => picks.map(([s, take]) => ({ offer: line.offer, warehouseId: s.warehouse_id, take })))
    .sort((a, b) => a.offer.id - b.offer.id || a.warehouseId - b.warehouseId);
  for (const h of holds) {
    const held = await changes(db, `UPDATE inventory SET reserved = reserved + ?
                                    WHERE offer_id = ? AND warehouse_id = ? AND on_hand - reserved >= ?`, h.take, h.offer.id, h.warehouseId, h.take);
    if (!held) throw soldOut(h.offer);
  }

  const orderId = await run(db, `INSERT INTO orders (user_id, address, status, payment_status, fulfilment_status, payment_method,
                                               subtotal_paise, shipping_paise, total_paise, created_at, updated_at)
                           VALUES (?,?, 'pending_payment', 'pending', 'not_started', ?,?,?,?,?,?)`,
  userId, dumps(addr), method, t.subtotal_paise, t.shipping_paise, t.total_paise, ts, ts);

  const shipments = new Map(); // warehouse_id -> {id, amount, days, name}
  for (const { line, picks } of plan) {
    const o = line.offer;
    for (const [s, take] of picks) {
      let ship = shipments.get(s.warehouse_id);
      if (!ship) {
        const sid = await run(db, `INSERT INTO shipments (order_id, warehouse_id, status, amount_paise, created_at, updated_at)
                             VALUES (?,?, 'pending', 0, ?, ?)`, orderId, s.warehouse_id, ts, ts);
        ship = { id: sid, amount: 0, days: 0, name: s.name };
        shipments.set(s.warehouse_id, ship);
      }
      ship.amount += o.price_paise * take;
      ship.days = Math.max(ship.days, o.handling_days + (s.city === city ? 1 : 3));
      await run(db, `INSERT INTO order_items (order_id, shipment_id, offer_id, product_id, seller_id, warehouse_id, title,
                                        qty, unit_price_paise) VALUES (?,?,?,?,?,?,?,?,?)`,
      orderId, ship.id, o.id, o.product_id, o.seller_id, s.warehouse_id, o.title, take, o.price_paise);
    }
  }
  let first = true;
  for (const ship of shipments.values()) {
    const amount = ship.amount + (first ? t.shipping_paise : 0);
    first = false;
    await run(db, 'UPDATE shipments SET amount_paise = ?, eta = ? WHERE id = ?', amount, etaDate(ship.days), ship.id);
  }

  const auth = method === 'bank'
    ? await authorizeBankTransfer(db, token, t.total_paise, statement || await loadStatement())
    : provider.authorize(method, token, t.total_paise);
  const payId = await run(db, `INSERT INTO payments (order_id, method, instrument, provider_ref, status, decline_reason, created_at, updated_at)
                         VALUES (?,?,?,?, 'pending', ?, ?, ?)`,
  orderId, method, auth.instrument, auth.ref, auth.declineReason, ts, ts);

  if (!auth.approved) {
    await paymentEvent(db, payId, 'decline', t.total_paise, `Declined: ${auth.declineReason}`);
    await run(db, "UPDATE payments SET status = 'declined' WHERE id = ?", payId);
    await releaseReservations(db, orderId);
    await run(db, "UPDATE shipments SET status = 'cancelled' WHERE order_id = ?", orderId);
    await run(db, "UPDATE orders SET status = 'payment_failed', payment_status = 'declined', fulfilment_status = 'cancelled' WHERE id = ?", orderId);
    await notify(db, userId, `Payment for order #${orderId} was declined. Your cart is saved — try another payment option.`, `#/orders/${orderId}`);
    return { result: 'payment_failed', order: await getOrder(db, orderId, userId) };
  }

  const total = t.total_paise;
  if (method === 'card') {
    await run(db, 'UPDATE payments SET authorized_paise = ? WHERE id = ?', total, payId);
    await paymentEvent(db, payId, 'authorize', total, 'Authorized; captured as items ship.');
  } else if (method === 'upi') {
    await run(db, 'UPDATE payments SET authorized_paise = ?, captured_paise = ? WHERE id = ?', total, total, payId);
    await paymentEvent(db, payId, 'authorize', total, 'Authorized.');
    await paymentEvent(db, payId, 'capture', total, 'Collected immediately (UPI).');
  } else if (method === 'bank') {
    await run(db, 'UPDATE payments SET authorized_paise = ?, captured_paise = ? WHERE id = ?', total, total, payId);
    await paymentEvent(db, payId, 'capture', total, `Matched to bank statement entry ${auth.ref}.`);
  } else {
    await run(db, 'UPDATE payments SET authorized_paise = ? WHERE id = ?', total, payId);
    await paymentEvent(db, payId, 'cod_due', total, 'To be collected on delivery.');
  }
  await run(db, "UPDATE orders SET status = 'confirmed' WHERE id = ?", orderId);
  await syncPaymentStatus(db, orderId);
  await emit(db, 'order.placed', 'order', orderId, { total_paise: total, payment_method: method, shipments: shipments.size });
  if (method === 'upi' || method === 'bank') await emit(db, 'payment.captured', 'order', orderId, { amount_paise: total, method });

  for (const ship of shipments.values()) await shipmentEvent(db, ship.id, 'pending', STAGE_NOTES.pending(ship.name));
  await run(db, 'DELETE FROM cart_items WHERE user_id = ?', userId);
  await notify(db, userId, `Order #${orderId} placed: ${inr(total)}. We'll let you know when it ships.`, `#/orders/${orderId}`);
  for (const s of await all(db, 'SELECT DISTINCT s.user_id FROM order_items oi JOIN sellers s ON s.id = oi.seller_id WHERE oi.order_id = ?', orderId)) {
    await notify(db, s.user_id, `New order #${orderId} to fulfil.`, '#/orders');
  }
  return { result: 'placed', order: await getOrder(db, orderId, userId) };
}

async function releaseReservations(db, orderId) {
  for (const item of await all(db, 'SELECT * FROM order_items WHERE order_id = ?', orderId)) {
    await run(db, 'UPDATE inventory SET reserved = reserved - ? WHERE offer_id = ? AND warehouse_id = ?', item.qty, item.offer_id, item.warehouse_id);
  }
}

// ---------------------------------------------------------------- payments

async function paymentEvent(db, paymentId, kind, amount, note) {
  await run(db, 'INSERT INTO payment_events (payment_id, kind, amount_paise, note, at) VALUES (?,?,?,?,?)', paymentId, kind, amount, note, now());
}

async function syncPaymentStatus(db, orderId) {
  const p = await one(db, 'SELECT * FROM payments WHERE order_id = ?', orderId);
  let status;
  if (['declined', 'voided', 'cancelled'].includes(p.status)) status = p.status;
  else if (p.refunded_paise) status = p.refunded_paise >= p.captured_paise ? 'refunded' : 'partially_refunded';
  else if (p.method === 'cod') {
    status = p.captured_paise === 0 ? 'cod_pending' : p.captured_paise >= p.authorized_paise ? 'cod_collected' : 'cod_partially_collected';
  } else {
    status = p.captured_paise === 0 ? 'authorized' : p.captured_paise >= p.authorized_paise ? 'captured' : 'partially_captured';
  }
  await run(db, 'UPDATE payments SET status = ?, updated_at = ? WHERE id = ?', status, now(), p.id);
  await run(db, 'UPDATE orders SET payment_status = ?, updated_at = ? WHERE id = ?', status, now(), orderId);
}

async function capture(db, orderId, amount, note) {
  const p = await one(db, 'SELECT * FROM payments WHERE order_id = ?', orderId);
  amount = Math.min(amount, p.authorized_paise - p.captured_paise);
  if (amount <= 0) return;
  provider.capture(p.provider_ref, amount);
  await run(db, 'UPDATE payments SET captured_paise = captured_paise + ? WHERE id = ?', amount, p.id);
  await paymentEvent(db, p.id, p.method === 'cod' ? 'cod_collect' : 'capture', amount, note);
  await syncPaymentStatus(db, orderId);
  await emit(db, 'payment.captured', 'order', orderId, { amount_paise: amount, method: p.method });
}

async function refund(db, orderId, amount, note) {
  const p = await one(db, 'SELECT * FROM payments WHERE order_id = ?', orderId);
  amount = Math.min(amount, p.captured_paise - p.refunded_paise);
  if (amount <= 0) return [0, ''];
  provider.refund(p.provider_ref, amount);
  const destination = p.method === 'cod' ? 'your Equidron balance (simulated)' : p.instrument;
  await run(db, 'UPDATE payments SET refunded_paise = refunded_paise + ? WHERE id = ?', amount, p.id);
  await paymentEvent(db, p.id, 'refund', amount, `${note} Refunded to ${destination}.`);
  await syncPaymentStatus(db, orderId);
  return [amount, destination];
}

// ---------------------------------------------------------------- fulfilment

async function shipmentEvent(db, shipmentId, status, note) {
  await run(db, 'INSERT INTO shipment_events (shipment_id, status, note, at) VALUES (?,?,?,?)', shipmentId, status, note, now());
}

export async function refreshOrder(db, orderId) {
  const order = await one(db, 'SELECT status FROM orders WHERE id = ?', orderId);
  if (['payment_failed', 'cancelled'].includes(order.status)) return;
  const stages = (await all(db, "SELECT status FROM shipments WHERE order_id = ? AND status != 'cancelled'", orderId)).map((r) => stage(r.status));
  const shipped = stage('shipped');
  const delivered = stage('delivered');
  let fulfilment;
  let status = 'confirmed';
  if (stages.every((s) => s === delivered)) [fulfilment, status] = ['delivered', 'completed'];
  else if (stages.some((s) => s === delivered)) fulfilment = 'partially_delivered';
  else if (stages.every((s) => s >= shipped)) fulfilment = 'shipped';
  else if (stages.some((s) => s >= shipped)) fulfilment = 'partially_shipped';
  else if (stages.some((s) => s > 0)) fulfilment = 'processing';
  else fulfilment = 'not_started';
  await run(db, 'UPDATE orders SET fulfilment_status = ?, status = ?, updated_at = ? WHERE id = ?', fulfilment, status, now(), orderId);
}

// Move a shipment to its next stage. actor is 'ops' or 'seller'.
// Sellers can only pick, pack and ship their own seller-dispatched shipments;
// carrier stages after that are driven by Equidron ops (the logistics simulator).
export async function advanceShipment(db, shipmentId, actor, sellerId = null) {
  const where = await one(db, 'SELECT order_id FROM shipments WHERE id = ?', shipmentId);
  if (!where) throw notFound('Shipment');
  // Lock the order, then the shipment: cancelling and advancing can't cross, and a double
  // click can't move it two stages. Always order first, so two requests can't deadlock.
  await one(db, 'SELECT id FROM orders WHERE id = ? FOR UPDATE', where.order_id);
  const s = await one(db, `SELECT sh.*, w.name AS warehouse_name, w.kind, w.seller_id AS wh_seller_id
                     FROM shipments sh JOIN warehouses w ON w.id = sh.warehouse_id WHERE sh.id = ? FOR UPDATE OF sh`, shipmentId);
  if (['delivered', 'cancelled'].includes(s.status)) throw conflict(`This shipment is already ${s.status}.`);
  const nxt = SHIPMENT_STAGES[stage(s.status) + 1];
  if (actor === 'seller') {
    if (s.kind !== 'seller_dispatch' || s.wh_seller_id !== sellerId) {
      throw forbidden('Only shipments dispatched from your own location can be updated here.');
    }
    if (!SELLER_STAGES.has(nxt)) throw forbidden('The carrier updates the shipment from here on.');
  }

  const orderId = s.order_id;
  const customer = (await one(db, 'SELECT user_id FROM orders WHERE id = ?', orderId)).user_id;
  const items = await all(db, 'SELECT * FROM order_items WHERE shipment_id = ?', shipmentId);
  if (nxt === 'packed') {
    const carrier = s.kind === 'equidron_fc' ? 'Equidron Logistics' : 'BlueRoute Express (simulated)';
    const tracking = 'EQ' + Array.from({ length: 10 }, () => crypto.randomInt(10)).join('');
    await run(db, 'UPDATE shipments SET status = ?, updated_at = ?, carrier = ?, tracking_no = ? WHERE id = ?', nxt, now(), carrier, tracking, shipmentId);
  } else {
    await run(db, 'UPDATE shipments SET status = ?, updated_at = ? WHERE id = ?', nxt, now(), shipmentId);
  }
  await shipmentEvent(db, shipmentId, nxt, STAGE_NOTES[nxt](s.warehouse_name));
  await audit(db, 'shipment.advance', 'shipment', shipmentId, { status: s.status }, { status: nxt, by: actor });
  await emit(db, 'shipment.status_changed', 'shipment', shipmentId, { order_id: s.order_id, from: s.status, to: nxt });
  const method = (await one(db, 'SELECT method FROM payments WHERE order_id = ?', orderId)).method;

  if (nxt === 'shipped') {
    for (const it of items) {
      await run(db, 'UPDATE inventory SET on_hand = on_hand - ?, reserved = reserved - ? WHERE offer_id = ? AND warehouse_id = ?',
        it.qty, it.qty, it.offer_id, it.warehouse_id);
    }
    if (method === 'card') await capture(db, orderId, s.amount_paise, `Captured for shipment #${shipmentId}.`);
    await notify(db, customer, `Order #${orderId}: shipment #${shipmentId} has shipped.`, `#/orders/${orderId}`);
  } else if (nxt === 'out_for_delivery') {
    await notify(db, customer, `Order #${orderId}: shipment #${shipmentId} is out for delivery today.`, `#/orders/${orderId}`);
  } else if (nxt === 'delivered') {
    if (method === 'cod') await capture(db, orderId, s.amount_paise, `Cash collected on delivery of shipment #${shipmentId}.`);
    for (const it of items) {
      const sale = it.unit_price_paise * it.qty;
      await ledger(db, it.seller_id, it.id, 'sale', sale, `Order #${orderId}: ${it.title} × ${it.qty}`);
      await ledger(db, it.seller_id, it.id, 'referral_fee', -Math.round(sale * REFERRAL_FEE_RATE), `Equidron referral fee ${REFERRAL_FEE_RATE * 100}%`);
    }
    await notify(db, customer, `Order #${orderId}: shipment #${shipmentId} was delivered.`, `#/orders/${orderId}`);
  }
  await refreshOrder(db, orderId);
  return await getShipment(db, shipmentId);
}

export async function confirmDelivery(db, userId, shipmentId) {
  const s = await one(db, 'SELECT sh.* FROM shipments sh JOIN orders o ON o.id = sh.order_id WHERE sh.id = ? AND o.user_id = ?', shipmentId, userId);
  if (!s) throw notFound('Shipment');
  if (s.status !== 'delivered') throw conflict('You can confirm receipt once the shipment is delivered.');
  if (await one(db, "SELECT 1 AS x FROM shipment_events WHERE shipment_id = ? AND status = 'receipt_confirmed'", shipmentId)) return;
  await shipmentEvent(db, shipmentId, 'receipt_confirmed', 'Customer confirmed the package arrived in good condition.');
}

export async function cancelOrder(db, userId, orderId) {
  const o = await one(db, 'SELECT * FROM orders WHERE id = ? AND user_id = ? FOR UPDATE', orderId, userId);
  if (!o) throw notFound('Order');
  if (o.status !== 'confirmed') throw conflict('Only confirmed orders can be cancelled.');
  const stages = (await all(db, 'SELECT status FROM shipments WHERE order_id = ?', orderId)).map((r) => r.status);
  if (stages.some((s) => s !== 'cancelled' && stage(s) >= stage('shipped'))) {
    throw conflict('Part of this order has already shipped. You can return it after delivery instead.');
  }
  await releaseReservations(db, orderId);
  for (const sh of await all(db, 'SELECT id FROM shipments WHERE order_id = ?', orderId)) {
    await run(db, "UPDATE shipments SET status = 'cancelled', updated_at = ? WHERE id = ?", now(), sh.id);
    await shipmentEvent(db, sh.id, 'cancelled', 'Cancelled by the customer before dispatch.');
  }
  const p = await one(db, 'SELECT * FROM payments WHERE order_id = ?', orderId);
  if (p.method === 'card') {
    provider.void(p.provider_ref, p.authorized_paise);
    await paymentEvent(db, p.id, 'void', p.authorized_paise, 'Authorization released; you were not charged.');
    await run(db, "UPDATE payments SET status = 'voided' WHERE id = ?", p.id);
  } else if (p.method === 'upi' || p.method === 'bank') {
    await refund(db, orderId, p.captured_paise, 'Order cancelled.');
  } else {
    await paymentEvent(db, p.id, 'cod_cancelled', p.authorized_paise, 'Nothing to collect.');
    await run(db, "UPDATE payments SET status = 'cancelled' WHERE id = ?", p.id);
  }
  await run(db, "UPDATE orders SET status = 'cancelled', fulfilment_status = 'cancelled', updated_at = ? WHERE id = ?", now(), orderId);
  await emit(db, 'order.cancelled', 'order', orderId, { by: 'customer' });
  await syncPaymentStatus(db, orderId);
  await notify(db, userId, `Order #${orderId} was cancelled.`, `#/orders/${orderId}`);
  for (const s of await all(db, 'SELECT DISTINCT s.user_id FROM order_items oi JOIN sellers s ON s.id = oi.seller_id WHERE oi.order_id = ?', orderId)) {
    await notify(db, s.user_id, `Order #${orderId} was cancelled by the customer. Stock was released.`, '#/orders');
  }
  return await getOrder(db, orderId, userId);
}

// ---------------------------------------------------------------- returns and refunds

async function deliveredOn(db, shipmentId) {
  const r = await one(db, "SELECT at FROM shipment_events WHERE shipment_id = ? AND status = 'delivered' ORDER BY id DESC LIMIT 1", shipmentId);
  return r ? indiaDate(r.at) : null; // the India date it arrived
}

// Returns [eligible, reason, maxQty] for one order item.
export async function returnEligibility(db, item, today = new Date()) {
  const window = await scalar(db, 'SELECT return_window_days FROM products WHERE id = ?', item.product_id);
  if (window === 0) return [false, 'This item is not returnable.', 0];
  const delivered = await deliveredOn(db, item.shipment_id);
  if (!delivered) return [false, 'You can return this after it is delivered.', 0];
  const lastDay = addDays(delivered, window);
  if (indiaDate(today) > lastDay) return [false, `The return window closed on ${lastDay}.`, 0];
  const openQty = await scalar(db, "SELECT COALESCE(SUM(qty), 0) FROM returns WHERE order_item_id = ? AND status IN ('pickup_scheduled', 'received')", item.id);
  const remaining = item.qty - item.returned_qty - openQty;
  if (remaining <= 0) return [false, 'Already returned.', 0];
  return [true, `Returnable until ${lastDay}.`, remaining];
}

export async function requestReturn(db, userId, orderId, orderItemId, qty, reason) {
  const item = await one(db, `SELECT oi.* FROM order_items oi JOIN orders o ON o.id = oi.order_id
                        WHERE oi.id = ? AND oi.order_id = ? AND o.user_id = ? FOR UPDATE OF oi`, orderItemId, orderId, userId);
  if (!item) throw notFound('Order item');
  reason = String(reason || '').trim();
  if (!reason) throw badRequest("Tell us why you're returning it.");
  const [ok, why, maxQty] = await returnEligibility(db, item);
  if (!ok) throw conflict(why);
  qty = toQty(qty);
  if (qty < 1 || qty > maxQty) throw badRequest(`You can return 1–${maxQty} of this item.`);
  const ts = now();
  const rid = await run(db, `INSERT INTO returns (order_id, order_item_id, user_id, qty, reason, status, created_at, updated_at)
                       VALUES (?,?,?,?,?, 'pickup_scheduled', ?, ?)`, orderId, orderItemId, userId, qty, reason, ts, ts);
  await emit(db, 'return.requested', 'return', rid, { order_id: orderId, order_item_id: orderItemId, qty });
  await notify(db, userId, `Return #${rid} approved. A courier will collect ${item.title} within 2 days.`, `#/orders/${orderId}`);
  const sellerUser = (await one(db, 'SELECT user_id FROM sellers WHERE id = ?', item.seller_id)).user_id;
  await notify(db, sellerUser, `Return requested on order #${orderId}: ${item.title} × ${qty} (${reason}).`, '#/orders');
  return rid;
}

// Lock the order, then the return, and read it fresh: the second of two clicks sees the first's result.
async function lockReturn(db, returnId) {
  const where = await one(db, 'SELECT order_id FROM returns WHERE id = ?', returnId);
  if (!where) return null;
  await one(db, 'SELECT id FROM orders WHERE id = ? FOR UPDATE', where.order_id);
  return await one(db, 'SELECT * FROM returns WHERE id = ? FOR UPDATE', returnId);
}

// Ops marks the returned item as received: refund the customer, restock, debit the seller.
export async function receiveReturn(db, returnId, restock = true, decidedBy = actorUserId()) {
  const r = await lockReturn(db, returnId); // two clicks can't refund twice
  if (!r) throw notFound('Return');
  if (r.status !== 'pickup_scheduled') throw conflict(`This return is already ${r.status}.`);
  const item = await one(db, 'SELECT * FROM order_items WHERE id = ?', r.order_item_id);
  const amount = item.unit_price_paise * r.qty;
  const [refunded, destination] = await refund(db, r.order_id, amount, `Return #${returnId}.`);
  if (restock) {
    await run(db, 'UPDATE inventory SET on_hand = on_hand + ? WHERE offer_id = ? AND warehouse_id = ?', r.qty, item.offer_id, item.warehouse_id);
  }
  await run(db, 'UPDATE order_items SET returned_qty = returned_qty + ? WHERE id = ?', r.qty, item.id);
  await run(db, "UPDATE returns SET status = 'refunded', refund_paise = ?, updated_at = ?, decided_by = ? WHERE id = ?", refunded, now(), decidedBy, returnId);
  await emit(db, 'return.received', 'return', returnId, { order_id: r.order_id, refund_paise: refunded, restock });
  await audit(db, 'return.refund', 'return', returnId, { status: r.status }, { status: 'refunded', refund_paise: refunded, restock, decided_by: decidedBy });
  await ledger(db, item.seller_id, item.id, 'refund', -amount, `Return #${returnId}: ${item.title} × ${r.qty}`);
  await ledger(db, item.seller_id, item.id, 'fee_reversal', Math.round(amount * REFERRAL_FEE_RATE), 'Referral fee returned');
  await notify(db, r.user_id, `Refund of ${inr(refunded)} for return #${returnId} issued to ${destination}.`, `#/orders/${r.order_id}`);
  return refunded;
}

export async function rejectReturn(db, returnId, note, decidedBy = actorUserId()) {
  const r = await lockReturn(db, returnId);
  if (!r) throw notFound('Return');
  if (r.status !== 'pickup_scheduled') throw conflict(`This return is already ${r.status}.`);
  await run(db, "UPDATE returns SET status = 'rejected', updated_at = ?, decided_by = ? WHERE id = ?", now(), decidedBy, returnId);
  await audit(db, 'return.reject', 'return', returnId, { status: r.status }, { status: 'rejected', note: note || null, decided_by: decidedBy });
  await notify(db, r.user_id, `Return #${returnId} was rejected: ${note || 'item did not match the return reason.'}`, `#/orders/${r.order_id}`);
  await emit(db, 'return.rejected', 'return', returnId, { order_id: r.order_id, note: note || null });
}

export async function listReturns(db, status = null) {
  let sql = `SELECT r.*, oi.title, u.name AS customer_name, s.name AS seller_name, d.name AS decided_by_name
             FROM returns r JOIN order_items oi ON oi.id = r.order_item_id JOIN users u ON u.id = r.user_id
             JOIN sellers s ON s.id = oi.seller_id LEFT JOIN users d ON d.id = r.decided_by`;
  const params = [];
  if (status) { sql += ' WHERE r.status = ?'; params.push(status); }
  return await all(db, sql + ' ORDER BY r.id DESC LIMIT 200', ...params);
}

// ---------------------------------------------------------------- seller settlement

async function ledger(db, sellerId, orderItemId, kind, amount, note) {
  await run(db, 'INSERT INTO seller_ledger (seller_id, order_item_id, kind, amount_paise, note, at) VALUES (?,?,?,?,?,?)',
    sellerId, orderItemId, kind, amount, note, now());
}

export async function sellerLedger(db, sellerId) {
  return {
    entries: await all(db, 'SELECT * FROM seller_ledger WHERE seller_id = ? ORDER BY id DESC LIMIT 300', sellerId),
    balance_paise: await scalar(db, 'SELECT COALESCE(SUM(amount_paise), 0) FROM seller_ledger WHERE seller_id = ?', sellerId),
  };
}

// Pay out every seller's positive balance (simulated bank transfer).
export async function runSettlement(db) {
  await lockNamed(db, 'settlement'); // a second run waits, then finds the balances already paid
  const payouts = [];
  for (const s of await all(db, 'SELECT id, name, user_id FROM sellers')) {
    const balance = await scalar(db, 'SELECT COALESCE(SUM(amount_paise), 0) FROM seller_ledger WHERE seller_id = ?', s.id);
    if (balance > 0) {
      await ledger(db, s.id, null, 'payout', -balance, 'Settlement paid to bank account on file (simulated)');
      await notify(db, s.user_id, `Settlement of ${inr(balance)} paid to your bank account (simulated).`, '#/payments');
      payouts.push({ seller_id: s.id, seller_name: s.name, amount_paise: balance });
    }
  }
  await audit(db, 'settlement.run', 'settlement', '-', null, { payouts });
  return payouts;
}

// ---------------------------------------------------------------- reads

export async function getShipment(db, shipmentId) {
  const s = await one(db, `SELECT sh.*, w.name AS warehouse_name, w.city AS warehouse_city, w.kind AS warehouse_kind
                     FROM shipments sh JOIN warehouses w ON w.id = sh.warehouse_id WHERE sh.id = ?`, shipmentId);
  s.events = await all(db, 'SELECT * FROM shipment_events WHERE shipment_id = ? ORDER BY id', shipmentId);
  s.items = await all(db, 'SELECT * FROM order_items WHERE shipment_id = ?', shipmentId);
  s.stage_index = stage(s.status);
  s.receipt_confirmed = s.events.some((e) => e.status === 'receipt_confirmed');
  return s;
}

export async function getOrder(db, orderId, userId = null) {
  const o = userId == null
    ? await one(db, 'SELECT * FROM orders WHERE id = ?', orderId)
    : await one(db, 'SELECT * FROM orders WHERE id = ? AND user_id = ?', orderId, userId);
  if (!o) throw notFound('Order');
  o.address = loads(o.address, {});
  o.shipments = [];
  for (const r of await all(db, 'SELECT id FROM shipments WHERE order_id = ? ORDER BY id', orderId)) o.shipments.push(await getShipment(db, r.id));
  for (const sh of o.shipments) {
    for (const it of sh.items) {
      const [ok, why, maxQty] = await returnEligibility(db, it);
      Object.assign(it, { returnable: ok, return_note: why, returnable_qty: maxQty });
    }
  }
  const p = await one(db, 'SELECT * FROM payments WHERE order_id = ?', orderId);
  if (p) p.events = await all(db, 'SELECT * FROM payment_events WHERE payment_id = ? ORDER BY id', p.id);
  o.payment = p;
  o.returns = await all(db, `SELECT r.*, oi.title FROM returns r JOIN order_items oi ON oi.id = r.order_item_id
                       WHERE r.order_id = ? ORDER BY r.id`, orderId);
  o.cancellable = o.status === 'confirmed' && o.shipments.every((sh) => ['pending', 'picking', 'packed', 'cancelled'].includes(sh.status));
  return o;
}

export async function listOrders(db, userId) {
  const out = await all(db, 'SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC', userId);
  for (const o of out) o.items = await all(db, 'SELECT title, qty FROM order_items WHERE order_id = ?', o.id);
  return out;
}

export async function sellerOrders(db, sellerId) {
  const items = await all(db, `SELECT oi.*, o.created_at, o.status AS order_status, o.payment_status, o.address,
                                sh.status AS shipment_status, sh.tracking_no, sh.eta, w.name AS warehouse_name, w.kind AS warehouse_kind
                         FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN shipments sh ON sh.id = oi.shipment_id
                         JOIN warehouses w ON w.id = oi.warehouse_id
                         WHERE oi.seller_id = ? AND o.status != 'payment_failed' ORDER BY oi.id DESC LIMIT 300`, sellerId);
  for (const it of items) {
    it.city = loads(it.address, {}).city;
    delete it.address;
    const i = stage(it.shipment_status);
    it.next_stage = i >= 0 && i < SHIPMENT_STAGES.length - 1 ? SHIPMENT_STAGES[i + 1] : null;
    it.seller_can_advance = it.warehouse_kind === 'seller_dispatch' && SELLER_STAGES.has(it.next_stage);
  }
  return items;
}

export async function listShipments(db, activeOnly = true) {
  let sql = "SELECT sh.id FROM shipments sh JOIN orders o ON o.id = sh.order_id WHERE o.status NOT IN ('payment_failed')";
  if (activeOnly) sql += " AND sh.status NOT IN ('delivered', 'cancelled')";
  const out = [];
  for (const r of await all(db, sql + ' ORDER BY sh.id DESC LIMIT 200')) {
    const s = await getShipment(db, r.id);
    s.next_stage = s.stage_index >= 0 && s.stage_index < SHIPMENT_STAGES.length - 1 ? SHIPMENT_STAGES[s.stage_index + 1] : null;
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------- support

export async function createTicket(db, userId, orderId, subject, body) {
  subject = String(subject || '').trim();
  body = String(body || '').trim();
  if (!subject || !body) throw badRequest('Add a subject and a message.');
  if (orderId && !await one(db, 'SELECT 1 AS x FROM orders WHERE id = ? AND user_id = ?', Number(orderId), userId)) throw notFound('Order');
  const tid = await run(db, "INSERT INTO support_tickets (user_id, order_id, subject, status, created_at) VALUES (?,?,?, 'open', ?)",
    userId, orderId ? Number(orderId) : null, subject, now());
  await run(db, "INSERT INTO support_messages (ticket_id, author_role, body, at) VALUES (?, 'customer', ?, ?)", tid, body, now());
  await emit(db, 'ticket.created', 'ticket', tid, { order_id: orderId ? Number(orderId) : null });
  return tid;
}

export async function listTickets(db, userId = null) {
  let sql = 'SELECT t.*, u.name AS customer_name FROM support_tickets t JOIN users u ON u.id = t.user_id';
  const params = [];
  if (userId) { sql += ' WHERE t.user_id = ?'; params.push(userId); }
  const tickets = await all(db, sql + ' ORDER BY t.id DESC LIMIT 200', ...params);
  for (const t of tickets) t.messages = await all(db, 'SELECT * FROM support_messages WHERE ticket_id = ? ORDER BY id', t.id);
  return tickets;
}

export async function replyTicket(db, ticketId, authorRole, body, close = false, userId = null) {
  const t = await one(db, 'SELECT * FROM support_tickets WHERE id = ?', ticketId);
  if (!t || (userId != null && t.user_id !== userId)) throw notFound('Ticket');
  body = String(body || '').trim();
  if (!body) throw badRequest('Write a message.');
  await run(db, 'INSERT INTO support_messages (ticket_id, author_role, body, at) VALUES (?,?,?,?)', ticketId, authorRole, body, now());
  await emit(db, 'ticket.message', 'ticket', ticketId, { author_role: authorRole, closed: Boolean(close) });
  const status = close ? 'closed' : authorRole === 'ops' ? 'answered' : 'open';
  await run(db, 'UPDATE support_tickets SET status = ? WHERE id = ?', status, ticketId);
  if (authorRole === 'ops') await notify(db, t.user_id, `Equidron Support replied to "${t.subject}".`, '#/support');
}
