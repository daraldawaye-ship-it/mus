-- Stage one: storage and metadata only. Existing business columns remain authoritative.
ALTER TABLE employees ADD CONSTRAINT employees_company_identity UNIQUE(company_id,id);

CREATE TABLE option_record_targets (
  page_key varchar(100) NOT NULL REFERENCES page_registry(key),
  record_kind text NOT NULL CHECK(record_kind IN ('item','account','employee','invoice','financial-document')),
  PRIMARY KEY(page_key,record_kind)
);
INSERT INTO option_record_targets(page_key,record_kind) VALUES
('company.items','item'),('company.item-card','item'),('company.item-new','item'),
('company.accounts','account'),('company.employees','employee'),
('company.sales','invoice'),('company.purchases','invoice'),('company.invoice','invoice'),
('company.sale-new','invoice'),('company.purchase-new','invoice'),
('company.financial-documents','financial-document'),('company.financial-document','financial-document'),
('company.financial-new','financial-document'),('company.journals','financial-document'),
('company.receipts','financial-document'),('company.payments','financial-document');

CREATE FUNCTION option_choices_valid(value_type text, choices jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE choice jsonb; seen text[] := ARRAY[]::text[]; choice_key text;
BEGIN
  IF value_type <> 'list' THEN RETURN choices = '[]'::jsonb; END IF;
  IF jsonb_typeof(choices) <> 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(choices) NOT BETWEEN 1 AND 100 THEN RETURN false; END IF;
  FOR choice IN SELECT value FROM jsonb_array_elements(choices) LOOP
    IF jsonb_typeof(choice) <> 'object' THEN RETURN false; END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(choice)) <> 2 THEN RETURN false; END IF;
    IF jsonb_typeof(choice->'key') IS DISTINCT FROM 'string'
      OR jsonb_typeof(choice->'label') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
    choice_key := choice->>'key';
    IF choice_key !~ '^[a-z][a-z0-9_-]{0,59}$' OR length(btrim(choice->>'label')) NOT BETWEEN 1 AND 120
      OR choice_key = ANY(seen) THEN RETURN false; END IF;
    seen := array_append(seen,choice_key);
  END LOOP;
  RETURN true;
END $$;

CREATE FUNCTION option_value_valid(value_type text, value jsonb, choices jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE scalar text; parsed_date date;
BEGIN
  IF value = 'null'::jsonb THEN RETURN true; END IF;
  IF value_type = 'boolean' THEN RETURN jsonb_typeof(value) = 'boolean'; END IF;
  IF jsonb_typeof(value) <> 'string' THEN RETURN false; END IF;
  scalar := value #>> '{}';
  CASE value_type
    WHEN 'text' THEN RETURN length(scalar) <= 2000;
    WHEN 'integer' THEN RETURN scalar ~ '^-?(0|[1-9][0-9]{0,27})$';
    WHEN 'decimal' THEN RETURN scalar ~ '^-?(0|[1-9][0-9]{0,21})(\.[0-9]{1,6})?$';
    WHEN 'list' THEN RETURN EXISTS(SELECT 1 FROM jsonb_array_elements(choices) c WHERE c->>'key'=scalar);
    WHEN 'date' THEN
      IF scalar !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN false; END IF;
      BEGIN parsed_date := scalar::date;
      EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RETURN false; END;
      RETURN parsed_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31';
    ELSE RETURN false;
  END CASE;
END $$;

CREATE TABLE option_definitions (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id),
  key varchar(100) NOT NULL CHECK(key ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  page_key varchar(100) NOT NULL,
  record_kind text NOT NULL,
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK(length(description)<=1000),
  value_type text NOT NULL CHECK(value_type IN ('boolean','text','integer','decimal','date','list')),
  default_value jsonb NOT NULL DEFAULT 'null'::jsonb,
  choices jsonb NOT NULL DEFAULT '[]'::jsonb,
  required boolean NOT NULL DEFAULT false,
  searchable boolean NOT NULL DEFAULT false,
  show_on_card boolean NOT NULL DEFAULT true,
  show_in_list boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0 CHECK(sort_order BETWEEN 0 AND 100000),
  active boolean NOT NULL DEFAULT true,
  is_system boolean NOT NULL DEFAULT false,
  native_binding text,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  created_by integer NOT NULL REFERENCES users(id),
  updated_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id,id,record_kind),
  UNIQUE(company_id,key),
  FOREIGN KEY(page_key,record_kind) REFERENCES option_record_targets(page_key,record_kind),
  CHECK(option_choices_valid(value_type,choices)),
  CHECK(option_value_valid(value_type,default_value,choices)),
  CHECK(native_binding IS NULL OR (is_system AND value_type='boolean' AND (
    (record_kind='item' AND native_binding IN ('items.archived','items.has_expiry')) OR
    (record_kind='account' AND native_binding='accounts.archived'))))
);
CREATE INDEX option_definitions_directory ON option_definitions(company_id,page_key,active,sort_order,id);

CREATE TABLE option_values (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id),
  definition_id integer NOT NULL,
  record_kind text NOT NULL,
  item_id integer, account_id integer, employee_id integer, invoice_id integer, financial_document_id integer,
  value jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  created_by integer NOT NULL REFERENCES users(id),
  updated_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(company_id,definition_id,record_kind) REFERENCES option_definitions(company_id,id,record_kind),
  FOREIGN KEY(company_id,item_id) REFERENCES items(company_id,id),
  FOREIGN KEY(company_id,account_id) REFERENCES accounts(company_id,id),
  FOREIGN KEY(company_id,employee_id) REFERENCES employees(company_id,id),
  FOREIGN KEY(company_id,invoice_id) REFERENCES invoices(company_id,id),
  FOREIGN KEY(company_id,financial_document_id) REFERENCES financial_documents(company_id,id),
  CHECK(num_nonnulls(item_id,account_id,employee_id,invoice_id,financial_document_id)=1),
  CHECK((record_kind='item' AND item_id IS NOT NULL) OR (record_kind='account' AND account_id IS NOT NULL)
    OR (record_kind='employee' AND employee_id IS NOT NULL) OR (record_kind='invoice' AND invoice_id IS NOT NULL)
    OR (record_kind='financial-document' AND financial_document_id IS NOT NULL)),
  UNIQUE NULLS NOT DISTINCT(company_id,definition_id,item_id,account_id,employee_id,invoice_id,financial_document_id)
);

CREATE FUNCTION protect_option_definition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Archive option definitions instead of deleting them' USING ERRCODE='23514'; END IF;
  IF ROW(NEW.id,NEW.company_id,NEW.key,NEW.page_key,NEW.record_kind,NEW.is_system,NEW.native_binding,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.company_id,OLD.key,OLD.page_key,OLD.record_kind,OLD.is_system,OLD.native_binding,OLD.created_by,OLD.created_at)
    OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at THEN
    RAISE EXCEPTION 'Option identity is immutable and revision must advance' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW.value_type,NEW.choices) IS DISTINCT FROM ROW(OLD.value_type,OLD.choices)
    AND (OLD.is_system OR EXISTS(SELECT 1 FROM option_values WHERE company_id=OLD.company_id AND definition_id=OLD.id)) THEN
    RAISE EXCEPTION 'Cannot reinterpret existing option values' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER option_definitions_identity BEFORE UPDATE OR DELETE ON option_definitions
  FOR EACH ROW EXECUTE FUNCTION protect_option_definition();

CREATE FUNCTION validate_option_value() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE definition option_definitions%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Clear optional values explicitly instead of deleting history' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.id,NEW.company_id,NEW.definition_id,NEW.record_kind,NEW.item_id,NEW.account_id,NEW.employee_id,
      NEW.invoice_id,NEW.financial_document_id,NEW.created_by,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.company_id,OLD.definition_id,OLD.record_kind,OLD.item_id,OLD.account_id,OLD.employee_id,
      OLD.invoice_id,OLD.financial_document_id,OLD.created_by,OLD.created_at)
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
  )) THEN RAISE EXCEPTION 'Finalized document options are immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER option_values_validation BEFORE INSERT OR UPDATE OR DELETE ON option_values
  FOR EACH ROW EXECUTE FUNCTION validate_option_value();

CREATE FUNCTION seed_company_options(target_company integer, actor_id integer) RETURNS void LANGUAGE plpgsql AS $$
DECLARE seeded jsonb;
BEGIN
  WITH added AS (
    INSERT INTO option_definitions(company_id,key,page_key,record_kind,name,value_type,default_value,searchable,is_system,native_binding,sort_order,created_by,updated_by)
    VALUES(target_company,'items.archived','company.items','item','مؤرشف','boolean','false',true,true,'items.archived',10,actor_id,actor_id),
      (target_company,'items.has-expiry','company.items','item','له تاريخ انتهاء','boolean','true',true,true,'items.has_expiry',20,actor_id,actor_id),
      (target_company,'accounts.archived','company.accounts','account','مؤرشف','boolean','false',true,true,'accounts.archived',10,actor_id,actor_id)
    ON CONFLICT(company_id,key) DO NOTHING RETURNING *
  ) SELECT jsonb_agg(to_jsonb(added)) INTO seeded FROM added;
  IF seeded IS NOT NULL THEN
    INSERT INTO audit_events(actor_id,actor_name,scope,company_id,action,target_type,target_id,before_value,after_value)
    VALUES(NULL,'النظام','company',target_company,'configuration.options.seed','company',target_company,NULL,seeded);
  END IF;
END $$;
SELECT seed_company_options(id,created_by) FROM companies;
CREATE FUNCTION seed_new_company_options() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM seed_company_options(NEW.id,NEW.created_by); RETURN NEW; END $$;
CREATE TRIGGER companies_option_defaults AFTER INSERT ON companies FOR EACH ROW EXECUTE FUNCTION seed_new_company_options();
