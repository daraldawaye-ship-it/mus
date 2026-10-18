-- Separate, opt-in authorization for the employee's own cashbox ledger.
-- Neither assigning a cashbox nor finance.view grants this page.
ALTER TABLE employees DROP CONSTRAINT employees_permissions_check;
ALTER TABLE employees ADD CONSTRAINT employees_permissions_check
  CHECK (permissions <@ ARRAY[
    'pages.manage','company.edit','employees.view','audit.view',
    'accounts.view','accounts.manage','currencies.view','currencies.manage',
    'locations.view','locations.manage','finance.view','finance.own-cashbox.view',
    'finance.manage','finance.post','items.view','items.manage',
    'commerce.view','commerce.manage','inventory.view','inventory.manage','inventory.post'
  ]::text[]);
ALTER TABLE permission_definitions DROP CONSTRAINT permission_definitions_required_permissions_check;
ALTER TABLE permission_definitions ADD CONSTRAINT permission_definitions_required_permissions_check
  CHECK (required_permissions <@ ARRAY[
    'pages.manage','company.edit','employees.view','audit.view',
    'accounts.view','accounts.manage','currencies.view','currencies.manage',
    'locations.view','locations.manage','finance.view','finance.own-cashbox.view',
    'finance.manage','finance.post','items.view','items.manage',
    'commerce.view','commerce.manage','inventory.view','inventory.manage','inventory.post'
  ]::text[]);
INSERT INTO page_registry(key) VALUES ('company.my-cashbox-ledger');
INSERT INTO permission_definitions(
  key,page_key,action,name,rule_role,required_permissions
) VALUES (
  'company.my-cashbox-ledger:view','company.my-cashbox-ledger','view',
  'كشف حساب صندوقي — عرض','permissions',ARRAY['finance.own-cashbox.view']::text[]
);
