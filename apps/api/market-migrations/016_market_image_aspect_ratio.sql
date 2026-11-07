-- Remove forced square dimensions; keep the complete image aspect ratio.
-- Legacy 512x512 uploads are still valid and rendered with border trimming.
ALTER TABLE market_image_uploads
  DROP CONSTRAINT IF EXISTS market_image_uploads_width_check,
  DROP CONSTRAINT IF EXISTS market_image_uploads_height_check;
ALTER TABLE market_image_uploads
  ADD CONSTRAINT market_image_uploads_max_side_check
  CHECK(width BETWEEN 1 AND 512 AND height BETWEEN 1 AND 512
        AND GREATEST(width,height)=512);
