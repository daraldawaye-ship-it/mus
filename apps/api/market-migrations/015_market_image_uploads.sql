-- Compressed, square medicine-market uploads are stored only in the isolated market database.
-- The original image never enters PostgreSQL: the browser uploads a resized 512x512 WebP.
CREATE TABLE market_image_uploads (
  id uuid PRIMARY KEY,
  card_id integer NOT NULL REFERENCES medicine_market_cards(id),
  uploaded_by integer NOT NULL REFERENCES users(id),
  mime text NOT NULL DEFAULT 'image/webp' CHECK(mime='image/webp'),
  width smallint NOT NULL DEFAULT 512 CHECK(width=512),
  height smallint NOT NULL DEFAULT 512 CHECK(height=512),
  byte_size integer NOT NULL CHECK(byte_size BETWEEN 1 AND 102400),
  image_bytes bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX market_image_uploads_author_date ON market_image_uploads(uploaded_by,created_at DESC);
