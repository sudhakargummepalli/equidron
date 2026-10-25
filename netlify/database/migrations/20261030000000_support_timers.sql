-- Also in SCHEMA in src/db.js; tests/postgres.test.js checks them match. Safe to run again.
-- Phase 6: response timers and the one-tap rating. A ticket is due a first reply within four hours
-- of being opened; the first reply from anyone who is not the customer stops that clock, and
-- closing the ticket records when it was resolved, which is what the rating is about.
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS first_response_due_at TIMESTAMPTZ;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMPTZ;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS rating INTEGER CHECK (rating BETWEEN 1 AND 5);
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS rated_at TIMESTAMPTZ;
