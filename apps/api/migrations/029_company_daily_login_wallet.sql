-- Phase 3c: per-company opt-in DAILY_LOGIN on explicit company activation.
-- The public/global sign-in never credits other company wallets.
UPDATE reward_task_definitions
SET implemented=true,
    description='مكافأة أول دخول فعلي للموظف إلى شركته في يوم عدن؛ لا توزّع على شركات أخرى ولا تتكرر خلال اليوم.'
WHERE code='DAILY_LOGIN';

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
  IF NEW.code='DAILY_LOGIN' AND NEW.repeat_rule<>'daily' THEN
   RAISE EXCEPTION 'Company login reward must be daily' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;

ALTER TABLE employee_wallet_entries
 ADD COLUMN reward_day date;
ALTER TABLE employee_wallet_entries DROP CONSTRAINT wallet_entry_source_check;
ALTER TABLE employee_wallet_entries ADD CONSTRAINT wallet_entry_source_check CHECK (
  (kind='manual' AND points>0 AND reference_id IS NULL AND invoice_id IS NULL
    AND financial_document_id IS NULL AND page_key IS NULL AND reward_day IS NULL AND task_code IS NULL AND task_revision IS NULL AND logical_line_count IS NULL)
  OR (kind='reversal' AND points<0 AND reference_id IS NOT NULL AND invoice_id IS NULL
    AND financial_document_id IS NULL AND page_key IS NULL AND reward_day IS NULL AND task_code IS NULL AND task_revision IS NULL AND logical_line_count IS NULL)
  OR (kind='automatic' AND points>0 AND reference_id IS NULL AND invoice_id IS NOT NULL
    AND financial_document_id IS NULL AND page_key IS NULL AND reward_day IS NULL AND task_code IN ('SALE_SAVED','PURCHASE_SAVED','SALE_LINES','PURCHASE_LINES')
    AND task_revision>0 AND logical_line_count BETWEEN 1 AND 100)
  OR (kind='automatic' AND points>0 AND reference_id IS NULL AND invoice_id IS NULL
    AND financial_document_id IS NOT NULL AND page_key IS NULL AND reward_day IS NULL AND task_code IN ('RECEIPT_PRINT','PAYMENT_PRINT')
    AND task_revision>0 AND logical_line_count=1)
  OR (kind='automatic' AND points>0 AND reference_id IS NULL AND invoice_id IS NULL
    AND financial_document_id IS NULL AND page_key IS NOT NULL AND reward_day IS NULL AND task_code='PAGE_VISIT'
    AND task_revision>0 AND logical_line_count=1)
  OR (kind='automatic' AND points>0 AND reference_id IS NULL AND invoice_id IS NULL
    AND financial_document_id IS NULL AND page_key IS NULL AND reward_day IS NOT NULL AND task_code='DAILY_LOGIN'
    AND task_revision>0 AND logical_line_count=1)
);
CREATE UNIQUE INDEX wallet_company_login_once_per_day
 ON employee_wallet_entries(company_id,employee_id,reward_day)
 WHERE kind='automatic' AND task_code='DAILY_LOGIN';
