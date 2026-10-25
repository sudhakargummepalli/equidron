// Settlement: a payout is a batch a person approves.
//
// Before this, a route paid every seller the moment it was called. Now the route builds a batch,
// Ops reads it (who, how much, why), and only an approval moves the money in the seller ledger.
// The tax lines are drafts, not advice: TCS under s.52 and TDS under 194-O both depend on the
// seller's registration and the month's facts, so a person checks them before filing.
import { audit } from './audit.js';
import { all, changes, now, one, run, scalar, transaction } from './db.js';
import { badRequest, conflict, notFound } from './errors.js';
import * as notify from './notify.js';
import { inr } from './orders.js';

// Draft rates. TCS s.52 is 0.5% of net taxable supplies; TDS 194-O is 1% of gross sales. Both are
// computed on the month's sales that were paid, not on the balance being paid out.
export const TCS_RATE = 0.005;
export const TDS_RATE = 0.01;

const monthStart = (at = new Date()) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString();

// The balance owed to each seller, from the ledger the shop already keeps.
export async function sellerBalances(db) {
  return await all(db, `SELECT s.id AS seller_id, s.name, s.user_id,
                               COALESCE(SUM(l.amount_paise), 0) AS balance_paise
                        FROM sellers s LEFT JOIN seller_ledger l ON l.seller_id = s.id
                        GROUP BY s.id, s.name, s.user_id
                        HAVING COALESCE(SUM(l.amount_paise), 0) > 0
                        ORDER BY s.id`);
}

// Gross sales this month, per seller: what the tax drafts are computed on.
async function monthlyGross(db, sellerId, from) {
  return Number(await scalar(db, `SELECT COALESCE(SUM(oi.unit_price_paise * oi.qty), 0)
                                  FROM order_items oi JOIN orders o ON o.id = oi.order_id
                                  WHERE oi.seller_id = ? AND o.payment_status = 'captured'
                                    AND o.status <> 'cancelled' AND o.created_at >= ?`, sellerId, from));
}

export async function buildBatch(db, { at = new Date() } = {}) {
  const open = await one(db, "SELECT id FROM payout_batches WHERE status = 'pending' ORDER BY id DESC LIMIT 1");
  if (open) throw conflict(`Batch #${open.id} is still waiting for approval.`);

  const balances = await sellerBalances(db);
  if (!balances.length) throw badRequest('There is nothing to pay out.');

  const from = monthStart(at);
  return await transaction(db, async () => {
    const lines = [];
    for (const s of balances) {
      const gross = await monthlyGross(db, s.seller_id, from);
      const tcs = Math.round(gross * TCS_RATE);
      const tds = Math.round(gross * TDS_RATE);
      const net = Number(s.balance_paise) - tcs - tds;
      if (net <= 0) continue;
      lines.push({ seller_id: Number(s.seller_id), seller: s.name, gross_paise: Number(s.balance_paise), tcs_paise: tcs, tds_paise: tds, net_paise: net });
    }
    if (!lines.length) throw badRequest('Every balance is smaller than the tax drafted on it.');
    const total = lines.reduce((n, l) => n + l.net_paise, 0);
    const batchId = await run(db, "INSERT INTO payout_batches (status, total_paise, note, created_at) VALUES ('pending', ?, ?, ?)",
      total, `Draft TCS ${TCS_RATE * 100}% and TDS ${TDS_RATE * 100}% on ${from.slice(0, 7)} sales; check before filing.`, now());
    for (const l of lines) {
      await run(db, `INSERT INTO payout_lines (batch_id, seller_id, gross_paise, tcs_paise, tds_paise, net_paise)
                     VALUES (?,?,?,?,?,?)`, batchId, l.seller_id, l.gross_paise, l.tcs_paise, l.tds_paise, l.net_paise);
    }
    await audit(db, 'payout.batch', 'payout_batch', batchId, null, { total_paise: total, sellers: lines.length });
    return await getBatch(db, batchId);
  });
}

export async function getBatch(db, id) {
  const batch = await one(db, 'SELECT * FROM payout_batches WHERE id = ?', Number(id));
  if (!batch) throw notFound('Payout batch');
  const lines = await all(db, `SELECT l.*, s.name AS seller FROM payout_lines l JOIN sellers s ON s.id = l.seller_id
                               WHERE l.batch_id = ? ORDER BY l.seller_id`, batch.id);
  return { ...batch, lines };
}

// Approving is what pays. One guarded UPDATE means two people clicking at once pay once.
export async function approveBatch(db, id, { by = null } = {}) {
  return await transaction(db, async () => {
    const fresh = await changes(db, "UPDATE payout_batches SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
      by, now(), Number(id));
    if (!fresh) {
      const b = await one(db, 'SELECT status FROM payout_batches WHERE id = ?', Number(id));
      if (!b) throw notFound('Payout batch');
      throw conflict(`This batch was already ${b.status}.`);
    }
    const lines = await all(db, 'SELECT l.*, s.user_id FROM payout_lines l JOIN sellers s ON s.id = l.seller_id WHERE l.batch_id = ?', Number(id));
    for (const l of lines) {
      // The payout line is negative in the ledger, as the balance is cleared.
      await run(db, 'INSERT INTO seller_ledger (seller_id, order_item_id, kind, amount_paise, note, at) VALUES (?, NULL, ?, ?, ?, ?)',
        l.seller_id, 'payout', -Number(l.net_paise), `Payout batch #${id}: net ${inr(l.net_paise)} after TCS and TDS drafts.`, now());
      await notify.notify(db, l.user_id, `Settlement of ${inr(l.net_paise)} is on its way to your bank account (simulated).`, '#/payments');
    }
    await audit(db, 'payout.approve', 'payout_batch', id, { status: 'pending' }, { status: 'approved', by });
    return await getBatch(db, id);
  });
}

export async function rejectBatch(db, id, { by = null, note = null } = {}) {
  const fresh = await changes(db, "UPDATE payout_batches SET status = 'rejected', decided_by = ?, decided_at = ?, note = ? WHERE id = ? AND status = 'pending'",
    by, now(), note, Number(id));
  if (!fresh) {
    const b = await one(db, 'SELECT status FROM payout_batches WHERE id = ?', Number(id));
    if (!b) throw notFound('Payout batch');
    throw conflict(`This batch was already ${b.status}.`);
  }
  await audit(db, 'payout.reject', 'payout_batch', id, { status: 'pending' }, { status: 'rejected', by, note });
  return await getBatch(db, id);
}

export async function listBatches(db, limit = 20) {
  return await all(db, 'SELECT * FROM payout_batches ORDER BY id DESC LIMIT ?', limit);
}

// The month's tax drafts on their own, for the CA: gross, TCS and TDS per seller.
export async function taxDrafts(db, { at = new Date() } = {}) {
  const from = monthStart(at);
  const rows = [];
  for (const s of await all(db, 'SELECT id, name FROM sellers ORDER BY id')) {
    const gross = await monthlyGross(db, s.id, from);
    if (!gross) continue;
    rows.push({ seller_id: Number(s.id), seller: s.name, month: from.slice(0, 7), gross_paise: gross,
      tcs_paise: Math.round(gross * TCS_RATE), tds_paise: Math.round(gross * TDS_RATE) });
  }
  return rows;
}
