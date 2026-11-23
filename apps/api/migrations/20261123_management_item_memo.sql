-- A linked-item memo may be addressed to company administration without a person.
ALTER TABLE memos
  ALTER COLUMN recipient_employee_id DROP NOT NULL,
  ALTER COLUMN recipient_user_id DROP NOT NULL,
  ALTER COLUMN current_user_id DROP NOT NULL,
  ADD CONSTRAINT memo_management_audience_shape CHECK (
    (recipient_user_id IS NOT NULL AND recipient_employee_id IS NOT NULL AND current_user_id IS NOT NULL)
    OR (recipient_user_id IS NULL AND recipient_employee_id IS NULL AND current_user_id IS NULL
        AND current_employee_id IS NULL AND recipient_name = 'الإدارة' AND current_name = 'الإدارة'
        AND status = 'pending')
  );

CREATE FUNCTION check_management_memo_item_link() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_id integer := CASE WHEN TG_TABLE_NAME = 'memos'
                            THEN (to_jsonb(NEW)->>'id')::integer
                            ELSE (to_jsonb(NEW)->>'memo_id')::integer END;
BEGIN
  IF EXISTS (
    SELECT 1 FROM memos m
    WHERE m.company_id=NEW.company_id AND m.id=target_id AND m.recipient_user_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM memo_links ml
        WHERE ml.company_id=m.company_id AND ml.memo_id=m.id AND ml.item_id IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'A management memo requires a company item link' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER management_memo_item_required
  AFTER INSERT ON memos DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_management_memo_item_link();
CREATE CONSTRAINT TRIGGER management_memo_link_required
  AFTER INSERT OR UPDATE ON memo_links DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_management_memo_item_link();
