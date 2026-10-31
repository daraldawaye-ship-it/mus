-- An employee earns configurable points only after a verified, newly posted
-- reconciliation from the due-count screen. Never backfill old adjustments.
INSERT INTO reward_task_definitions
  (code,name,description,implemented,default_points,default_repeat_rule)
VALUES ('STOCK_COUNT_REQUIRED','تسوية صنف مطلوب جرده',
 'مكافأة كل تسوية ناجحة لصنف مستحق للجرد من صفحة الأصناف المطلوبة، بما فيها الجرد المطابق، مرة واحدة للعملية.',true,10,'per-document')
ON CONFLICT(code) DO NOTHING;

INSERT INTO reward_task_settings
  (company_id,code,points,repeat_rule,enabled,page_key,updated_by)
SELECT c.id,'STOCK_COUNT_REQUIRED',10,'per-document',true,NULL,c.created_by
FROM companies c ON CONFLICT(company_id,code) DO NOTHING;

-- New companies also receive the editable reward card.
CREATE FUNCTION initialize_required_stock_count_reward() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO reward_task_settings
    (company_id,code,points,repeat_rule,enabled,page_key,updated_by)
  VALUES (NEW.id,'STOCK_COUNT_REQUIRED',10,'per-document',true,NULL,NEW.created_by)
  ON CONFLICT(company_id,code) DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER company_required_stock_count_reward AFTER INSERT ON companies
  FOR EACH ROW EXECUTE FUNCTION initialize_required_stock_count_reward();

-- The existing ledger remains immutable and wallet balances continue to
-- change exclusively through ledger inserts. Link each credit to its real
-- stock operation, never to a fabricated invoice or financial document.
ALTER TABLE employee_wallet_entries
  ADD COLUMN stock_operation_id integer,
  ADD CONSTRAINT wallet_stock_operation_fk
    FOREIGN KEY(company_id,stock_operation_id)
    REFERENCES stock_operations(company_id,id);

DO $$
DECLARE previous_check text;
BEGIN
  SELECT pg_get_expr(conbin,conrelid) INTO previous_check
  FROM pg_constraint WHERE conrelid='employee_wallet_entries'::regclass
    AND conname='wallet_entry_source_check';
  IF previous_check IS NULL THEN
    RAISE EXCEPTION 'Missing wallet source guard';
  END IF;
  ALTER TABLE employee_wallet_entries DROP CONSTRAINT wallet_entry_source_check;
  EXECUTE format($guard$
    ALTER TABLE employee_wallet_entries ADD CONSTRAINT wallet_entry_source_check CHECK (
      (%s) OR (
        kind='automatic' AND points>0 AND money=0
        AND stock_operation_id IS NOT NULL
        AND task_code='STOCK_COUNT_REQUIRED'
        AND task_revision>0 AND logical_line_count=1
        AND reference_id IS NULL AND invoice_id IS NULL
        AND financial_document_id IS NULL AND conversion_id IS NULL
        AND attendance_entry_id IS NULL AND clearance_earning_id IS NULL
        AND page_key IS NULL
      )
    )
  $guard$,previous_check);
END $$;

ALTER TABLE employee_wallet_entries
  ADD CONSTRAINT wallet_stock_count_source_guard CHECK (
    stock_operation_id IS NULL OR (
      kind='automatic' AND task_code='STOCK_COUNT_REQUIRED'
      AND invoice_id IS NULL AND financial_document_id IS NULL
      AND conversion_id IS NULL AND attendance_entry_id IS NULL
      AND clearance_earning_id IS NULL AND page_key IS NULL
    )
  );

CREATE UNIQUE INDEX wallet_stock_count_once
  ON employee_wallet_entries(company_id,employee_id,task_code,stock_operation_id)
  WHERE stock_operation_id IS NOT NULL;

-- Keep the repeat rule consistent with the per-operation wallet index.
CREATE OR REPLACE FUNCTION guard_reward_task_activation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ready boolean;
BEGIN
 IF NEW.enabled THEN
  SELECT implemented INTO ready FROM reward_task_definitions WHERE code=NEW.code;
  IF NOT COALESCE(ready,false) THEN
    RAISE EXCEPTION 'Unimplemented reward task cannot be activated' USING ERRCODE='23514';
  END IF;
  IF NEW.code IN ('SALE_SAVED','PURCHASE_SAVED','SALE_LINES','PURCHASE_LINES',
                  'RECEIPT_PRINT','PAYMENT_PRINT','CUSTOMER_NEW','CUSTOMER_EXISTING',
                  'DOCTOR_REFERRED','STOCK_COUNT_REQUIRED')
    AND NEW.repeat_rule<>'per-document' THEN
    RAISE EXCEPTION 'Document rewards must use per-document repeat rule' USING ERRCODE='23514';
  END IF;
  IF NEW.code='PAGE_VISIT' AND (NEW.page_key IS NULL OR NEW.repeat_rule='per-document' OR NEW.points<=0) THEN
    RAISE EXCEPTION 'Page visit reward requires a target, positive points and time-based repeat rule' USING ERRCODE='23514';
  END IF;
  IF NEW.code='DAILY_LOGIN' AND (NEW.repeat_rule<>'daily' OR NEW.page_key IS NOT NULL OR NEW.points<=0) THEN
    RAISE EXCEPTION 'Company login reward requires daily repeat and positive points' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
