-- Each company chooses an independent full-width print masthead image.
-- Reuse database-backed assets so Railway deploys do not erase uploads.
ALTER TABLE media_assets DROP CONSTRAINT media_assets_purpose_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_purpose_check
  CHECK (purpose IN ('avatar', 'item', 'letterhead'));
ALTER TABLE media_assets DROP CONSTRAINT media_assets_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_check
  CHECK (
    (purpose='avatar' AND company_id IS NULL)
    OR (purpose IN ('item', 'letterhead') AND company_id IS NOT NULL)
  );

CREATE TABLE company_letterheads (
  company_id integer PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  media_id uuid NOT NULL REFERENCES media_assets(id),
  updated_by integer NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX company_letterheads_media ON company_letterheads(media_id);
