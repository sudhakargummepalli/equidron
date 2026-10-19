// Which database a Netlify function uses: DATABASE_URL when set (the app then creates its own
// tables), otherwise Netlify Database (whose tables come from netlify/database/migrations/).
import { getConnectionString } from '@netlify/database';
import { openDatabase } from './server.js';

export function netlifyDatabaseTarget() {
  if (process.env.DATABASE_URL) return { url: process.env.DATABASE_URL, createSchema: true };
  try {
    return { url: getConnectionString(), createSchema: false };
  } catch {
    return null;
  }
}

// One small pool per function instance, opened on first use and reused while it stays warm.
let opening = null;
export function netlifyDatabase() {
  if (!opening) {
    const target = netlifyDatabaseTarget();
    if (!target) return Promise.reject(new Error('No database: Netlify Database is not provisioned and DATABASE_URL is not set.'));
    opening = openDatabase(target.url, { maxConnections: 2, createSchema: target.createSchema }).catch((e) => {
      opening = null;
      throw e;
    });
  }
  return opening;
}
