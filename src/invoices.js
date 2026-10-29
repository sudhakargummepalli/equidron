// Phase 10: the GST invoice.
//
// Prices in this marketplace are quoted tax-inclusive, the way an Indian buyer expects. So the
// taxable value is worked back out of the total, and the tax is split equally between CGST and SGST
// for a sale within the seller's state, or shown as IGST for a sale outside it.
//
// The document is a plain PDF written here rather than a dependency: a handful of text lines at
// fixed positions is all an invoice needs, and a five-line generator is easier to audit than a
// template engine. Rates and the seller's GSTIN are the two things a CA may want to change, and
// both are in one place.
import { all, now, one, run } from './db.js';
import { notFound } from './errors.js';
import { inr } from './orders.js';

export const GST_RATE = 0.18; // set once, for the whole invoice
export const SELLER_STATE = 'Karnataka'; // a sale inside this state splits CGST/SGST
export const SELLER_GSTIN = process.env.EQUIDRON_GSTIN || '29ABCDE1234F1Z5';
export const SELLER_NAME = 'Equidron Marketplace';
export const SELLER_ADDRESS = '12 Lakeview Road, Indiranagar, Bengaluru 560038';

// Tax-inclusive total -> the taxable value and the two halves of the tax, in whole paise.
export function splitTax(totalPaise) {
  const total = Number(totalPaise);
  const taxable = Math.round(total / (1 + GST_RATE));
  const tax = total - taxable;
  const cgst = Math.floor(tax / 2);
  return { taxable, tax, cgst, sgst: tax - cgst };
}

const pad = (n) => String(n).padStart(4, '0');

// The invoice number is per month, so a year of invoices sorts and can be explained to an auditor.
export async function issue(db, orderId) {
  const existing = await one(db, 'SELECT * FROM invoices WHERE order_id = ?', orderId);
  if (existing) return existing;

  const order = await one(db, `SELECT o.*, u.name AS customer_name, u.email AS customer_email
                               FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = ?`, orderId);
  if (!order) throw notFound('Order');
  const address = order.address || {};
  const month = new Date().toISOString().slice(0, 7).replace('-', '');
  const seq = Number((await one(db, 'SELECT COUNT(*) AS n FROM invoices')).n) + 1;
  const number = `INV-${month}-${pad(seq)}`;

  const { taxable, cgst, sgst } = splitTax(order.total_paise);
  const outside = String(address.state || '').trim() && !String(address.state).toLowerCase().includes(SELLER_STATE.toLowerCase());
  const igst = outside ? cgst + sgst : 0;

  await run(db, `INSERT INTO invoices (order_id, number, issued_at, taxable_paise, cgst_paise, sgst_paise,
                    igst_paise, total_paise, place_of_supply, seller_gstin)
                 VALUES (?,?,?,?,?,?,?,?,?,?)`,
  orderId, number, now(), taxable, outside ? 0 : cgst, outside ? 0 : sgst, igst, Number(order.total_paise),
  address.state || address.city || null, SELLER_GSTIN);

  return await one(db, 'SELECT * FROM invoices WHERE order_id = ?', orderId);
}

async function lines(db, invoice) {
  const order = await one(db, 'SELECT * FROM orders WHERE id = ?', invoice.order_id);
  const items = await all(db, 'SELECT title, qty, unit_price_paise FROM order_items WHERE order_id = ? ORDER BY id', invoice.order_id);
  const buyer = await one(db, 'SELECT u.name, u.email FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = ?', invoice.order_id);
  return { order, items, buyer, address: order.address || {} };
}

// A minimal PDF writer: A4, Helvetica, one text line per row. No dependency, no compression.
export function renderPdf(invoice, { items = [], buyer = {}, address = {} } = {}) {
  const esc = (s) => String(s ?? '').replace(/[\\()]/g, '\\$&').replace(/[^\x20-\x7E]/g, '?');
  const money = (paise) => esc(inr(Number(paise)));
  const rows = [];
  const put = (text, x, y, size = 11, bold = false) =>
    rows.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x} ${y} Td (${esc(text)}) Tj ET`);

  put('TAX INVOICE', 40, 800, 18, true);
  put(SELLER_NAME, 40, 780, 12, true);
  put(SELLER_ADDRESS, 40, 766, 9);
  put(`GSTIN: ${SELLER_GSTIN}`, 40, 754, 9);
  put(`Invoice: ${invoice.number}`, 400, 800, 10, true);
  put(`Date: ${String(invoice.issued_at).slice(0, 10)}`, 400, 786, 10);
  put(`Order: #${invoice.order_id}`, 400, 772, 10);
  put('Billed to', 40, 726, 11, true);
  put(buyer.name || '', 40, 712, 10);
  put(buyer.email || '', 40, 700, 9);
  put([address.line1, address.city, address.pincode].filter(Boolean).join(', '), 40, 688, 9);

  put('Item', 40, 650, 9, true);
  put('Qty', 360, 650, 9, true);
  put('Rate', 400, 650, 9, true);
  put('Amount', 480, 650, 9, true);
  let y = 636;
  for (const it of items) {
    put(String(it.title).slice(0, 60), 40, y, 9);
    put(String(it.qty), 360, y, 9);
    put(money(it.unit_price_paise), 400, y, 9);
    put(money(Number(it.unit_price_paise) * Number(it.qty)), 480, y, 9);
    y -= 14;
    if (y < 240) break;
  }

  y -= 10;
  put('Taxable value', 360, y, 9); put(money(invoice.taxable_paise), 480, y, 9); y -= 14;
  if (Number(invoice.igst_paise)) { put('IGST 18%', 360, y, 9); put(money(invoice.igst_paise), 480, y, 9); y -= 14; }
  else {
    put('CGST 9%', 360, y, 9); put(money(invoice.cgst_paise), 480, y, 9); y -= 14;
    put('SGST 9%', 360, y, 9); put(money(invoice.sgst_paise), 480, y, 9); y -= 14;
  }
  put('Total (tax inclusive)', 360, y, 10, true); put(money(invoice.total_paise), 480, y, 10, true);
  y -= 30;
  put('Prices include GST. This is a computer-generated invoice.', 40, y, 8);

  const content = rows.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

export async function invoicePdf(db, orderId, userId = null) {
  const order = await one(db, 'SELECT id, user_id FROM orders WHERE id = ?', orderId);
  if (!order) throw notFound('Order');
  if (userId != null && Number(order.user_id) !== Number(userId)) throw notFound('Order');
  const invoice = await issue(db, orderId);
  const facts = await lines(db, invoice);
  return { invoice, pdf: renderPdf(invoice, facts) };
}

export async function listInvoices(db, limit = 50) {
  return await all(db, 'SELECT * FROM invoices ORDER BY id DESC LIMIT ?', Math.min(200, Math.max(1, Number(limit) || 50)));
}
