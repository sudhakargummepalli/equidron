-- Also in SCHEMA in src/db.js; tests/postgres.test.js checks them match. Safe to run again.
-- Phase 9: what the carrier gives back. The AWB is the number the customer and the courier both
-- use, the label is a URL we do not store the PDF of, and carrier_ref is their own id for support.
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS awb TEXT;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS label_url TEXT;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS carrier_ref TEXT;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS booked_at TIMESTAMPTZ;
