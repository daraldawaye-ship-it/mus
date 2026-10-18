-- Opt-in authorization: having a sales cashbox does not grant access.
ALTER TABLE employees DROP CONSTRAINT employees_permissions_check;
ALTER TABLE employees ADD CONSTRAINT employees_permissions_check
  CHECK (permissions <@ ARRAY['pages.manage','company.edit','employees.view','audit.view','accounts.view','accounts.manage','accounts.balance-followup','accounts.balance-approve','currencies.view','currencies.manage','locations.view','locations.manage','finance.view','finance.own-cashbox.view','finance.manage','finance.post','items.view','items.manage','commerce.view','commerce.manage','inventory.view','inventory.manage','inventory.post']::text[]);

-- Preserve separate null-element and permission-shape constraints.
DO $$
DECLARE prior_allowlist text;
BEGIN
  SELECT conname INTO STRICT prior_allowlist FROM pg_constraint
  WHERE conrelid='permission_definitions'::regclass
    AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%required_permissions <@%';
  EXECUTE format('ALTER TABLE permission_definitions DROP CONSTRAINT %I',prior_allowlist);
END $$;
ALTER TABLE permission_definitions
  ADD CONSTRAINT permission_definitions_known_permissions
  CHECK (required_permissions <@ ARRAY['pages.manage','company.edit','employees.view','audit.view','accounts.view','accounts.manage','accounts.balance-followup','accounts.balance-approve','currencies.view','currencies.manage','locations.view','locations.manage','finance.view','finance.own-cashbox.view','finance.manage','finance.post','items.view','items.manage','commerce.view','commerce.manage','inventory.view','inventory.manage','inventory.post']::text[]);

INSERT INTO page_registry(key) VALUES ('company.my-cashbox-ledger')
ON CONFLICT DO NOTHING;
INSERT INTO permission_definitions(
  key,page_key,action,name,rule_role,required_permissions
) VALUES (
  'company.my-cashbox-ledger:view','company.my-cashbox-ledger','view',
  'كشف حساب صندوقي — عرض','permissions',
  ARRAY['finance.own-cashbox.view']::text[]
) ON CONFLICT(key) DO NOTHING;
