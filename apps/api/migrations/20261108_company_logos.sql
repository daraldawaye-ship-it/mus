-- Company-specific logos are independent of full-width print letterheads.
-- Original raster is the logo; thumbnail stores the matching compact square icon.
ALTER TABLE media_assets DROP CONSTRAINT media_assets_purpose_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_purpose_check
  CHECK (purpose IN ('avatar','item','letterhead','chat','logo'));
ALTER TABLE media_assets DROP CONSTRAINT media_assets_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_check
  CHECK ((purpose='avatar' AND company_id IS NULL)
      OR (purpose IN ('item','letterhead','logo') AND company_id IS NOT NULL)
      OR (purpose='chat'));

CREATE TABLE company_logos (
  company_id integer PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  media_id uuid NOT NULL REFERENCES media_assets(id),
  updated_by integer NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX company_logos_media ON company_logos(media_id);
