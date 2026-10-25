-- Also in SCHEMA in src/db.js; tests/postgres.test.js checks them match. Safe to run again.
-- Phase 7: the price band a seller sets for an offer, and whether an agent may move the price
-- inside it. The band belongs to the seller, not to the agent: a tool can read it and must stay
-- inside it, but only a person can change it.
ALTER TABLE offers ADD COLUMN IF NOT EXISTS price_floor_paise INTEGER;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS price_ceiling_paise INTEGER;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS auto_pricing BOOLEAN NOT NULL DEFAULT false;
