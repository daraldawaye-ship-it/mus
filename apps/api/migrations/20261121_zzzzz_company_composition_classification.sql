-- Classification is optional and separate from dosage form and the public market.
-- No default or backfill: existing composition cards remain unclassified.
ALTER TABLE item_compositions
  ADD COLUMN classification text,
  ADD CONSTRAINT item_composition_classification_valid
    CHECK (classification IN ('medical_supplies','health_supplies','medicine'));
