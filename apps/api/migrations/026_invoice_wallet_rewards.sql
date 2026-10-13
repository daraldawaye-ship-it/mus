-- Phase 2: opt-in automatic rewards, committed with the posted invoice.
-- Existing settings stay disabled: historical invoices are never retroactively rewarded.
ALTER TABLE reward_task_definitions DROP CONSTRAINT reward_task_definitions_implemented_check;
ALTER TABLE reward_task_settings DROP CONSTRAINT reward_task_settings_enabled_check;

UPDATE reward_task_definitions SET implemented=true,
 description='نقاط لكل فاتورة جديدة بعد الترحيل؛ مستقلة عن مكافأة سطورها. إعادة فتح الفاتورة أو إعادة الطلب لا تمنح مكافأة ثانية.'
 WHERE code IN ('SALE_SAVED','PURCHASE_SAVED');
UPDATE reward_task_definitions SET implemented=true,
 description='نقاط لكل سطر منطقي في فاتورة جديدة بعد ترحيلها، بما فيها المردودات. تكرار الصنف والوحدة والسعر ودفعة الصلاحية يُحسب مرة واحدة؛ يمكن جمعها مع مكافأة الفاتورة.'
 WHERE code IN ('SALE_LINES','PURCHASE_LINES');

-- Prevent activation of unfinished tasks and unsupported repeat rules at DB level.
CREATE FUNCTION guard_reward_task_activation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ready boolean;
BEGIN
 IF NEW.enabled THEN
  SELECT implemented INTO ready FROM reward_task_definitions WHERE code=NEW.code;
  IF NOT COALESCE(ready,false) THEN
   RAISE EXCEPTION 'Unimplemented reward task cannot be activated' USING ERRCODE='23514';
  END IF;
  IF NEW.code IN ('SALE_SAVED','PURCHASE_SAVED','SALE_LINES','PURCHASE_LINES')
     AND NEW.repeat_rule<>'per-document' THEN
   RAISE EXCEPTION 'Invoice rewards must use per-document repeat rule' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reward_task_activation BEFORE INSERT OR UPDATE ON reward_task_settings
 FOR EACH ROW EXECUTE FUNCTION guard_reward_task_activation();

ALTER TABLE employee_wallet_entries DROP CONSTRAINT employee_wallet_entries_kind_check;
ALTER TABLE employee_wallet_entries DROP CONSTRAINT employee_wallet_entries_check;
ALTER TABLE employee_wallet_entries
 ADD COLUMN invoice_id integer,
 ADD COLUMN task_code varchar(100) REFERENCES reward_task_definitions(code),
 ADD COLUMN task_revision integer,
 ADD COLUMN logical_line_count integer,
 ADD FOREIGN KEY(company_id,invoice_id) REFERENCES invoices(company_id,id),
 ADD CONSTRAINT wallet_entry_source_check CHECK (
  (kind='manual' AND points>0 AND reference_id IS NULL AND invoice_id IS NULL AND task_code IS NULL AND task_revision IS NULL AND logical_line_count IS NULL)
  OR (kind='automatic' AND points>0 AND reference_id IS NULL AND invoice_id IS NOT NULL AND task_code IS NOT NULL AND task_revision>0 AND logical_line_count BETWEEN 1 AND 100)
  OR (kind='reversal' AND points<0 AND reference_id IS NOT NULL AND invoice_id IS NULL AND task_code IS NULL AND task_revision IS NULL AND logical_line_count IS NULL)
 ),
 ADD CONSTRAINT wallet_entry_kind_check CHECK(kind IN('manual','automatic','reversal'));
CREATE UNIQUE INDEX wallet_auto_once_per_invoice ON employee_wallet_entries(company_id,employee_id,task_code,invoice_id)
 WHERE kind='automatic';
CREATE INDEX wallet_auto_invoice_lookup ON employee_wallet_entries(company_id,invoice_id) WHERE kind='automatic';

CREATE OR REPLACE FUNCTION protect_wallet_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original employee_wallet_entries;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Wallet ledger is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.kind='reversal' THEN
  SELECT * INTO original FROM employee_wallet_entries WHERE company_id=NEW.company_id AND id=NEW.reference_id;
  IF NOT FOUND OR original.kind NOT IN ('manual','automatic') OR NEW.employee_id<>original.employee_id
     OR NEW.points<>-original.points OR NEW.money<>-original.money THEN
   RAISE EXCEPTION 'Reversal must exactly invert the original reward in the same wallet' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
