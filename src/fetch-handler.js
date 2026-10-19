// The API and placeholder images for Fetch-style runtimes (Netlify Functions):
// takes a Request, returns a Response.
import { mask } from './mask.js';
import { handleApi, parseCookies, placeholderSvg } from './api.js';
import { openDatabase, parseJsonBody } from './server.js';

export async function handleRequest(db, request) {
  const url = new URL(request.url);
  const img = /^\/img\/([A-Za-z0-9_\-]+)\.svg$/.exec(url.pathname);
  if (img) {
    return new Response(await placeholderSvg(db, img[1]), { headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
  }

  const raw = Buffer.from(await request.arrayBuffer());
  if (raw.length > 1_000_000) return Response.json({ error: 'Request too large.' }, { status: 413 });
  const parsed = parseJsonBody(request.method, request.headers.get('content-type'), raw);
  if (parsed.error) return Response.json({ error: parsed.error[1] }, { status: parsed.error[0] });

  const out = await handleApi(db, {
    method: request.method, path: url.pathname, query: url.searchParams, body: parsed.body,
    cookies: parseCookies(request.headers.get('cookie')),
  });

  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'X-Request-Id': out.requestId };
  if (out.setCookie) headers['Set-Cookie'] = `${out.setCookie}; Secure`;
  return new Response(JSON.stringify(out.payload), { status: out.status, headers });
}

// Each function instance opens one small
// connection pool on its first request and reuses it while it stays warm.
// createSchema: false when the tables come from migrations instead.
export function makePostgresHandler(databaseUrl, { maxConnections = 2, createSchema = true } = {}) {
  let opening = null;
  const handle = async (request) => {
    if (!opening) opening = openDatabase(databaseUrl, { maxConnections, createSchema });
    let db;
    try {
      db = await opening;
    } catch (e) {
      opening = null;
      console.error(mask(e?.stack || String(e)));
      return Response.json({ error: 'The database is unavailable. Please try again.' }, { status: 503 });
    }
    return handleRequest(db, request);
  };
  handle.close = async () => {
    if (opening) await (await opening).close();
    opening = null;
  };
  return handle;
}
