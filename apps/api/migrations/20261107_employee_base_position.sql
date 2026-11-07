-- Expand the existing employee position check to include the universal
-- "employee" position. Do not alter any other employee position or grant.
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employee_position_keys_known;
ALTER TABLE employees ADD CONSTRAINT employee_position_keys_known
  CHECK (position_keys <@ ARRAY['employee', 'admin1', 'admin2', 'sales', 'purchase-entry', 'accountant', 'cashier', 'purchase-followup', 'external-purchasing', 'camera-monitor', 'sales-supervisor', 'warehouse-manager', 'cleaner', 'guard', 'memo-followup', 'chat-supervisor', 'attendance-supervisor', 'alert-supervisor', 'task-supervisor', 'accounts-view2', 'accounts-view3', 'accounts-view4', 'inventory-variance-followup']::text[]);
-- Cover every old employee in every company, active or inactive, exactly once.
UPDATE employees SET
  position_keys=array_append(COALESCE(position_keys,ARRAY[]::text[]),'employee')
WHERE NOT ('employee'=ANY(COALESCE(position_keys,ARRAY[]::text[])));
