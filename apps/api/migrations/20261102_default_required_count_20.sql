-- Increase the default for NEW company reward settings only.
-- Existing company overrides, revisions and employee wallet ledgers are immutable.
UPDATE reward_task_definitions
SET default_points=20
WHERE code='STOCK_COUNT_REQUIRED';

CREATE OR REPLACE FUNCTION initialize_required_stock_count_reward()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO reward_task_settings
    (company_id,code,points,repeat_rule,enabled,page_key,updated_by)
  VALUES (NEW.id,'STOCK_COUNT_REQUIRED',20,'per-document',true,NULL,NEW.created_by)
  ON CONFLICT(company_id,code) DO NOTHING;
  RETURN NEW;
END $$;
