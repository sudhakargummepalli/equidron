// Phase 10: the GST invoice. A default format, stated plainly so a CA can change the rates in one
// place later; the arithmetic and the access control are what the tests hold down.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { all, one, run } from "../src/db.js";
import { GST_RATE, invoicePdf, issue, renderPdf, splitTax } from "../src/invoices.js";
import { openDatabase } from "../src/server.js";

process.env.EQUIDRON_SEED_DEMO = "1";

let db;
let asha;
let order;
before(async () => {
  db = await openDatabase("memory");
  asha = await one(db, "SELECT id FROM users WHERE email = 'asha@example.com'");
  order = await one(db, "SELECT id FROM orders WHERE user_id = ? ORDER BY id LIMIT 1", asha.id);
});
after(async () => { await db?.close(); });

test("tax-inclusive prices are split back into taxable value, CGST and SGST", () => {
  const split = splitTax(11800);
  assert.equal(split.taxable, 10000);
  assert.equal(split.cgst + split.sgst, 1800);
  assert.equal(split.cgst, 900);
  for (const total of [1, 99, 100, 5000, 12345, 999999]) {
    const s = splitTax(total);
    assert.equal(s.taxable + s.cgst + s.sgst, total, "total " + total);
  }
  assert.equal(GST_RATE, 0.18);
});

test("an invoice is issued once per order, with a readable number", async () => {
  const first = await issue(db, order.id);
  assert.match(first.number, /^INV-\d{6}-\d{4}$/);
  const row = await one(db, "SELECT total_paise FROM orders WHERE id = ?", order.id);
  assert.equal(Number(first.total_paise), Number(row.total_paise));
  const again = await issue(db, order.id);
  assert.equal(again.number, first.number, "asking twice returns the same invoice");
  assert.equal((await all(db, "SELECT id FROM invoices WHERE order_id = ?", order.id)).length, 1);
});

test("the PDF is a real PDF, and it names the invoice and the buyer", async () => {
  const { invoice, pdf } = await invoicePdf(db, order.id, asha.id);
  assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");
  const text = pdf.toString("latin1");
  assert.match(text, /TAX INVOICE/);
  assert.ok(text.includes(invoice.number));
  assert.match(text, /GSTIN/);
  assert.ok(text.includes("Total"), "the total line is present");
  assert.ok(pdf.length > 800, "a page of text, not an empty stub");
});

test("another customer cannot read the invoice", async () => {
  const rahul = await one(db, "SELECT id FROM users WHERE email = 'rahul@example.com'");
  await assert.rejects(() => invoicePdf(db, order.id, rahul.id), /not found/i);
});

test("a sale outside Karnataka is charged IGST instead of CGST and SGST", async () => {
  const user = await one(db, "SELECT id FROM users WHERE email = 'asha@example.com'");
  const outside = await run(db, "INSERT INTO orders (user_id, address, status, payment_status, fulfilment_status, payment_method, subtotal_paise, shipping_paise, total_paise, created_at, updated_at) VALUES (?, '{\"state\":\"Delhi\"}', 'confirmed', 'captured', 'unfulfilled', 'cod', 10000, 0, 11800, now(), now())", user.id);
  const issued = await issue(db, outside);
  assert.equal(Number(issued.cgst_paise), 0);
  assert.equal(Number(issued.sgst_paise), 0);
  assert.equal(Number(issued.igst_paise), 1800);
  const pdf = renderPdf(issued, { items: [], buyer: { name: "Test" }, address: { state: "Delhi" } });
  assert.match(pdf.toString("latin1"), /IGST/);
});