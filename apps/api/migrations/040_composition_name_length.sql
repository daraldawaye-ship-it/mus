-- Preserve the longest composition names in the legacy source spreadsheet.
-- No data removal, reclassification or change to existing items.
ALTER TABLE item_compositions
  DROP CONSTRAINT item_compositions_arabic_name_check;
ALTER TABLE item_compositions
  DROP CONSTRAINT item_compositions_english_name_check;
ALTER TABLE item_compositions
  ADD CONSTRAINT item_compositions_arabic_name_check
  CHECK (length(trim(arabic_name)) BETWEEN 1 AND 240);
ALTER TABLE item_compositions
  ADD CONSTRAINT item_compositions_english_name_check
  CHECK (length(trim(english_name)) BETWEEN 1 AND 240);
