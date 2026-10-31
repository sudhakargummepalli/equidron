-- Store assistant questions per customer per day, for the daily cap. Also in SCHEMA in src/db.js; tests/postgres.test.js checks they match.
CREATE TABLE IF NOT EXISTS assistant_usage (
    user_id INTEGER NOT NULL REFERENCES users(id),
    day TEXT NOT NULL,
    questions INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
);
