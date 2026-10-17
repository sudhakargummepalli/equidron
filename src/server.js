// Local HTTP server: JSON API plus the static front ends and placeholder images.
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi, parseCookies, placeholderSvg } from './api.js';
import { connect, dropSchema, initSchema, transaction } from './db.js';
import { seed } from './seed.js';

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'static');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };
const MAX_BODY = 1_000_000;

// target: a postgres:// URL, a PGlite data directory, or 'memory' (see db.js).
// reset drops Equidron's tables first, so the sample data is loaded again.
export async function openDatabase(target, { reset = false, ...options } = {}) {
  const db = await connect(target, options);
  if (reset) await dropSchema(db);
  // In a transaction so concurrent first starts against one database don't race to create tables.
  await transaction(db, () => initSchema(db));
  await seed(db);
  return db;
}

function send(res, status, body, type, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, {
    'Content-Type': type, 'Content-Length': buf.length, 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin', 'Cache-Control': 'no-store', ...headers,
  });
  res.end(buf);
}

const sendJson = (res, status, payload, headers) => send(res, status, JSON.stringify(payload), 'application/json; charset=utf-8', headers);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Parse and check a request body. Requiring JSON blocks cross-site form posts
// (simple cross-site requests can't set this content type).
export function parseJsonBody(method, contentType, raw) {
  if (method !== 'POST' && !raw.length) return { body: {} };
  if (!String(contentType || '').includes('application/json')) {
    return { error: [415, 'Send JSON (Content-Type: application/json).'] };
  }
  let body;
  try {
    body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
  } catch {
    return { error: [400, 'Invalid JSON.'] };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: [400, 'Expected a JSON object.'] };
  return { body };
}

export function createServer(db, { quiet = false } = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (!quiet) console.log(`${req.method} ${req.url}`);
    try {
      if (p.startsWith('/api/')) {
        let raw;
        try {
          raw = await readBody(req);
        } catch (e) {
          return sendJson(res, e.status || 400, { error: 'Request too large.' });
        }
        const parsed = parseJsonBody(req.method, req.headers['content-type'], raw);
        if (parsed.error) return sendJson(res, parsed.error[0], { error: parsed.error[1] });
        const out = await handleApi(db, { method: req.method, path: p, query: url.searchParams, body: parsed.body,
          cookies: parseCookies(req.headers.cookie) });
        return sendJson(res, out.status, out.payload, out.setCookie ? { 'Set-Cookie': out.setCookie } : {});
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain');
      if (p === '/') return send(res, 302, '', 'text/plain', { Location: '/shop/' });
      if (['/shop', '/seller', '/ops'].includes(p)) return send(res, 302, '', 'text/plain', { Location: p + '/' });
      const img = /^\/img\/([A-Za-z0-9_\-]+)\.svg$/.exec(p);
      if (img) return send(res, 200, await placeholderSvg(db, img[1]), 'image/svg+xml; charset=utf-8');
      const rel = decodeURIComponent(p.endsWith('/') ? p + 'index.html' : p);
      const full = path.normalize(path.join(STATIC_DIR, rel));
      if (!full.startsWith(STATIC_DIR + path.sep)) return send(res, 404, 'Not found', 'text/plain');
      let data;
      try {
        data = await readFile(full);
      } catch {
        return send(res, 404, 'Not found', 'text/plain');
      }
      return send(res, 200, data, TYPES[path.extname(full)] || 'application/octet-stream');
    } catch (e) {
      console.error(e);
      return sendJson(res, 500, { error: 'Something went wrong on our side. Please try again.' });
    }
  });
}
