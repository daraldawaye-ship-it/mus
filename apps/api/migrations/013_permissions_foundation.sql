-- Foundation only. Existing employees.permissions and owner/general-manager
-- access checks remain authoritative until the reviewed authorization integration.
-- Grants, assignments and exceptions intentionally start empty.
CREATE TABLE permission_definitions (
  key varchar(140) PRIMARY KEY,
  page_key varchar(100) NOT NULL REFERENCES page_registry(key),
  action varchar(20) NOT NULL CHECK (action IN ('view', 'create', 'edit', 'print', 'post', 'reverse')),
  name varchar(200) NOT NULL CHECK (length(trim(name)) > 0),
  rule_role varchar(30) NOT NULL CHECK (rule_role IN ('company-member', 'company-general', 'permissions')),
  required_permissions text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by integer REFERENCES users(id),
  updated_by integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (page_key, action),
  CHECK (page_key LIKE 'company.%'),
  CHECK (key = page_key || ':' || action),
  CHECK (array_position(required_permissions, NULL) IS NULL),
  CHECK (required_permissions <@ ARRAY['pages.manage','company.edit','employees.view','audit.view','accounts.view','accounts.manage','currencies.view','currencies.manage','locations.view','locations.manage','finance.view','finance.manage','finance.post','items.view','items.manage','commerce.view','commerce.manage','inventory.view','inventory.manage','inventory.post']::text[]),
  CHECK ((rule_role = 'permissions' AND cardinality(required_permissions) > 0)
    OR (rule_role <> 'permissions' AND cardinality(required_permissions) = 0))
);
-- These are the implemented company page actions, copied exactly from pages.ts.
-- Definitions describe existing gates; inserting a definition grants no access.
INSERT INTO permission_definitions(key, page_key, action, name, rule_role, required_permissions) VALUES
('company.overview:view', 'company.overview', 'view', 'نظرة عامة — عرض', 'company-member', ARRAY[]::text[]),
('company.pages:view', 'company.pages', 'view', 'قائمة الصفحات — عرض', 'company-member', ARRAY[]::text[]),
('company.pages:edit', 'company.pages', 'edit', 'قائمة الصفحات — تعديل', 'permissions', ARRAY['pages.manage']::text[]),
('company.employees:view', 'company.employees', 'view', 'الموظفون — عرض', 'permissions', ARRAY['employees.view']::text[]),
('company.employees:create', 'company.employees', 'create', 'الموظفون — إضافة', 'company-general', ARRAY[]::text[]),
('company.employees:edit', 'company.employees', 'edit', 'الموظفون — تعديل', 'company-general', ARRAY[]::text[]),
('company.settings:view', 'company.settings', 'view', 'بيانات الشركة — عرض', 'permissions', ARRAY['company.edit']::text[]),
('company.settings:edit', 'company.settings', 'edit', 'بيانات الشركة — تعديل', 'permissions', ARRAY['company.edit']::text[]),
('company.accounts:view', 'company.accounts', 'view', 'دليل الحسابات — عرض', 'permissions', ARRAY['accounts.view']::text[]),
('company.accounts:create', 'company.accounts', 'create', 'دليل الحسابات — إضافة', 'permissions', ARRAY['accounts.manage']::text[]),
('company.accounts:edit', 'company.accounts', 'edit', 'دليل الحسابات — تعديل', 'permissions', ARRAY['accounts.manage']::text[]),
('company.currencies:view', 'company.currencies', 'view', 'العملات — عرض', 'permissions', ARRAY['currencies.view']::text[]),
('company.currencies:create', 'company.currencies', 'create', 'العملات — إضافة', 'permissions', ARRAY['currencies.manage']::text[]),
('company.currencies:edit', 'company.currencies', 'edit', 'العملات — تعديل', 'permissions', ARRAY['currencies.manage']::text[]),
('company.exchange-rates:view', 'company.exchange-rates', 'view', 'أسعار الصرف — عرض', 'permissions', ARRAY['currencies.view']::text[]),
('company.exchange-rates:create', 'company.exchange-rates', 'create', 'أسعار الصرف — إضافة', 'permissions', ARRAY['currencies.manage']::text[]),
('company.exchange-rates:edit', 'company.exchange-rates', 'edit', 'أسعار الصرف — تعديل', 'permissions', ARRAY['currencies.manage']::text[]),
('company.branches:view', 'company.branches', 'view', 'الفروع — عرض', 'permissions', ARRAY['locations.view']::text[]),
('company.branches:create', 'company.branches', 'create', 'الفروع — إضافة', 'permissions', ARRAY['locations.manage']::text[]),
('company.branches:edit', 'company.branches', 'edit', 'الفروع — تعديل', 'permissions', ARRAY['locations.manage']::text[]),
('company.locations:view', 'company.locations', 'view', 'المعارض والمخازن — عرض', 'permissions', ARRAY['locations.view']::text[]),
('company.locations:create', 'company.locations', 'create', 'المعارض والمخازن — إضافة', 'permissions', ARRAY['locations.manage']::text[]),
('company.locations:edit', 'company.locations', 'edit', 'المعارض والمخازن — تعديل', 'permissions', ARRAY['locations.manage']::text[]),
('company.items:view', 'company.items', 'view', 'الأصناف — عرض', 'permissions', ARRAY['items.view']::text[]),
('company.items:create', 'company.items', 'create', 'الأصناف — إضافة', 'permissions', ARRAY['items.manage']::text[]),
('company.items:edit', 'company.items', 'edit', 'الأصناف — تعديل', 'permissions', ARRAY['items.manage']::text[]),
('company.item-card:view', 'company.item-card', 'view', 'كرت الصنف — عرض', 'permissions', ARRAY['items.view']::text[]),
('company.item-card:edit', 'company.item-card', 'edit', 'كرت الصنف — تعديل', 'permissions', ARRAY['items.manage']::text[]),
('company.item-new:view', 'company.item-new', 'view', 'إضافة صنف — عرض', 'permissions', ARRAY['items.manage']::text[]),
('company.item-new:create', 'company.item-new', 'create', 'إضافة صنف — إضافة', 'permissions', ARRAY['items.manage']::text[]),
('company.item-agents:view', 'company.item-agents', 'view', 'وكلاء الأصناف — عرض', 'permissions', ARRAY['items.view']::text[]),
('company.item-agents:create', 'company.item-agents', 'create', 'وكلاء الأصناف — إضافة', 'permissions', ARRAY['items.manage']::text[]),
('company.item-agents:edit', 'company.item-agents', 'edit', 'وكلاء الأصناف — تعديل', 'permissions', ARRAY['items.manage']::text[]),
('company.stock-balances:view', 'company.stock-balances', 'view', 'أرصدة المخزون — عرض', 'permissions', ARRAY['inventory.view']::text[]),
('company.stock-movements:view', 'company.stock-movements', 'view', 'حركات المخزون — عرض', 'permissions', ARRAY['inventory.view']::text[]),
('company.stock-operations:view', 'company.stock-operations', 'view', 'المناقلات والجرد — عرض', 'permissions', ARRAY['inventory.view','inventory.post']::text[]),
('company.stock-operations:create', 'company.stock-operations', 'create', 'المناقلات والجرد — إضافة', 'permissions', ARRAY['inventory.post','finance.post']::text[]),
('company.inventory-settings:view', 'company.inventory-settings', 'view', 'إعداد المخزون — عرض', 'permissions', ARRAY['inventory.manage']::text[]),
('company.inventory-settings:edit', 'company.inventory-settings', 'edit', 'إعداد المخزون — تعديل', 'permissions', ARRAY['inventory.manage']::text[]),
('company.sales:view', 'company.sales', 'view', 'فواتير المبيعات — عرض', 'permissions', ARRAY['commerce.view']::text[]),
('company.sales:create', 'company.sales', 'create', 'فواتير المبيعات — إضافة', 'permissions', ARRAY['commerce.manage','finance.post']::text[]),
('company.purchases:view', 'company.purchases', 'view', 'فواتير المشتريات — عرض', 'permissions', ARRAY['commerce.view']::text[]),
('company.purchases:create', 'company.purchases', 'create', 'فواتير المشتريات — إضافة', 'permissions', ARRAY['commerce.manage','finance.post']::text[]),
('company.sale-new:view', 'company.sale-new', 'view', 'إضافة فاتورة مبيعات — عرض', 'permissions', ARRAY['commerce.manage','finance.post']::text[]),
('company.sale-new:create', 'company.sale-new', 'create', 'إضافة فاتورة مبيعات — إضافة', 'permissions', ARRAY['commerce.manage','finance.post']::text[]),
('company.purchase-new:view', 'company.purchase-new', 'view', 'إضافة فاتورة مشتريات — عرض', 'permissions', ARRAY['commerce.manage','finance.post']::text[]),
('company.purchase-new:create', 'company.purchase-new', 'create', 'إضافة فاتورة مشتريات — إضافة', 'permissions', ARRAY['commerce.manage','finance.post']::text[]),
('company.invoice:view', 'company.invoice', 'view', 'عرض الفاتورة — عرض', 'permissions', ARRAY['commerce.view']::text[]),
('company.invoice:print', 'company.invoice', 'print', 'عرض الفاتورة — طباعة', 'permissions', ARRAY['commerce.view']::text[]),
('company.financial-documents:view', 'company.financial-documents', 'view', 'العمليات المالية — عرض', 'permissions', ARRAY['finance.view']::text[]),
('company.financial-documents:create', 'company.financial-documents', 'create', 'العمليات المالية — إضافة', 'permissions', ARRAY['finance.manage']::text[]),
('company.financial-documents:edit', 'company.financial-documents', 'edit', 'العمليات المالية — تعديل', 'permissions', ARRAY['finance.manage']::text[]),
('company.financial-documents:post', 'company.financial-documents', 'post', 'العمليات المالية — ترحيل', 'permissions', ARRAY['finance.post']::text[]),
('company.financial-documents:reverse', 'company.financial-documents', 'reverse', 'العمليات المالية — عكس', 'permissions', ARRAY['finance.post']::text[]),
('company.journals:view', 'company.journals', 'view', 'قيود اليومية — عرض', 'permissions', ARRAY['finance.view']::text[]),
('company.journals:create', 'company.journals', 'create', 'قيود اليومية — إضافة', 'permissions', ARRAY['finance.manage']::text[]),
('company.journals:edit', 'company.journals', 'edit', 'قيود اليومية — تعديل', 'permissions', ARRAY['finance.manage']::text[]),
('company.journals:post', 'company.journals', 'post', 'قيود اليومية — ترحيل', 'permissions', ARRAY['finance.post']::text[]),
('company.journals:reverse', 'company.journals', 'reverse', 'قيود اليومية — عكس', 'permissions', ARRAY['finance.post']::text[]),
('company.receipts:view', 'company.receipts', 'view', 'سندات القبض — عرض', 'permissions', ARRAY['finance.view']::text[]),
('company.receipts:create', 'company.receipts', 'create', 'سندات القبض — إضافة', 'permissions', ARRAY['finance.manage']::text[]),
('company.receipts:edit', 'company.receipts', 'edit', 'سندات القبض — تعديل', 'permissions', ARRAY['finance.manage']::text[]),
('company.receipts:post', 'company.receipts', 'post', 'سندات القبض — ترحيل', 'permissions', ARRAY['finance.post']::text[]),
('company.receipts:reverse', 'company.receipts', 'reverse', 'سندات القبض — عكس', 'permissions', ARRAY['finance.post']::text[]),
('company.payments:view', 'company.payments', 'view', 'سندات الصرف — عرض', 'permissions', ARRAY['finance.view']::text[]),
('company.payments:create', 'company.payments', 'create', 'سندات الصرف — إضافة', 'permissions', ARRAY['finance.manage']::text[]),
('company.payments:edit', 'company.payments', 'edit', 'سندات الصرف — تعديل', 'permissions', ARRAY['finance.manage']::text[]),
('company.payments:post', 'company.payments', 'post', 'سندات الصرف — ترحيل', 'permissions', ARRAY['finance.post']::text[]),
('company.payments:reverse', 'company.payments', 'reverse', 'سندات الصرف — عكس', 'permissions', ARRAY['finance.post']::text[]),
('company.financial-new:view', 'company.financial-new', 'view', 'إضافة مستند مالي — عرض', 'permissions', ARRAY['finance.manage']::text[]),
('company.financial-new:create', 'company.financial-new', 'create', 'إضافة مستند مالي — إضافة', 'permissions', ARRAY['finance.manage']::text[]),
('company.financial-document:view', 'company.financial-document', 'view', 'عرض المستند المالي — عرض', 'permissions', ARRAY['finance.view']::text[]),
('company.financial-document:create', 'company.financial-document', 'create', 'عرض المستند المالي — إضافة', 'permissions', ARRAY['finance.manage']::text[]),
('company.financial-document:edit', 'company.financial-document', 'edit', 'عرض المستند المالي — تعديل', 'permissions', ARRAY['finance.manage']::text[]),
('company.financial-document:post', 'company.financial-document', 'post', 'عرض المستند المالي — ترحيل', 'permissions', ARRAY['finance.post']::text[]),
('company.financial-document:reverse', 'company.financial-document', 'reverse', 'عرض المستند المالي — عكس', 'permissions', ARRAY['finance.post']::text[]),
('company.financial-document:print', 'company.financial-document', 'print', 'عرض المستند المالي — طباعة', 'permissions', ARRAY['finance.view']::text[]),
('company.account-balances:view', 'company.account-balances', 'view', 'أرصدة الحسابات — عرض', 'permissions', ARRAY['finance.view']::text[]),
('company.account-ledger:view', 'company.account-ledger', 'view', 'كشف حساب — عرض', 'permissions', ARRAY['finance.view']::text[]),
('company.audit:view', 'company.audit', 'view', 'سجل الشركة — عرض', 'permissions', ARRAY['audit.view']::text[]);

CREATE TABLE company_roles (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id),
  key varchar(100) NOT NULL CHECK (key ~ '^[a-z][a-z0-9_-]{0,99}$'),
  name varchar(200) NOT NULL CHECK (length(trim(name)) > 0),
  description text NOT NULL DEFAULT '',
  is_system boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by integer REFERENCES users(id),
  updated_by integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, key),
  UNIQUE (company_id, id),
  CHECK (is_system = (key IN ('employee', 'administrative', 'accountant', 'sales', 'purchases')))
);

CREATE TABLE role_permission_rules (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id),
  role_id integer NOT NULL,
  permission_key varchar(140) NOT NULL REFERENCES permission_definitions(key),
  effect varchar(5) NOT NULL CHECK (effect IN ('allow', 'deny')),
  active boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by integer REFERENCES users(id),
  updated_by integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, role_id) REFERENCES company_roles(company_id, id),
  UNIQUE (company_id, role_id, permission_key)
);

CREATE TABLE employee_role_assignments (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id),
  employee_id integer NOT NULL,
  role_id integer NOT NULL,
  active boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by integer REFERENCES users(id),
  updated_by integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, employee_id) REFERENCES employees(company_id, id),
  FOREIGN KEY (company_id, role_id) REFERENCES company_roles(company_id, id),
  UNIQUE (company_id, employee_id, role_id)
);
CREATE INDEX employee_role_assignments_role ON employee_role_assignments(company_id, role_id);

CREATE TABLE employee_permission_rules (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id),
  employee_id integer NOT NULL,
  permission_key varchar(140) NOT NULL REFERENCES permission_definitions(key),
  effect varchar(5) NOT NULL CHECK (effect IN ('allow', 'deny')),
  active boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by integer REFERENCES users(id),
  updated_by integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, employee_id) REFERENCES employees(company_id, id),
  UNIQUE (company_id, employee_id, permission_key)
);

-- Stable references cannot be repointed to a different company, employee,
-- role or page action. Revisions are updated by the database on every edit.
-- Future write handlers must use revision predicates and audit_events before/after.
CREATE FUNCTION guard_permission_foundation_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  field_name text;
BEGIN
  FOREACH field_name IN ARRAY string_to_array(TG_ARGV[0], ',') LOOP
    IF (to_jsonb(NEW) -> field_name) IS DISTINCT FROM (to_jsonb(OLD) -> field_name) THEN
      RAISE EXCEPTION 'Permission foundation identity % cannot change', field_name;
    END IF;
  END LOOP;
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER permission_definitions_identity BEFORE UPDATE ON permission_definitions
FOR EACH ROW EXECUTE FUNCTION guard_permission_foundation_identity('key,page_key,action,rule_role,required_permissions,created_by,created_at');
CREATE TRIGGER company_roles_identity BEFORE UPDATE ON company_roles
FOR EACH ROW EXECUTE FUNCTION guard_permission_foundation_identity('id,company_id,key,is_system,created_by,created_at');
CREATE TRIGGER role_permission_rules_identity BEFORE UPDATE ON role_permission_rules
FOR EACH ROW EXECUTE FUNCTION guard_permission_foundation_identity('id,company_id,role_id,permission_key,created_by,created_at');
CREATE TRIGGER employee_role_assignments_identity BEFORE UPDATE ON employee_role_assignments
FOR EACH ROW EXECUTE FUNCTION guard_permission_foundation_identity('id,company_id,employee_id,role_id,created_by,created_at');
CREATE TRIGGER employee_permission_rules_identity BEFORE UPDATE ON employee_permission_rules
FOR EACH ROW EXECUTE FUNCTION guard_permission_foundation_identity('id,company_id,employee_id,permission_key,created_by,created_at');

CREATE FUNCTION guard_permission_system_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'permission_definitions' THEN
    RAISE EXCEPTION 'Implemented page action definitions cannot be deleted';
  END IF;
  IF OLD.is_system THEN
    RAISE EXCEPTION 'System company roles cannot be deleted';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER permission_definitions_protected BEFORE DELETE ON permission_definitions
FOR EACH ROW EXECUTE FUNCTION guard_permission_system_delete();
CREATE TRIGGER company_roles_protected BEFORE DELETE ON company_roles
FOR EACH ROW EXECUTE FUNCTION guard_permission_system_delete();

-- Named roles are a company-specific directory, never automatic permission
-- templates. Existing single-role employee records are not changed or expanded.
WITH seeded_roles AS (
  INSERT INTO company_roles(company_id, key, name, is_system, created_by, updated_by)
  SELECT c.id, r.key, r.name, true, c.created_by, c.created_by
  FROM companies c CROSS JOIN (VALUES
    ('employee', 'موظف'),
    ('administrative', 'إداري'),
    ('accountant', 'محاسب'),
    ('sales', 'مبيعات'),
    ('purchases', 'مشتريات')
  ) AS r(key, name)
  RETURNING *
)
INSERT INTO audit_events(actor_id, actor_name, scope, company_id, action, target_type, target_id, before_value, after_value)
SELECT NULL, 'النظام', 'company', company_id, 'configuration.roles.seed', 'company', company_id,
  NULL, jsonb_agg(to_jsonb(seeded_roles) ORDER BY key)
FROM seeded_roles
GROUP BY company_id;

CREATE FUNCTION initialize_company_roles() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  WITH seeded_roles AS (
    INSERT INTO company_roles(company_id, key, name, is_system, created_by, updated_by)
    SELECT NEW.id, r.key, r.name, true, NEW.created_by, NEW.created_by
    FROM (VALUES
    ('employee', 'موظف'),
    ('administrative', 'إداري'),
    ('accountant', 'محاسب'),
    ('sales', 'مبيعات'),
    ('purchases', 'مشتريات')
    ) AS r(key, name)
    RETURNING *
  )
  INSERT INTO audit_events(actor_id, actor_name, scope, company_id, action, target_type, target_id, before_value, after_value)
  SELECT NULL, 'النظام', 'company', company_id, 'configuration.roles.seed', 'company', company_id,
    NULL, jsonb_agg(to_jsonb(seeded_roles) ORDER BY key)
  FROM seeded_roles
  GROUP BY company_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER companies_initialize_roles AFTER INSERT ON companies
FOR EACH ROW EXECUTE FUNCTION initialize_company_roles();
