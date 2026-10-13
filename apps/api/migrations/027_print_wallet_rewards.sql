-- Phase 3a: opt-in print-request rewards for posted receipt/payment vouchers.
-- A print request is an observable user action, not proof that paper was printed.
UPDATE reward_task_definitions
SET implemented=true,
    description='نقاط عند طلب طباعة سند قبض مرحّل؛ مرة لكل سند ولكل موظف مؤهل. فتح نافذة الطباعة لا يثبت خروج الورقة.'
WHERE code='RECEIPT_PRINT';
UPDATE reward_task_definitions
SET implemented=true,
    description='نقاط عند طلب طباعة سند صرف مرحّل؛ مرة لكل سند ولكل موظف مؤهل. فتح نافذة الطباعة لا يثبت خروج الورقة.'
WHERE code='PAYMENT_PRINT';

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
 END IF;
 RETURN NEW;
END $$;

ALTER TABLE employee_wallet_entries
  ADD COLUMN financial_document_id integer,
  ADD CONSTRAINT wallet_print_document_reference
    FOREIGN KEY(company_id,financial_document_id) REFERENCES financial_documents(company_id,id);
ALTER TABLE employee_wallet_entries DROP CONSTRAINT wallet_entry_source_check;
ALTER TABLE employee_wallet_entries ADD CONSTRAINT wallet_entry_source_check CHECK (
  (kind='manual' AND points>0 AND reference_id IS NULL AND invoice_id IS NULL
    AND financial_document_id IS NULL AND task_code IS NULL AND task_revision IS NULL AND logical_line_count IS NULL)
  OR (kind='reversal' AND points<0 AND reference_id IS NOT NULL AND invoice_id IS NULL
    AND financial_document_id IS NULL AND task_code IS NULL AND task_revision IS NULL AND logical_line_count IS NULL)
  OR (kind='automatic' AND points>0 AND reference_id IS NULL AND invoice_id IS NOT NULL
    AND financial_document_id IS NULL AND task_code IN ('SALE_SAVED','PURCHASE_SAVED','SALE_LINES','PURCHASE_LINES')
    AND task_revision>0 AND logical_line_count BETWEEN 1 AND 100)
  OR (kind='automatic' AND points>0 AND reference_id IS NULL AND invoice_id IS NULL
    AND financial_document_id IS NOT NULL AND task_code IN ('RECEIPT_PRINT','PAYMENT_PRINT')
    AND task_revision>0 AND logical_line_count=1)
);
CREATE UNIQUE INDEX wallet_auto_once_per_print_request
 ON employee_wallet_entries(company_id,employee_id,task_code,financial_document_id)
 WHERE kind='automatic' AND financial_document_id IS NOT NULL;
