import { readFileSync } from 'node:fs';
import { openDatabase } from '../src/server.js';
import { restoreInto } from '../src/backup.js';
import { all } from '../src/db.js';

const [, , dumpPath, target] = process.argv;
const db = await openDatabase(target);
const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));

const tables = (await all(db, "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name"))
  .map((r) => r.t);

const list = tables.map((t) => '"' + t + '"').join(', ');
await db.query('TRUNCATE TABLE ' + list + ' RESTART IDENTITY CASCADE');
console.log('emptied', tables.length, 'tables');

await restoreInto(db, dump);

const counts = {};
for (const t of ['users', 'products', 'offers', 'orders', 'order_items', 'invoices']) {
  const rows = await all(db, `SELECT count(*) AS n FROM "${t}"`);
  counts[t] = Number(rows[0].n);
}
console.log('restored:', JSON.stringify(counts));
await db.close?.();
process.exit(0);