-- Invoice rewards are enabled explicitly by each company's task cards.
-- Historical invoices are never backfilled, and financial balances remain zero-only.
ALTER TABLE reward_task_definitions DROP CONSTRAINT reward_task_definitions_check;
ALTER TABLE reward_task_definitions ADD CONSTRAINT reward_task_implemented_scope
  CHECK (NOT implemented OR code IN ('SALE_SAVED','PURCHASE_SAVED','SALE_LINES','PURCHASE_LINES'));
UPDATE reward_task_definitions
SET implemented=true,
    description=CASE code
      WHEN 'SALE_SAVED' THEN 'نقاط عند ترحيل فاتورة مبيعات أو مردود جديد بنجاح؛ مستقلة عن مكافأة السطور.'
      WHEN 'PURCHASE_SAVED' THEN 'نقاط عند ترحيل فاتورة مشتريات أو مردود جديد بنجاح؛ مستقلة عن مكافأة السطور.'
      WHEN 'SALE_LINES' THEN 'نقاط لكل سطر منطقي مميز في فاتورة المبيعات أو مردودها؛ تكرار الصنف والوحدة والسعر والصلاحية لا يضاعف المكافأة.'
      WHEN 'PURCHASE_LINES' THEN 'نقاط لكل سطر منطقي مميز في فاتورة المشتريات أو مردودها؛ حدد القيمة قبل التفعيل.'
    END
WHERE code IN ('SALE_SAVED','PURCHASE_SAVED','SALE_LINES','PURCHASE_LINES');

ALTER TABLE reward_task_settings DROP CONSTRAINT reward_task_settings_enabled_check;
ALTER TABLE reward_task_settings ADD CONSTRAINT reward_task_enabled_scope
  CHECK (NOT enabled OR code IN ('SALE_SAVED','PURCHASE_SAVED','SALE_LINES','PURCHASE_LINES'));

ALTER TABLE employee_wallet_entries DROP CONSTRAINT employee_wallet_entries_kind_check;
ALTER TABLE employee_wallet_entries DROP CONSTRAINT employee_wallet_entries_check;
ALTER TABLE employee_wallet_entries
  ADD CONSTRAINT employee_wallet_entry_kind CHECK (kind IN ('manual','reversal','automatic')),
  ADD COLUMN task_code varchar(100) REFERENCES reward_task_definitions(code),
  ADD COLUMN invoice_id integer,
  ADD COLUMN rewarded_units integer,
  ADD CONSTRAINT wallet_invoice_reference
    FOREIGN KEY (company_id,invoice_id) REFERENCES invoices(company_id,id),
  ADD CONSTRAINT employee_wallet_entry_source CHECK (
    (kind='manual' AND points>0 AND reference_id IS NULL AND task_code IS NULL AND invoice_id IS NULL AND rewarded_units IS NULL)
    OR (kind='reversal' AND points<0 AND reference_id IS NOT NULL AND task_code IS NULL AND invoice_id IS NULL AND rewarded_units IS NULL)
    OR (kind='automatic' AND points>0 AND reference_id IS NULL AND task_code IN
      ('SALE_SAVED','PURCHASE_SAVED','SALE_LINES','PURCHASE_LINES') AND invoice_id IS NOT NULL AND rewarded_units>0)
  );
-- A posted invoice can grant a task at most once per eligible employee,
-- regardless of retries, concurrent requests or changes to card settings.
CREATE UNIQUE INDEX employee_wallet_invoice_once
  ON employee_wallet_entries(company_id,employee_id,invoice_id,task_code)
  WHERE kind='automatic';
CREATE INDEX employee_wallet_invoice_history
  ON employee_wallet_entries(company_id,invoice_id,id)
  WHERE kind='automatic';
