// Phase 8: Razorpay. The signature rules are pure functions, so they are tested without a network;
// the browser and webhook paths are tested through the API with a stubbed fetch.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { handleApi } from "../src/api.js";
import { settings } from "../src/auth.js";
import { one } from "../src/db.js";
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
