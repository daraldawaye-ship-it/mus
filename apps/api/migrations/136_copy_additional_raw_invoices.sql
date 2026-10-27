-- Explicit manual request: 30,000 additional raw invoices only.
-- The shared transfer excludes every previously copied or posted identity.
-- No stock, journals, statistics or background workers are started.
DO $manual_copy$
BEGIN
 IF EXISTS(SELECT 1 FROM legacy_import_staging WHERE company_id=2
   AND source_system='dar-aldawa-legacy-2026-10' AND source_kind='invoice') THEN
   PERFORM transfer_raw_invoice_table(2,'dar-aldawa-legacy-2026-10','f7fd2626-f242-43ef-a52f-35b2ee8d6720'::uuid,30000);
 END IF;
END $manual_copy$;
