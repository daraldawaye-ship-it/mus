-- Storage foundation only. No financial/activity calculation, source revision
-- producer, historical event synthesis or daily-bucket population runs here.
-- The authoritative ledger, invoices and stock remain unchanged.
CREATE TABLE account_statistics (
  company_id integer NOT NULL,
  account_id integer NOT NULL,
  policy_version integer NOT NULL DEFAULT 1 CHECK (policy_version >= 1),
  -- Reserved for the future calculation engine; initialization is not a refresh.
  source_revision bigint NOT NULL DEFAULT 0 CHECK (source_revision >= 0),

  balance_state text NOT NULL DEFAULT 'uncomputed' CHECK (balance_state IN ('uncomputed','stale','ready')),
  balance_computed_revision bigint CHECK (balance_computed_revision BETWEEN 0 AND source_revision),
  balance_as_of_date date CHECK (balance_as_of_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
  balance_computed_at timestamptz,
  activity_state text NOT NULL DEFAULT 'uncomputed' CHECK (activity_state IN ('uncomputed','stale','ready')),
  activity_computed_revision bigint CHECK (activity_computed_revision BETWEEN 0 AND source_revision),
  activity_as_of_date date CHECK (activity_as_of_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
  activity_computed_at timestamptz,
  commerce_state text NOT NULL DEFAULT 'uncomputed' CHECK (commerce_state IN ('uncomputed','stale','ready')),
  commerce_computed_revision bigint CHECK (commerce_computed_revision BETWEEN 0 AND source_revision),
  commerce_as_of_date date CHECK (commerce_as_of_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
  commerce_computed_at timestamptz,
  stock_state text NOT NULL DEFAULT 'uncomputed' CHECK (stock_state IN ('uncomputed','stale','ready')),
  stock_computed_revision bigint CHECK (stock_computed_revision BETWEEN 0 AND source_revision),
  stock_as_of_date date CHECK (stock_as_of_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
  stock_computed_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (company_id,account_id),
  FOREIGN KEY (company_id,account_id) REFERENCES accounts(company_id,id),
  CONSTRAINT account_statistics_balance_metadata CHECK (
    (balance_state='uncomputed' AND balance_computed_revision IS NULL AND balance_as_of_date IS NULL AND balance_computed_at IS NULL)
    OR (balance_state IN ('stale','ready') AND balance_computed_revision IS NOT NULL AND balance_as_of_date IS NOT NULL AND balance_computed_at IS NOT NULL)
  ),
  CONSTRAINT account_statistics_activity_metadata CHECK (
    (activity_state='uncomputed' AND activity_computed_revision IS NULL AND activity_as_of_date IS NULL AND activity_computed_at IS NULL)
    OR (activity_state IN ('stale','ready') AND activity_computed_revision IS NOT NULL AND activity_as_of_date IS NOT NULL AND activity_computed_at IS NOT NULL)
  ),
  CONSTRAINT account_statistics_commerce_metadata CHECK (
    (commerce_state='uncomputed' AND commerce_computed_revision IS NULL AND commerce_as_of_date IS NULL AND commerce_computed_at IS NULL)
    OR (commerce_state IN ('stale','ready') AND commerce_computed_revision IS NOT NULL AND commerce_as_of_date IS NOT NULL AND commerce_computed_at IS NOT NULL)
  ),
  CONSTRAINT account_statistics_stock_metadata CHECK (
    (stock_state='uncomputed' AND stock_computed_revision IS NULL AND stock_as_of_date IS NULL AND stock_computed_at IS NULL)
    OR (stock_state IN ('stale','ready') AND stock_computed_revision IS NOT NULL AND stock_as_of_date IS NOT NULL AND stock_computed_at IS NOT NULL)
  ),
  CHECK (balance_state<>'ready' OR balance_computed_revision=source_revision),
  CHECK (activity_state<>'ready' OR activity_computed_revision=source_revision),
  CHECK (commerce_state<>'ready' OR commerce_computed_revision=source_revision),
  CHECK (stock_state<>'ready' OR stock_computed_revision=source_revision)
);

CREATE FUNCTION protect_account_statistics_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account_kind text;
BEGIN
  IF TG_OP='UPDATE' AND ROW(NEW.company_id,NEW.account_id) IS DISTINCT FROM ROW(OLD.company_id,OLD.account_id) THEN
    RAISE EXCEPTION 'Account statistics identity is immutable' USING ERRCODE='23514';
  END IF;
  SELECT kind INTO account_kind FROM accounts
    WHERE company_id=NEW.company_id AND id=NEW.account_id FOR SHARE;
  IF account_kind IS DISTINCT FROM 'posting' THEN
    RAISE EXCEPTION 'Account statistics require a posting account in the same company' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER account_statistics_scope BEFORE INSERT OR UPDATE ON account_statistics
  FOR EACH ROW EXECUTE FUNCTION protect_account_statistics_scope();

-- Keep the posting-only relationship valid if an account kind is changed by a
-- future maintenance path; account cards currently do not edit this identity.
CREATE FUNCTION protect_account_statistics_account_kind() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind<>'posting' AND EXISTS (
    SELECT 1 FROM account_statistics WHERE company_id=OLD.company_id AND account_id=OLD.id
  ) THEN
    RAISE EXCEPTION 'An account with statistics must remain a posting account' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER accounts_statistics_kind BEFORE UPDATE OF kind ON accounts
  FOR EACH ROW WHEN (NEW.kind IS DISTINCT FROM OLD.kind)
  EXECUTE FUNCTION protect_account_statistics_account_kind();

-- Sparse, normalized future projection. No empty days or zero totals are seeded.
-- Activity is a document counter only; ledger keeps the signed net plus its two
-- nonnegative sides. Other families keep signed original/base monetary totals.
CREATE TABLE account_daily_activity (
  company_id integer NOT NULL,
  account_id integer NOT NULL,
  document_date date NOT NULL CHECK (document_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
  currency_id integer NOT NULL,
  family text NOT NULL CHECK (family IN ('ledger','activity','sale','purchase','purchase_cash','payment','receipt')),
  base_currency_id integer NOT NULL,
  document_count bigint NOT NULL CHECK (document_count >= 0),
  amount numeric(38,6) CHECK (amount <> 'NaN'::numeric),
  base_amount numeric(38,6) CHECK (base_amount <> 'NaN'::numeric),
  base_debit numeric(38,6) CHECK (base_debit >= 0 AND base_debit <> 'NaN'::numeric),
  base_credit numeric(38,6) CHECK (base_credit >= 0 AND base_credit <> 'NaN'::numeric),
  source_revision bigint NOT NULL CHECK (source_revision >= 0),
  PRIMARY KEY (company_id,account_id,document_date,currency_id,family),
  FOREIGN KEY (company_id,account_id) REFERENCES account_statistics(company_id,account_id),
  FOREIGN KEY (company_id,currency_id) REFERENCES company_currencies(company_id,id),
  FOREIGN KEY (company_id,base_currency_id) REFERENCES company_currencies(company_id,id),
  CONSTRAINT account_daily_activity_family_values CHECK (
    (family='activity' AND amount IS NULL AND base_amount IS NULL AND base_debit IS NULL AND base_credit IS NULL)
    OR (family='ledger' AND amount IS NOT NULL AND base_amount IS NOT NULL AND base_debit IS NOT NULL AND base_credit IS NOT NULL
      AND base_amount=base_debit-base_credit)
    OR (family IN ('sale','purchase','purchase_cash','payment','receipt') AND amount IS NOT NULL AND base_amount IS NOT NULL
      AND base_debit IS NULL AND base_credit IS NULL)
  )
);

-- Human actions are independent of derived statistics. No existing option value
-- is reinterpreted as an action, and no action is synthesized from ledger rows.
CREATE TABLE account_balance_followups (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer NOT NULL,
  account_id integer NOT NULL,
  followed_up_at timestamptz NOT NULL,
  created_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
  idempotency_key uuid NOT NULL,
  request_payload jsonb NOT NULL CHECK (jsonb_typeof(request_payload)='object'),
  UNIQUE (company_id,idempotency_key),
  UNIQUE (company_id,account_id,id),
  FOREIGN KEY (company_id,account_id) REFERENCES account_statistics(company_id,account_id)
);
CREATE INDEX account_balance_followups_history
  ON account_balance_followups(company_id,account_id,followed_up_at DESC,id DESC);

-- Approval is a fixed signed base-currency snapshot through balance_date,
-- inclusive. It has no source-document FK: a later authorized transaction reset
-- must not cascade into deleting human approval history or rewrite its amount.
CREATE TABLE account_balance_approvals (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer NOT NULL,
  account_id integer NOT NULL,
  balance_date date NOT NULL CHECK (balance_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
  balance_base numeric(38,6) NOT NULL CHECK (balance_base <> 'NaN'::numeric),
  base_currency_id integer NOT NULL,
  base_currency_code text NOT NULL CHECK (base_currency_code ~ '^[A-Z]{3}$'),
  base_decimal_places integer NOT NULL CHECK (base_decimal_places BETWEEN 0 AND 6),
  source_revision bigint NOT NULL CHECK (source_revision >= 0),
  policy_version integer NOT NULL CHECK (policy_version >= 1),
  created_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
  idempotency_key uuid NOT NULL,
  request_payload jsonb NOT NULL CHECK (jsonb_typeof(request_payload)='object'),
  UNIQUE (company_id,idempotency_key),
  UNIQUE (company_id,account_id,id),
  FOREIGN KEY (company_id,account_id) REFERENCES account_statistics(company_id,account_id),
  FOREIGN KEY (company_id,base_currency_id) REFERENCES company_currencies(company_id,id),
  CHECK (balance_base=round(balance_base,base_decimal_places))
);
CREATE INDEX account_balance_approvals_history
  ON account_balance_approvals(company_id,account_id,created_at DESC,id DESC);

-- Validate an approval's currency snapshot at insertion, then preserve it as
-- immutable history. The empty statistics scaffold still needs no currency.
CREATE FUNCTION validate_account_balance_approval_currency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_currency_id integer; expected_code text; expected_places integer;
BEGIN
  -- Lock the settings row before its referenced currency, keeping the current
  -- base-currency choice and its snapshot stable until this transaction ends.
  SELECT base_currency_id INTO expected_currency_id FROM finance_settings
    WHERE company_id=NEW.company_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'A balance approval requires company finance settings'
      USING ERRCODE='23514', CONSTRAINT='account_balance_approvals_currency_snapshot';
  END IF;
  SELECT code,decimal_places INTO expected_code,expected_places FROM company_currencies
    WHERE company_id=NEW.company_id AND id=expected_currency_id FOR SHARE;
  IF NOT FOUND OR ROW(NEW.base_currency_id,NEW.base_currency_code,NEW.base_decimal_places)
    IS DISTINCT FROM ROW(expected_currency_id,expected_code,expected_places) THEN
    RAISE EXCEPTION 'Balance approval currency must match the company base-currency snapshot'
      USING ERRCODE='23514', CONSTRAINT='account_balance_approvals_currency_snapshot';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER account_balance_approvals_currency BEFORE INSERT ON account_balance_approvals
  FOR EACH ROW EXECUTE FUNCTION validate_account_balance_approval_currency();

CREATE FUNCTION protect_account_balance_action() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Account balance follow-ups and approvals are append-only' USING ERRCODE='23514';
END $$;
CREATE TRIGGER account_balance_followups_immutable BEFORE UPDATE OR DELETE ON account_balance_followups
  FOR EACH ROW EXECUTE FUNCTION protect_account_balance_action();
CREATE TRIGGER account_balance_approvals_immutable BEFORE UPDATE OR DELETE ON account_balance_approvals
  FOR EACH ROW EXECUTE FUNCTION protect_account_balance_action();

CREATE FUNCTION initialize_account_statistics(target_company integer,target_account integer)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO account_statistics(company_id,account_id)
    SELECT company_id,id FROM accounts
    WHERE company_id=target_company AND id=target_account AND kind='posting'
    ON CONFLICT (company_id,account_id) DO NOTHING;
END $$;

CREATE FUNCTION initialize_new_account_statistics() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind='posting' THEN
    PERFORM initialize_account_statistics(NEW.company_id,NEW.id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER accounts_statistics_init AFTER INSERT ON accounts
  FOR EACH ROW EXECUTE FUNCTION initialize_new_account_statistics();

-- Existing/new accounts get only the uncomputed scaffold. In particular, a
-- new company's accounts may be created before its currencies are initialized.
SELECT initialize_account_statistics(company_id,id)
  FROM accounts WHERE kind='posting' ORDER BY company_id,id;
