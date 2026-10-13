-- Exact double-entry documents. A company lock serializes numbering and mutations.
ALTER TABLE employees DROP CONSTRAINT employees_permissions_check;
ALTER TABLE employees ADD CONSTRAINT employees_permissions_check CHECK (
  permissions <@ ARRAY['company.edit','employees.view','audit.view','accounts.view','accounts.manage',
  'currencies.view','currencies.manage','locations.view','locations.manage','finance.view','finance.manage','finance.post']::text[]
);
ALTER TABLE accounts ADD COLUMN cash_or_bank boolean NOT NULL DEFAULT false;
ALTER TABLE accounts ADD CONSTRAINT accounts_cash_or_bank_check CHECK (NOT cash_or_bank OR (kind='posting' AND category='asset'));

CREATE TABLE financial_document_counters (
  company_id integer PRIMARY KEY REFERENCES companies(id),
  next_number bigint NOT NULL DEFAULT 1 CHECK (next_number>0)
);
CREATE TABLE financial_documents (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id),
  number text NOT NULL CHECK (number ~ '^[0-9]{10,19}$'),
  kind text NOT NULL CHECK (kind IN ('journal','receipt','payment')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','reversed')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  document_date date NOT NULL CHECK (document_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
  currency_id integer NOT NULL,
  currency_code text,
  currency_name text,
  decimal_places integer CHECK (decimal_places BETWEEN 0 AND 6),
  base_currency_id integer,
  base_currency_code text,
  base_decimal_places integer CHECK (base_decimal_places BETWEEN 0 AND 6),
  exchange_rate numeric(28,12) CHECK (exchange_rate>0),
  exchange_rate_id integer,
  exchange_rate_source text,
  branch_id integer,
  branch_name text,
  cash_account_id integer,
  description text NOT NULL DEFAULT '' CHECK (length(description)<=1000),
  total_debit numeric(32,6) NOT NULL DEFAULT 0 CHECK (total_debit>=0),
  total_credit numeric(32,6) NOT NULL DEFAULT 0 CHECK (total_credit>=0),
  total_base_debit numeric(32,6) CHECK (total_base_debit>=0),
  total_base_credit numeric(32,6) CHECK (total_base_credit>=0),
  created_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  posted_by integer REFERENCES users(id),
  posted_at timestamptz,
  posted_from_revision integer,
  reversal_document_id integer,
  reverses_document_id integer,
  idempotency_key uuid NOT NULL,
  creation_payload jsonb NOT NULL,
  UNIQUE(company_id,id),
  UNIQUE(company_id,number),
  UNIQUE(company_id,idempotency_key),
  UNIQUE(company_id,reverses_document_id),
  FOREIGN KEY(company_id,currency_id) REFERENCES company_currencies(company_id,id),
  FOREIGN KEY(company_id,base_currency_id) REFERENCES company_currencies(company_id,id),
  FOREIGN KEY(company_id,exchange_rate_id) REFERENCES exchange_rates(company_id,id),
  FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id),
  FOREIGN KEY(company_id,cash_account_id) REFERENCES accounts(company_id,id),
  FOREIGN KEY(company_id,reversal_document_id) REFERENCES financial_documents(company_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(company_id,reverses_document_id) REFERENCES financial_documents(company_id,id) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((kind='journal' AND cash_account_id IS NULL) OR (kind IN ('receipt','payment') AND cash_account_id IS NOT NULL)),
  CHECK (status='draft' OR (currency_code IS NOT NULL AND currency_name IS NOT NULL AND decimal_places IS NOT NULL
    AND base_currency_id IS NOT NULL AND base_currency_code IS NOT NULL AND base_decimal_places IS NOT NULL
    AND exchange_rate IS NOT NULL AND exchange_rate_source IS NOT NULL AND posted_by IS NOT NULL AND posted_at IS NOT NULL
    AND posted_from_revision IS NOT NULL AND total_debit=total_credit AND total_debit>0
    AND total_base_debit=total_base_credit AND total_base_debit>0)),
  CHECK ((status='reversed')=(reversal_document_id IS NOT NULL)),
  CHECK (reverses_document_id IS NULL OR kind='journal'),
  CHECK (reverses_document_id IS NULL OR reverses_document_id<>id),
  CHECK (reversal_document_id IS NULL OR reversal_document_id<>id)
);
CREATE INDEX financial_documents_listing ON financial_documents(company_id,document_date DESC,id DESC);
CREATE INDEX financial_documents_status ON financial_documents(company_id,status,kind,id DESC);
CREATE TABLE financial_document_lines (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer NOT NULL,
  document_id integer NOT NULL,
  line_number integer NOT NULL CHECK (line_number BETWEEN 1 AND 100),
  account_id integer NOT NULL,
  account_code text,
  account_name text,
  debit numeric(28,6) NOT NULL CHECK (debit>=0),
  credit numeric(28,6) NOT NULL CHECK (credit>=0),
  base_debit numeric(28,6) CHECK (base_debit>=0),
  base_credit numeric(28,6) CHECK (base_credit>=0),
  description text NOT NULL DEFAULT '' CHECK (length(description)<=500),
  UNIQUE(company_id,document_id,line_number),
  FOREIGN KEY(company_id,document_id) REFERENCES financial_documents(company_id,id),
  FOREIGN KEY(company_id,account_id) REFERENCES accounts(company_id,id)
);
CREATE INDEX financial_lines_account ON financial_document_lines(company_id,account_id,document_id,id);

CREATE FUNCTION protect_financial_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Financial documents cannot be deleted' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW.company_id,NEW.id,NEW.number,NEW.created_by,NEW.created_at,NEW.idempotency_key,NEW.creation_payload)
    IS DISTINCT FROM ROW(OLD.company_id,OLD.id,OLD.number,OLD.created_by,OLD.created_at,OLD.idempotency_key,OLD.creation_payload) THEN
    RAISE EXCEPTION 'Financial identity is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.status<>'draft' AND NEW IS DISTINCT FROM OLD THEN
    IF NOT (OLD.status='posted' AND NEW.status='reversed' AND NEW.reversal_document_id IS NOT NULL
      AND NEW.revision=OLD.revision+1 AND
      (to_jsonb(NEW)-ARRAY['status','revision','reversal_document_id'])=(to_jsonb(OLD)-ARRAY['status','revision','reversal_document_id'])) THEN
      RAISE EXCEPTION 'Posted financial document is immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER financial_document_immutable BEFORE UPDATE OR DELETE ON financial_documents FOR EACH ROW EXECUTE FUNCTION protect_financial_document();
CREATE FUNCTION protect_financial_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status text;
BEGIN
  IF TG_OP<>'INSERT' THEN
    SELECT status INTO parent_status FROM financial_documents WHERE company_id=OLD.company_id AND id=OLD.document_id FOR SHARE;
    IF parent_status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'Posted financial lines are immutable' USING ERRCODE='23514'; END IF;
  END IF;
  IF TG_OP<>'DELETE' THEN
    SELECT status INTO parent_status FROM financial_documents WHERE company_id=NEW.company_id AND id=NEW.document_id FOR SHARE;
    IF parent_status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'Posted financial lines are immutable' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER financial_line_immutable BEFORE INSERT OR UPDATE OR DELETE ON financial_document_lines FOR EACH ROW EXECUTE FUNCTION protect_financial_line();

CREATE FUNCTION check_financial_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE doc financial_documents%ROWTYPE; original financial_documents%ROWTYPE; line_count integer; invalid_count integer;
  debit_sum numeric; credit_sum numeric; base_debit_sum numeric; base_credit_sum numeric;
BEGIN
  IF TG_TABLE_NAME='financial_documents' THEN
    SELECT * INTO doc FROM financial_documents WHERE company_id=NEW.company_id AND id=NEW.id;
  ELSE
    SELECT * INTO doc FROM financial_documents WHERE company_id=COALESCE(NEW.company_id,OLD.company_id) AND id=COALESCE(NEW.document_id,OLD.document_id);
  END IF;
  IF doc.status='draft' THEN RETURN NULL; END IF;
  SELECT count(*), count(*) FILTER(WHERE (debit=0 AND credit=0) OR (debit>0 AND credit>0)
    OR base_debit IS NULL OR base_credit IS NULL OR account_code IS NULL OR account_name IS NULL
    OR debit<>round(debit,doc.decimal_places) OR credit<>round(credit,doc.decimal_places)
    OR base_debit<>round(debit*doc.exchange_rate,doc.base_decimal_places) OR base_credit<>round(credit*doc.exchange_rate,doc.base_decimal_places)),
    sum(debit),sum(credit),sum(base_debit),sum(base_credit)
  INTO line_count,invalid_count,debit_sum,credit_sum,base_debit_sum,base_credit_sum
  FROM financial_document_lines WHERE company_id=doc.company_id AND document_id=doc.id;
  IF line_count<2 OR invalid_count>0 OR debit_sum<>doc.total_debit OR credit_sum<>doc.total_credit
    OR base_debit_sum<>doc.total_base_debit OR base_credit_sum<>doc.total_base_credit THEN
    RAISE EXCEPTION 'Posted double-entry document is inconsistent' USING ERRCODE='23514';
  END IF;
  IF doc.kind IN ('receipt','payment') THEN
    IF line_count<>2 OR NOT EXISTS(SELECT 1 FROM accounts WHERE company_id=doc.company_id AND id=doc.cash_account_id AND cash_or_bank AND kind='posting' AND category='asset')
       OR NOT EXISTS(SELECT 1 FROM financial_document_lines WHERE company_id=doc.company_id AND document_id=doc.id AND account_id=doc.cash_account_id
       AND ((doc.kind='receipt' AND debit>0 AND credit=0) OR (doc.kind='payment' AND credit>0 AND debit=0)))
       OR (SELECT count(DISTINCT account_id) FROM financial_document_lines WHERE company_id=doc.company_id AND document_id=doc.id)<>2 THEN
      RAISE EXCEPTION 'Voucher cash direction is inconsistent' USING ERRCODE='23514';
    END IF;
  END IF;
  IF doc.reverses_document_id IS NOT NULL THEN
    SELECT * INTO original FROM financial_documents WHERE company_id=doc.company_id AND id=doc.reverses_document_id;
    IF original.status<>'reversed' OR original.reversal_document_id<>doc.id
      OR ROW(doc.currency_id,doc.currency_code,doc.decimal_places,doc.base_currency_id,doc.base_currency_code,doc.base_decimal_places,doc.exchange_rate,doc.exchange_rate_id,doc.exchange_rate_source,doc.branch_id)
       IS DISTINCT FROM ROW(original.currency_id,original.currency_code,original.decimal_places,original.base_currency_id,original.base_currency_code,original.base_decimal_places,original.exchange_rate,original.exchange_rate_id,original.exchange_rate_source,original.branch_id)
      OR EXISTS((SELECT line_number,account_id,account_code,account_name,debit,credit,base_debit,base_credit FROM financial_document_lines WHERE company_id=doc.company_id AND document_id=doc.id)
        EXCEPT (SELECT line_number,account_id,account_code,account_name,credit,debit,base_credit,base_debit FROM financial_document_lines WHERE company_id=doc.company_id AND document_id=original.id))
      OR (SELECT count(*) FROM financial_document_lines WHERE company_id=doc.company_id AND document_id=original.id)<>line_count THEN
      RAISE EXCEPTION 'Reversal must preserve exact original snapshots' USING ERRCODE='23514';
    END IF;
  END IF;
  IF doc.status='reversed' AND NOT EXISTS(SELECT 1 FROM financial_documents WHERE company_id=doc.company_id AND id=doc.reversal_document_id AND status='posted' AND reverses_document_id=doc.id) THEN
    RAISE EXCEPTION 'Reversal link is inconsistent' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER financial_documents_balanced AFTER INSERT OR UPDATE ON financial_documents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_financial_integrity();
CREATE CONSTRAINT TRIGGER financial_lines_balanced AFTER INSERT OR UPDATE OR DELETE ON financial_document_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_financial_integrity();

CREATE FUNCTION protect_financial_master_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='accounts' THEN
    IF ROW(NEW.code,NEW.kind,NEW.category,NEW.normal_side,NEW.cash_or_bank) IS DISTINCT FROM ROW(OLD.code,OLD.kind,OLD.category,OLD.normal_side,OLD.cash_or_bank) AND EXISTS(SELECT 1 FROM financial_document_lines l JOIN financial_documents d ON d.company_id=l.company_id AND d.id=l.document_id WHERE l.company_id=OLD.company_id AND l.account_id=OLD.id AND d.status<>'draft') THEN
      RAISE EXCEPTION 'Account history cannot be reinterpreted' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='company_currencies' THEN
    IF ROW(NEW.code,NEW.decimal_places) IS DISTINCT FROM ROW(OLD.code,OLD.decimal_places) AND EXISTS(SELECT 1 FROM financial_documents WHERE company_id=OLD.company_id AND status<>'draft' AND (currency_id=OLD.id OR base_currency_id=OLD.id)) THEN
      RAISE EXCEPTION 'Currency history cannot be reinterpreted' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='finance_settings' THEN
    IF NEW.base_currency_id<>OLD.base_currency_id AND (EXISTS(SELECT 1 FROM exchange_rates WHERE company_id=OLD.company_id) OR EXISTS(SELECT 1 FROM financial_documents WHERE company_id=OLD.company_id AND status<>'draft')) THEN
      RAISE EXCEPTION 'Base currency history cannot be reinterpreted' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER accounts_financial_history BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION protect_financial_master_history();
CREATE TRIGGER currencies_financial_history BEFORE UPDATE ON company_currencies FOR EACH ROW EXECUTE FUNCTION protect_financial_master_history();
CREATE TRIGGER settings_financial_history BEFORE UPDATE ON finance_settings FOR EACH ROW EXECUTE FUNCTION protect_financial_master_history();
