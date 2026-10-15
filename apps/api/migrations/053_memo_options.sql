-- Memo options share the existing definitions/value validator, not an unrelated JSON field.
ALTER TABLE option_record_targets DROP CONSTRAINT option_record_targets_record_kind_check;
ALTER TABLE option_record_targets
 ADD CONSTRAINT option_record_targets_record_kind_check
 CHECK(record_kind IN ('item','account','employee','invoice','financial-document','memo'));
INSERT INTO option_record_targets(page_key,record_kind) VALUES('company.memos','memo');

ALTER TABLE option_values
 ADD COLUMN memo_id integer,
 ADD CONSTRAINT option_values_memo_company_fk
 FOREIGN KEY(company_id,memo_id) REFERENCES memos(company_id,id);
-- Replace generated constraints to include memo_id. Preserve all current rows.
DO $$
DECLARE constraint_name text;
BEGIN
 FOR constraint_name IN
   SELECT conname FROM pg_constraint
   WHERE conrelid='option_values'::regclass AND
    ((contype='c' AND
      (pg_get_constraintdef(oid) LIKE '%num_nonnulls%' OR pg_get_constraintdef(oid) LIKE '%record_kind%'))
     OR (contype='u' AND pg_get_constraintdef(oid) LIKE '%NULLS NOT DISTINCT%'))
 LOOP EXECUTE format('ALTER TABLE option_values DROP CONSTRAINT %I',constraint_name); END LOOP;
END $$;
ALTER TABLE option_values
 ADD CONSTRAINT option_values_one_target CHECK
  (num_nonnulls(item_id,account_id,employee_id,invoice_id,financial_document_id,memo_id)=1),
 ADD CONSTRAINT option_values_kind_target CHECK
  ((record_kind='item' AND item_id IS NOT NULL) OR
   (record_kind='account' AND account_id IS NOT NULL) OR
   (record_kind='employee' AND employee_id IS NOT NULL) OR
   (record_kind='invoice' AND invoice_id IS NOT NULL) OR
   (record_kind='financial-document' AND financial_document_id IS NOT NULL) OR
   (record_kind='memo' AND memo_id IS NOT NULL)),
 ADD CONSTRAINT option_values_record_unique UNIQUE NULLS NOT DISTINCT
  (company_id,definition_id,item_id,account_id,employee_id,invoice_id,financial_document_id,memo_id);

CREATE OR REPLACE FUNCTION validate_option_value() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE definition option_definitions%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Clear optional values explicitly instead of deleting history' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.id,NEW.company_id,NEW.definition_id,NEW.record_kind,NEW.item_id,NEW.account_id,NEW.employee_id,
      NEW.invoice_id,NEW.financial_document_id,NEW.memo_id,NEW.created_by,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.company_id,OLD.definition_id,OLD.record_kind,OLD.item_id,OLD.account_id,OLD.employee_id,
      OLD.invoice_id,OLD.financial_document_id,OLD.memo_id,OLD.created_by,OLD.created_at)
      OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at THEN
      RAISE EXCEPTION 'Option value identity is immutable and revision must advance' USING ERRCODE='23514';
    END IF;
  END IF;
  SELECT * INTO definition FROM option_definitions WHERE company_id=NEW.company_id AND id=NEW.definition_id FOR SHARE;
  IF NOT FOUND OR NOT definition.active OR definition.native_binding IS NOT NULL
    OR NOT option_value_valid(definition.value_type,NEW.value,definition.choices)
    OR (definition.required AND (NEW.value='null'::jsonb OR NEW.value='""'::jsonb)) THEN
    RAISE EXCEPTION 'Invalid option value or protected native field' USING ERRCODE='23514';
  END IF;
  IF NEW.invoice_id IS NOT NULL OR (NEW.financial_document_id IS NOT NULL AND EXISTS(
    SELECT 1 FROM financial_documents WHERE company_id=NEW.company_id AND id=NEW.financial_document_id AND status<>'draft'
  )) OR (NEW.memo_id IS NOT NULL AND EXISTS(
    SELECT 1 FROM memos WHERE company_id=NEW.company_id AND id=NEW.memo_id AND status='completed'
  )) THEN RAISE EXCEPTION 'Finalized document or memo options are immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

CREATE TABLE memo_option_versions (
 company_id integer NOT NULL REFERENCES companies(id),
 memo_id integer NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 changed_by integer REFERENCES users(id),
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,memo_id),
 FOREIGN KEY(company_id,memo_id) REFERENCES memos(company_id,id)
);
INSERT INTO memo_option_versions(company_id,memo_id) SELECT company_id,id FROM memos;

CREATE TABLE memo_option_changes (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 company_id integer NOT NULL REFERENCES companies(id),
 memo_id integer NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 actor_user_id integer NOT NULL REFERENCES users(id),
 actor_name text NOT NULL,
 previous_value jsonb NOT NULL,
 next_value jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,memo_id,revision),
 FOREIGN KEY(company_id,memo_id) REFERENCES memos(company_id,id)
);
CREATE TRIGGER memo_option_changes_immutable BEFORE UPDATE OR DELETE ON memo_option_changes
 FOR EACH ROW EXECUTE FUNCTION protect_memo_history();
CREATE INDEX option_values_memo_lookup ON option_values(company_id,memo_id,definition_id) WHERE memo_id IS NOT NULL;
