ALTER TABLE medawee_items_staging
  ADD COLUMN linked_market_card_id integer REFERENCES medicine_market_cards(id) ON DELETE RESTRICT,
  ADD COLUMN review_revision integer NOT NULL DEFAULT 0 CHECK (review_revision >= 0);
