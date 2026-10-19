// Bank-statement payment checks. A customer who paid by UPI or bank transfer enters the
// reference (UTR / RRN) from their bank; checkout looks it up in Equidron's account
// statement and accepts it only if that payment really arrived for this order.
//
// The statement is a Google Sheet published as CSV (File -> Share -> Publish to web ->
// CSV), whose link goes in PAYMENT_STATEMENT_CSV_URL. Without it, the bundled
// FICTIONAL sample statement (src/sample-statement.js) is used.
// Columns are found by name: "Reference", "Credit", "Status" and "Narration".
import { mask } from './mask.js';
import { AppError } from './errors.js';
import { SAMPLE_STATEMENT_CSV } from './sample-statement.js';

const CACHE_MS = 30_000;
let cache = null; // { url, at, rows }

// RFC 4180 CSV: quoted fields, doubled quotes, commas and line breaks inside quotes.
export function parseCsv(text) {
  const records = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim())) records.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim())) records.push(row);
  return records;
}

const toPaise = (v) => {
  const n = Number(String(v ?? '').replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
};
export const normalizeRef = (ref) => String(ref ?? '').trim().toUpperCase();

// CSV text -> [{ref, creditPaise, debitPaise, status, narration}].
export function readStatement(csv) {
  const [header, ...lines] = parseCsv(csv);
  if (!header) throw new Error('The statement is empty.');
  const col = (name) => header.findIndex((h) => h.trim().toLowerCase().startsWith(name));
  const at = { ref: col('reference'), credit: col('credit'), debit: col('debit'), status: col('status'), narration: col('narration') };
  if (at.ref < 0 || at.credit < 0 || at.status < 0) {
    throw new Error('The statement needs "Reference", "Credit" and "Status" columns.');
  }
  return lines.map((r) => ({
    ref: normalizeRef(r[at.ref]),
    creditPaise: toPaise(r[at.credit]),
    debitPaise: at.debit >= 0 ? toPaise(r[at.debit]) : 0,
    status: String(r[at.status] ?? '').trim().toUpperCase(),
    narration: at.narration >= 0 ? String(r[at.narration] ?? '').toUpperCase() : '',
  })).filter((r) => r.ref);
}

// The statement rows, fetched at most every 30 seconds. Failures surface as a 503.
export async function loadStatement({ url = process.env.PAYMENT_STATEMENT_CSV_URL, fetchFn = globalThis.fetch } = {}) {
  if (!url) return readStatement(SAMPLE_STATEMENT_CSV);
  if (cache && cache.url === url && Date.now() - cache.at < CACHE_MS) return cache.rows;
  let rows;
  try {
    const res = await fetchFn(url, { headers: { Accept: 'text/csv' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    rows = readStatement(await res.text());
  } catch (e) {
    console.error('payment statement unavailable', mask(e.message));
    throw new AppError(503, "We couldn't reach the bank statement to confirm your payment. Please try again in a minute.");
  }
  cache = { url, at: Date.now(), rows };
  return rows;
}

// Does the statement show this reference paid in full for this order?
// Returns { ok: true } or { ok: false, code, message }. "Not used before" is checked
// against Equidron's own payments by the caller.
export function checkReference(rows, ref, totalPaise, rupees) {
  ref = normalizeRef(ref);
  const credits = rows.filter((r) => r.ref === ref && r.creditPaise > 0);
  if (!credits.length) {
    return { ok: false, code: 'reference_not_found', message: `No payment with reference ${ref} has reached Equidron's account yet.` };
  }
  const reversed = rows.some((r) => r.status === 'REVERSED' && r.ref !== ref && (r.ref === `REV${ref}` || r.narration.includes(ref)));
  if (reversed) return { ok: false, code: 'payment_reversed', message: `Payment ${ref} was reversed by the bank.` };
  const done = credits.find((r) => r.status === 'SUCCESS');
  if (!done) {
    const status = credits[0].status;
    if (status === 'PENDING') return { ok: false, code: 'payment_pending', message: `Payment ${ref} is still pending at the bank. Try again once it completes.` };
    const why = status && status !== 'FAILED' ? ` (status ${status.toLowerCase()})` : '';
    return { ok: false, code: 'payment_failed', message: `Payment ${ref} failed at the bank${why}.` };
  }
  if (done.creditPaise !== totalPaise) {
    return { ok: false, code: 'amount_mismatch', message: `Payment ${ref} was ${rupees(done.creditPaise)}, but this order is ${rupees(totalPaise)}.` };
  }
  return { ok: true };
}
