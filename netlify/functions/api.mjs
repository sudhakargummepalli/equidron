// Netlify Function: the Equidron API and placeholder images, backed by PostgreSQL.
// By default it uses Netlify Database: Netlify provisions it because @netlify/database is a
// dependency, and applies netlify/database/migrations/ on every deploy. Set DATABASE_URL to
// use another PostgreSQL server instead; the app then creates its own tables.
import { makePostgresHandler } from '../../src/fetch-handler.js';
import { netlifyDatabaseTarget } from '../../src/netlify-db.js';

let handle = null;

export default (request) => {
  if (!handle) {
    const target = netlifyDatabaseTarget();
    if (!target) {
      console.error('No database: Netlify Database is not provisioned and DATABASE_URL is not set.');
      return Response.json({ error: 'The store is not connected to a database yet.' }, { status: 503 });
    }
    handle = makePostgresHandler(target.url, { createSchema: target.createSchema });
  }
  return handle(request);
};

export const config = { path: ['/api/*', '/img/*'] };
