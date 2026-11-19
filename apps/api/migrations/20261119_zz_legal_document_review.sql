ALTER TABLE legal_records ADD COLUMN IF NOT EXISTS document_review jsonb NOT NULL DEFAULT '{}'::jsonb;
