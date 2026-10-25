// Phase 12: settlement is a batch a person approves. Building it moves nothing; approving it pays;
// and the tax figures on it are drafts a CA checks, not a filing.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { handleApi } from '../src/api.js';
import { settings } from '../src/auth.js';
import { all, one, run, scalar } from '../src/db.js';
import * as orders from '../src/orders.js';
import { approveBatch, buildBatch, listBatches, rejectBatch, sellerBalances, TCS_RATE, TDS_RATE, taxDrafts } from '../src/settlement.js';
import { openDatabase } from '../src/server.js';

settings.fastHashing = true;
process.env.EQUIDRON_SEED_DEMO = '1';

let db;
before(async () => { db = await openDatabase('memory'); });
after(async () => { await db?.close(); });

const payouts = () => scalar(db, "SELECT COALESCE(SUM(-amount_paise), 0) FROM seller_ledger WHERE kind = 'payout'");

test('the seeded shop has something to settle', async () => {
  const balances = await sellerBalances(db);
  assert.ok(balances.length > 0, 'at least one seller has a positive balance');
  assert.ok(balances.every((b) => Number(b.balance_paise) > 0));
});

test('building a batch moves no money at all', async () => {
  const before = await payouts();
  const batch = await buildBatch(db);
  assert.equal(batch.status, 'pending');
  assert.ok(batch.lines.length > 0);
  assert.ok(batch.total_paise > 0);
  // The ledger has no payout row yet: that is the whole point.
  assert.equal(await payouts(), before);
  // The net is the balance minus the two tax drafts.
  for (const l of batch.lines) {
    assert.equal(Number(l.net_paise), Number(l.gross_paise) - Number(l.tcs_paise) - Number(l.tds_paise));
    assert.ok(Number(l.tcs_paise) >= 0 && Number(l.tds_paise) >= 0);
  }
  assert.equal(Number(batch.total_paise), batch.lines.reduce((n, l) => n + Number(l.net_paise), 0));
});

test('only one batch is open at a time', async () => {
  await assert.rejects(() => buildBatch(db), /waiting for approval/);
});

test('approving pays the net amounts, once', async () => {
  const [batch] = await listBatches(db);
  const before = await payouts();
  const paid = await approveBatch(db, batch.id, { by: null });
  assert.equal(paid.status, 'approved');
  const after = await payouts();
  assert.equal(after - before, Number(batch.total_paise), 'the ledger moved by exactly the batch total');

  // A second approval is refused, so nobody pays twice.
  await assert.rejects(() => approveBatch(db, batch.id, { by: null }), /already approved/);
  assert.equal(await payouts(), after);
  // The sellers were told.
  const notes = await all(db, "SELECT * FROM notifications WHERE message LIKE 'Settlement of %'");
  assert.ok(notes.length >= paid.lines.length);
});

test('a rejected batch pays nothing and can be replaced', async () => {
  // Give a seller a balance again by crediting the ledger directly, the way a delivery would.
  const seller = await one(db, 'SELECT id FROM sellers ORDER BY id LIMIT 1');
  await run(db, `INSERT INTO seller_ledger (seller_id, order_item_id, kind, amount_paise, note, at)
                 VALUES (?, NULL, 'sale', 500000, 'A sale for the rejection test.', now())`, seller.id);
  const before = await payouts();
  const batch = await buildBatch(db);
  const rejected = await rejectBatch(db, batch.id, { by: null, note: 'Wrong month.' });
  assert.equal(rejected.status, 'rejected');
  assert.equal(await payouts(), before, 'a rejection pays nothing');
  // A new batch can be built now.
  const next = await buildBatch(db);
  assert.equal(next.status, 'pending');
  assert.notEqual(next.id, batch.id);
});

test('the tax drafts are per seller, on this month’s paid sales', async () => {
  const drafts = await taxDrafts(db);
  assert.ok(drafts.length > 0);
  for (const d of drafts) {
    assert.equal(Number(d.tcs_paise), Math.round(Number(d.gross_paise) * TCS_RATE));
    assert.equal(Number(d.tds_paise), Math.round(Number(d.gross_paise) * TDS_RATE));
    assert.match(d.month, /^\d{4}-\d{2}$/);
  }
});

test('the settlement route builds a batch and pays nothing; finance decides', async () => {
  const cookies = {};
  const call = async (method, path, body) => {
    const out = await handleApi(db, { method, path, query: new URLSearchParams(), body, cookies });
    if (out.setCookie) {
      const [k, v] = out.setCookie.split(';')[0].split('=');
      if (v) cookies[k] = v; else delete cookies[k];
    }
    return out;
  };
  assert.equal((await call('POST', '/api/ops/login', { email: 'finance@example.com', password: 'equidron-demo' })).status, 200);
  // Close anything the earlier tests left open, so this test starts from a clean queue.
  for (const b of (await call('GET', '/api/ops/settlement')).payload.batches) {
    if (b.status === 'pending') await call('POST', `/api/ops/settlement/batches/${b.id}/reject`, { note: 'cleanup' });
  }

  const before = await payouts();
  const built = await call('POST', '/api/ops/settlement/run');
  assert.equal(built.status, 200);
  assert.equal(built.payload.batch.status, 'pending');
  assert.equal(await payouts(), before, 'the route alone pays nobody');

  const approved = await call('POST', `/api/ops/settlement/batches/${built.payload.batch.id}/approve`);
  assert.equal(approved.status, 200);
  assert.equal(approved.payload.status, 'approved');
  assert.ok(await payouts() > before);

  // The list route shows the batch and the tax drafts.
  const view = await call('GET', '/api/ops/settlement');
  assert.equal(view.status, 200);
  assert.ok(view.payload.batches.length > 0);
  assert.ok(Array.isArray(view.payload.tax));

  // A seller has no business here.
  const shop = {};
  const other = await handleApi(db, { method: 'POST', path: '/api/ops/settlement/run', query: new URLSearchParams(), body: {}, cookies: shop });
  assert.ok([401, 403].includes(other.status));
});
