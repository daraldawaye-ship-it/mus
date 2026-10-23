-- Explicit user-triggered stocktake request timestamp. Never writable through the ordinary item payload.
-- Timestamp originates at the PostgreSQL server, not the browser.
ALTER TABLE items ADD COLUMN stocktake_required_at timestamptz;
