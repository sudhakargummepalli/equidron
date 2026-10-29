// Phase 14: GitHub's webhook. Signed over the raw bytes, idempotent by delivery id, and refused
// entirely when no secret is configured.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
import { handleApi } from "../src/api.js";
import { all } from "../src/db.js";
import { openDatabase } from "../src/server.js";

process.env.EQUIDRON_SEED_DEMO = "1";

let db;
before(async () => { db = await openDatabase("memory"); process.env.GITHUB_WEBHOOK_SECRET = "gh-secret"; });
after(async () => { delete process.env.GITHUB_WEBHOOK_SECRET; await db?.close(); });

const payload = { action: "opened", repository: { full_name: "sudhakargummepalli/equidron" }, issue: { number: 7 } };
const raw = JSON.stringify(payload);
const sign = (body) => "sha256=" + crypto.createHmac("sha256", "gh-secret").update(body).digest("hex");

const hook = (headers, body) => handleApi(db, { method: "POST", path: "/api/webhooks/github",
  query: new URLSearchParams(), body, raw: body, cookies: {}, headers });

test("without a secret, every delivery is refused", async () => {
  delete process.env.GITHUB_WEBHOOK_SECRET;
  const out = await hook({ "x-github-delivery": "d1", "x-github-event": "issues", "x-hub-signature-256": sign(raw) }, raw);
  assert.equal(out.status, 403);
  assert.match(out.payload.error, /not configured/);
  process.env.GITHUB_WEBHOOK_SECRET = "gh-secret";
});

test("a bad or missing signature is refused", async () => {
  assert.equal((await hook({ "x-github-delivery": "d2", "x-github-event": "issues" }, raw)).status, 403);
  assert.equal((await hook({ "x-github-delivery": "d2", "x-github-event": "issues", "x-hub-signature-256": "sha256=deadbeef" }, raw)).status, 403);
});

test("a signed delivery is stored once, and a repeat changes nothing", async () => {
  const headers = { "x-github-delivery": "d3", "x-github-event": "issues", "x-hub-signature-256": sign(raw) };
  const first = await hook(headers, raw);
  assert.equal(first.status, 200);
  assert.equal(first.payload.duplicate, false);
  const second = await hook(headers, raw);
  assert.equal(second.status, 200);
  assert.equal(second.payload.duplicate, true);
  const rows = await all(db, "SELECT delivery_id, event, repo FROM github_events WHERE delivery_id = 'd3'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, "issues");
  assert.equal(rows[0].repo, "sudhakargummepalli/equidron");
});

test("a delivery with no id is refused rather than stored anonymously", async () => {
  const out = await hook({ "x-github-event": "issues", "x-hub-signature-256": sign(raw) }, raw);
  assert.equal(out.status, 400);
  assert.match(out.payload.error, /X-GitHub-Delivery/);
});