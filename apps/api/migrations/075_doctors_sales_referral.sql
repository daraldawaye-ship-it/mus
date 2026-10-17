-- Company-scoped doctor, nurse and institution directory.
CREATE TABLE doctors (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id),
  name varchar(240) NOT NULL CHECK (length(btrim(name)) > 0),
  kind varchar(12) NOT NULL CHECK (kind IN ('doctor','nurse','entity')),
  department varchar(240) NOT NULL DEFAULT '',
  phone varchar(60) NOT NULL DEFAULT '',
  search_keys varchar(500) NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  active boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id,id)
);
CREATE INDEX doctors_search ON doctors(company_id,active,name,id);
CREATE INDEX doctors_departments ON doctors(company_id,department) WHERE department <> '';
ALTER TABLE invoices ADD COLUMN doctor_id integer,
 ADD COLUMN doctor_name varchar(240);
ALTER TABLE invoices ADD CONSTRAINT invoices_doctor_company_fk
 FOREIGN KEY (company_id,doctor_id) REFERENCES doctors(company_id,id);
CREATE INDEX invoices_doctor_by_company ON invoices(company_id,doctor_id) WHERE doctor_id IS NOT NULL;

INSERT INTO page_registry(key) VALUES ('company.doctors') ON CONFLICT DO NOTHING;
INSERT INTO permission_definitions(key,page_key,action,name,rule_role,required_permissions)
VALUES
 ('company.doctors:view','company.doctors','view','كرت الأطباء والجهات — عرض','permissions',ARRAY['commerce.view']::text[]),
 ('company.doctors:create','company.doctors','create','كرت الأطباء والجهات — إضافة','permissions',ARRAY['commerce.manage']::text[]),
 ('company.doctors:edit','company.doctors','edit','كرت الأطباء والجهات — تعديل','permissions',ARRAY['commerce.manage']::text[])
ON CONFLICT(key) DO NOTHING;
