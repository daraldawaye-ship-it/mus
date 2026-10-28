-- Customer and doctor creation rewards use the existing company task cards and wallet.
-- Each reward is committed atomically with the invoice or doctor card.
INSERT INTO reward_task_definitions
  (code,name,description,implemented,default_points,default_repeat_rule)
VALUES
 ('CUSTOMER_NEW','إضافة عميل جديد',
  '10 نقاط افتراضيًا عند حفظ فاتورة مبيعات تؤدي إلى إنشاء رقم عميل جديد. مرة لكل فاتورة وللموظف الذي حفظها.',true,10,'per-document'),
 ('CUSTOMER_EXISTING','إضافة عميل سابق',
  '5 نقاط افتراضيًا عند اختيار رقم عميل مسجل سابقًا في فاتورة مبيعات جديدة. مرة لكل فاتورة.',true,5,'per-document'),
 ('DOCTOR_NEW','إضافة طبيب أو جهة',
  '5 نقاط افتراضيًا عند إنشاء كرت طبيب أو ممرض جديد، أو استكمال تصنيف كرت جديد غير مصنف إلى طبيب أو ممرض. لا تُحتسب للجهة وحدها ولا عند تعديل الكرت لاحقًا.',true,5,'per-document')
ON CONFLICT(code) DO NOTHING;

-- New rewards start enabled, while each company's existing chosen settings are preserved.
INSERT INTO reward_task_settings
  (company_id,code,points,repeat_rule,enabled,page_key,updated_by)
SELECT c.id,d.code,d.default_points,d.default_repeat_rule,true,NULL,c.created_by
FROM companies c JOIN reward_task_definitions d
  ON d.code IN ('CUSTOMER_NEW','CUSTOMER_EXISTING','DOCTOR_NEW')
ON CONFLICT(company_id,code) DO NOTHING;

-- Seed newly created companies as well, without requiring manual activation.
CREATE FUNCTION initialize_registration_rewards() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO reward_task_settings
   (company_id,code,points,repeat_rule,enabled,page_key,updated_by)
 SELECT NEW.id,d.code,d.default_points,d.default_repeat_rule,true,NULL,NEW.created_by
 FROM reward_task_definitions d
 WHERE d.code IN ('CUSTOMER_NEW','CUSTOMER_EXISTING','DOCTOR_NEW')
 ON CONFLICT(company_id,code) DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER company_registration_rewards AFTER INSERT ON companies
 FOR EACH ROW EXECUTE FUNCTION initialize_registration_rewards();

-- A doctor reward has an immutable source card, like invoice rewards have an invoice.
ALTER TABLE employee_wallet_entries ADD COLUMN doctor_id integer,
 ADD CONSTRAINT wallet_doctor_reward_reference
 FOREIGN KEY (company_id,doctor_id) REFERENCES doctors(company_id,id);

DO $$
DECLARE old_guard text;
BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO old_guard FROM pg_constraint
 WHERE conrelid='employee_wallet_entries'::regclass
   AND conname='wallet_entry_source_check';
 IF old_guard IS NULL THEN RAISE EXCEPTION 'Wallet source check is missing'; END IF;
 ALTER TABLE employee_wallet_entries DROP CONSTRAINT wallet_entry_source_check;
 EXECUTE format($sql$
  ALTER TABLE employee_wallet_entries ADD CONSTRAINT wallet_entry_source_check CHECK (
   (%s) OR
   (kind='automatic' AND points>0 AND money=0 AND reference_id IS NULL
    AND invoice_id IS NOT NULL AND doctor_id IS NULL
    AND financial_document_id IS NULL AND conversion_id IS NULL
    AND attendance_entry_id IS NULL AND clearance_earning_id IS NULL
    AND page_key IS NULL AND task_code IN ('CUSTOMER_NEW','CUSTOMER_EXISTING')
    AND task_revision>0 AND logical_line_count=1)
   OR
   (kind='automatic' AND points>0 AND money=0 AND reference_id IS NULL
    AND invoice_id IS NULL AND doctor_id IS NOT NULL
    AND financial_document_id IS NULL AND conversion_id IS NULL
    AND attendance_entry_id IS NULL AND clearance_earning_id IS NULL
    AND page_key IS NULL AND task_code='DOCTOR_NEW'
    AND task_revision>0 AND logical_line_count=1)
  )
 $sql$,old_guard);
END $$;
CREATE UNIQUE INDEX wallet_doctor_reward_once
 ON employee_wallet_entries(company_id,doctor_id,task_code)
 WHERE kind='automatic' AND doctor_id IS NOT NULL;
CREATE UNIQUE INDEX wallet_customer_reward_once
 ON employee_wallet_entries(company_id,invoice_id,task_code)
 WHERE kind='automatic' AND task_code IN ('CUSTOMER_NEW','CUSTOMER_EXISTING');
