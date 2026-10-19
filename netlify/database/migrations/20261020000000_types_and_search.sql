-- Also in SCHEMA in src/db.js; tests/postgres.test.js checks they match. Safe to run again.
-- Phase 2b: columns get real types, and products get a full-text search index.
-- Each column is converted only while it still has its old type (text or integer). Times stored
-- as text are read as UTC, which is what the Netlify functions wrote. Flags become booleans,
-- JSON text becomes JSONB, and the delivery promise and the assistant's day become dates.
DO $$
DECLARE
    c RECORD;
BEGIN
    FOR c IN SELECT * FROM (VALUES
        ('users', 'created_at', 'timestamptz', NULL),
        ('products', 'created_at', 'timestamptz', NULL),
        ('offers', 'updated_at', 'timestamptz', NULL),
        ('submissions', 'created_at', 'timestamptz', NULL),
        ('submissions', 'decided_at', 'timestamptz', NULL),
        ('cart_items', 'added_at', 'timestamptz', NULL),
        ('orders', 'created_at', 'timestamptz', NULL),
        ('orders', 'updated_at', 'timestamptz', NULL),
        ('shipments', 'created_at', 'timestamptz', NULL),
        ('shipments', 'updated_at', 'timestamptz', NULL),
        ('shipment_events', 'at', 'timestamptz', NULL),
        ('payments', 'created_at', 'timestamptz', NULL),
        ('payments', 'updated_at', 'timestamptz', NULL),
        ('payment_events', 'at', 'timestamptz', NULL),
        ('returns', 'created_at', 'timestamptz', NULL),
        ('returns', 'updated_at', 'timestamptz', NULL),
        ('seller_ledger', 'at', 'timestamptz', NULL),
        ('notifications', 'at', 'timestamptz', NULL),
        ('support_tickets', 'created_at', 'timestamptz', NULL),
        ('support_messages', 'at', 'timestamptz', NULL),
        ('outbox', 'at', 'timestamptz', NULL),
        ('shipments', 'eta', 'date', NULL),
        ('assistant_usage', 'day', 'date', NULL),
        ('products', 'specs', 'jsonb', '''{}''::jsonb'),
        ('products', 'images', 'jsonb', '''[]''::jsonb'),
        ('offers', 'ships_to', 'jsonb', '''["ALL"]''::jsonb'),
        ('submissions', 'payload', 'jsonb', NULL),
        ('submissions', 'review_reasons', 'jsonb', '''[]''::jsonb'),
        ('orders', 'address', 'jsonb', NULL),
        ('users', 'permissions', 'jsonb', '''[]''::jsonb'),
        ('users', 'is_sample', 'boolean', 'false'),
        ('users', 'email_verified', 'boolean', 'true'),
        ('users', 'totp_enabled', 'boolean', 'false'),
        ('sellers', 'is_sample', 'boolean', 'false'),
        ('products', 'is_sample', 'boolean', 'false'),
        ('offers', 'is_sample', 'boolean', 'false'),
        ('submissions', 'auto_decided', 'boolean', 'false'),
        ('notifications', 'is_read', 'boolean', 'false'),
        ('login_attempts', 'ok', 'boolean', NULL)
    ) AS v(tbl, col, typ, dflt)
    LOOP
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                   AND table_name = c.tbl AND column_name = c.col AND data_type IN ('text', 'integer')) THEN
            EXECUTE format('ALTER TABLE %I ALTER COLUMN %I DROP DEFAULT', c.tbl, c.col);
            EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE %s USING %s', c.tbl, c.col, c.typ,
                CASE c.typ
                    WHEN 'timestamptz' THEN format('(%I::timestamp AT TIME ZONE ''UTC'')', c.col)
                    WHEN 'boolean' THEN format('(%I <> 0)', c.col)
                    ELSE format('%I::%s', c.col, c.typ)
                END);
            IF c.dflt IS NOT NULL THEN
                EXECUTE format('ALTER TABLE %I ALTER COLUMN %I SET DEFAULT %s', c.tbl, c.col, c.dflt);
            END IF;
        END IF;
    END LOOP;
END $$;
-- Full-text search over a product's words; src/catalog.js queries the same expression (SEARCH_VECTOR).
CREATE INDEX IF NOT EXISTS products_search ON products
    USING GIN (to_tsvector('simple', title || ' ' || brand || ' ' || category || ' ' || description || ' ' || specs::text));
-- Typo matching on titles, where the server offers the pg_trgm extension. Without it, search
-- still works; it just doesn't forgive typos.
DO $$
BEGIN
    BEGIN
        CREATE EXTENSION IF NOT EXISTS pg_trgm;
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'pg_trgm is not available, so search will not match typos.';
    END;
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
        EXECUTE 'CREATE INDEX IF NOT EXISTS products_title_trgm ON products USING GIN ((title || '' '' || brand) gin_trgm_ops)';
    END IF;
END $$;
