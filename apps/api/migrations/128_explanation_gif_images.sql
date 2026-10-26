-- Allow animated GIF images alongside the existing PDF/PNG/JPEG/WebP formats.
ALTER TABLE explanation_assets
 DROP CONSTRAINT IF EXISTS explanation_assets_mime_type_check;
ALTER TABLE explanation_assets
 ADD CONSTRAINT explanation_assets_mime_type_check
 CHECK (mime_type IN ('application/pdf','image/png','image/jpeg','image/webp','image/gif'));
