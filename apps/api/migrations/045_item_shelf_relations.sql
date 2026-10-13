-- Link item shelf selections to master shelf cards by scoped foreign key.
-- Historical free-text shelf labels stay intact and items without a matching
-- master shelf retain a NULL reference.
ALTER TABLE items ADD COLUMN shelf_id integer;
ALTER TABLE items ADD CONSTRAINT items_shelf_card_fk
  FOREIGN KEY(company_id,shelf_id) REFERENCES item_shelves(company_id,id);
CREATE INDEX items_shelf_card ON items(company_id,shelf_id)
  WHERE shelf_id IS NOT NULL;
