// Phase 11: KYC, simulated. The provider decides by the PAN's last character, so every branch is
// testable offline and a real vendor can slot in behind the same interface.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { one, run } from '../src/db.js';
import { decide } from '../src/kyc.js';
import { runKyc, saveDraft, submit } from '../src/seller-signup.js';
import { openDatabase } from '../src/server.js';

process.env.EQUIDRON_SEED_DEMO = '1';

let db;
let applicant;
before(async () => {
  db = await openDatabase('memory');
  applicant = await one(db, "SELECT * FROM users WHERE email = 'rahul@example.com'");
});
after(async () => { await db?.close(); });

const base = {
  business_name: 'Rahul Traders', business_type: 'individual',
  bank_account_name: 'Rahul Kumar', bank_account_no: '123456789012', bank_ifsc: 'HDFC0001234',
  pickup_line1: '4 Market Road', pickup_city: 'Bengaluru', pickup_pincode: '560038', pickup_phone: '9800000009',
};

async function applied(user, pan, name) {
  await saveDraft(db, user, { ...base, pan, business_name: name });
  const out = await submit(db, user, { agreement: true });
  return out.application.id;
}

test('the simulator answers by the last character, and refuses a malformed PAN', () => {
  assert.equal(decide('ABCDE1234A').status, 'verified');
  assert.equal(decide('ABCDE1234B').status, 'rejected');
  assert.match(decide('ABCDE1234B').reason, /name does not match/);
  assert.equal(decide('ABCDE1234Z').status, 'rejected');
  assert.equal(decide('nonsense').status, 'rejected');
  assert.match(decide('nonsense').reason, /format/);
});

test('a verified PAN approves the application and records the reference', async () => {
  const id = await applied(applicant, 'ABCDE1234A', 'Rahul Traders');
  const out = await runKyc(db, id, 1);
  assert.equal(out.status, 'approved');
  assert.equal(out.kyc_status, 'verified');
  assert.match(out.ref, /^sim_kyc_/);
  const row = await one(db, 'SELECT status, kyc_status, kyc_ref, kyc_at FROM seller_applications WHERE id = ?', id);
  assert.equal(row.status, 'approved');
  assert.ok(row.kyc_at);
  const auditRow = await one(db, "SELECT * FROM audit_log WHERE action = 'seller.kyc' ORDER BY id DESC LIMIT 1");
  assert.ok(auditRow, 'the KYC decision is audited');
  await assert.rejects(() => runKyc(db, id, 1), /not waiting for KYC|already answered/);
});

test('a rejected PAN sends the account back to customer', async () => {
  const other = await one(db, "SELECT * FROM users WHERE email = 'asha@example.com'");
  const id = await applied(other, 'ABCDE1234B', 'Asha Studio');
  const answer = await runKyc(db, id, 1);
  assert.equal(answer.status, 'rejected');
  assert.match(answer.reason, /name does not match/);
  assert.equal((await one(db, 'SELECT role FROM users WHERE id = ?', other.id)).role, 'customer');
});

test('an application that is still a draft cannot be verified', async () => {
  const userId = await run(db, "INSERT INTO users (email, name, role, pw_salt, pw_hash, created_at) VALUES ('draft-only@example.com', 'Draft Only', 'customer', 's', 'h', now())");
  const draftUser = await one(db, 'SELECT * FROM users WHERE id = ?', userId);
  await saveDraft(db, draftUser, { ...base, pan: 'ABCDE1234A', business_name: 'Draft Only' });
  const draft = await one(db, 'SELECT id FROM seller_applications WHERE user_id = ?', draftUser.id);
  await assert.rejects(() => runKyc(db, draft.id, 1), /not waiting for KYC/);
});