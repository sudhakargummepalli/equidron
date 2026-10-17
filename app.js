// Run Equidron locally:  node app.js [--port 8000] [--db data/equidron.db] [--reset]
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createServer, openDatabase } from './src/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '8000' },
    db: { type: 'string', default: path.join(here, 'data', 'equidron.db') },
    reset: { type: 'boolean', default: false },
  },
});

mkdirSync(path.dirname(path.resolve(args.db)), { recursive: true });
if (args.reset) {
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(args.db + suffix)) rmSync(args.db + suffix);
}

const db = openDatabase(args.db);
const server = createServer(db);
server.listen(Number(args.port), args.host, () => {
  const base = `http://localhost:${args.port}`;
  console.log('Equidron is running (sample data, simulated payments).');
  console.log(`  Storefront:     ${base}/shop/`);
  console.log(`  Seller Central: ${base}/seller/`);
  console.log(`  Equidron Ops:   ${base}/ops/`);
  console.log('Press Ctrl+C to stop.');
});
