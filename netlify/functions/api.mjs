// Netlify Function: the Equidron API and placeholder images, backed by PostgreSQL.
// Set DATABASE_URL under Site configuration -> Environment variables; Netlify DB sets
// NETLIFY_DATABASE_URL itself. Functions have no lasting disk, so there is no local fallback.
import { makePostgresHandler } from '../../src/fetch-handler.js';

const databaseUrl = process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL;
const handle = databaseUrl ? makePostgresHandler(databaseUrl) : null;

export default (request) => {
  if (!handle) {
    console.error('DATABASE_URL is not set. Add it under Site configuration -> Environment variables.');
    return Response.json({ error: 'The store is not connected to a database yet.' }, { status: 503 });
  }
  return handle(request);
};

export const config = { path: ['/api/*', '/img/*'] };
