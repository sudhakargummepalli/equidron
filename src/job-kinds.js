// The kinds of job Equidron runs today. Each handler runs inside its job's transaction and
// reads fresh data from the ids in the payload. Agents (Phase 4) will be more kinds of job.
import { saveBackup } from './backup.js';
import { one } from './db.js';
import * as orders from './orders.js';
import { sendEmail } from './outbox.js';

export const BUILT_IN = {
  // The confirmation email for a new order (into the outbox until email is connected).
  async 'email:order_confirmation'(db, payload) {
    const o = await one(db, `SELECT o.id, o.total_paise, u.id AS user_id, u.email, u.name
                             FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = ?`, payload.entity_id);
    if (!o) return;
    await sendEmail(db, o.user_id, o.email, `Your Equidron order #${o.id} is confirmed`,
      `Thank you, ${o.name.split(' ')[0]}. Your order #${o.id} for ${orders.inr(o.total_paise)} is confirmed. `
      + "We'll let you know when it ships. You can follow it under Your orders.");
  },

  // The logistics simulator: every active shipment moves one stage, as the Ops button does.
  async 'simulator:advance_shipments'(db) {
    for (const s of await orders.listShipments(db)) await orders.advanceShipment(db, s.id, 'ops');
  },

  // Every table as JSON, kept in Netlify Blobs (or data/backups locally).
  async 'backup:weekly'(db) {
    await saveBackup(db);
  },
};
