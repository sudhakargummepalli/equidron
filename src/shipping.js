// Phase 9: talking to a courier.
//
// Two providers, one interface:
//   simulated  deterministic, no network. It is what the tests and the local demo use, and it
//              behaves like a carrier: serviceability by pincode, a rate per weight, an AWB, a
//              label URL, pickup slots and tracking stages.
//   http       a thin JSON-over-HTTP client for a real sandbox. It is configured only by the
//              environment, and it refuses to run when that configuration is missing, so a
//              half-configured carrier fails loudly instead of pretending to book.
//
// The shape of the HTTP calls is documented in docs/DECISIONS.md: the exact paths differ between
// Shiprocket, Delhivery and the rest, so it is one adapter with the mapping in one place, to be
// adjusted when the owner picks a carrier and supplies a sandbox account.
import { badRequest } from './errors.js';

// The stages a carrier reports, mapped onto the stages the app already uses.
export const STAGE_FROM_CARRIER = {
  PICKED_UP: 'picked', PICKED: 'picked',
  IN_TRANSIT: 'in_transit', OUT_FOR_DELIVERY: 'out_for_delivery',
  DELIVERED: 'delivered',
  UNDELIVERED: 'undelivered', NDR: 'undelivered',
  RTO: 'returned', RETURNED: 'returned',
};

export const RATE_PER_500G_PAISE = 4_500; // ₹45 per 500 g, a published-ish demo rate
export const SERVICEABLE_PINCODES = /^[1-9][0-9]{5}$/;

export const providerName = () => (process.env.SHIPPING_PROVIDER || 'simulated').toLowerCase();

// What the app calls. Both providers answer the same promises.
export async function serviceability(pincode) {
  const pin = String(pincode || '').trim();
  if (!SERVICEABLE_PINCODES.test(pin)) return { serviceable: false, reason: 'Not a valid pincode.' };
  if (providerName() === 'http') {
    const out = await http('GET', `/serviceability?pincode=${encodeURIComponent(pin)}`);
    return { serviceable: Boolean(out.serviceable), reason: out.reason ?? null, eta_days: out.eta_days ?? null };
  }
  // Simulated: every valid pincode is serviceable, in 2 to 4 days.
  return { serviceable: true, reason: null, eta_days: 2 + (Number(pin.slice(-1)) % 3) };
}

export async function rate({ weightGrams = 500, pincode = null } = {}) {
  const units = Math.max(1, Math.ceil(Number(weightGrams) / 500));
  if (providerName() === 'http') {
    const out = await http('POST', '/rates', { weight_grams: Number(weightGrams), pincode });
    return { amount_paise: Number(out.amount_paise), eta_days: Number(out.eta_days ?? 3) };
  }
  return { amount_paise: units * RATE_PER_500G_PAISE, eta_days: pincode ? 2 + (Number(String(pincode).slice(-1)) % 3) : 3 };
}

// Book one shipment. The caller has already decided that this shipment is going out; this returns
// the carrier's own identifiers and never changes the order.
export async function createShipment({ shipmentId, orderId, weightGrams = 500, pincode, city, paymentMode = 'prepaid' } = {}) {
  if (!shipmentId || !orderId) throw badRequest('A booking needs the shipment and its order.');
  if (!SERVICEABLE_PINCODES.test(String(pincode || ''))) throw badRequest('That delivery pincode is not valid.');
  const served = await serviceability(pincode);
  if (!served.serviceable) throw badRequest(`The courier does not deliver to ${pincode}.`);

  if (providerName() === 'http') {
    const out = await http('POST', '/shipments', {
      reference: String(shipmentId), order_reference: String(orderId),
      weight_grams: Number(weightGrams), pincode, city, payment_mode: paymentMode,
    });
    if (!out.awb) throw badRequest('The courier did not return an AWB.');
    return { awb: String(out.awb), label_url: out.label_url ?? null, carrier_ref: out.id ?? null, eta: out.eta ?? null };
  }

  // Simulated: an AWB that looks like the real thing, and a label URL that is stable per shipment.
  const awb = `EQ${String(100000 + Number(shipmentId) * 7919).slice(-9)}`;
  return {
    awb, label_url: `/img/label-${shipmentId}.svg`, carrier_ref: `SIM-${shipmentId}`,
    eta: new Date(Date.now() + served.eta_days * 86_400_000).toISOString().slice(0, 10),
  };
}

export async function schedulePickup({ awb, date = new Date() } = {}) {
  if (!awb) throw badRequest('A pickup needs an AWB.');
  if (providerName() === 'http') {
    const out = await http('POST', '/pickups', { awb, date: date.toISOString().slice(0, 10) });
    return { pickup_at: out.pickup_at ?? date.toISOString() };
  }
  // Simulated: the next day at 10:00, which is what most carriers offer.
  const at = new Date(date.getTime() + 86_400_000);
  at.setUTCHours(4, 30, 0, 0); // 10:00 IST
  return { pickup_at: at.toISOString() };
}

export async function track(awb) {
  if (!awb) throw badRequest('Tracking needs an AWB.');
  if (providerName() === 'http') {
    const out = await http('GET', `/track?awb=${encodeURIComponent(awb)}`);
    return { stage: STAGE_FROM_CARRIER[String(out.status || '').toUpperCase()] ?? null, raw: out.status ?? null, events: out.events ?? [] };
  }
  return { stage: null, raw: null, events: [] }; // the simulator moves shipments through the app itself
}

// The HTTP provider. Fail closed: no base URL or token means no carrier, not a silent simulation.
async function http(method, path, body = null) {
  const base = process.env.SHIPPING_BASE_URL;
  const token = process.env.SHIPPING_TOKEN;
  if (!base || !token) throw badRequest('The courier sandbox is not configured. Set SHIPPING_BASE_URL and SHIPPING_TOKEN.');
  const res = await fetch(`${base.replace(/\/$/, '')}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
  if (!res.ok) throw badRequest(`The courier refused the request (${res.status}). ${payload.error ?? payload.message ?? ''}`.trim());
  return payload;
}
