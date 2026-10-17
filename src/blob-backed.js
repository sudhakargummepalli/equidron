// Runs the API against a SQLite file that lives in a key-value blob store
// (Netlify Blobs in production). Serverless functions have no permanent disk,
// so each instance keeps a working copy in /tmp:
//   - before a request, reload the copy if the stored file changed (etag differs)
//   - after a successful write request, upload the whole file again
// Concurrent writes from two instances are last-writer-wins: fine for a demo,
// not for real traffic.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { handleApi, parseCookies, placeholderSvg } from './api.js';
import { connect, initSchema } from './db.js';
import { seed } from './seed.js';
import { parseJsonBody } from './server.js';

const KEY = 'equidron.db';

// store: { getMetadata(key) -> {etag}|null, get(key, {type:'arrayBuffer'}) -> ArrayBuffer|null, set(key, data) }
export function makeBlobHandler(getStoreFn, dbPath = '/tmp/equidron.db') {
  let db = null;
  let loadedEtag = null;

  async function save(store) {
    await store.set(KEY, readFileSync(dbPath));
    const meta = await store.getMetadata(KEY);
    loadedEtag = meta ? meta.etag : null;
  }

  async function ensureFresh(store) {
    const meta = await store.getMetadata(KEY);
    if (db && meta && meta.etag === loadedEtag) return;
    if (db) db.close();
    db = null;
    if (meta) {
      writeFileSync(dbPath, Buffer.from(await store.get(KEY, { type: 'arrayBuffer' })));
      loadedEtag = meta.etag;
    } else if (existsSync(dbPath)) {
      rmSync(dbPath);
    }
    // DELETE journal mode keeps every committed change inside the single .db file we upload.
    db = connect(dbPath, { journal: 'DELETE' });
    initSchema(db);
    if (seed(db)) await save(store);
  }

  handle.close = () => {
    if (db) db.close();
    db = null;
  };
  return handle;

  async function handle(request) {
    const store = getStoreFn();
    const url = new URL(request.url);
    try {
      await ensureFresh(store);
    } catch (e) {
      console.error(e);
      return Response.json({ error: 'Storage is unavailable. Please try again.' }, { status: 503 });
    }

    const img = /^\/img\/([A-Za-z0-9_\-]+)\.svg$/.exec(url.pathname);
    if (img) {
      return new Response(placeholderSvg(db, img[1]), { headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
    }

    const raw = Buffer.from(await request.arrayBuffer());
    if (raw.length > 1_000_000) return Response.json({ error: 'Request too large.' }, { status: 413 });
    const parsed = parseJsonBody(request.method, request.headers.get('content-type'), raw);
    if (parsed.error) return Response.json({ error: parsed.error[1] }, { status: parsed.error[0] });

    const out = handleApi(db, {
      method: request.method, path: url.pathname, query: url.searchParams, body: parsed.body,
      cookies: parseCookies(request.headers.get('cookie')),
    });
    if (request.method !== 'GET' && out.status < 500) await save(store);

    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (out.setCookie) headers['Set-Cookie'] = `${out.setCookie}; Secure`;
    return new Response(JSON.stringify(out.payload), { status: out.status, headers });
  }
}
