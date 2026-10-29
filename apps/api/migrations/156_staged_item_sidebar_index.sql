-- Fast read-only sale/purchase item history lookups for preserved, unposted invoices.
-- Only active source rows are indexed; completed/posted invoices remain in the normal history.
CREATE INDEX IF NOT EXISTS legacy_import_staging_item_sidebar_gin
  ON legacy_import_staging
  USING gin ((source_document->'payload'->'lines') jsonb_path_ops)
  WHERE source_kind='invoice'
    AND status IN ('pending','failed','excluded')
    AND source_document->>'type'='invoice';
