// Policies: versioned marketplace rules, and the block every agent reads at the start of a run.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { all, one } from '../src/db.js';
import { activePolicies, ensurePolicies, KINDS, policyText, publishPolicy } from '../src/policies.js';
import { openDatabase } from '../src/server.js';

let db;
before(async () => { db = await openDatabase('memory'); }); // openDatabase seeds the policies
after(async () => { await db?.close(); });

test('every kind starts at version 1, seeded once', async () => {
  const rows = await all(db, 'SELECT kind, version, active FROM policies ORDER BY kind');
  assert.equal(rows.length, KINDS.length);
  for (const r of rows) {
    assert.equal(Number(r.version), 1);
    assert.equal(r.active, true);
  }
  // Running the seed again changes nothing: it is called on every start.
  await ensurePolicies(db);
  assert.equal((await all(db, 'SELECT id FROM policies')).length, KINDS.length);
});

test('the prompt block names each policy and its version', async () => {
  const text = await policyText(db);
  assert.match(text, /MARKETPLACE POLICIES/);
  for (const kind of KINDS) assert.match(text, new RegExp(`${kind} \\(v1\\):`));
  // A number an agent must not invent: the referral fee is in the fees policy.
  assert.match(text, /10% of the item price/);
  // The refund limit is the one that gates money, so it must be in the text no matter the model.
  assert.match(text, /₹2,000/);
});

test('publishing a new version deactivates the old one and never loses it', async () => {
  const before = await one(db, "SELECT version FROM policies WHERE kind = 'refunds' AND active");
  const published = await publishPolicy(db, 'refunds', ['An agent may refund up to ₹1,000 without a person.'], { by: 'ops@example.com' });
  assert.equal(Number(published.version), Number(before.version) + 1);
  assert.equal(published.active, true);

  const active = await activePolicies(db);
  const refunds = active.find((p) => p.kind === 'refunds');
  assert.equal(Number(refunds.version), Number(published.version));
  assert.match(refunds.body, /₹1,000/);

  // The old row still exists, inactive: a decision can always be traced to the version it used.
  const history = await all(db, "SELECT version, active FROM policies WHERE kind = 'refunds' ORDER BY version");
  assert.equal(history.length, 2);
  assert.deepEqual(history.map((h) => h.active), [false, true]);

  // The new text is what the prompt now carries.
  assert.match(await policyText(db), /₹1,000/);
});

test('an unknown kind or an empty body is refused', async () => {
  await assert.rejects(() => publishPolicy(db, 'shipping', ['x']), /no policy called/i);
  await assert.rejects(() => publishPolicy(db, 'fees', ['   ']), /cannot be empty/i);
});

test('the database itself allows only one active version per kind', async () => {
  await assert.rejects(
    () => db.query("INSERT INTO policies (kind, version, body, active) VALUES ('fees', 99, 'x', true)"),
    /duplicate key|unique/i,
  );
});
