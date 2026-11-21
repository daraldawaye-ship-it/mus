-- Add the fourth explicit option without changing stored classifications.
ALTER TABLE item_compositions
  DROP CONSTRAINT item_composition_classification_valid,
  ADD CONSTRAINT item_composition_classification_valid
    CHECK (classification IN ('medical_supplies','health_supplies','medicine','medical_and_health_supplies'));
