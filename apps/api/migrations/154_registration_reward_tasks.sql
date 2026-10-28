-- Sales customer and doctor/referral rewards use the existing task cards and employee wallet.
-- Credit only newly posted invoices, with immutable one-invoice/one-task protection.
INSERT INTO reward_task_definitions
  (code,name,description,implemented,default_points,default_repeat_rule)
VALUES
 ('CUSTOMER_NEW','إضافة عميل جديد',
  '10 نقاط افتراضيًا عند حفظ فاتورة تؤدي إلى إنشاء كرت عميل جديد. مرة واحدة للفاتورة.',true,10,'per-document'),
 ('CUSTOMER_EXISTING','إضافة عميل سابق',
  '5 نقاط افتراضيًا عند حفظ فاتورة مرتبطة برقم عميل كان مسجلًا بالفعل.',true,5,'per-document'),
 ('DOCTOR_REFERRED','إضافة طبيب أو جهة',
  '5 نقاط افتراضيًا عند حفظ فاتورة باختيار طبيب أو ممرض مسجل، أو إنشاء اسم جديد بكرت غير مصنف. لا تشترط تصنيف الاسم الجديد، ولا تُحتسب عند تكرار اسم موجود غير مصنف أو جهة من نوع جهة.',true,5,'per-document')
ON CONFLICT(code) DO NOTHING;

-- Enable the three rewards with defaults for all current companies;
-- edits and disabling in existing company reward cards are preserved.
INSERT INTO reward_task_settings
  (company_id,code,points,repeat_rule,enabled,page_key,updated_by)
SELECT c.id,d.code,d.default_points,d.default_repeat_rule,true,NULL,c.created_by
FROM companies c JOIN reward_task_definitions d
  ON d.code IN ('CUSTOMER_NEW','CUSTOMER_EXISTING','DOCTOR_REFERRED')
ON CONFLICT(company_id,code) DO NOTHING;

-- Give new companies the same editable reward cards.
CREATE FUNCTION initialize_registration_rewards() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO reward_task_settings
   (company_id,code,points,repeat_rule,enabled,page_key,updated_by)
 SELECT NEW.id,d.code,d.default_points,d.default_repeat_rule,true,NULL,NEW.created_by
 FROM reward_task_definitions d
 WHERE d.code IN ('CUSTOMER_NEW','CUSTOMER_EXISTING','DOCTOR_REFERRED')
 ON CONFLICT(company_id,code) DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER company_registration_rewards AFTER INSERT ON companies
 FOR EACH ROW EXECUTE FUNCTION initialize_registration_rewards();

-- Old wallet source rules are immutable. Extend them only for the three
-- new positive automatic, invoice-attributed reward event codes.
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
    AND invoice_id IS NOT NULL AND financial_document_id IS NULL
    AND conversion_id IS NULL AND attendance_entry_id IS NULL
    AND clearance_earning_id IS NULL AND page_key IS NULL
    AND task_code IN ('CUSTOMER_NEW','CUSTOMER_EXISTING','DOCTOR_REFERRED')
    AND task_revision>0 AND logical_line_count=1)
  )
 $sql$,old_guard);
END $$;

-- The existing wallet_auto_once_per_invoice unique index enforces
-- (company, employee, invoice, task code) exactly once, including these events.
