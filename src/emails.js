// Every email the marketplace sends, in one place, in the customer's language.
//
// The text is a small dictionary rather than a sentence per function: the same greeting, total,
// tracking and sign-off are reused by every message, and translating a phrase once translates it
// everywhere. English is the fallback, so an unknown language still sends a correct email.
//
// The rules the app follows are the same in both languages: a sale is a sale, a refund goes back
// to the original method, and an email never promises what the policy does not allow.
import { inr } from './orders.js';

// What a customer should read for each courier stage. 'pending' is left out on purpose: the
// order confirmation already says the order was received.
export const STAGE_WORDS = {
  en: {
    picking: 'Your items are being picked',
    packed: 'Your order is packed',
    shipped: 'Your order has shipped',
    in_transit: 'Your order is on its way',
    out_for_delivery: 'Your order is out for delivery',
    delivered: 'Your order was delivered',
  },
  te: {
    picking: 'మీ వస్తువులు ఎంపిక అవుతున్నాయి',
    packed: 'మీ ఆర్డర్ ప్యాక్ అయింది',
    shipped: 'మీ ఆర్డర్ పంపబడింది',
    in_transit: 'మీ ఆర్డర్ మార్గంలో ఉంది',
    out_for_delivery: 'మీ ఆర్డర్ డెలివరీకి బయలుదేరింది',
    delivered: 'మీ ఆర్డర్ డెలివరీ అయింది',
  },
};

export const LANGUAGES = ['en', 'te'];

const STRINGS = {
  en: {
    greeting: 'Hello {name},',
    signoff: '— Equidron',
    items: 'Items: {items}',
    total: 'Total: {amount}',
    deliveringTo: 'Delivering to: {city}',
    tracking: 'Tracking: {tracking}',
    expectedBy: 'Expected by: {eta}',
    howPaid: 'Paid with: {method}',

    'placed.subject': 'Your Equidron order #{id} is confirmed',
    'placed.body': 'Thank you. Your order #{id} is confirmed.',
    'placed.more': 'We will email you again when it is packed, when it ships and when it is out for delivery.',

    'payment.subject': 'Payment received for order #{id}',
    'payment.body': 'We have received {amount} for order #{id}. There is nothing you need to do.',

    'shipment.subject': '{stage} — order #{id}',
    'shipment.deliveredHint': 'If anything is wrong, you can ask for a return from Your orders.',

    'cancelled.subject': 'Order #{id} was cancelled',
    'cancelled.body': 'Order #{id} ({amount}) has been cancelled. Any money already taken is returned to the same payment method.',

    'returnApproved.subject': 'Return #{returnId} approved for order #{id}',
    'returnApproved.body': 'We have approved return #{returnId}: {title} × {qty}. A courier will collect it within two days. The refund goes back to your original payment method after we receive it.',

    'returnRefunded.subject': 'Refund of {amount} for order #{id}',
    'returnRefunded.body': 'We received the item from return #{returnId} and have refunded {amount}. It goes back to your original payment method, usually within five working days.',

    'returnRejected.subject': 'Return #{returnId} was not approved',
    'returnRejected.body': 'We could not approve return #{returnId}{title}. If you think this is wrong, reply to this email or open a support ticket.',

    'listingSubmitted.subject': 'Your {what} "{title}" {state}',
    'listingSubmitted.live': 'is live',
    'listingSubmitted.review': 'is being reviewed',
    'listingSubmitted.received': 'We received your {what}: {title}.',
    'listingSubmitted.inReview': 'It is in review: {reasons}.',
    'listingSubmitted.willTell': 'We will email you when it is decided.',
    'listingSubmitted.seeInventory': 'You can see it under Seller Central → Inventory.',

    'listingDecided.subject': 'Listing {state}: {title}',
    'listingDecided.approved': 'approved',
    'listingDecided.rejected': 'rejected',
    'listingDecided.body': 'Your listing "{title}" was {state}{auto}.',
    'listingDecided.auto': ' automatically',
    'listingDecided.note': 'Note from the reviewer: {note}',
    'listingDecided.next': 'You can edit it under Seller Central → Inventory.',
    'listingDecided.retry': 'You can fix the problem and submit it again.',
  },
  te: {
    greeting: 'నమస్తే {name},',
    signoff: '— ఈక్విడ్రాన్',
    items: 'వస్తువులు: {items}',
    total: 'మొత్తం: {amount}',
    deliveringTo: 'డెలివరీ: {city}',
    tracking: 'ట్రాకింగ్: {tracking}',
    expectedBy: 'అంచనా తేదీ: {eta}',
    howPaid: 'చెల్లించిన విధానం: {method}',

    'placed.subject': 'మీ ఈక్విడ్రాన్ ఆర్డర్ #{id} నిర్ధారించబడింది',
    'placed.body': 'ధన్యవాదాలు. మీ ఆర్డర్ #{id} నిర్ధారించబడింది.',
    'placed.more': 'ప్యాక్ అయినప్పుడు, పంపినప్పుడు మరియు డెలివరీకి బయలుదేరినప్పుడు మీకు మళ్లీ మెయిల్ పంపుతాము.',

    'payment.subject': 'ఆర్డర్ #{id} కోసం చెల్లింపు అందింది',
    'payment.body': 'ఆర్డర్ #{id} కోసం {amount} అందింది. మీరు ఏమీ చేయాల్సిన అవసరం లేదు.',

    'shipment.subject': '{stage} — ఆర్డర్ #{id}',
    'shipment.deliveredHint': 'ఏదైనా సమస్య ఉంటే, మీ ఆర్డర్ల నుండి రిటర్న్ కోరవచ్చు.',

    'cancelled.subject': 'ఆర్డర్ #{id} రద్దు చేయబడింది',
    'cancelled.body': 'ఆర్డర్ #{id} ({amount}) రద్దు చేయబడింది. తీసుకున్న డబ్బు అదే చెల్లింపు పద్ధతికి తిరిగి ఇవ్వబడుతుంది.',

    'returnApproved.subject': 'ఆర్డర్ #{id} కోసం రిటర్న్ #{returnId} ఆమోదించబడింది',
    'returnApproved.body': 'రిటర్న్ #{returnId}: {title} × {qty} ఆమోదించాము. రెండు రోజుల్లో కొరియర్ వస్తువును తీసుకుంటారు. వస్తువు మాకు చేరిన తర్వాత రీఫండ్ మీ అసలు చెల్లింపు పద్ధతికి వెళ్తుంది.',

    'returnRefunded.subject': 'ఆర్డర్ #{id} కోసం {amount} రీఫండ్',
    'returnRefunded.body': 'రిటర్న్ #{returnId} నుండి వస్తువు అందింది, {amount} రీఫండ్ చేశాము. ఇది సాధారణంగా ఐదు పని దినాల్లో మీ అసలు చెల్లింపు పద్ధతికి చేరుతుంది.',

    'returnRejected.subject': 'రిటర్న్ #{returnId} ఆమోదించబడలేదు',
    'returnRejected.body': 'రిటర్న్ #{returnId}{title} ఆమోదించలేకపోయాము. ఇది తప్పు అనిపిస్తే, ఈ మెయిల్కు ప్రత్యుత్తరం ఇవ్వండి లేదా సపోర్ట్ టికెట్ తెరవండి.',

    'listingSubmitted.subject': 'మీ {what} "{title}" {state}',
    'listingSubmitted.live': 'ప్రచారంలో ఉంది',
    'listingSubmitted.review': 'సమీక్షలో ఉంది',
    'listingSubmitted.received': 'మీ {what} అందింది: {title}.',
    'listingSubmitted.inReview': 'ఇది సమీక్షలో ఉంది: {reasons}.',
    'listingSubmitted.willTell': 'నిర్ణయం అయినప్పుడు మీకు మెయిల్ పంపుతాము.',
    'listingSubmitted.seeInventory': 'ఇది సెల్లర్ సెంట్రల్ → ఇన్వెంటరీలో చూడవచ్చు.',

    'listingDecided.subject': 'లిస్టింగ్ {state}: {title}',
    'listingDecided.approved': 'ఆమోదించబడింది',
    'listingDecided.rejected': 'తిరస్కరించబడింది',
    'listingDecided.body': 'మీ లిస్టింగ్ "{title}" {state}{auto}.',
    'listingDecided.auto': ' స్వయంచాలకంగా',
    'listingDecided.note': 'సమీక్షకుడి నోట్: {note}',
    'listingDecided.next': 'సెల్లర్ సెంట్రల్ → ఇన్వెంటరీలో మార్చవచ్చు.',
    'listingDecided.retry': 'సమస్యను సరిచేసి మళ్లీ సమర్పించవచ్చు.',
  },
};

export const langOf = (value) => (LANGUAGES.includes(value) ? value : 'en');

// t('te', 'placed.subject', { id: 12 }) — a missing key returns the key, which a test would catch.
export function t(lang, key, vars = {}) {
  const table = STRINGS[langOf(lang)];
  const fallback = STRINGS.en;
  let value = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : fallback[key];
  if (value == null) return key;
  for (const [k, v] of Object.entries(vars)) value = value.split(`{${k}}`).join(String(v));
  return value;
}

const money = (paise) => inr(Number(paise) || 0);
const hi = (lang, name) => t(lang, 'greeting', { name: String(name || '').split(' ')[0] || 'there' });
const signoff = (lang) => t(lang, 'signoff');

export function orderPlaced({ lang = 'en', firstName, orderId, totalPaise, itemCount, city }) {
  const L = langOf(lang);
  const lines = [hi(L, firstName), '', t(L, 'placed.body', { id: orderId }),
    t(L, 'items', { items: itemCount }), t(L, 'total', { amount: money(totalPaise) })];
  if (city) lines.push(t(L, 'deliveringTo', { city }));
  lines.push('', t(L, 'placed.more'), '', signoff(L));
  return { subject: t(L, 'placed.subject', { id: orderId }), body: lines.join('\n') };
}

export function paymentReceived({ lang = 'en', firstName, orderId, totalPaise, method }) {
  const L = langOf(lang);
  return {
    subject: t(L, 'payment.subject', { id: orderId }),
    body: [hi(L, firstName), '', t(L, 'payment.body', { id: orderId, amount: money(totalPaise) }),
      method ? t(L, 'howPaid', { method }) : '', '', signoff(L)].filter((x) => x !== '').join('\n'),
  };
}

export function shipmentUpdate({ lang = 'en', firstName, orderId, stage, items, tracking, eta, city }) {
  const L = langOf(lang);
  const words = STAGE_WORDS[L][stage] || STAGE_WORDS.en[stage];
  if (!words) return null;
  const lines = [hi(L, firstName), '', `${words}.`];
  if (items && items.length) lines.push(t(L, 'items', { items: items.join(', ') }));
  if (tracking) lines.push(t(L, 'tracking', { tracking }));
  if (eta) lines.push(t(L, 'expectedBy', { eta }));
  if (city) lines.push(t(L, 'deliveringTo', { city }));
  if (stage === 'delivered') lines.push(t(L, 'shipment.deliveredHint'));
  lines.push('', signoff(L));
  return { subject: t(L, 'shipment.subject', { stage: words, id: orderId }), body: lines.join('\n') };
}

export function orderCancelled({ lang = 'en', firstName, orderId, totalPaise }) {
  const L = langOf(lang);
  return {
    subject: t(L, 'cancelled.subject', { id: orderId }),
    body: [hi(L, firstName), '', t(L, 'cancelled.body', { id: orderId, amount: money(totalPaise) }), '', signoff(L)].join('\n'),
  };
}

export function returnApproved({ lang = 'en', firstName, orderId, returnId, title, qty }) {
  const L = langOf(lang);
  return {
    subject: t(L, 'returnApproved.subject', { returnId, id: orderId }),
    body: [hi(L, firstName), '', t(L, 'returnApproved.body', { returnId, title, qty }), '', signoff(L)].join('\n'),
  };
}

export function returnRefunded({ lang = 'en', firstName, orderId, returnId, refundPaise }) {
  const L = langOf(lang);
  return {
    subject: t(L, 'returnRefunded.subject', { id: orderId, amount: money(refundPaise) }),
    body: [hi(L, firstName), '', t(L, 'returnRefunded.body', { returnId, amount: money(refundPaise) }), '', signoff(L)].join('\n'),
  };
}

export function returnRejected({ lang = 'en', firstName, orderId, returnId, title }) {
  const L = langOf(lang);
  return {
    subject: t(L, 'returnRejected.subject', { returnId }),
    body: [hi(L, firstName), '', t(L, 'returnRejected.body', { returnId, title: title ? ` (${title})` : '' }), '', signoff(L)].join('\n'),
  };
}

export function listingSubmitted({ lang = 'en', firstName, title, kind, status, reasons }) {
  const L = langOf(lang);
  const live = status === 'approved';
  const what = kind === 'update' ? 'update' : 'new listing';
  return {
    subject: t(L, 'listingSubmitted.subject', { what, title, state: live ? t(L, 'listingSubmitted.live') : t(L, 'listingSubmitted.review') }),
    body: [
      hi(L, firstName), '',
      t(L, 'listingSubmitted.received', { what, title }),
      live ? `${t(L, 'listingSubmitted.live')}.` : t(L, 'listingSubmitted.inReview', { reasons: (reasons || []).join('; ') || '—' }),
      live ? '' : t(L, 'listingSubmitted.willTell'),
      '', t(L, 'listingSubmitted.seeInventory'), '', signoff(L),
    ].filter((x) => x !== '').join('\n'),
  };
}

export function listingDecided({ lang = 'en', firstName, title, approved, note, auto }) {
  const L = langOf(lang);
  const state = approved ? t(L, 'listingDecided.approved') : t(L, 'listingDecided.rejected');
  return {
    subject: t(L, 'listingDecided.subject', { state, title }),
    body: [
      hi(L, firstName), '',
      t(L, 'listingDecided.body', { title, state, auto: auto ? t(L, 'listingDecided.auto') : '' }),
      note ? t(L, 'listingDecided.note', { note }) : '',
      approved ? t(L, 'listingDecided.next') : t(L, 'listingDecided.retry'),
      '', signoff(L),
    ].filter((x) => x !== '').join('\n'),
  };
}

// For the tests and for anyone adding a language: every key must exist in every language.
export const KEYS = Object.keys(STRINGS.en);
export const TABLES = STRINGS;
