-- Phase 3b: explicit company page visits earn task points only after opting in.
UPDATE reward_task_definitions
 SET implemented=true,
     description='نقاط زيارة صفحة شركة حددتها الإدارة من دليل الصفحات، وفق التكرار والسقف اليومي؛ لا تُحسب استدعاءات تحديث البيانات الخلفية.'
 WHERE code='PAGE_VISIT';

ALTER TABLE reward_task_settings
 ADD COLUMN daily_limit integer CHECK(daily_limit BETWEEN 1 AND 10000);

CREATE OR REPLACE FUNCTION guard_reward_task_activation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ready boolean;
BEGIN
 IF NEW.enabled THEN
  SELECT implemented INTO ready FROM reward_task_definitions WHERE code=NEW.code;
  IF NOT COALESCE(ready,false) THEN
    RAISE EXCEPTION 'Unimplemented reward task cannot be activated' USING ERRCODE='23514';
  END IF;
  IF NEW.code IN ('SALE_SAVED','PURCHASE_SAVED','SALE_LINES','PURCHASE_LINES','RECEIPT_PRINT','PAYMENT_PRINT')
    AND NEW.repeat_rule<>'per-document' THEN
    RAISE EXCEPTION 'Document rewards must use per-document repeat rule' USING ERRCODE='23514';
  END IF;
  IF NEW.code='PAGE_VISIT' AND (NEW.page_key IS NULL OR NEW.repeat_rule='per-document' OR NEW.points<=0) THEN
    RAISE EXCEPTION 'Page visit reward requires a target, positive points and time-based repeat rule' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;

ALTER TABLE employee_wallet_entries
 ADD COLUMN page_key varchar(100) REFERENCES page_registry(key);
ALTER TABLE employee_wallet_entries DROP CONSTRAINT wallet_entry_source_check;
ALTER TABLE employee_wallet_entries ADD CONSTRAINT wallet_entry_source_check CHECK (
  (kind='manual' AND points>0 AND reference_id IS NULL AND invoice_id IS NULL
    AND financial_document_id IS NULL AND page_key IS NULL AND task_code IS NULL AND task_revision IS NULL AND logical_line_count IS NULL)
  OR (kind='reversal' AND points<0 AND reference_id IS NOT NULL AND invoice_id IS NULL
    AND financial_document_id IS NULL AND page_key IS NULL AND task_code IS NULL AND task_revision IS NULL AND logical_line_count IS NULL)
  OR (kind='automatic' AND points>0 AND reference_id IS NULL AND invoice_id IS NOT NULL
    AND financial_document_id IS NULL AND page_key IS NULL AND task_code IN ('SALE_SAVED','PURCHASE_SAVED','SALE_LINES','PURCHASE_LINES')
    AND task_revision>0 AND logical_line_count BETWEEN 1 AND 100)
  OR (kind='automatic' AND points>0 AND reference_id IS NULL AND invoice_id IS NULL
    AND financial_document_id IS NOT NULL AND page_key IS NULL AND task_code IN ('RECEIPT_PRINT','PAYMENT_PRINT')
    AND task_revision>0 AND logical_line_count=1)
  OR (kind='automatic' AND points>0 AND reference_id IS NULL AND invoice_id IS NULL
    AND financial_document_id IS NULL AND page_key IS NOT NULL AND task_code='PAGE_VISIT'
    AND task_revision>0 AND logical_line_count=1)
);
CREATE INDEX wallet_page_visit_repeat
 ON employee_wallet_entries(company_id,employee_id,task_code,created_at DESC)
 WHERE kind='automatic' AND task_code='PAGE_VISIT';
