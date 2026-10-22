-- Also in SCHEMA in src/db.js; tests/postgres.test.js checks they match. Safe to run again.
-- Telegram: one linked chat per person, and a one-time code that proves which account the chat
-- belongs to. A bot can never ask for a password, so the link is made from a signed-in session.
CREATE TABLE IF NOT EXISTS telegram_links (
    chat_id BIGINT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    role TEXT NOT NULL CHECK (role IN ('customer', 'seller')),
    linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS telegram_links_user ON telegram_links (user_id);
CREATE TABLE IF NOT EXISTS telegram_link_codes (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    code_hash TEXT NOT NULL,
    expires_at DOUBLE PRECISION NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
