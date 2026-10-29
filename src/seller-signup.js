// Phase 11: a seller's application, in steps, and what happens when it is submitted.
//
// Two rules shape it:
//   - A half-finished form is a draft, never a seller. Nothing is created until the last step is
//     submitted and the format checks pass.
//   - The formats are checked in code (PAN, GSTIN, IFSC, account number, pincode), and the medical
//     identifiers the roadmap bans — Aadhaar — are not collected at all, so they cannot be leaked.
//
// The KYC provider call is deliberately absent: it needs a sandbox account. Everything up to that
// point is real, and the approval is an Ops decision recorded in the audit trail.
import { audit } from './audit.js';
import { all, loads, now, one, run } from './db.js';
import * as kyc from './kyc.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';

export const STEPS = ['business', 'tax', 'bank', 'pickup', 'agreement'];

export const FIELDS = [
  'business_name', 'business_type', 'pan', 'gstin',
  'bank_account_name', 'bank_account_no', 'bank_ifsc',
  'pickup_line1', 'pickup_city', 'pickup_pincode', 'pickup_phone',
];

// Formats used in India. A wrong PAN does not fail later at the gateway; it fails now, with the field.
export const RE = {
  pan: /^[A-Z]{5}[0-9]{4}[A-Z]$/,
  gstin: /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/,
  ifsc: /^[A-Z]{4}0[A-Z0-9]{6}$/,
  account: /^[0-9]{9,18}$/,
  pincode: /^[1-9][0-9]{5}$/,
  phone: /^[6-9][0-9]{9}$/,
};

const upper = (value) => String(value ?? '').trim().toUpperCase();

export function validate(input = {}) {
  const errors = {};
  const clean = {};

  const name = String(input.business_name ?? '').trim();
  if (name.length < 2) errors.business_name = 'Tell us the business name.';
  else clean.business_name = name.slice(0, 120);

  if (!['individual', 'proprietorship', 'partnership', 'private_limited'].includes(input.business_type)) {
    errors.business_type = 'Choose a business type.';
  } else clean.business_type = input.business_type;

  const pan = upper(input.pan);
  if (!RE.pan.test(pan)) errors.pan = 'A PAN is ten characters, like ABCDE1234F.';
  else clean.pan = pan;

  // GSTIN is optional: a small seller may be unregistered.
  if (input.gstin != null && String(input.gstin).trim() !== '') {
    const gstin = upper(input.gstin);
    if (!RE.gstin.test(gstin)) errors.gstin = 'A GSTIN is fifteen characters, like 29ABCDE1234F1Z5.';
    else clean.gstin = gstin;
  } else clean.gstin = null;

  const holder = String(input.bank_account_name ?? '').trim();
  if (holder.length < 2) errors.bank_account_name = 'Whose account is it?';
  else clean.bank_account_name = holder.slice(0, 120);

  const accountNo = String(input.bank_account_no ?? '').replace(/\s+/g, '');
  if (!RE.account.test(accountNo)) errors.bank_account_no = 'An account number is 9–18 digits.';
  else clean.bank_account_no = accountNo;

  const ifsc = upper(input.bank_ifsc);
  if (!RE.ifsc.test(ifsc)) errors.bank_ifsc = 'An IFSC is eleven characters, like HDFC0001234.';
  else clean.bank_ifsc = ifsc;

  const line1 = String(input.pickup_line1 ?? '').trim();
  if (line1.length < 4) errors.pickup_line1 = 'Add the street and building.';
  else clean.pickup_line1 = line1.slice(0, 200);

  const city = String(input.pickup_city ?? '').trim();
  if (city.length < 2) errors.pickup_city = 'Add the city.';
  else clean.pickup_city = city.slice(0, 60);

  const pincode = String(input.pickup_pincode ?? '').trim();
  if (!RE.pincode.test(pincode)) errors.pickup_pincode = 'A pincode is six digits and cannot start with 0.';
  else clean.pickup_pincode = pincode;

  const phone = String(input.pickup_phone ?? '').trim();
  if (!RE.phone.test(phone)) errors.pickup_phone = 'A mobile number is ten digits and starts with 6–9.';
  else clean.pickup_phone = phone;

  return [clean, errors];
}

// What is still missing for a submission, in step order, so the form can say where to go next.
export function missingFor(application) {
  const [clean, errors] = validate(application ?? {});
  const missing = Object.keys(errors);
  const stepOf = (field) => {
    if (['business_name', 'business_type'].includes(field)) return 'business';
    if (['pan', 'gstin'].includes(field)) return 'tax';
    if (field.startsWith('bank_')) return 'bank';
    if (field.startsWith('pickup_')) return 'pickup';
    return 'agreement';
  };
  return {
    steps: [...new Set(missing.map(stepOf))],
    fields: missing,
    errors,
    clean,
  };
}

export async function applicationFor(db, userId) {
  return await one(db, 'SELECT * FROM seller_applications WHERE user_id = ?', userId);
}

// A draft is saved whenever the seller leaves a step. A half-filled form is allowed: the format
// checks run at submission, where a wrong value can stop the seller becoming a seller.
export async function saveDraft(db, user, input = {}) {
  if (user.role === 'seller') throw conflict('This account is already a seller.');
  if (user.role !== 'customer') throw forbidden('Only a customer account can apply to sell.');

  const existing = await applicationFor(db, user.id);
  if (existing && existing.status !== 'draft') throw conflict(`Your application is already ${existing.status}.`);

  // Text fields are trimmed; the two tax identifiers and the IFSC are upper-cased as typed.
  const UPPER = new Set(['pan', 'gstin', 'bank_ifsc']);
  const values = {};
  for (const field of FIELDS) {
    const raw = input[field] !== undefined ? input[field] : existing?.[field];
    if (raw == null) { values[field] = null; continue; }
    const text = String(raw).replace(/\s+/g, field === 'pickup_line1' || field === 'business_name' || field === 'bank_account_name' ? ' ' : '').trim();
    values[field] = UPPER.has(field) ? text.toUpperCase() : (text || null);
  }

  if (existing) {
    await run(db, `UPDATE seller_applications SET business_name = ?, business_type = ?, pan = ?, gstin = ?,
                     bank_account_name = ?, bank_account_no = ?, bank_ifsc = ?,
                     pickup_line1 = ?, pickup_city = ?, pickup_pincode = ?, pickup_phone = ?, updated_at = ?
                   WHERE user_id = ?`,
    values.business_name, values.business_type, values.pan, values.gstin,
    values.bank_account_name, values.bank_account_no, values.bank_ifsc,
    values.pickup_line1, values.pickup_city, values.pickup_pincode, values.pickup_phone, now(), user.id);
  } else {
    await run(db, `INSERT INTO seller_applications (user_id, business_name, business_type, pan, gstin,
                     bank_account_name, bank_account_no, bank_ifsc, pickup_line1, pickup_city, pickup_pincode,
                     pickup_phone, status, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'draft', ?, ?)`,
    user.id, values.business_name, values.business_type, values.pan, values.gstin,
    values.bank_account_name, values.bank_account_no, values.bank_ifsc,
    values.pickup_line1, values.pickup_city, values.pickup_pincode, values.pickup_phone, now(), now());
  }
  return await applicationFor(db, user.id);
}

// The last step: everything must be valid and the agreement accepted. Then the seller exists, with
// a dispatch warehouse, and Ops gets a task to look at the documents.
export async function submit(db, user, { agreement = false } = {}) {
  if (user.role === 'seller') throw conflict('This account is already a seller.');
  const app = await applicationFor(db, user.id);
  if (!app) throw badRequest('Start the application first.');
  if (app.status !== 'draft') throw conflict(`This application is already ${app.status}.`);

  const { steps, errors, clean } = missingFor(app);
  if (steps.length) {
    // fields is the list of names; errors says what is wrong with each, for the form to show.
    throw badRequest('Some details are missing or not in the right format.', { steps, fields: Object.keys(errors), errors });
  }
  if (!app.agreement_at && !agreement) throw badRequest('Accept the seller agreement to finish.');

  const stamp = app.agreement_at ?? now();
  await run(db, "UPDATE seller_applications SET status = 'submitted', agreement_at = ?, submitted_at = ?, updated_at = ? WHERE user_id = ?",
    stamp, now(), now(), user.id);

  // The account becomes a seller, with a dispatch warehouse in its pickup city.
  await run(db, "UPDATE users SET role = 'seller' WHERE id = ?", user.id);
  const sellerId = await run(db, 'INSERT INTO sellers (user_id, name, rating, rating_count, city, is_sample) VALUES (?,?, 4.0, 0, ?, false)',
    user.id, clean.business_name, clean.pickup_city);
  await run(db, "INSERT INTO warehouses (code, name, city, kind, seller_id) VALUES (?,?,?, 'seller_dispatch', ?)",
    `S-U${user.id}`, `${clean.business_name} dispatch, ${clean.pickup_city}`, clean.pickup_city, sellerId);

  // A person checks the documents before the seller lists anything: the KYC call is Phase 11's
  // provider step, and until it exists this is the control.
  await run(db, `INSERT INTO ops_tasks (kind, subject, body, dedupe_key)
                 VALUES ('seller_kyc', ?, ?, ?)
                 ON CONFLICT (dedupe_key) DO NOTHING`,
  `Seller application: ${clean.business_name}`,
  `Check PAN ${clean.pan}${clean.gstin ? `, GSTIN ${clean.gstin}` : ' (no GSTIN)'} and the bank details for ${clean.business_name} (${clean.pickup_city}). Seller #${sellerId}.`,
  `seller-kyc:${user.id}`);

  await audit(db, 'seller.apply', 'seller_application', app.id, { status: 'draft' }, { status: 'submitted', seller_id: sellerId });
  return { application: await applicationFor(db, user.id), seller_id: sellerId };
}

export const DOC_KINDS = ['pan_card', 'gst_certificate', 'bank_proof', 'cheque', 'other'];
const DOC_URL = /^https:\/\/[^\s]{8,500}$/i;
const DOC_EXT = /\.(pdf|jpg|jpeg|png|webp)(\?.*)?$/i;

export function checkDocument({ kind, url } = {}) {
  if (!DOC_KINDS.includes(kind)) throw badRequest('Choose what the document is.');
  const text = String(url || '').trim();
  // Our own upload path is allowed as well as an outside https link.
  if (/^\/api\/uploads\/\d+$/.test(text)) return { kind, url: text };
  if (!DOC_URL.test(text) || !DOC_EXT.test(text)) {
    throw badRequest('Give an https link to a PDF or image (jpg, png, webp).');
  }
  return { kind, url: text };
}

// One document per kind: a re-upload replaces the previous one rather than piling up versions.
export async function saveDocument(db, user, input = {}) {
  if (!['customer', 'seller'].includes(user.role)) throw forbidden('Only a seller account can submit documents.');
  const app = await applicationFor(db, user.id);
  if (!app) throw badRequest('Start the seller application first.');
  const { kind, url } = checkDocument(input);
  const uploadId = /^\/api\/uploads\/(\d+)$/.exec(url)?.[1] ?? null;
  await run(db, `INSERT INTO seller_documents (application_id, kind, url, note, upload_id, created_at)
                  VALUES (?, ?, ?, ?, ?, ?)
                  ON CONFLICT (application_id, kind) DO UPDATE
                    SET url = EXCLUDED.url, note = EXCLUDED.note, upload_id = EXCLUDED.upload_id,
                        status = 'submitted', reviewed_by = NULL, reviewed_at = NULL`,
  app.id, kind, url, String(input.note || '').slice(0, 200) || null, uploadId ? Number(uploadId) : null, now());
  await audit(db, 'seller.document', 'seller_application', app.id, null, { kind, url_host: safeHost(url) });
  return await listDocuments(db, app.id);
}

// The query string can hold a token from the storage provider; only the host and path are shown.
export const safeHost = (url) => {
  try { return new URL(url).host; } catch { return 'unknown'; }
};
export const publicUrl = (url) => {
  try { const u = new URL(url); u.search = ''; return u.toString(); } catch { return String(url); }
};

export async function listDocuments(db, applicationId) {
  const rows = await all(db, 'SELECT * FROM seller_documents WHERE application_id = ? ORDER BY kind', applicationId);
  return rows.map((d) => ({ kind: d.kind, url: publicUrl(d.url), note: d.note, status: d.status }));
}

export async function documentsFor(db, userId) {
  const app = await applicationFor(db, userId);
  return app ? await listDocuments(db, app.id) : [];
}

// Phase 11: run the KYC provider on a submitted application and record its answer. A rejection
// keeps the seller out of the marketplace; a verification approves the application.
export async function runKyc(db, applicationId, staffId = null) {
  const app = await one(db, 'SELECT * FROM seller_applications WHERE id = ?', applicationId);
  if (!app) throw notFound('Application');
  if (app.status !== 'submitted') throw conflict(`This application is ${app.status}, not waiting for KYC.`);
  if (app.kyc_status) throw conflict(`KYC already answered: ${app.kyc_status}.`);

  const answer = await kyc.verify({ pan: app.pan, name: app.bank_account_name, businessName: app.business_name });
  const status = answer.status === 'verified' ? 'approved' : 'rejected';
  await run(db, 'UPDATE seller_applications SET kyc_status = ?, kyc_ref = ?, kyc_at = ?, status = ?, updated_at = ? WHERE id = ?',
    answer.status, answer.ref, now(), status, now(), applicationId);
  if (status === 'rejected') {
    await run(db, "UPDATE users SET role = 'customer' WHERE id = ?", app.user_id);
    await run(db, 'UPDATE sellers SET name = name WHERE user_id = ?', app.user_id);
  }
  await audit(db, 'seller.kyc', 'seller_application', applicationId, { status: 'submitted' },
    { status, kyc_status: answer.status, reason: answer.reason, ref: answer.ref, by: staffId });
  return { application_id: Number(applicationId), status, kyc_status: answer.status, reason: answer.reason, ref: answer.ref };
}

export async function listApplications(db, status = null) {
  return await all(db, `SELECT a.*, u.email, u.name FROM seller_applications a JOIN users u ON u.id = a.user_id
                        WHERE (?::text IS NULL OR a.status = ?::text) ORDER BY a.id DESC`, status, status);
}
