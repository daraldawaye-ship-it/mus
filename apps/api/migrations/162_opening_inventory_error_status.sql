ALTER TABLE opening_inventory_runs
 ADD COLUMN IF NOT EXISTS last_error text;
