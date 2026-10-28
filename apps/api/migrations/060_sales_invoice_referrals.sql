-- Auto-register named doctors and referral entities from posted sales invoices.
CREATE TABLE invoice_referrals (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id),
  kind text NOT NULL CHECK (kind IN ('doctor','entity')),
  name varchar(160) NOT NULL CHECK (length(btrim(name)) > 0),
  category varchar(100),
  phone varchar(50),
  details varchar(2000) NOT NULL DEFAULT '',
  archived boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id,id)
);
-- One card per type/name/company, including archived cards.
CREATE UNIQUE INDEX invoice_referrals_identity ON invoice_referrals(company_id,kind,lower(name));
CREATE INDEX invoice_referrals_review ON invoice_referrals(company_id,archived,kind,id) WHERE category IS NULL;

ALTER TABLE invoices
  ADD COLUMN doctor_referral_id integer,
  ADD COLUMN entity_referral_id integer,
  ADD COLUMN doctor_name varchar(160) NOT NULL DEFAULT '',
  ADD COLUMN entity_name varchar(160) NOT NULL DEFAULT '',
  ADD CONSTRAINT invoices_doctor_referral_fk FOREIGN KEY(company_id,doctor_referral_id) REFERENCES invoice_referrals(company_id,id),
  ADD CONSTRAINT invoices_entity_referral_fk FOREIGN KEY(company_id,entity_referral_id) REFERENCES invoice_referrals(company_id,id);

INSERT INTO notification_templates(code,name,category,scope,description,implemented,can_disable,default_importance,default_notify_managers)
VALUES ('SALES_REFERRAL_NEEDS_REVIEW','طبيب أو جهة جديد يحتاج استكمال','مبيعات','company',
'إنشاء كرت طبيب أو جهة جديد تلقائيًا من فاتورة مبيعات دون فئة؛ يمكن تصنيفه أو أرشفته.',true,true,'medium',true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO page_registry(key) VALUES ('company.sales-referrals') ON CONFLICT DO NOTHING;
INSERT INTO permission_definitions(key,page_key,action,name,rule_role,required_permissions)
VALUES
 ('company.sales-referrals:view','company.sales-referrals','view','كروت الأطباء والجهات — عرض','permissions',ARRAY['commerce.view']),
 ('company.sales-referrals:edit','company.sales-referrals','edit','كروت الأطباء والجهات — تعديل','permissions',ARRAY['commerce.manage'])
ON CONFLICT (key) DO NOTHING;
