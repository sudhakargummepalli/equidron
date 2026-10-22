// Every email the marketplace sends, in one place: one voice, one subject line per event, and
// one file to change when the wording changes.
//
// Each builder returns { subject, body } as plain text. Nothing here touches the database, so the
// wording can be tested without one; src/job-kinds.js does the reading and hands the facts in.
import { inr } from './orders.js';

// What a customer should read for each courier stage. 'pending' is left out on purpose: the
// order confirmation already says the order was received, and one email at that moment is enough.
export const STAGE_WORDS = {
  picking: 'Your items are being picked',
  packed: 'Your order is packed',
  shipped: 'Your order has shipped',
  in_transit: 'Your order is on its way',
  out_for_delivery: 'Your order is out for delivery',
  delivered: 'Your order was delivered',
};

const money = (paise) => inr(Number(paise) || 0);
const hi = (name) => `Hello ${String(name || 'there').split(' ')[0]},`;

export function orderPlaced({ firstName, orderId, totalPaise, itemCount, city }) {
  return {
    subject: `Your Equidron order #${orderId} is confirmed`,
    body: `${hi(firstName)}\n\n`
      + `Thank you. Your order #${orderId} is confirmed.\n`
      + `Items: ${itemCount}\nTotal: ${money(totalPaise)}\n`
      + (city ? `Delivering to: ${city}\n` : '')
      + `\nWe will email you again when it is packed, when it ships and when it is out for delivery.\n`
      + `You can follow it at any time under Your orders.\n\n— Equidron`,
  };
}

export function paymentReceived({ firstName, orderId, totalPaise, method }) {
  const how = { card: 'card', upi: 'UPI', bank: 'bank transfer', cod: 'cash on delivery' }[method] || method || 'your chosen method';
  return {
    subject: `Payment received for order #${orderId}`,
    body: `${hi(firstName)}\n\nWe have received ${money(totalPaise)} for order #${orderId} (${how}).\n`
      + `There is nothing you need to do.\n\n— Equidron`,
  };
}

export function shipmentUpdate({ firstName, orderId, stage, items, tracking, eta, city }) {
  const words = STAGE_WORDS[stage] || 'Your order has moved on';
  const lines = [`${hi(firstName)}`, '', `${words} (order #${orderId}).`];
  if (items && items.length) lines.push(`Items: ${items.join(', ')}`);
  if (tracking) lines.push(`Tracking: ${tracking}`);
  if (eta) lines.push(`Expected by: ${eta}`);
  if (city) lines.push(`Delivering to: ${city}`);
  if (stage === 'delivered') lines.push('If anything is wrong, you can ask for a return from Your orders.');
  lines.push('', '— Equidron');
  return { subject: `${words} — order #${orderId}`, body: lines.join('\n') };
}

export function orderCancelled({ firstName, orderId, totalPaise }) {
  return {
    subject: `Order #${orderId} was cancelled`,
    body: `${hi(firstName)}\n\nOrder #${orderId} (${money(totalPaise)}) has been cancelled.\n`
      + `Any money already taken is returned to the same payment method.\n`
      + `You can order again at any time.\n\n— Equidron`,
  };
}

export function returnApproved({ firstName, orderId, returnId, title, qty }) {
  return {
    subject: `Return #${returnId} approved for order #${orderId}`,
    body: `${hi(firstName)}\n\nWe have approved return #${returnId}: ${title} × ${qty}.\n`
      + `A courier will collect it within two days. Keep the item packed with its tags and invoice.\n`
      + `The refund goes back to your original payment method after we receive it.\n\n— Equidron`,
  };
}

export function returnRefunded({ firstName, orderId, returnId, refundPaise }) {
  return {
    subject: `Refund of ${money(refundPaise)} for order #${orderId}`,
    body: `${hi(firstName)}\n\nWe received the item from return #${returnId} and have refunded ${money(refundPaise)}.\n`
      + `It goes back to your original payment method, usually within five working days.\n\n— Equidron`,
  };
}

export function returnRejected({ firstName, orderId, returnId, note, title }) {
  return {
    subject: `Return #${returnId} was not approved`,
    body: `${hi(firstName)}\n\nWe could not approve return #${returnId}${title ? ` for ${title}` : ''}.\n`
      + (note ? `Reason: ${note}\n` : '')
      + `If you think this is wrong, reply to this email or open a support ticket from the order page.\n\n— Equidron`,
  };
}

export function listingSubmitted({ firstName, title, kind, status, reasons }) {
  const live = status === 'approved';
  const what = kind === 'update' ? 'update' : 'new listing';
  return {
    subject: `Your ${what} "${title}" ${live ? 'is live' : 'is being reviewed'}`,
    body: `${hi(firstName)}\n\n`
      + `We received your ${what}: ${title}.\n`
      + (live
        ? 'It is approved and live in the store now.\n'
        : `It is in review: ${(reasons && reasons.length ? reasons.join('; ') : 'a reviewer will look at it shortly')}.\nWe will email you when it is decided.\n`)
      + `You can see it under Seller Central → Inventory.\n\n— Equidron`,
  };
}

export function listingDecided({ firstName, title, approved, note, auto }) {
  return {
    subject: `Listing ${approved ? 'approved' : 'rejected'}: ${title}`,
    body: `${hi(firstName)}\n\n`
      + `Your listing "${title}" was ${approved ? 'approved and is live' : 'rejected'}${auto ? ' automatically' : ''}.\n`
      + (note ? `Note from the reviewer: ${note}\n` : '')
      + (approved ? 'You can edit it under Seller Central → Inventory.\n' : 'You can fix the problem and submit it again.\n')
      + `\n— Equidron`,
  };
}
