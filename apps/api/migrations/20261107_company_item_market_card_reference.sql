-- Optional informational ID only: the medicine market lives in a separate database.
-- No foreign key, synchronization, or inventory side effects.
ALTER TABLE items
  ADD COLUMN IF NOT EXISTS market_card_id integer
  CHECK (market_card_id > 0);
