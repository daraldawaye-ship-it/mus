-- Current stock attribution follows the item card's one current supplier.
-- Each company/item valuation pool contributes once, independently of its
-- locations, batches, item activity flag or historical invoice supplier.
ALTER TABLE account_statistics
  ADD COLUMN stock_value_base numeric(38,6),
  ADD COLUMN stock_confirmed_value_base numeric(38,6),
  ADD COLUMN stock_inferred_value_base numeric(38,6),
  ADD COLUMN stock_assigned_items_count bigint,
  ADD COLUMN stock_inferred_items_count bigint,
  ADD COLUMN stock_negative_items_count bigint,
  ADD COLUMN stock_negative_value_base numeric(38,6),
  ADD COLUMN stock_currency_id integer,
  ADD COLUMN stock_currency_code text,
  ADD COLUMN stock_currency_decimal_places integer,
  ADD COLUMN stock_generation uuid,
  ADD CONSTRAINT account_statistics_stock_currency_fk
    FOREIGN KEY (company_id,stock_currency_id) REFERENCES company_currencies(company_id,id),
  ADD CONSTRAINT account_statistics_stock_currency_code
    CHECK (stock_currency_code ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT account_statistics_stock_currency_precision
    CHECK (stock_currency_decimal_places BETWEEN 0 AND 6);

-- A foundation readiness marker does not contain this projection. Preserve
-- its metadata without presenting it as a calculated stock value.
UPDATE account_statistics SET stock_state='stale' WHERE stock_state='ready';

ALTER TABLE account_statistics
  ADD CONSTRAINT account_statistics_stock_ready_snapshot CHECK (
    stock_state<>'ready' OR (
      policy_version=1
      AND stock_computed_revision IS NOT NULL AND stock_computed_revision=source_revision
      AND stock_as_of_date IS NOT NULL AND stock_computed_at IS NOT NULL
      AND stock_generation IS NOT NULL
      AND stock_currency_id IS NOT NULL AND stock_currency_code IS NOT NULL
      AND stock_currency_decimal_places IS NOT NULL
      AND stock_value_base IS NOT NULL
      AND stock_value_base NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)
      AND stock_confirmed_value_base IS NOT NULL
      AND stock_confirmed_value_base NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)
      AND stock_inferred_value_base IS NOT NULL
      AND stock_inferred_value_base NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)
      AND stock_negative_value_base IS NOT NULL
      AND stock_negative_value_base NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)
      AND stock_value_base=stock_confirmed_value_base+stock_inferred_value_base
      AND stock_value_base=round(stock_value_base,stock_currency_decimal_places)
      AND stock_confirmed_value_base=round(stock_confirmed_value_base,stock_currency_decimal_places)
      AND stock_inferred_value_base=round(stock_inferred_value_base,stock_currency_decimal_places)
      AND stock_negative_value_base=round(stock_negative_value_base,stock_currency_decimal_places)
      AND stock_assigned_items_count IS NOT NULL AND stock_assigned_items_count>=0
      AND stock_inferred_items_count IS NOT NULL AND stock_inferred_items_count>=0
      AND stock_inferred_items_count<=stock_assigned_items_count
      AND stock_negative_items_count IS NOT NULL AND stock_negative_items_count>=0
      AND stock_negative_items_count<=stock_assigned_items_count
    )
  );

-- A stock-only change must not advance the financial source revision or alter
-- the balance quote used for a human approval. Rebuild only on an allowed read.
CREATE FUNCTION invalidate_account_stock_statistics(p_company integer,p_account integer)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM companies WHERE id=p_company FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM initialize_account_statistics(p_company,p_account);
  UPDATE account_statistics SET stock_state='stale',updated_at=clock_timestamp()
    WHERE company_id=p_company AND account_id=p_account AND stock_state='ready';
END $$;

CREATE FUNCTION invalidate_item_supplier_stock_statistics() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous_company integer;
  previous_supplier integer;
  next_company integer;
  next_supplier integer;
  affected record;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.supplier_account_id,NEW.supplier_inferred)
      IS NOT DISTINCT FROM ROW(OLD.supplier_account_id,OLD.supplier_inferred) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP<>'INSERT' THEN
    previous_company := OLD.company_id;
    previous_supplier := OLD.supplier_account_id;
  END IF;
  IF TG_OP<>'DELETE' THEN
    next_company := NEW.company_id;
    next_supplier := NEW.supplier_account_id;
  END IF;
  FOR affected IN
    SELECT DISTINCT scope.company_id,scope.account_id
    FROM (VALUES(previous_company,previous_supplier),(next_company,next_supplier)) AS scope(company_id,account_id)
    WHERE scope.company_id IS NOT NULL AND scope.account_id IS NOT NULL
    ORDER BY scope.company_id,scope.account_id
  LOOP
    PERFORM invalidate_account_stock_statistics(affected.company_id,affected.account_id);
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER items_account_stock_statistics
  AFTER INSERT OR UPDATE OF supplier_account_id,supplier_inferred OR DELETE ON items
  FOR EACH ROW EXECUTE FUNCTION invalidate_item_supplier_stock_statistics();

CREATE FUNCTION invalidate_valuation_supplier_stock_statistics() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous_company integer;
  previous_item integer;
  next_company integer;
  next_item integer;
  affected record;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.company_id,NEW.item_id,NEW.quantity_smallest,NEW.value_base)
      IS NOT DISTINCT FROM ROW(OLD.company_id,OLD.item_id,OLD.quantity_smallest,OLD.value_base) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP<>'INSERT' THEN
    previous_company := OLD.company_id;
    previous_item := OLD.item_id;
  END IF;
  IF TG_OP<>'DELETE' THEN
    next_company := NEW.company_id;
    next_item := NEW.item_id;
  END IF;
  FOR affected IN
    SELECT DISTINCT i.company_id,i.supplier_account_id AS account_id
    FROM items i JOIN (
      VALUES(previous_company,previous_item),(next_company,next_item)
    ) AS scope(company_id,item_id) ON scope.company_id=i.company_id AND scope.item_id=i.id
    WHERE i.supplier_account_id IS NOT NULL
    ORDER BY i.company_id,i.supplier_account_id
  LOOP
    PERFORM invalidate_account_stock_statistics(affected.company_id,affected.account_id);
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER valuations_account_stock_statistics AFTER INSERT OR UPDATE OR DELETE ON stock_item_valuations
  FOR EACH ROW EXECUTE FUNCTION invalidate_valuation_supplier_stock_statistics();

CREATE FUNCTION refresh_account_stock_statistics(p_company integer,p_account integer)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  today_in_aden date := (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date;
  cached account_statistics%ROWTYPE;
  current_generation uuid;
  current_currency_id integer;
  current_currency_code text;
  current_currency_places integer;
  total_value numeric;
  confirmed_value numeric;
  inferred_value numeric;
  assigned_items bigint;
  inferred_items bigint;
  negative_items bigint;
  negative_value numeric;
BEGIN
  -- Application posting, item edits and resets also acquire this company lock
  -- first. Callers still enforce current membership, pages and value grants.
  PERFORM id FROM companies WHERE id=p_company FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM id FROM accounts WHERE company_id=p_company AND id=p_account AND kind='posting' FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM initialize_account_statistics(p_company,p_account);
  SELECT * INTO cached FROM account_statistics
    WHERE company_id=p_company AND account_id=p_account FOR UPDATE;

  SELECT generation INTO current_generation FROM account_balance_sources WHERE company_id=p_company FOR SHARE;
  IF NOT FOUND THEN
    PERFORM invalidate_account_stock_statistics(p_company,p_account);
    RETURN false;
  END IF;
  SELECT base_currency_id INTO current_currency_id FROM finance_settings WHERE company_id=p_company FOR SHARE;
  IF NOT FOUND THEN
    PERFORM invalidate_account_stock_statistics(p_company,p_account);
    RETURN false;
  END IF;
  SELECT code,decimal_places INTO current_currency_code,current_currency_places FROM company_currencies
    WHERE company_id=p_company AND id=current_currency_id AND active FOR SHARE;
  IF NOT FOUND THEN
    PERFORM invalidate_account_stock_statistics(p_company,p_account);
    RETURN false;
  END IF;

  IF cached.policy_version=1 AND cached.stock_state='ready'
    AND cached.stock_computed_revision=cached.source_revision
    AND cached.stock_as_of_date=today_in_aden AND cached.stock_generation=current_generation
    AND cached.stock_currency_id=current_currency_id AND cached.stock_currency_code=current_currency_code
    AND cached.stock_currency_decimal_places=current_currency_places THEN
    RETURN true;
  END IF;

  -- This is a current transaction-state snapshot, including already posted
  -- future-dated movements. No historical as-of date is inferred from the pool.
  -- The pool PK ensures one contribution per item; never join stock_balances.
  SELECT
    COALESCE(sum(COALESCE(v.value_base,0)),0),
    COALESCE(sum(COALESCE(v.value_base,0)) FILTER (WHERE NOT i.supplier_inferred),0),
    COALESCE(sum(COALESCE(v.value_base,0)) FILTER (WHERE i.supplier_inferred),0),
    count(*),
    count(*) FILTER (WHERE i.supplier_inferred),
    count(*) FILTER (WHERE v.quantity_smallest<0),
    COALESCE(sum(v.value_base) FILTER (WHERE v.quantity_smallest<0),0)
  INTO total_value,confirmed_value,inferred_value,assigned_items,inferred_items,negative_items,negative_value
  FROM items i LEFT JOIN stock_item_valuations v ON v.company_id=i.company_id AND v.item_id=i.id
  WHERE i.company_id=p_company AND i.supplier_account_id=p_account;

  UPDATE account_statistics SET
    policy_version=1,
    stock_value_base=total_value,
    stock_confirmed_value_base=confirmed_value,
    stock_inferred_value_base=inferred_value,
    stock_assigned_items_count=assigned_items,
    stock_inferred_items_count=inferred_items,
    stock_negative_items_count=negative_items,
    stock_negative_value_base=negative_value,
    stock_currency_id=current_currency_id,
    stock_currency_code=current_currency_code,
    stock_currency_decimal_places=current_currency_places,
    stock_generation=current_generation,
    stock_state='ready',stock_computed_revision=source_revision,
    stock_as_of_date=today_in_aden,stock_computed_at=clock_timestamp(),updated_at=clock_timestamp()
  WHERE company_id=p_company AND account_id=p_account;
  RETURN true;
END $$;
