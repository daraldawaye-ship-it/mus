-- Preserve the original filename and a separately editable reader-facing image/PDF label.
ALTER TABLE explanation_assets ADD COLUMN IF NOT EXISTS display_name varchar(250);
UPDATE explanation_assets SET display_name=filename WHERE display_name IS NULL;
ALTER TABLE explanation_assets ALTER COLUMN display_name SET NOT NULL;
ALTER TABLE explanation_assets DROP CONSTRAINT IF EXISTS explanation_assets_content_check;
ALTER TABLE explanation_assets ADD CONSTRAINT explanation_assets_content_check
 CHECK(octet_length(content)>0 AND octet_length(content)<=10485760);
CREATE INDEX IF NOT EXISTS explanation_assets_uploaded_at_idx
 ON explanation_assets(node_id, created_at, id);
