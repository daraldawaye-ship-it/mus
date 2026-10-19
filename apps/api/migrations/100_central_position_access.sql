-- Additive migration: old role and employee.permissions remain intact until
-- every protected operation has been migrated and tested.
ALTER TABLE employees
  ADD COLUMN position_keys text[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE employees ADD CONSTRAINT employee_position_keys_known CHECK (
  position_keys <@ ARRAY[
    'admin1','admin2','sales','purchase-entry','accountant','cashier',
    'purchase-followup','external-purchasing','camera-monitor','sales-supervisor',
    'warehouse-manager','cleaner','guard','memo-followup','chat-supervisor',
    'attendance-supervisor','alert-supervisor','task-supervisor',
    'accounts-view2','accounts-view3','accounts-view4',
    'inventory-variance-followup'
  ]::text[]
  AND array_position(position_keys,NULL) IS NULL
);
-- Assign old employee roles to the closest single position so the UI is not
-- empty during migration. Never overwrite manually selected multiple roles.
UPDATE employees SET position_keys=CASE role
  WHEN 'administrative' THEN ARRAY['admin1']::text[]
  WHEN 'accountant' THEN ARRAY['accountant']::text[]
  WHEN 'sales' THEN ARRAY['sales']::text[]
  WHEN 'purchases' THEN ARRAY['purchase-entry']::text[]
  ELSE '{}'::text[] END
WHERE cardinality(position_keys)=0;

-- Code-owned resource keys: clients cannot define their own resources. Each
-- company can choose view/edit position groups; edits are versioned/audited.
CREATE TABLE central_access_policies (
  company_id integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  resource_key varchar(180) NOT NULL,
  view_positions text[] NOT NULL DEFAULT '{}'::text[],
  edit_positions text[] NOT NULL DEFAULT '{}'::text[],
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  updated_by integer NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(company_id,resource_key),
  CHECK (cardinality(view_positions)<=22 AND cardinality(edit_positions)<=22),
  CHECK (edit_positions <@ view_positions),
  CHECK (array_position(view_positions,NULL) IS NULL AND
         array_position(edit_positions,NULL) IS NULL)
);
CREATE INDEX central_access_policies_editor_idx ON central_access_policies(company_id,updated_at DESC);
INSERT INTO page_registry(key) VALUES('company.central-access') ON CONFLICT DO NOTHING;
INSERT INTO permission_definitions(
 key,page_key,action,name,rule_role,required_permissions
) VALUES
 ('company.central-access:view','company.central-access','view','مركز الصلاحيات — عرض','company-general',ARRAY[]::text[]),
 ('company.central-access:edit','company.central-access','edit','مركز الصلاحيات — تعديل','company-general',ARRAY[]::text[])
ON CONFLICT(key) DO NOTHING;
