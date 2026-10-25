// Phase 11: seller sign-up. A draft is not a seller; the formats are checked in code; Aadhaar is
// never asked for; and submission creates the seller, its dispatch warehouse, and an Ops task.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { handleApi } from '../src/api.js';
import { settings } from '../src/auth.js';
import { all, one } from '../src/db.js';
import { missingFor, RE, saveDraft, submit, validate } from '../src/seller-signup.js';
import { openDatabase } from '../src/server.js';

settings.fastHashing = true;
process.env.EQUIDRON_SEED_DEMO = '1';

let db;
let asha;
let rahul;
before(async () => {
  db = await openDatabase('memory');
  asha = await one(db, "SELECT * FROM users WHERE email = 'asha@example.com'");
  rahul = await one(db, "SELECT * FROM users WHERE email = 'rahul@example.com'");
});
after(async () => { await db?.close(); });

const good = {
  business_name: 'Asha Home Studio',
  business_type: 'proprietorship',
  pan: 'ABCDE1234F',
  gstin: '29ABCDE1234F1Z5',
  bank_account_name: 'Asha Rao',
  bank_account_no: '123456789012',
  bank_ifsc: 'HDFC0001234',
  pickup_line1: '12 Lakeview Road, Indiranagar',
  pickup_city: 'Bengaluru',
  pickup_pincode: '560038',
  pickup_phone: '9800000001',
};

test('the format checks are the Indian formats, and they reject a near miss', () => {
  assert.ok(RE.pan.test('ABCDE1234F'));
  assert.ok(!RE.pan.test('ABCDE1234'), 'too short');
  assert.ok(!RE.pan.test('abcde1234f'), 'lower case is fixed by upper-casing, not accepted raw');
  assert.ok(RE.gstin.test('29ABCDE1234F1Z5'));
  assert.ok(!RE.gstin.test('29ABCDE1234F1Z'), 'short');
  assert.ok(RE.ifsc.test('HDFC0001234'));
  assert.ok(!RE.ifsc.test('HDFC1001234'), 'the fifth character is a zero');
  assert.ok(RE.pincode.test('560038'));
  assert.ok(!RE.pincode.test('060038'), 'cannot start with zero');
  assert.ok(RE.phone.test('9800000001'));
  assert.ok(!RE.phone.test('5800000001'), 'starts 6-9');
});

test('a complete application validates and nothing is missing', () => {
  const [clean, errors] = validate(good);
  assert.deepEqual(errors, {});
  assert.equal(clean.pan, 'ABCDE1234F');
  assert.equal(clean.gstin, '29ABCDE1234F1Z5');
  const missing = missingFor({ ...clean, agreement_at: null });
  assert.deepEqual(missing.steps, []);
});

test('a wrong PAN is refused with the field named, and the step it belongs to', () => {
  const missing = missingFor({ ...good, pan: 'NOPE' });
  assert.ok(missing.fields.includes('pan'));
  assert.ok(missing.steps.includes('tax'));
  assert.match(missing.errors.pan, /ten characters/);
});

test('GSTIN is optional: a small seller may be unregistered', () => {
  const missing = missingFor({ ...good, gstin: '' });
  assert.ok(!missing.fields.includes('gstin'));
});

test('a draft saves partial work and creates no seller', async () => {
  const draft = await saveDraft(db, asha, { business_name: 'Asha Home Studio', business_type: 'proprietorship' });
  assert.equal(draft.status, 'draft');
  assert.equal(draft.business_name, 'Asha Home Studio');
  // No seller row, and the account is still a customer.
  assert.equal(await one(db, 'SELECT id FROM sellers WHERE user_id = ?', asha.id), null);
  assert.equal((await one(db, 'SELECT role FROM users WHERE id = ?', asha.id)).role, 'customer');
});

test('submitting an incomplete draft is refused, and names the steps', async () => {
  await assert.rejects(() => submit(db, asha, { agreement: true }), (e) => {
    assert.match(e.message, /missing or not in the right format/i);
    assert.ok(e.details.steps.includes('tax'), 'the tax step is named');
    return true;
  });
});

test('completing and accepting makes the account a seller, with a warehouse and an Ops task', async () => {
  await saveDraft(db, asha, good);
  const out = await submit(db, asha, { agreement: true });

  assert.equal(out.application.status, 'submitted');
  assert.ok(out.application.agreement_at, 'the agreement is stamped');
  assert.ok(out.seller_id);
  assert.equal((await one(db, 'SELECT role FROM users WHERE id = ?', asha.id)).role, 'seller');
  const seller = await one(db, 'SELECT * FROM sellers WHERE id = ?', out.seller_id);
  assert.equal(seller.name, 'Asha Home Studio');
  assert.equal(seller.city, 'Bengaluru');
  const warehouse = await one(db, "SELECT * FROM warehouses WHERE seller_id = ? AND kind = 'seller_dispatch'", out.seller_id);
  assert.ok(warehouse, 'a dispatch warehouse is created');
  const task = await one(db, "SELECT * FROM ops_tasks WHERE kind = 'seller_kyc' AND dedupe_key = ?", `seller-kyc:${asha.id}`);
  assert.ok(task, 'a person is asked to check the documents');
  assert.match(task.body, /ABCDE1234F/);

  // A second submission is refused, and a second application cannot start.
  await assert.rejects(() => submit(db, asha, { agreement: true }), /already a seller|already submitted/);
});

test('a seller cannot apply again, and a non-customer cannot apply at all', async () => {
  const sellerUser = await one(db, "SELECT * FROM users WHERE email = 'techbazaar.seller@example.com'");
  await assert.rejects(() => saveDraft(db, sellerUser, good), /already a seller/);
  const staff = await one(db, "SELECT * FROM users WHERE email = 'ops@example.com'");
  await assert.rejects(() => saveDraft(db, staff, good), /customer account/i);
});

test('the API saves a draft and submits it, scoped to the session', async () => {
  const cookies = {};
  const call = async (method, path, body) => {
    const out = await handleApi(db, { method, path, query: new URLSearchParams(), body, cookies });
    if (out.setCookie) {
      const [k, v] = out.setCookie.split(';')[0].split('=');
      if (v) cookies[k] = v; else delete cookies[k];
    }
    return out;
  };
  assert.equal((await call('POST', '/api/shop/login', { email: 'rahul@example.com', password: 'equidron-demo' })).status, 200);
  const saved = await call('POST', '/api/shop/seller-application', { business_name: 'Rahul Traders', business_type: 'individual' });
  assert.equal(saved.status, 200);
  assert.equal(saved.payload.application.status, 'draft');

  const early = await call('POST', '/api/shop/seller-application/submit', { agreement: true });
  assert.equal(early.status, 400);
  assert.ok(early.payload.details.fields.length > 0);

  await call('POST', '/api/shop/seller-application', { ...good, business_name: 'Rahul Traders' });
  const done = await call('POST', '/api/shop/seller-application/submit', { agreement: true });
  assert.equal(done.status, 200);
  assert.equal(done.payload.application.status, 'submitted');
  assert.equal((await one(db, 'SELECT role FROM users WHERE id = ?', rahul.id)).role, 'seller');

  // The account is now a seller, so the shop session is no longer valid for the shop area (a
  // seller signs in at Seller Central), and there is still exactly one seller row.
  const again = await call('POST', '/api/shop/seller-application', { business_name: 'Another' });
  assert.equal(again.status, 401);
  assert.equal((await all(db, 'SELECT id FROM sellers WHERE user_id = ?', rahul.id)).length, 1);
});
