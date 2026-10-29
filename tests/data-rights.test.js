// Phase 15: a customer's data rights. Export gives them everything; delete anonymises them and keeps
// the orders the law requires.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { one } from "../src/db.js";
import { deleteAccount, exportFor } from "../src/data-rights.js";
import { openDatabase } from "../src/server.js";

process.env.EQUIDRON_SEED_DEMO = "1";

let db;
let asha;
before(async () => {
  db = await openDatabase("memory");
  asha = await one(db, "SELECT id, email FROM users WHERE email = 'asha@example.com'");
});
after(async () => { await db?.close(); });

test("the export holds this person's data and nothing of anyone else's", async () => {
  const mine = await exportFor(db, asha.id);
  assert.equal(mine.account.id, asha.id);
  assert.ok(mine.orders.length >= 1, "their orders are there");
  for (const order of mine.orders) {
    const row = await one(db, 'SELECT user_id FROM orders WHERE id = ?', order.id);
    assert.equal(Number(row.user_id), Number(asha.id), "no other customer's order");
  }
  assert.ok(Array.isArray(mine.addresses));
  assert.match(mine.note, /tax and consumer law/i);
});

test("deleting needs the word DELETE, so a stray request cannot erase an account", async () => {
  await assert.rejects(() => deleteAccount(db, asha.id, { confirm: 'yes' }), /Type DELETE/);
  await assert.rejects(() => deleteAccount(db, asha.id, {}), /Type DELETE/);
});

test("deletion anonymises the person, keeps the orders, and ends their sessions", async () => {
  const before = (await one(db, 'SELECT COUNT(*) AS n FROM orders WHERE user_id = ?', asha.id)).n;
  const out = await deleteAccount(db, asha.id, { confirm: 'DELETE' });
  assert.equal(out.deleted, true);

  const user = await one(db, 'SELECT email, name, deleted_at, pw_hash FROM users WHERE id = ?', asha.id);
  assert.equal(user.name, 'Deleted customer');
  assert.match(user.email, /^deleted-\d+@invalid$/);
  assert.ok(user.deleted_at, 'the row remembers when');
  assert.equal(user.pw_hash, 'x', 'the password cannot work');

  const after = (await one(db, 'SELECT COUNT(*) AS n FROM orders WHERE user_id = ?', asha.id)).n;
  assert.equal(Number(after), Number(before), 'orders survive, as tax law requires');
  assert.equal((await one(db, 'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', asha.id)).n, 0);

  // A second deletion is refused rather than silently repeated.
  await assert.rejects(() => deleteAccount(db, asha.id, { confirm: 'DELETE' }), /already deleted/);
});