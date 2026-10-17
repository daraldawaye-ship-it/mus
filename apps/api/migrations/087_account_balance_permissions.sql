-- The new balance actions are opt-in. Do not rewrite employee permissions,
-- role templates or existing permission rules when registering their catalog.
ALTER TABLE employees DROP CONSTRAINT employees_permissions_check;
ALTER TABLE employees ADD CONSTRAINT employees_permissions_check CHECK (
  permissions <@ ARRAY[
    'pages.manage','company.edit','employees.view','audit.view',
    'accounts.view','accounts.manage','accounts.balance-followup','accounts.balance-approve',
    'currencies.view','currencies.manage','locations.view','locations.manage',
    'finance.view','finance.manage','finance.post','items.view','items.manage',
    'commerce.view','commerce.manage','inventory.view','inventory.manage','inventory.post'
  ]::text[]
);

-- The original catalog used unnamed CHECK constraints. Locate only its
-- required-permissions allowlist; retain the shape and null-element guards.
DO $$
DECLARE allowlist_constraint text;
BEGIN
  SELECT conname INTO STRICT allowlist_constraint FROM pg_constraint
  WHERE conrelid='permission_definitions'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%required_permissions <@%';
  EXECUTE format('ALTER TABLE permission_definitions DROP CONSTRAINT %I',allowlist_constraint);
END $$;
ALTER TABLE permission_definitions ADD CONSTRAINT permission_definitions_known_permissions CHECK (
  required_permissions <@ ARRAY[
    'pages.manage','company.edit','employees.view','audit.view',
    'accounts.view','accounts.manage','accounts.balance-followup','accounts.balance-approve',
    'currencies.view','currencies.manage','locations.view','locations.manage',
    'finance.view','finance.manage','finance.post','items.view','items.manage',
    'commerce.view','commerce.manage','inventory.view','inventory.manage','inventory.post'
  ]::text[]
);

INSERT INTO page_registry(key) VALUES('company.account-statistics') ON CONFLICT DO NOTHING;
INSERT INTO permission_definitions(key,page_key,action,name,rule_role,required_permissions)
VALUES
  ('company.account-statistics:view','company.account-statistics','view',
    'إحصاءات الحسابات — عرض','permissions',ARRAY['accounts.view','finance.view']::text[]),
  ('company.account-statistics:create','company.account-statistics','create',
    'إحصاءات الحسابات — تسجيل متابعة الرصيد','permissions',ARRAY['accounts.balance-followup']::text[]),
  ('company.account-statistics:post','company.account-statistics','post',
    'إحصاءات الحسابات — اعتماد الرصيد','permissions',ARRAY['accounts.balance-approve']::text[])
ON CONFLICT(key) DO NOTHING;
