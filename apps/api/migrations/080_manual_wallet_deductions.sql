-- Manual deductions are separate, immutable wallet entries. The existing
-- positive 'manual' and linked 'reversal' event types are unchanged.
-- The wallet balance trigger and pending-conversion reservation guard prevent
-- overdrafts and ensure that historical entries cannot be rewritten.
ALTER TABLE employee_wallet_entries DROP CONSTRAINT wallet_entry_kind_check;
ALTER TABLE employee_wallet_entries ADD CONSTRAINT wallet_entry_kind_check
 CHECK(kind IN ('manual','manual_debit','automatic','reversal','conversion','attendance','clearance'));

DO $$
DECLARE previous_check text;
BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO previous_check
 FROM pg_constraint WHERE conrelid='employee_wallet_entries'::regclass
   AND conname='wallet_entry_source_check';
 IF previous_check IS NULL THEN
  RAISE EXCEPTION 'Wallet source check is missing';
 END IF;
 ALTER TABLE employee_wallet_entries DROP CONSTRAINT wallet_entry_source_check;
 EXECUTE format($constraint$
  ALTER TABLE employee_wallet_entries
  ADD CONSTRAINT wallet_entry_source_check CHECK (
   (%s) OR (
    kind='manual_debit' AND points<0 AND money=0
    AND reference_id IS NULL AND invoice_id IS NULL
    AND financial_document_id IS NULL AND conversion_id IS NULL
    AND attendance_entry_id IS NULL AND clearance_earning_id IS NULL
    AND page_key IS NULL AND task_code IS NULL
    AND task_revision IS NULL AND logical_line_count IS NULL
   )
  )
 $constraint$,previous_check);
END $$;
