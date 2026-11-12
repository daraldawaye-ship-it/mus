-- Main WebP + icon only. Byte compaction is an explicit owner-triggered pass,
-- not a destructive migration during startup or an update to card contents.
ALTER TABLE market_image_variants ADD COLUMN storage_version integer NOT NULL DEFAULT 1;
ALTER TABLE market_image_variants DROP CONSTRAINT market_image_variants_check;
ALTER TABLE market_image_variants DROP CONSTRAINT market_image_variants_preview_bytes_check;
ALTER TABLE market_image_variants DROP CONSTRAINT market_image_variants_preview_width_check;
ALTER TABLE market_image_variants DROP CONSTRAINT market_image_variants_preview_height_check;
ALTER TABLE market_image_variants ADD CONSTRAINT market_image_variants_preview_bytes_check
  CHECK(octet_length(preview_bytes)<=204800);
ALTER TABLE market_image_variants ADD CONSTRAINT market_image_variants_preview_width_check
  CHECK(preview_width BETWEEN 1 AND 1200);
ALTER TABLE market_image_variants ADD CONSTRAINT market_image_variants_preview_height_check
  CHECK(preview_height BETWEEN 1 AND 1200);
ALTER TABLE market_image_variants ADD CONSTRAINT market_image_variants_ready_check
  CHECK(status<>'ready' OR (icon_bytes IS NOT NULL AND icon_width IS NOT NULL AND icon_height IS NOT NULL
    AND (image_id IS NOT NULL OR (preview_bytes IS NOT NULL AND preview_width IS NOT NULL AND preview_height IS NOT NULL))));
-- Retain existing legacy limits until the owner pass has safely compacted old files.
ALTER TABLE market_image_uploads DROP CONSTRAINT IF EXISTS market_image_uploads_width_check;
ALTER TABLE market_image_uploads DROP CONSTRAINT IF EXISTS market_image_uploads_height_check;
ALTER TABLE market_image_uploads DROP CONSTRAINT IF EXISTS market_image_uploads_byte_size_check;
ALTER TABLE market_image_uploads ADD CONSTRAINT market_image_uploads_width_check CHECK(width BETWEEN 1 AND 1600);
ALTER TABLE market_image_uploads ADD CONSTRAINT market_image_uploads_height_check CHECK(height BETWEEN 1 AND 1600);
ALTER TABLE market_image_uploads ADD CONSTRAINT market_image_uploads_byte_size_check CHECK(byte_size BETWEEN 1 AND 512000);
