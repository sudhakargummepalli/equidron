-- Also in SCHEMA in src/db.js; tests/postgres.test.js checks them match. Safe to run again.
-- Phase 11: the KYC answer. Simulated by default; the vendor reference is kept for support.
ALTER TABLE seller_applications ADD COLUMN IF NOT EXISTS kyc_status TEXT;
ALTER TABLE seller_applications ADD COLUMN IF NOT EXISTS kyc_ref TEXT;
ALTER TABLE seller_applications ADD COLUMN IF NOT EXISTS kyc_at TIMESTAMPTZ;
