-- Phase 2: idempotency keys, so a checkout sent twice (a double click, a retried request) places one order.
-- Also in SCHEMA in src/db.js; tests/postgres.test.js checks they match.
CREATE TABLE IF NOT EXISTS idempotency_keys (
    user_id INTEGER NOT NULL REFERENCES users(id),
    key TEXT NOT NULL,
    route TEXT NOT NULL,
    status INTEGER,
    response JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, key)
);
