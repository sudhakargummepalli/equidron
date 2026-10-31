import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

const ORDERS = [36, 37, 38, 67];
const src = new PGlite("data/pg-fix");
await src.waitReady;
const tgt = new pg.Client({ connectionString: "postgres://equidron:equidron-local@127.0.0.1:5432/equidron_live" });
await tgt.connect();

const liveUserByEmail = async (email) =>
  (await tgt.query("SELECT id FROM users WHERE email = $1", [email])).rows[0]?.id ?? null;
const recoveredEmail = async (userId) =>
  (await src.query("SELECT email FROM users WHERE id = $1", [userId])).rows[0]?.email ?? null;

await tgt.query("BEGIN");
const report = [];

// 1. The one account the recovered copy had that the live database does not.
const old = (await src.query("SELECT * FROM users WHERE email = 'equidron+old@gmail.com'")).rows[0];
if (old && !(await liveUserByEmail(old.email))) {
  await tgt.query(
    `INSERT INTO users (email, name, role, pw_algo, pw_salt, pw_hash, email_verified, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [old.email, old.name, old.role, old.pw_algo, old.pw_salt, old.pw_hash, old.email_verified, old.created_at]);
  report.push("account equidron+old@gmail.com");
}

// 2. Shipments and their timeline, for the four restored orders (seller and warehouse from live).
for (const id of ORDERS) {
  const ships = (await src.query("SELECT * FROM shipments WHERE order_id = $1 ORDER BY id", [id])).rows;
  for (const s of ships) {
    const exists = (await tgt.query("SELECT 1 FROM shipments WHERE order_id = $1 AND status = $2", [id, s.status])).rowCount > 0;
    if (exists) continue;
    const wh = (await tgt.query(
      "SELECT MIN(warehouse_id) AS w FROM inventory WHERE offer_id IN (SELECT offer_id FROM order_items WHERE order_id = $1)", [id])).rows[0].w;
    const ins = await tgt.query(
      `INSERT INTO shipments (order_id, warehouse_id, status, carrier, tracking_no, amount_paise, eta, created_at, updated_at, awb, label_url, carrier_ref, booked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [id, wh, s.status, s.carrier, s.tracking_no, s.amount_paise, s.eta, s.created_at, s.updated_at, s.awb, s.label_url, s.carrier_ref, s.booked_at]);
    const newId = ins.rows[0].id;
    const evs = (await src.query("SELECT * FROM shipment_events WHERE shipment_id = $1 ORDER BY id", [s.id])).rows;
    for (const e of evs) {
      await tgt.query(
        `INSERT INTO shipment_events (shipment_id, status, note, at) VALUES ($1,$2,$3,$4)`,
        [newId, e.status, e.note, e.at]);
    }
    report.push(`shipment ${s.status} for order ${id} (${evs.length} events)`);
  }

  // 3. Payment timeline, so the order page shows how the money moved.
  const payLive = (await tgt.query("SELECT id FROM payments WHERE order_id = $1 ORDER BY id LIMIT 1", [id])).rows[0];
  if (payLive) {
    const evs = (await src.query("SELECT * FROM payment_events WHERE payment_id IN (SELECT id FROM payments WHERE order_id = $1)", [id])).rows;
    const have = (await tgt.query("SELECT count(*) AS n FROM payment_events WHERE payment_id = $1", [payLive.id])).rows[0].n;
    if (Number(have) === 0) {
      for (const e of evs) {
        await tgt.query(
          `INSERT INTO payment_events (payment_id, kind, amount_paise, note, at) VALUES ($1,$2,$3,$4,$5)`,
          [payLive.id, e.kind, e.amount_paise, e.note, e.at]);
      }
      if (evs.length) report.push(`payment timeline for order ${id} (${evs.length})`);
    }
  }
}

// 4. Ledger rows for the restored orders, with the seller taken from the live offer.
const ledger = (await src.query("SELECT * FROM seller_ledger ORDER BY id")).rows;
let ledgerAdded = 0;
for (const l of ledger) {
  const orderItem = (await src.query("SELECT order_id, offer_id, qty, unit_price_paise FROM order_items WHERE id = $1", [l.order_item_id])).rows[0];
  if (!orderItem || !ORDERS.includes(orderItem.order_id)) continue;
  const seller = (await tgt.query("SELECT seller_id FROM offers WHERE id = $1", [orderItem.offer_id])).rows[0]?.seller_id;
  const liveItem = (await tgt.query(
    "SELECT id FROM order_items WHERE order_id = $1 AND offer_id = $2 LIMIT 1", [orderItem.order_id, orderItem.offer_id])).rows[0];
  if (!seller || !liveItem) continue;
  const exists = (await tgt.query("SELECT 1 FROM seller_ledger WHERE order_item_id = $1", [liveItem.id])).rowCount > 0;
  if (exists) continue;
  // note is NOT NULL in this schema; an empty string is what the writer uses when there is nothing to say.
  await tgt.query(
    `INSERT INTO seller_ledger (seller_id, order_item_id, kind, amount_paise, note, at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [seller, liveItem.id, l.kind, l.amount_paise, l.note ?? "", l.at]);
  ledgerAdded++;
}
if (ledgerAdded) report.push(`${ledgerAdded} ledger rows`);

// 5. Notices and email history for accounts that exist on both sides, matched by email.
for (const table of ["notifications", "outbox"]) {
  const rows = (await src.query(`SELECT * FROM "${table}" ORDER BY id`)).rows;
  let added = 0;
  for (const r of rows) {
    const email = await recoveredEmail(r.user_id);
    const liveUser = email ? await liveUserByEmail(email) : null;
    if (!liveUser) continue;
    const cols = table === "notifications" ? ["user_id", "message", "link", "is_read", "at"]
                                           : ["user_id", "channel", "to_address", "subject", "body", "at", "status", "attempts", "last_error", "sent_at", "claimed_at"];
    const values = table === "notifications"
      ? [liveUser, r.message, r.link, r.is_read, r.at]
      : [liveUser, r.channel, r.to_address, r.subject, r.body, r.at, r.status, r.attempts, r.last_error, r.sent_at, r.claimed_at];
    const dup = table === "notifications"
      ? await tgt.query("SELECT 1 FROM notifications WHERE user_id = $1 AND message = $2 AND at = $3", [liveUser, r.message, r.at])
      : await tgt.query("SELECT 1 FROM outbox WHERE user_id = $1 AND subject = $2 AND at = $3", [liveUser, r.subject, r.at]);
    if (dup.rowCount > 0) continue;
    await tgt.query(
      `INSERT INTO "${table}" (${cols.join(",")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(",")})`, values);
    added++;
  }
  if (added) report.push(`${added} ${table}`);
}

await tgt.query("COMMIT");
console.log(report.length ? report.map(r => "  restored " + r).join("\n") : "  nothing left to restore");
await tgt.end();
await src.close();
