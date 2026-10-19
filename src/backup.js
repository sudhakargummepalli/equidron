// Backups: every table exported as JSON, and restored into an empty database. The weekly job
// stores them in Netlify Blobs (store "backups") on Netlify, or in data/backups/ locally
// (EQUIDRON_BACKUP_DIR to change it). Sessions are left out: a restore signs everyone out.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { all, TABLES, transaction } from './db.js';
import { log } from './log.js';

const SKIP = new Set(['sessions']);

export async function exportAll(db) {
  const tables = {};
  for (const t of TABLES) if (!SKIP.has(t)) tables[t] = await all(db, `SELECT * FROM ${t}`);
  return { format: 'equidron-backup-1', at: new Date().toISOString(), tables };
}

// Into a database that has the schema and no rows. Tables go in schema order, so rows that
// others refer to come first; id counters then carry on after the restored ids.
export async function restoreInto(db, dump) {
  await transaction(db, async () => {
    for (const t of TABLES) {
      // JSONB values go back as JSON text, even when they are plain strings or numbers.
      const json = new Set((await all(db, "SELECT column_name FROM information_schema.columns WHERE table_name = ? AND data_type = 'jsonb'", t))
        .map((r) => r.column_name));
      for (const row of dump.tables[t] || []) {
        const cols = Object.keys(row);
        const values = cols.map((c) => (json.has(c) && row[c] !== null ? JSON.stringify(row[c]) : row[c]));
        await db.query(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, values);
      }
      const hasId = await all(db, "SELECT 1 AS x FROM information_schema.columns WHERE table_name = ? AND column_name = 'id'", t);
      if (hasId.length) await db.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), (SELECT COALESCE(MAX(id), 0) + 1 FROM ${t}), false)`);
    }
  });
}

export async function saveBackup(db) {
  const dump = await exportAll(db);
  const name = `equidron-${dump.at.slice(0, 10)}.json`;
  const body = JSON.stringify(dump);
  if (process.env.NETLIFY_BLOBS_CONTEXT || process.env.NETLIFY) {
    const { getStore } = await import('@netlify/blobs');
    await getStore('backups').set(name, body);
    log('info', 'backup saved to Netlify Blobs', { name, bytes: body.length });
    return name;
  }
  const dir = process.env.EQUIDRON_BACKUP_DIR || path.join(process.cwd(), 'data', 'backups');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), body);
  log('info', 'backup saved', { file: path.join(dir, name), bytes: body.length });
  return name;
}
