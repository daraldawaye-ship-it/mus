CREATE TABLE IF NOT EXISTS owner_medicine_taxonomy_draft (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  classifications jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(classifications) = 'array')
);
INSERT INTO owner_medicine_taxonomy_draft (singleton) VALUES (true) ON CONFLICT DO NOTHING;
