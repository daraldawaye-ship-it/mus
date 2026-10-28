-- Customer numbers are company-scoped identifiers; never accounting account numbers.
CREATE TABLE sale_customers (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 company_id integer NOT NULL REFERENCES companies(id),
 customer_number varchar(30) NOT NULL CHECK (customer_number ~ '^[0-9]{1,30}$'),
 name varchar(240) NOT NULL CHECK (length(btrim(name)) > 0),
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 created_by integer NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id),
 UNIQUE(company_id,customer_number)
);
CREATE INDEX sale_customers_name_search ON sale_customers(company_id,name,id);
ALTER TABLE invoices
 ADD COLUMN sale_customer_id integer,
 ADD COLUMN sale_customer_number varchar(30),
 ADD COLUMN sale_customer_name varchar(240),
 ADD CONSTRAINT invoices_sale_customer_company_fk
   FOREIGN KEY(company_id,sale_customer_id) REFERENCES sale_customers(company_id,id);
CREATE INDEX invoices_sale_customer ON invoices(company_id,sale_customer_id)
 WHERE sale_customer_id IS NOT NULL;

INSERT INTO page_registry(key) VALUES ('company.sale-customers') ON CONFLICT DO NOTHING;
INSERT INTO permission_definitions(key,page_key,action,name,rule_role,required_permissions)
 VALUES
 ('company.sale-customers:view','company.sale-customers','view','كرت العملاء — عرض','permissions',ARRAY['commerce.view']::text[]),
 ('company.sale-customers:create','company.sale-customers','create','كرت العملاء — إضافة','permissions',ARRAY['commerce.manage']::text[]),
 ('company.sale-customers:edit','company.sale-customers','edit','كرت العملاء — تعديل','permissions',ARRAY['commerce.manage']::text[])
ON CONFLICT(key) DO NOTHING;
