ALTER TABLE items
  ADD COLUMN default_supply_max_quantity numeric(22, 0)
    CHECK (default_supply_max_quantity >= 0),
  ADD COLUMN default_supply_max_notes text
    CHECK (char_length(default_supply_max_notes) <= 1000);
