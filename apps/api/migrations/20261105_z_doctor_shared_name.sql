-- Company-scoped canonical label for grouping doctor/nurse/entity cards later.
-- Keep IDs, historical invoice doctor_id snapshots and individual cards untouched.
ALTER TABLE doctors
  ADD COLUMN IF NOT EXISTS shared_name varchar(240) NOT NULL DEFAULT '';

-- Existing cards are initially their own main card; no automatic identity merge.
UPDATE doctors SET shared_name = name WHERE shared_name = '';

CREATE INDEX IF NOT EXISTS doctors_shared_name_lookup
  ON doctors(company_id,shared_name,id);
