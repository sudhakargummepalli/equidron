// Phase 8: Razorpay. The signature rules are pure functions, so they are tested without a network;
// the browser and webhook paths are tested through the API with a stubbed fetch.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { handleApi } from "../src/api.js";
import { settings } from "../src/auth.js";
import { one, run } from "../src/db.js";
import * as orders from "../src/orders.js";
import * as gateway from "../src/payments-gateway.js";
import * as razorpay from "../src/razorpay.js";
import { openDatabase } from "../src/server.js";

settings.fastHashing = true;
process.env.EQUIDRON_SEED_DEMO = "1";

let db;
const realFetch = globalThis.fetch;
before(async () => {
  db = await openDatabase("memory");
  process.env.RAZORPAY_KEY_ID = "rzp_test_headless";
  process.env.RAZORPAY_KEY_SECRET = "secret_headless";
  process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_headless";
});
after(async () => { globalThis.fetch = realFetch; await db?.close(); });

const sign = (orderId, paymentId) => crypto.createHmac("sha256", "secret_headless").update(`${orderId}|${paymentId}`).digest("hex");

test("the key id is public, the secret never is", () => {
  assert.equal(razorpay.keyId(), "rzp_test_headless");
  assert.equal(razorpay.enabled(), true);
  const src = readFileSync(new URL("../src/razorpay.js", import.meta.url), "utf8");
  assert.ok(!src.includes("secret_headless"), "no secret is written into the code");
  assert.ok(!/rzp_(test|live)_[A-Za-z0-9]{10,}/.test(src), "no real key id is written into the code");
});

test("a signature covers the order and the payment, and nothing else", () => {
  assert.equal(razorpay.verifySignature({ orderId: "order_a", paymentId: "pay_b", signature: sign("order_a", "pay_b") }), true);
  assert.equal(razorpay.verifySignature({ orderId: "order_a", paymentId: "pay_c", signature: sign("order_a", "pay_b") }), false);
  assert.equal(razorpay.verifySignature({ orderId: "order_z", paymentId: "pay_b", signature: sign("order_a", "pay_b") }), false);
  assert.throws(() => razorpay.verifySignature({ orderId: "order_a", paymentId: "pay_b" }), /signature are required/);
});

test("the webhook signature is over the raw bytes, and needs a secret", () => {
  const body = JSON.stringify({ event: "payment.captured" });
  const good = crypto.createHmac("sha256", "whsec_headless").update(body).digest("hex");
  assert.equal(razorpay.verifyWebhook(body, good), true);
  assert.equal(razorpay.verifyWebhook(body + " ", good), false, "a changed byte changes the signature");
  delete process.env.RAZORPAY_WEBHOOK_SECRET;
  assert.equal(razorpay.verifyWebhook(body, good), false, "no secret configured: fail closed");
  process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_headless";
});

test("an amount below 100 paise is refused before any call is made", async () => {
  await assert.rejects(() => razorpay.createOrder({ amountPaise: 99, receipt: "r1" }), /at least 100 paise/);
});

test("creating a gateway order uses the secret, and never returns it", async () => {
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url, auth: init.headers.authorization, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ id: "order_gw1", amount: init.body ? JSON.parse(init.body).amount : 5000, currency: "INR", receipt: "order_7", status: "created" }), { status: 200 });
  };
  const out = await razorpay.createOrder({ amountPaise: 5000, receipt: "order_7" });
  assert.equal(out.order_id, "order_gw1");
  assert.equal(out.amount, 5000);
  assert.match(seen.auth, /^Basic /);
  assert.equal(seen.body.currency, "INR");
  assert.equal(seen.body.payment_capture, 1);
  assert.ok(!JSON.stringify(out).includes("secret_headless"));
});

test("the webhook refuses a bad signature and ignores an event with no payment", async () => {
  const hook = (body, signature) => handleApi(db, { method: "POST", path: "/api/webhooks/payments",
    query: new URLSearchParams(), body: JSON.parse(typeof body === "string" ? body : JSON.stringify(body)),
    raw: typeof body === "string" ? body : JSON.stringify(body), cookies: {},
    headers: signature ? { "x-razorpay-signature": signature } : {} });
  const body = JSON.stringify({ event: "payment.captured", payload: {} });
  assert.equal((await hook(body, "deadbeef")).status, 403);
  assert.equal((await hook(body, null)).status, 403);
  const good = crypto.createHmac("sha256", "whsec_headless").update(body).digest("hex");
  const ok = await hook(body, good);
  assert.equal(ok.status, 200);
  assert.equal(ok.payload.ignored, "no payment in the event");
});

test('a refund on a gateway payment calls Razorpay and records the refund id once', async () => {
  const db = await openDatabase('memory');
  // An order paid through the gateway: payments.method razorpay, captured, with a gateway ref.
  const user = await one(db, "SELECT id FROM users WHERE email = 'asha@example.com'");
  const order = await run(db, "INSERT INTO orders (user_id, address, status, payment_status, fulfilment_status, payment_method, subtotal_paise, shipping_paise, total_paise, created_at, updated_at) VALUES (?, '{}', 'confirmed', 'captured', 'unfulfilled', 'razorpay', 10000, 0, 10000, now(), now())", user.id);
  await run(db, "INSERT INTO payments (order_id, method, instrument, provider_ref, status, authorized_paise, captured_paise, created_at, updated_at) VALUES (?, 'razorpay', 'razorpay', 'pay_gw_1', 'captured', 10000, 10000, now(), now())", order);

  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (String(url).endsWith('/refund')) {
      return new Response(JSON.stringify({ id: 'rfnd_1', amount: 10000, status: 'processed' }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  };
  const out = await orders.refundOrder(db, order, 10000, 'Test refund.');
  assert.equal(out[0], 10000);
  assert.match(calls.join(' '), /pay_gw_1\/refund/);
  const row = await one(db, 'SELECT refunded_paise FROM payments WHERE order_id = ?', order);
  assert.equal(Number(row.refunded_paise), 10000);
  // A second call cannot refund again: the amount left is zero.
  const again = await orders.refundOrder(db, order, 10000, 'Twice.');
  assert.equal(again[0], 0);
  await db.close();
});

test('the reconciler captures a payment whose webhook never arrived, and does it once', async () => {
  const db = await openDatabase('memory');
  const user = await one(db, "SELECT id FROM users WHERE email = 'asha@example.com'");
  const order = await run(db, "INSERT INTO orders (user_id, address, status, payment_status, fulfilment_status, payment_method, subtotal_paise, shipping_paise, total_paise, created_at, updated_at) VALUES (?, '{}', 'confirmed', 'pending', 'unfulfilled', 'razorpay', 5000, 0, 5000, now() - interval '1 hour', now())", user.id);
  await run(db, "INSERT INTO payments (order_id, method, instrument, provider_ref, status, created_at, updated_at) VALUES (?, 'razorpay', 'razorpay', 'order_gw_rec', 'created', now() - interval '20 minutes', now())", order);
  globalThis.fetch = async (url) => {
    if (String(url).includes('/orders/order_gw_rec/payments')) {
      return new Response(JSON.stringify({ items: [{ id: 'pay_rec_1', status: 'captured', amount: 5000, order_id: 'order_gw_rec' }] }), { status: 200 });
    }
    if (String(url).includes('/payments/pay_rec_1')) {
      return new Response(JSON.stringify({ id: 'pay_rec_1', order_id: 'order_gw_rec', amount: 5000, currency: 'INR', status: 'captured', method: 'upi' }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  };
  const first = await gateway.reconcile(db, { olderThanMinutes: 15 });
  assert.equal(first.checked, 1);
  assert.equal(first.captured, 1);
  assert.equal(Number((await one(db, 'SELECT captured_paise FROM payments WHERE order_id = ?', order)).captured_paise), 5000);
  const second = await gateway.reconcile(db, { olderThanMinutes: 15 });
  assert.equal(second.captured, 0, 'nothing left to capture');
  await db.close();
});
