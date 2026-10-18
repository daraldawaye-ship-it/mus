-- Balance-only projection. Source writes invalidate metadata; history is scanned
-- only by an explicitly requested refresh. Other statistic components remain
-- uncomputed until their own engines are introduced.
CREATE TABLE account_balance_sources (
  company_id integer PRIMARY KEY REFERENCES companies(id),
  generation uuid NOT NULL DEFAULT gen_random_uuid(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO account_balance_sources(company_id)
  SELECT id FROM companies ORDER BY id ON CONFLICT (company_id) DO NOTHING;

CREATE FUNCTION initialize_company_account_balance_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO account_balance_sources(company_id) VALUES(NEW.id)
    ON CONFLICT (company_id) DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER companies_account_balance_source AFTER INSERT ON companies
  FOR EACH ROW EXECUTE FUNCTION initialize_company_account_balance_source();

ALTER TABLE account_statistics
  ADD COLUMN balance_current_base numeric(38,6),
  ADD COLUMN balance_one_year_ago_base numeric(38,6),
  ADD COLUMN balance_at_current_year_start_base numeric(38,6),
  ADD COLUMN balance_at_previous_year_start_base numeric(38,6),
  ADD COLUMN balance_at_two_years_ago_start_base numeric(38,6),
  ADD COLUMN balance_currency_id integer,
  ADD COLUMN balance_currency_code text,
  ADD COLUMN balance_currency_decimal_places integer,
  ADD COLUMN balance_generation uuid,
  ADD CONSTRAINT account_statistics_balance_currency_fk
    FOREIGN KEY (company_id,balance_currency_id) REFERENCES company_currencies(company_id,id),
  ADD CONSTRAINT account_statistics_balance_currency_code
    CHECK (balance_currency_code ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT account_statistics_balance_currency_precision
    CHECK (balance_currency_decimal_places BETWEEN 0 AND 6);

-- Foundation metadata was not a computed balance snapshot. Preserve its date,
-- revision and timestamp, but never advertise an old ready marker as this cache.
UPDATE account_statistics SET balance_state='stale' WHERE balance_state='ready';

ALTER TABLE account_statistics
  ADD CONSTRAINT account_statistics_balance_ready_snapshot CHECK (
    balance_state<>'ready' OR (
      policy_version=1
      AND balance_computed_revision IS NOT NULL AND balance_computed_revision=source_revision
      AND balance_as_of_date IS NOT NULL AND balance_computed_at IS NOT NULL
      AND balance_generation IS NOT NULL
      AND balance_currency_id IS NOT NULL AND balance_currency_code IS NOT NULL
      AND balance_currency_decimal_places IS NOT NULL
      AND balance_current_base IS NOT NULL AND balance_current_base<>'NaN'::numeric
      AND balance_one_year_ago_base IS NOT NULL AND balance_one_year_ago_base<>'NaN'::numeric
      AND balance_at_current_year_start_base IS NOT NULL AND balance_at_current_year_start_base<>'NaN'::numeric
      AND balance_at_previous_year_start_base IS NOT NULL AND balance_at_previous_year_start_base<>'NaN'::numeric
      AND balance_at_two_years_ago_start_base IS NOT NULL AND balance_at_two_years_ago_start_base<>'NaN'::numeric
      AND balance_current_base=round(balance_current_base,balance_currency_decimal_places)
      AND balance_one_year_ago_base=round(balance_one_year_ago_base,balance_currency_decimal_places)
      AND balance_at_current_year_start_base=round(balance_at_current_year_start_base,balance_currency_decimal_places)
      AND balance_at_previous_year_start_base=round(balance_at_previous_year_start_base,balance_currency_decimal_places)
      AND balance_at_two_years_ago_start_base=round(balance_at_two_years_ago_start_base,balance_currency_decimal_places)
    )
  );

-- NULL on an older approval means its generation is unknown. Never replace that
-- NULL with today's generation, and never FK history to the mutable current UUID.
ALTER TABLE account_balance_approvals ADD COLUMN source_generation uuid;

CREATE FUNCTION validate_account_balance_approval_generation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_generation uuid;
BEGIN
  -- This trigger sorts before the existing currency validator, so approval
  -- insertion takes the same company-first lock as reset, posting and refresh.
  PERFORM id FROM companies WHERE id=NEW.company_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'A balance approval requires the current company source generation'
      USING ERRCODE='23514', CONSTRAINT='account_balance_approvals_source_generation';
  END IF;
  SELECT generation INTO current_generation FROM account_balance_sources
    WHERE company_id=NEW.company_id FOR SHARE;
  IF NOT FOUND OR NEW.source_generation IS NULL OR NEW.source_generation IS DISTINCT FROM current_generation THEN
    RAISE EXCEPTION 'Balance approval source generation must match the current company generation'
      USING ERRCODE='23514', CONSTRAINT='account_balance_approvals_source_generation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER account_balance_approvals_00_generation BEFORE INSERT ON account_balance_approvals
  FOR EACH ROW EXECUTE FUNCTION validate_account_balance_approval_generation();

CREATE FUNCTION invalidate_account_balance_statistics(p_company integer,p_account integer)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM companies WHERE id=p_company FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM initialize_account_statistics(p_company,p_account);
  UPDATE account_statistics SET
    source_revision=source_revision+1,
    balance_state=CASE WHEN balance_state='ready' THEN 'stale' ELSE balance_state END,
    activity_state=CASE WHEN activity_state='ready' THEN 'stale' ELSE activity_state END,
    commerce_state=CASE WHEN commerce_state='ready' THEN 'stale' ELSE commerce_state END,
    stock_state=CASE WHEN stock_state='ready' THEN 'stale' ELSE stock_state END,
    updated_at=clock_timestamp()
  WHERE company_id=p_company AND account_id=p_account;
END $$;

CREATE FUNCTION invalidate_company_account_balance_statistics(p_company integer)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE affected_account integer;
BEGIN
  PERFORM id FROM companies WHERE id=p_company FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  FOR affected_account IN SELECT id FROM accounts
    WHERE company_id=p_company AND kind='posting' ORDER BY id
  LOOP
    PERFORM invalidate_account_balance_statistics(p_company,affected_account);
  END LOOP;
END $$;

CREATE FUNCTION invalidate_financial_document_account_balances() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected_account integer;
BEGIN
  IF NEW.status NOT IN ('posted','reversed') THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  END IF;
  FOR affected_account IN SELECT DISTINCT account_id FROM financial_document_lines
    WHERE company_id=NEW.company_id AND document_id=NEW.id ORDER BY account_id
  LOOP
    PERFORM invalidate_account_balance_statistics(NEW.company_id,affected_account);
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER financial_documents_account_balances AFTER INSERT OR UPDATE OF status ON financial_documents
  FOR EACH ROW EXECUTE FUNCTION invalidate_financial_document_account_balances();

-- A reset deletes financial lines before their parent documents. A statement
-- transition table avoids invalidating once for every line of the same account.
-- Ordinary replacement of draft lines does not change any posted balance.
CREATE FUNCTION invalidate_deleted_financial_line_balances() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected record;
BEGIN
  FOR affected IN
    SELECT DISTINCT l.company_id,l.account_id FROM deleted_balance_lines l
    JOIN financial_documents d ON d.company_id=l.company_id AND d.id=l.document_id
    WHERE d.status IN ('posted','reversed') ORDER BY l.company_id,l.account_id
  LOOP
    PERFORM invalidate_account_balance_statistics(affected.company_id,affected.account_id);
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER financial_lines_account_balances_deleted AFTER DELETE ON financial_document_lines
  REFERENCING OLD TABLE AS deleted_balance_lines
  FOR EACH STATEMENT EXECUTE FUNCTION invalidate_deleted_financial_line_balances();

CREATE FUNCTION invalidate_finance_settings_account_balances() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.base_currency_id IS NOT DISTINCT FROM OLD.base_currency_id THEN RETURN NEW; END IF;
  END IF;
  IF TG_OP='DELETE' THEN
    PERFORM invalidate_company_account_balance_statistics(OLD.company_id);
    RETURN OLD;
  END IF;
  PERFORM invalidate_company_account_balance_statistics(NEW.company_id);
  RETURN NEW;
END $$;
CREATE TRIGGER finance_settings_account_balances AFTER INSERT OR UPDATE OR DELETE ON finance_settings
  FOR EACH ROW EXECUTE FUNCTION invalidate_finance_settings_account_balances();

CREATE FUNCTION rotate_reset_account_balance_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM companies WHERE id=NEW.company_id FOR UPDATE;
  -- The server chooses a fresh generation even when a reset removed no lines.
  -- The client's idempotency UUID is a receipt key, never a source generation.
  INSERT INTO account_balance_sources(company_id,generation,updated_at)
    VALUES(NEW.company_id,gen_random_uuid(),clock_timestamp())
    ON CONFLICT (company_id) DO UPDATE SET
      generation=EXCLUDED.generation,updated_at=EXCLUDED.updated_at;
  PERFORM invalidate_company_account_balance_statistics(NEW.company_id);
  RETURN NEW;
END $$;
CREATE TRIGGER company_transaction_resets_balance_source AFTER INSERT ON company_transaction_resets
  FOR EACH ROW EXECUTE FUNCTION rotate_reset_account_balance_source();

CREATE FUNCTION refresh_account_balance_statistics(p_company integer,p_account integer,p_asof date)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  today_in_aden date := (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date;
  cached account_statistics%ROWTYPE;
  current_generation uuid;
  current_currency_id integer;
  current_currency_code text;
  current_currency_places integer;
  prior_year_date date;
  current_year_start date;
  previous_year_start date;
  two_years_ago_start date;
  current_balance numeric;
  one_year_ago_balance numeric;
  current_year_balance numeric;
  previous_year_balance numeric;
  two_years_ago_balance numeric;
BEGIN
  IF p_asof IS NULL OR p_asof<DATE '0003-01-01' OR p_asof>today_in_aden THEN
    RAISE EXCEPTION 'Balance date must be between 0003-01-01 and the current Asia/Aden date'
      USING ERRCODE='22023';
  END IF;

  -- All application financial mutations and reset take this company lock first.
  -- The caller must still check the current actor, company and page permissions.
  PERFORM id FROM companies WHERE id=p_company FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM id FROM accounts WHERE company_id=p_company AND id=p_account AND kind='posting' FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM initialize_account_statistics(p_company,p_account);
  SELECT * INTO cached FROM account_statistics
    WHERE company_id=p_company AND account_id=p_account FOR UPDATE;

  SELECT generation INTO current_generation FROM account_balance_sources
    WHERE company_id=p_company FOR SHARE;
  IF NOT FOUND THEN
    UPDATE account_statistics SET balance_state='stale',updated_at=clock_timestamp()
      WHERE company_id=p_company AND account_id=p_account AND balance_state='ready';
    RETURN false;
  END IF;
  SELECT base_currency_id INTO current_currency_id FROM finance_settings
    WHERE company_id=p_company FOR SHARE;
  IF NOT FOUND THEN
    UPDATE account_statistics SET balance_state='stale',updated_at=clock_timestamp()
      WHERE company_id=p_company AND account_id=p_account AND balance_state='ready';
    RETURN false;
  END IF;
  SELECT code,decimal_places INTO current_currency_code,current_currency_places FROM company_currencies
    WHERE company_id=p_company AND id=current_currency_id AND active FOR SHARE;
  IF NOT FOUND THEN
    UPDATE account_statistics SET balance_state='stale',updated_at=clock_timestamp()
      WHERE company_id=p_company AND account_id=p_account AND balance_state='ready';
    RETURN false;
  END IF;

  IF cached.balance_state='ready' AND cached.policy_version=1
    AND cached.balance_computed_revision=cached.source_revision
    AND cached.balance_as_of_date=p_asof AND cached.balance_generation=current_generation
    AND cached.balance_currency_id=current_currency_id AND cached.balance_currency_code=current_currency_code
    AND cached.balance_currency_decimal_places=current_currency_places THEN
    RETURN true;
  END IF;

  prior_year_date := (p_asof-interval '1 year')::date;
  current_year_start := make_date(extract(year FROM p_asof)::integer,1,1);
  previous_year_start := (current_year_start-interval '1 year')::date;
  two_years_ago_start := (current_year_start-interval '2 years')::date;

  SELECT
    COALESCE(sum(l.base_debit-l.base_credit),0),
    COALESCE(sum(l.base_debit-l.base_credit) FILTER (WHERE d.document_date<=prior_year_date),0),
    COALESCE(sum(l.base_debit-l.base_credit) FILTER (WHERE d.document_date<current_year_start),0),
    COALESCE(sum(l.base_debit-l.base_credit) FILTER (WHERE d.document_date<previous_year_start),0),
    COALESCE(sum(l.base_debit-l.base_credit) FILTER (WHERE d.document_date<two_years_ago_start),0)
  INTO current_balance,one_year_ago_balance,current_year_balance,previous_year_balance,two_years_ago_balance
  FROM financial_document_lines l
  JOIN financial_documents d ON d.company_id=l.company_id AND d.id=l.document_id
  WHERE l.company_id=p_company AND l.account_id=p_account
    AND d.status IN ('posted','reversed') AND d.document_date<=p_asof;

  UPDATE account_statistics SET
    policy_version=1,
    balance_current_base=current_balance,
    balance_one_year_ago_base=one_year_ago_balance,
    balance_at_current_year_start_base=current_year_balance,
    balance_at_previous_year_start_base=previous_year_balance,
    balance_at_two_years_ago_start_base=two_years_ago_balance,
    balance_currency_id=current_currency_id,
    balance_currency_code=current_currency_code,
    balance_currency_decimal_places=current_currency_places,
    balance_generation=current_generation,
    balance_state='ready',balance_computed_revision=source_revision,
    balance_as_of_date=p_asof,balance_computed_at=clock_timestamp(),updated_at=clock_timestamp()
  WHERE company_id=p_company AND account_id=p_account;
  RETURN true;
END $$;
