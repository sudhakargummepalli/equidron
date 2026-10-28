// Phase 11: real file uploads.
//
// The bytes arrive base64-encoded in a JSON body (no multipart parser to get wrong), are type-checked
// by their magic bytes rather than by what the client claims, capped at 2 MB, hashed, and written to
// a storage adapter. Locally that adapter is the disk under `data/uploads`; in production it is a
// bucket, and the only code that changes is `put()`/`get()` here.
//
// A stored file is never served publicly: a read needs the owner or a staff permission, and the
// response says who that was.
import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { one, run } from './db.js';
import { badRequest, forbidden, notFound } from './errors.js';

export const MAX_BYTES = 2 * 1024 * 1024; // 2 MB: a phone photo of a document fits, a scan does not
export const KINDS = ['pan_card', 'gst_certificate', 'bank_proof', 'cheque', 'other'];

// The first bytes decide the type. A file named .png that starts like a PDF is a PDF, and an .exe
// renamed to .pdf is neither, so it is refused.
const SIGNATURES = [
  { type: 'application/pdf', check: (b) => b.subarray(0, 4).toString('latin1') === '%PDF' },
  { type: 'image/png', check: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 },
  { type: 'image/jpeg', check: (b) => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
  { type: 'image/webp', check: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

export const sniff = (buffer) => SIGNATURES.find((s) => s.check(buffer))?.type ?? null;

const UPLOAD_DIR = () => process.env.UPLOAD_DIR || join(process.cwd(), 'data', 'uploads');

// The storage seam. A bucket implementation replaces these two functions and nothing else.
async function put(key, buffer) {
  const path = join(UPLOAD_DIR(), key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buffer);
  return key;
}
async function get(key) {
  return await readFile(join(UPLOAD_DIR(), key));
}

export async function save(db, user, { kind, filename, data } = {}) {
  if (!['customer', 'seller'].includes(user.role)) throw forbidden('Only a customer or seller account can upload.');
  if (!KINDS.includes(kind)) throw badRequest('Choose what the file is.');
  const base64 = String(data || '').replace(/^data:[^;]+;base64,/, '');
  if (!base64) throw badRequest('Send the file as base64 in `data`.');
  let buffer;
  try { buffer = Buffer.from(base64, 'base64'); } catch { throw badRequest('That file could not be decoded.'); }
  if (!buffer.length) throw badRequest('The file is empty.');
  if (buffer.length > MAX_BYTES) throw badRequest(`The file is ${Math.round(buffer.length / 1024)} KB; the limit is 2 MB.`);

  const contentType = sniff(buffer);
  if (!contentType) throw badRequest('Only a PDF, PNG, JPEG or WebP file is accepted.');

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const safeName = String(filename || 'document').replace(/[^A-Za-z0-9._-]/g, '_').slice(-80);
  const storageKey = `${sha256.slice(0, 2)}/${sha256}`;
  // The same bytes are stored once: two sellers uploading the same file share it.
  const existing = await one(db, 'SELECT id FROM uploads WHERE sha256 = ? AND user_id = ?', sha256, user.id);
  if (existing) {
    return { upload_id: Number(existing.id), url: `/api/uploads/${existing.id}`, sha256, bytes: buffer.length, content_type: contentType };
  }
  await put(storageKey, buffer);
  const id = await run(db, `INSERT INTO uploads (user_id, kind, filename, content_type, bytes, sha256, storage_key)
                            VALUES (?,?,?,?,?,?,?)`,
  user.id, kind, safeName, contentType, buffer.length, sha256, storageKey);
  return { upload_id: Number(id), url: `/api/uploads/${id}`, sha256, bytes: buffer.length, content_type: contentType };
}

// Who may read a file: the person who uploaded it, or staff (the reviewer).
export async function read(db, id, user) {
  const row = await one(db, 'SELECT * FROM uploads WHERE id = ?', id);
  if (!row) throw notFound('File');
  const staff = user.role === 'ops';
  if (row.user_id !== user.id && !staff) throw notFound('File');
  const buffer = await get(row.storage_key);
  return { ...row, base64: buffer.toString('base64') };
}

export async function describe(db, id, user) {
  const row = await one(db, 'SELECT id, kind, filename, content_type, bytes, sha256, created_at, user_id FROM uploads WHERE id = ?', id);
  if (!row) throw notFound('File');
  if (row.user_id !== user.id && user.role !== 'ops') throw notFound('File');
  return { upload_id: Number(row.id), kind: row.kind, filename: row.filename, content_type: row.content_type,
    bytes: Number(row.bytes), sha256: row.sha256, created_at: row.created_at };
}
