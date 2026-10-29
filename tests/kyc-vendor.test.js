// Phase 11: the KYC vendor side, simulated. The http provider is exercised against a local endpoint
// that answers the shape a real vendor does - so the code path that will talk to Karza or Signzy is
// the one being tested, not a parallel simulation of it.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { handleApi } from '../src/api.js';
import * as kyc from '../src/kyc.js';
import { openDatabase } from '../src/server.js';

process.env.EQUIDRON_SEED_DEMO = '1';

let db;
const realFetch = globalThis.fetch;
before(async () => {
  db = await openDatabase('memory');
  process.env.KYC_DEV_VENDOR = '1';
  process.env.KYC_PROVIDER = 'http';
  process.env.KYC_API_URL = 'https://vendor.test/verify';
  process.env.KYC_API_KEY = 'test-key';
});
after(async () => {
  globalThis.fetch = realFetch;
  delete process.env.KYC_DEV_VENDOR; delete process.env.KYC_PROVIDER;
  delete process.env.KYC_API_URL; delete process.env.KYC_API_KEY;
  await db?.close();
});

test('the vendor endpoint is 404 unless it is switched on', async () => {
  delete process.env.KYC_DEV_VENDOR;
  const hidden = await handleApi(db, { method: 'POST', path: '/api/dev/kyc', query: new URLSearchParams(), body: { pan: 'ABCDE1234A' }, cookies: {}, headers: {} });
  assert.equal(hidden.status, 404);
  process.env.KYC_DEV_VENDOR = '1';
  const shown = await handleApi(db, { method: 'POST', path: '/api/dev/kyc', query: new URLSearchParams(), body: { pan: 'ABCDE1234A' }, cookies: {}, headers: {} });
  assert.equal(shown.status, 200);
  assert.equal(shown.payload.status, 'verified');
  assert.match(shown.payload.reference, /^dev_/);
});

test('the http provider sends the PAN and reads the vendor answer', async () => {
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), auth: init.headers.authorization, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ status: 'verified', reason: 'PAN and name match.', score: 0.97, reference: 'v_1' }), { status: 200 });
  };
  const answer = await kyc.verify({ pan: 'ABCDE1234A', name: 'Asha Rao', businessName: 'Asha Studio' });
  assert.equal(answer.status, 'verified');
  assert.equal(answer.ref, 'v_1');
  assert.match(seen.url, /vendor\.test/);
  assert.equal(seen.auth, 'Bearer test-key');
  assert.equal(seen.body.pan, 'ABCDE1234A');
  assert.equal(seen.body.business_name, 'Asha Studio');
});

test('a vendor that refuses the request is an error, not a silent pass', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'quota exceeded' }), { status: 429 });
  await assert.rejects(() => kyc.verify({ pan: 'ABCDE1234A', name: 'X' }), /refused the request \(429\).*quota exceeded/);
});

test('with no provider configuration the call refuses before any network use', async () => {
  delete process.env.KYC_API_URL;
  globalThis.fetch = async () => { throw new Error('no network should be touched'); };
  await assert.rejects(() => kyc.verify({ pan: 'ABCDE1234A', name: 'X' }), /not configured/);
  process.env.KYC_API_URL = 'https://vendor.test/verify';
});