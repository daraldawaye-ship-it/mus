-- Text lookup must narrow matches before joining prices, stock and rankings.
-- Install the trusted extension once across isolated application schemas.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_trgm') THEN
    PERFORM pg_advisory_xact_lock(hashtext('alraesy:pg-trgm-extension'));
    CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
  END IF;
END $$;

-- Match the normal company-first mutation order before index DDL blocks writes.
LOCK TABLE companies IN EXCLUSIVE MODE;
CREATE INDEX items_lookup_text ON items USING gin (
  name public.gin_trgm_ops,
  english_name public.gin_trgm_ops,
  code public.gin_trgm_ops,
  barcode public.gin_trgm_ops,
  search_keys public.gin_trgm_ops
);
CREATE INDEX item_compositions_lookup_text ON item_compositions USING gin (
  arabic_name public.gin_trgm_ops,
  english_name public.gin_trgm_ops
);
ANALYZE items;
ANALYZE item_compositions;
ANALYZE company_currencies;
ANALYZE item_sale_rankings;
