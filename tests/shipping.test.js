// Phase 9: booking a shipment with the courier, and the carrier webhook that moves it.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, test } from 'node:test';
import { handleApi } from '../src/api.js';
import { settings } from '../src/auth.js';
import { all, one, run } from '../src/db.js';
import { STAGE_FROM_CARRIER, createShipment, providerName, rate, schedulePickup, serviceability } from '../src/shipping.js';
import { openDatabase } from '../src/server.js';

settings.fastHashing = true;
process.env.EQUIDRON_SEED_DEMO = '1';

let db;
before(async () => { db = await openDatabase('memory'); delete process.env.SHIPPING_PROVIDER; delete process.env.SHIPPING_BASE_URL; delete process.env.SHIPPING_TOKEN; });
after(async () => { await db?.close(); });

test('the simulator is the default, and it answers like a carrier', async () => {
  assert.equal(providerName(), 'simulated');
  const ok = await serviceability('560038');
  assert.equal(ok.serviceable, true);
  assert.ok(ok.eta_days >= 2 && ok.eta_days <= 4);
  assert.equal((await serviceability('060038')).serviceable, false, 'a pincode cannot start with zero');
  assert.equal((await serviceability('abc')).serviceable, false);

  // Two 500 g units cost twice one.
  const one500 = await rate({ weightGrams: 500, pincode: '560038' });
  const one1000 = await rate({ weightGrams: 1000, pincode: '560038' });
  assert.equal(one1000.amount_paise, one500.amount_paise * 2);
});

test('booking returns an AWB, a label and an ETA, and is deterministic per shipment', async () => {
  const first = await createShipment({ shipmentId: 7, orderId: 3, pincode: '560038', city: 'Bengaluru' });
  const again = await createShipment({ shipmentId: 7, orderId: 3, pincode: '560038', city: 'Bengaluru' });
  assert.match(first.awb, /^EQ\d+$/);
  assert.equal(again.awb, first.awb, 'the same shipment gets the same AWB');
  assert.ok(first.label_url);
  assert.match(first.eta, /^\d{4}-\d{2}-\d{2}$/);
  // An unserviceable pincode is refused before anything is booked.
  await assert.rejects(() => createShipment({ shipmentId: 8, orderId: 4, pincode: '00000' }), /not valid|does not deliver/);
});

test('the pickups are offered the next morning in India time', async () => {
  const { pickup_at } = await schedulePickup({ awb: 'EQ1', date: new Date('2026-10-26T00:00:00Z') });
  const d = new Date(pickup_at);
  assert.equal(d.toISOString().slice(0, 10), '2026-10-27');
  assert.equal(d.getUTCHours(), 4); // 10:00 IST
});

test('the carrier stages map onto the app’s stages', () => {
  assert.equal(STAGE_FROM_CARRIER.DELIVERED, 'delivered');
  assert.equal(STAGE_FROM_CARRIER.NDR, 'undelivered');
  assert.equal(STAGE_FROM_CARRIER.RTO, 'returned');
  assert.equal(STAGE_FROM_CARRIER.WHATEVER, undefined);
});

test('choosing the http provider without credentials fails closed', async () => {
  process.env.SHIPPING_PROVIDER = 'http';
  await assert.rejects(() => serviceability('560038'), /not configured/);
  await assert.rejects(() => createShipment({ shipmentId: 1, orderId: 1, pincode: '560038' }), /not configured/);
  process.env.SHIPPING_PROVIDER = 'simulated';
});

test('the webhook needs its secret, moves the shipment, and ignores a repeat', async () => {
  process.env.SHIPPING_WEBHOOK_SECRET = 'carrier-secret';
  const shipment = await one(db, 'SELECT id, order_id, status FROM shipments ORDER BY id LIMIT 1');
  assert.ok(shipment, 'the sample data has a shipment');
  // A booking is what gives a shipment its AWB; the webhook finds shipments by that number.
  const booked = await createShipment({ shipmentId: shipment.id, orderId: shipment.order_id, pincode: '560038', city: 'Bengaluru' });
  await run(db, 'UPDATE shipments SET awb = ? WHERE id = ?', booked.awb, shipment.id);
  const awb = booked.awb;

  const hook = (headers, body) => handleApi(db, { method: 'POST', path: '/api/webhooks/shipping', query: new URLSearchParams(), body, cookies: {}, headers });

  assert.equal((await hook({}, { awb, status: 'DELIVERED', event_id: 'e1' })).status, 403);
  assert.equal((await hook({ 'x-shipping-secret': 'wrong' }, { awb, status: 'DELIVERED', event_id: 'e1' })).status, 403);

  const ok = await hook({ 'x-shipping-secret': 'carrier-secret' }, { awb: 'EQ-NOT-OURS', status: 'DELIVERED', event_id: 'e0' });
  assert.equal(ok.status, 200);
  assert.equal(ok.payload.ignored, 'unknown awb');

  const moved = await hook({ 'x-shipping-secret': 'carrier-secret' }, { awb, status: 'OUT_FOR_DELIVERY', event_id: `e-${shipment.id}` });
  assert.equal(moved.status, 200);
  assert.equal(moved.payload.stage, 'out_for_delivery');
  const after = await one(db, 'SELECT status FROM shipments WHERE id = ?', shipment.id);
  assert.equal(after.status, 'out_for_delivery');
  const event = await one(db, "SELECT * FROM shipment_events WHERE shipment_id = ? ORDER BY id DESC LIMIT 1", shipment.id);
  assert.match(String(event.note), /carrier/i);

  // The same event id again changes nothing.
  const repeat = await hook({ 'x-shipping-secret': 'carrier-secret' }, { awb, status: 'DELIVERED', event_id: `e-${shipment.id}` });
  assert.equal(repeat.status, 200);
  assert.equal(repeat.payload.duplicate, true);
  assert.equal((await one(db, 'SELECT status FROM shipments WHERE id = ?', shipment.id)).status, 'out_for_delivery');

  delete process.env.SHIPPING_WEBHOOK_SECRET;
});
