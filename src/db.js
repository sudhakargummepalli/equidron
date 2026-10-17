// SQLite schema and helpers (Node's built-in node:sqlite, no npm packages).
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('customer', 'seller', 'ops')),
    pw_salt TEXT NOT NULL,
    pw_hash TEXT NOT NULL,
    is_sample INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    role TEXT NOT NULL,
    expires_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS sellers (
    id INTEGER PRIMARY KEY,
    user_id INTEGER UNIQUE NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    rating REAL NOT NULL DEFAULT 4.0,
    rating_count INTEGER NOT NULL DEFAULT 0,
    city TEXT NOT NULL,
    is_sample INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS warehouses (
    id INTEGER PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    city TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('equidron_fc', 'seller_dispatch')),
    seller_id INTEGER REFERENCES sellers(id)
);
CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    brand TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    specs TEXT NOT NULL DEFAULT '{}',
    images TEXT NOT NULL DEFAULT '[]',
    rating REAL NOT NULL DEFAULT 0,
    review_count INTEGER NOT NULL DEFAULT 0,
    return_window_days INTEGER NOT NULL DEFAULT 10,
    status TEXT NOT NULL CHECK (status IN ('pending', 'live')),
    is_sample INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS offers (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id),
    seller_id INTEGER NOT NULL REFERENCES sellers(id),
    price_paise INTEGER NOT NULL CHECK (price_paise > 0),
    mrp_paise INTEGER,
    condition TEXT NOT NULL DEFAULT 'new',
    fulfilment TEXT NOT NULL CHECK (fulfilment IN ('equidron', 'seller')),
    handling_days INTEGER NOT NULL DEFAULT 1,
    ships_to TEXT NOT NULL DEFAULT '["ALL"]',
    status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'inactive')),
    is_sample INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    UNIQUE (product_id, seller_id, condition)
);
CREATE TABLE IF NOT EXISTS inventory (
    offer_id INTEGER NOT NULL REFERENCES offers(id),
    warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
    on_hand INTEGER NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
    reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
    PRIMARY KEY (offer_id, warehouse_id),
    CHECK (reserved <= on_hand)
);
CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY,
    seller_id INTEGER NOT NULL REFERENCES sellers(id),
    product_id INTEGER REFERENCES products(id),
    offer_id INTEGER REFERENCES offers(id),
    kind TEXT NOT NULL CHECK (kind IN ('new_product', 'new_offer', 'update')),
    payload TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
    auto_decided INTEGER NOT NULL DEFAULT 0,
    review_reasons TEXT NOT NULL DEFAULT '[]',
    reviewer_note TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
);
CREATE TABLE IF NOT EXISTS addresses (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    line1 TEXT NOT NULL,
    city TEXT NOT NULL,
    pincode TEXT NOT NULL,
    phone TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cart_items (
    user_id INTEGER NOT NULL REFERENCES users(id),
    offer_id INTEGER NOT NULL REFERENCES offers(id),
    qty INTEGER NOT NULL CHECK (qty > 0),
    price_at_add_paise INTEGER NOT NULL,
    added_at TEXT NOT NULL,
    PRIMARY KEY (user_id, offer_id)
);
CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    address TEXT NOT NULL,
    status TEXT NOT NULL,
    payment_status TEXT NOT NULL,
    fulfilment_status TEXT NOT NULL,
    payment_method TEXT NOT NULL,
    subtotal_paise INTEGER NOT NULL,
    shipping_paise INTEGER NOT NULL,
    total_paise INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shipments (
    id INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
    status TEXT NOT NULL,
    carrier TEXT,
    tracking_no TEXT,
    amount_paise INTEGER NOT NULL,
    eta TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shipment_events (
    id INTEGER PRIMARY KEY,
    shipment_id INTEGER NOT NULL REFERENCES shipments(id),
    status TEXT NOT NULL,
    note TEXT NOT NULL,
    at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    shipment_id INTEGER REFERENCES shipments(id),
    offer_id INTEGER NOT NULL REFERENCES offers(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    seller_id INTEGER NOT NULL REFERENCES sellers(id),
    warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
    title TEXT NOT NULL,
    qty INTEGER NOT NULL,
    unit_price_paise INTEGER NOT NULL,
    returned_qty INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY,
    order_id INTEGER UNIQUE NOT NULL REFERENCES orders(id),
    method TEXT NOT NULL,
    instrument TEXT NOT NULL,
    provider_ref TEXT,
    status TEXT NOT NULL,
    authorized_paise INTEGER NOT NULL DEFAULT 0,
    captured_paise INTEGER NOT NULL DEFAULT 0,
    refunded_paise INTEGER NOT NULL DEFAULT 0,
    decline_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_events (
    id INTEGER PRIMARY KEY,
    payment_id INTEGER NOT NULL REFERENCES payments(id),
    kind TEXT NOT NULL,
    amount_paise INTEGER NOT NULL,
    note TEXT,
    at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS returns (
    id INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    order_item_id INTEGER NOT NULL REFERENCES order_items(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    qty INTEGER NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL,
    refund_paise INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS seller_ledger (
    id INTEGER PRIMARY KEY,
    seller_id INTEGER NOT NULL REFERENCES sellers(id),
    order_item_id INTEGER REFERENCES order_items(id),
    kind TEXT NOT NULL,
    amount_paise INTEGER NOT NULL,
    note TEXT NOT NULL,
    at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    message TEXT NOT NULL,
    link TEXT,
    is_read INTEGER NOT NULL DEFAULT 0,
    at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS support_tickets (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    order_id INTEGER REFERENCES orders(id),
    subject TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS support_messages (
    id INTEGER PRIMARY KEY,
    ticket_id INTEGER NOT NULL REFERENCES support_tickets(id),
    author_role TEXT NOT NULL,
    body TEXT NOT NULL,
    at TEXT NOT NULL
);
`;

const pad = (n) => String(n).padStart(2, '0');

export function now(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function isoDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// journal: 'WAL' for the local server, 'DELETE' when the file must be self-contained (Netlify Blobs).
export function connect(path, { journal = 'WAL' } = {}) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') db.exec(`PRAGMA journal_mode = ${journal}`);
  return db;
}

export function initSchema(db) {
  db.exec(SCHEMA);
}

// SQLite can't bind undefined or booleans; normalise them.
const bind = (params) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));

const plain = (r) => (r ? { ...r } : null);

export function all(db, sql, ...params) {
  return db.prepare(sql).all(...bind(params)).map(plain);
}

export function one(db, sql, ...params) {
  return plain(db.prepare(sql).get(...bind(params)));
}

export function scalar(db, sql, ...params) {
  const r = db.prepare(sql).get(...bind(params));
  return r ? Object.values(r)[0] : null;
}

export function run(db, sql, ...params) {
  const r = db.prepare(sql).run(...bind(params));
  return Number(r.lastInsertRowid);
}

// Run fn inside BEGIN IMMEDIATE ... COMMIT, rolling back if it throws.
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function loads(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export const dumps = (v) => JSON.stringify(v);
