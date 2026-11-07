-- Public prescription cards with optional community medicine links.
-- Preserve media readability without growing the company's primary database.
ALTER TABLE medicine_market_cards DROP CONSTRAINT IF EXISTS medicine_market_cards_kind_check;
ALTER TABLE medicine_market_cards ADD CONSTRAINT medicine_market_cards_kind_check
 CHECK(kind IN ('medicine','composition','scientific-name','dosage-form','pharmacy',
 'wholesaler','agent','manufacturer','doctor','hospital','clinic','college','prescription'));
ALTER TABLE market_image_uploads DROP CONSTRAINT IF EXISTS market_image_uploads_byte_size_check;
ALTER TABLE market_image_uploads ADD CONSTRAINT market_image_uploads_byte_size_check
 CHECK(byte_size BETWEEN 1 AND 512000);
ALTER TABLE market_image_uploads DROP CONSTRAINT IF EXISTS market_image_uploads_max_side_check;
ALTER TABLE market_image_uploads ADD CONSTRAINT market_image_uploads_max_side_check
 CHECK(width BETWEEN 1 AND 1600 AND height BETWEEN 1 AND 1600);
