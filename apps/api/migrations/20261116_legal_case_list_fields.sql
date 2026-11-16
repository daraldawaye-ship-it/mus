ALTER TABLE legal_cases ADD COLUMN IF NOT EXISTS case_type text NOT NULL DEFAULT '';
ALTER TABLE legal_cases ADD COLUMN IF NOT EXISTS last_hearing date;
