-- Also in SCHEMA in src/db.js; tests/postgres.test.js checks them match. Safe to run again.
-- Phase 15: a deleted account is anonymised, never physically removed: orders and invoices must
-- survive for tax and consumer law.
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
