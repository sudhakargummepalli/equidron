// Run Equidron locally:  node app.js [--port 8000] [--db data/pg | postgres://...] [--reset] [--no-jobs]
// With no --db, DATABASE_URL is used when set. Otherwise data is kept in data/pg by
// PGlite (PostgreSQL running inside Node), so no database server is needed.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isServerUrl } from './src/db.js';
import { tick, work } from './src/jobs.js';
import { createServer, openDatabase } from './src/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '8000' },
    db: { type: 'string', default: process.env.DATABASE_URL || path.join(here, 'data', 'pg') },
    reset: { type: 'boolean', default: false },
    'no-jobs': { type: 'boolean', default: false },
  },
});

const remote = isServerUrl(args.db);
if (!remote && args.db !== 'memory') mkdirSync(path.resolve(args.db), { recursive: true });

// A local run is a demo: the sample accounts and their shared password work. Set
// EQUIDRON_SEED_DEMO=0 to try the app as it behaves anywhere else.
process.env.EQUIDRON_SEED_DEMO ??= '1';
const db = await openDatabase(args.db, { reset: args.reset });
// The same minute tick Netlify runs, in this process: events become jobs, the shipment
// simulator runs every five minutes, and ready jobs run. --no-jobs turns it off.
if (!args['no-jobs']) {
  const minute = async () => {
    try {
      await tick(db);
      await work(db, { seconds: 20 });
    } catch (e) {
      console.error('job tick failed:', e.message);
    }
  };
  setTimeout(minute, 5_000).unref();
  setInterval(minute, 60_000).unref();
}

const server = createServer(db);
server.listen(Number(args.port), args.host, () => {
  const base = `http://localhost:${args.port}`;
  console.log('Equidron is running (sample data, simulated payments).');
  console.log(`  Database:       PostgreSQL ${remote ? 'server' : `(PGlite, ${args.db})`}`);
  console.log(`  Storefront:     ${base}/shop/`);
  console.log(`  Seller Central: ${base}/seller/`);
  console.log(`  Equidron Ops:   ${base}/ops/`);
  console.log('Press Ctrl+C to stop.');
});
