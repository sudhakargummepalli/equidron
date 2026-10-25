-- Also in SCHEMA in src/db.js; tests/postgres.test.js checks them match. Safe to run again.
-- Phase 10: the language a person reads. The store keeps it in the conversation's localStorage and
-- saves it to the account; emails are written in it from then on.
ALTER TABLE users ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'en'
    CHECK (language IN ('en', 'te'));
