ALTER TABLE legal_records DROP CONSTRAINT legal_records_kind_check;
ALTER TABLE legal_records ADD CONSTRAINT legal_records_kind_check
  CHECK (kind IN ('fact','document','event','explanation','task','report','hearing','instruction'));

CREATE VIEW legal_instructions AS
  SELECT * FROM legal_records WHERE kind = 'instruction';
