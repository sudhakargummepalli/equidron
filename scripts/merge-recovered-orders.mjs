// Merge the recovered four days into the live database, by email and by the live catalogue.
//
// The recovered rows must not be copied blindly: their user 2 and seller 4 are ids from a different
// database, so an order would land on the wrong customer. Everything is re-linked through values that
// mean the same thing in both - an email address, an offer id that exists in the live catalogue - and the
// two orders whose payment never captured are left out, because a pending payment from a dead checkout is
// not history anybody wants restored.
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

const ORDERS = [36, 37, 38, 67];
const source = new PGlite("data/pg-fix");
await source.waitReady;
const target = new pg.Client({ connectionString: "postgres://equidron:equidron-local@127.0.0.1:5432/equidron_live" });
await target.connect();

const liveUser = (await target.query("SELECT id FROM users WHERE email = 'equidron@gmail.com'")).rows[0].id;
console.log("live user for equidron@gmail.com:", liveUser);

await target.query("BEGIN");
let inserted = 0, items = 0, payments = 0;

for (const id of ORDERS) {
  const order = (await source.query(
    `SELECT o.*, u.email FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = $1`, [id])).rows[0];
  if (!order) { console.log(`  order ${id}: not in the recovered data, skipped`); continue; }
  const exists = (await target.query("SELECT 1 FROM orders WHERE id = $1", [id])).rowCount > 0;
  if (exists) { console.log(`  order ${id}: already live, skipped`); continue; }

  await target.query(
    `INSERT INTO orders (id, user_id, address, status, payment_status, fulfilment_status, payment_method,
                         subtotal_paise, shipping_paise, total_paise, created_at, updated_at)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, liveUser, JSON.stringify(order.address), order.status, order.payment_status, order.fulfilment_status,
     order.payment_method, order.subtotal_paise, order.shipping_paise, order.total_paise,
     order.created_at, order.updated_at]);
  inserted++;

  const lines = (await source.query(
    `SELECT oi.* FROM order_items oi WHERE oi.order_id = $1 ORDER BY oi.id`, [id])).rows;
  for (const line of lines) {
    // Seller and warehouse come from the live catalogue, not from the recovered ids.
    const offer = (await target.query(
      `SELECT o.seller_id, o.product_id, (SELECT MIN(i.warehouse_id) FROM inventory i WHERE i.offer_id = o.id) AS warehouse_id
         FROM offers o WHERE o.id = $1`, [line.offer_id])).rows[0];
    if (!offer) { console.log(`    line ${line.id}: offer ${line.offer_id} missing live, skipped`); continue; }
    await target.query(
      `INSERT INTO order_items (order_id, offer_id, product_id, seller_id, warehouse_id, title, qty, unit_price_paise, returned_qty)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, line.offer_id, offer.product_id, offer.seller_id, offer.warehouse_id, line.title, line.qty,
       line.unit_price_paise, line.returned_qty ?? 0]);
    items++;
  }

  const pay = (await source.query(`SELECT * FROM payments WHERE order_id = $1 ORDER BY id LIMIT 1`, [id])).rows[0];
  if (pay) {
    await target.query(
      `INSERT INTO payments (order_id, method, instrument, status, authorized_paise, captured_paise, provider_ref, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, pay.method, pay.instrument, pay.status, pay.authorized_paise, pay.captured_paise,
       pay.provider_ref ?? null, pay.created_at, pay.updated_at]);
    payments++;
  }
  console.log(`  order ${id}: restored (${lines.length} line(s))`);
}

await target.query("COMMIT");
console.log(`done: ${inserted} orders, ${items} items, ${payments} payments`);
await target.end();
await source.close();
