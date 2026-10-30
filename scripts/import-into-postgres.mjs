// Copy the marketplace from PGlite (Node) into PostgreSQL (Java).
//
// The order matters and is not the order of the migration files: tables are inserted in dependency
// order, worked out from the foreign keys the target database already has. Inserting users before
// orders is not a style choice, it is the difference between working and failing.
//
// Identity sequences are reset after the copy. An explicit id does not advance a sequence, so without
// setval the first new order would collide with an imported one - a bug that appears days later, on
// a customer's order.
//
// Usage: node scripts/import-into-postgres.mjs [--pglite data/pg] [--target postgres://...] [--dry]
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const source = arg('pglite', 'data/pg');
const target = arg('target', process.env.TARGET_DB_URL || 'postgres://equidron:equidron-local@127.0.0.1:5432/equidron_cutover');
const dry = args.includes('--dry');

const db = new PGlite(source);
await db.waitReady;
const client = new pg.Client({ connectionString: target });
await client.connect();
console.log('source: PGlite', source, '\ntarget:', target.replace(/:[^:@/]+@/, ':***@'), dry ? '(dry run)' : '');

// 1. Tables and their foreign keys, from the target's own catalog.
const tables = (await client.query(
  `SELECT table_name FROM information_schema.tables
   WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'flyway_schema_history'
   ORDER BY table_name`)).rows.map((r) => r.table_name);

const edges = (await client.query(
  `SELECT con.conrelid::regclass::text AS child, confrelid::regclass::text AS parent
   FROM pg_constraint con WHERE con.contype = 'f'`)).rows;

const parents = new Map(tables.map((t) => [t, new Set()]));
for (const e of edges) {
  const child = e.child.replace(/"/g, ''), parent = e.parent.replace(/"/g, '');
  if (parents.has(child) && parents.has(child) && tables.includes(parent)) parents.get(child).add(parent);
}

// 2. Dependency order: a table comes after every table it points at.
const order = [];
const seen = new Set();
const visit = (t, stack = new Set()) => {
  if (seen.has(t) || stack.has(t)) return;
  stack.add(t);
  for (const p of parents.get(t) || []) visit(p, stack);
  seen.add(t);
  order.push(t);
};
tables.forEach((t) => visit(t));

const failures = [];
const encode = (v) => (v === undefined ? null : v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v);
let total = 0;
const counts = {};
for (const table of order) {
  let rows = [];
  try {
    rows = (await db.query(`SELECT * FROM "${table}"`)).rows;
  } catch (e) {
    console.log(`  ${table.padEnd(28)} source has no such table, skipped`);
    continue;
  }
  counts[table] = rows.length;
  total += rows.length;
  if (!rows.length || dry) {
    console.log(`  ${table.padEnd(28)} ${rows.length} rows${dry ? ' (not written)' : ''}`);
    continue;
  }
  const columns = Object.keys(rows[0]);
  const values = rows.flatMap((r) => columns.map((c) => encode(r[c])));
  const placeholders = rows.map((_, ri) => '(' + columns.map((__, ci) => `$${ri * columns.length + ci + 1}`).join(',') + ')').join(',');
  try {
    await client.query(
      `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(',')}) VALUES ${placeholders} ON CONFLICT DO NOTHING`,
      values);
    console.log(`  ${table.padEnd(28)} ${rows.length} rows`);
  } catch (e) {
    failures.push(table + ': ' + e.message.split('\n')[0]);
    console.log(`  ${table.padEnd(28)} FAILED: ${e.message.split('\n')[0]}`);
  }
}

// 3. Counts after, and the sequences that must be moved past the copied ids.
if (!dry) {
  let mismatches = 0;
  for (const table of order) {
    if (counts[table] === undefined) continue;
    const now = Number((await client.query(`SELECT count(*) FROM "${table}"`)).rows[0].count);
    if (now !== counts[table]) {
      console.log(`  COUNT MISMATCH ${table}: exported ${counts[table]}, imported ${now}`);
      mismatches++;
    }
  }
  const seqs = (await client.query(
    `SELECT sequencename FROM pg_sequences WHERE schemaname = 'public'`)).rows.map((r) => r.sequencename);
  for (const seq of seqs) {
    const table = seq.replace(/_id_seq$/, '');
    try {
      await client.query(`SELECT setval('${seq}', COALESCE((SELECT MAX(id) FROM "${table}"), 1), (SELECT MAX(id) FROM "${table}") IS NOT NULL)`);
    } catch { /* a sequence whose table has no id column: nothing to reset */ }
  }
  console.log(mismatches === 0 ? '\ncounts match for every table' : `\n${mismatches} table(s) did not match`);
}

if (failures.length) console.log('\nfailed tables:\n  ' + failures.join('\n  '));
console.log(`\n${order.length} tables, ${total} rows ${dry ? 'counted' : 'copied'}, ${failures.length} failed`);
await client.end();
await db.close();