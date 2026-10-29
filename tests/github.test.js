// Phase 14: the engineering agent and its GitHub App. The JWT and the fail-closed rules are pure
// functions; the API calls are exercised with a stubbed fetch.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
import { getAgent } from "../src/agents/agents.js";
import { owns, tool, toolDefsFor } from "../src/agents/tools.js";
import { one } from "../src/db.js";
import * as github from "../src/github.js";
import { openDatabase } from "../src/server.js";

process.env.EQUIDRON_SEED_DEMO = "1";

let db;
let keys;
const realFetch = globalThis.fetch;
before(async () => {
  db = await openDatabase("memory");
  keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.GITHUB_APP_ID = "424242";
  process.env.GITHUB_INSTALLATION_ID = "777";
  process.env.GITHUB_PRIVATE_KEY = keys.privateKey.export({ type: "pkcs1", format: "pem" }).replace(/\n/g, "\\n");
});
after(async () => { globalThis.fetch = realFetch; await db?.close(); });

test("the app JWT is RS256 and verifies with the public key", () => {
  const jwt = github.appJwt(1700000000);
  const [header, payload, signature] = jwt.split(".");
  assert.equal(JSON.parse(Buffer.from(header, "base64url")).alg, "RS256");
  const claims = JSON.parse(Buffer.from(payload, "base64url"));
  assert.equal(claims.iss, 424242);
  assert.equal(claims.exp - claims.iat, 600, "GitHub allows ten minutes at most");
  const ok = crypto.verify("sha256", Buffer.from(`${header}.${payload}`), keys.publicKey, Buffer.from(signature, "base64url"));
  assert.equal(ok, true, "the signature verifies");
});

test("with nothing configured, every call refuses before any network request", async () => {
  const saved = { ...process.env };
  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_INSTALLATION_ID;
  delete process.env.GITHUB_PRIVATE_KEY;
  github._resetCache();
  await assert.rejects(() => github.openIssues(), /not configured/);
  assert.equal(github.configured(), false);
  Object.assign(process.env, saved);
  github._resetCache();
});

test("an installation token is exchanged once and reused", async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (String(url).endsWith("/access_tokens")) {
      return new Response(JSON.stringify({ token: "ghs_test", expires_at: new Date(Date.now() + 3600_000).toISOString() }), { status: 201 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  };
  github._resetCache();
  await github.openIssues();
  await github.openIssues();
  const tokenCalls = urls.filter((u) => u.endsWith("/access_tokens"));
  assert.equal(tokenCalls.length, 1, "the second call used the cached token");
  assert.equal(urls.length, 3, "two repository reads and one token exchange");
});

test("issues, pull requests and failed runs are shaped for the model", async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/access_tokens")) return new Response(JSON.stringify({ token: "ghs", expires_at: new Date(Date.now() + 3600_000).toISOString() }), { status: 201 });
    if (u.includes("/issues?")) return new Response(JSON.stringify([
      { number: 7, title: "Checkout fails on UPI", labels: [{ name: "bug" }], created_at: "2026-10-20T00:00:00Z" },
      { number: 8, title: "A pull request, not an issue", pull_request: {}, labels: [] },
    ]), { status: 200 });
    if (u.includes("/pulls/9")) return new Response(JSON.stringify({ number: 9, title: "Fix", state: "open", draft: false, mergeable: true, head: { ref: "fix", sha: "abc" }, base: { ref: "main" }, changed_files: 3 }), { status: 200 });
    if (u.includes("/check-runs")) return new Response(JSON.stringify({ check_runs: [{ name: "test", status: "completed", conclusion: "failure" }] }), { status: 200 });
    if (u.includes("/actions/runs")) return new Response(JSON.stringify({ workflow_runs: [{ id: 1, name: "ci", head_branch: "fix", conclusion: "failure", html_url: "https://x", created_at: "now" }] }), { status: 200 });
    return new Response(JSON.stringify({}), { status: 404 });
  };
  const issues = await github.openIssues();
  assert.equal(issues.length, 1, "a pull request is not an issue");
  assert.deepEqual(issues[0].labels, ["bug"]);
  const pr = await github.pullRequest(9);
  assert.equal(pr.checks[0].conclusion, "failure");
  const runs = await github.failedRuns();
  assert.equal(runs[0].branch, "fix");
});

test("the engineer can read and comment, and has no tool that pushes, merges or deploys", async () => {
  for (const name of ["github_issues", "github_pull_request", "github_failed_runs", "github_comment"]) {
    assert.ok(owns("engineer", name), name);
  }
  const names = toolDefsFor("engineer").map((t) => t.name);
  for (const forbidden of ["merge_pr", "push", "deploy", "create_release", "delete_branch"]) {
    assert.ok(!names.includes(forbidden), forbidden + " must not exist");
  }
  const agent = await getAgent(db, "engineer");
  assert.equal(agent.enabled, false);
  assert.equal(agent.autonomy_level, 1);
});

test("a comment goes through the API and leaves an audit row", async () => {
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/access_tokens")) return new Response(JSON.stringify({ token: "ghs", expires_at: new Date(Date.now() + 3600_000).toISOString() }), { status: 201 });
    assert.equal(init.method, "POST");
    return new Response(JSON.stringify({ id: 99, html_url: "https://github.com/x/y/issues/7#c99" }), { status: 201 });
  };
  const out = await tool("github_comment").run(db, {}, { number: 7, body: "The failure is in the UPI test, not the code.", reason: "Record the finding on the issue." });
  assert.equal(out.id, 99);
  const row = await one(db, "SELECT * FROM audit_log WHERE action = 'github.comment' ORDER BY id DESC LIMIT 1");
  assert.ok(row, "the comment is audited");
});