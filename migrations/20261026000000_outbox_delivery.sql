-- Also in SCHEMA in src/db.js; tests/postgres.test.js checks they match. Safe to run again.
-- Delivery state for the outbox: a row is 'pending' until a worker claims it, then 'sent' or,
-- after the last retry, 'failed'. Rows written before this change become 'pending', which is what
-- makes the messages already waiting in Ops -> Outbox go out once SMTP is configured.
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'failed'));
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS outbox_unsent ON outbox (status, id) WHERE status IN ('pending', 'sending');
