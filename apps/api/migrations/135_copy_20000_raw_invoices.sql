-- Explicit manual request: 20,000 additional raw invoices only.
-- Existing copied/posted identities are excluded by the shared transfer function.
-- Application jobs, statistics, stock and accounting remain paused.
DO $manual_copy$
BEGIN
 IF EXISTS(SELECT 1 FROM legacy_import_staging WHERE company_id=2
   AND source_system='dar-aldawa-legacy-2026-10' AND source_kind='invoice') THEN
   PERFORM transfer_raw_invoice_table(2,'dar-aldawa-legacy-2026-10','6c4d3555-fec4-419c-b85b-7cdf1e5e9a46'::uuid,20000);
 END IF;
END $manual_copy$;
