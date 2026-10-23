-- Ready, dated monthly sale counts. Search reads these rows without aggregating
-- daily activity. Tomorrow is prepared ahead of midnight in Asia/Aden.
-- Acquire normal mutation locks before DDL takes locks on their source tables.
LOCK TABLE companies IN EXCLUSIVE MODE;

CREATE TABLE item_sale_ranking_days (
  as_of_date date PRIMARY KEY
);

CREATE TABLE item_sale_rankings (
  company_id integer NOT NULL,
  item_id integer NOT NULL,
  as_of_date date NOT NULL REFERENCES item_sale_ranking_days(as_of_date) ON DELETE CASCADE,
  net_sale_invoices numeric(40,0) NOT NULL,
  PRIMARY KEY (company_id,as_of_date,item_id),
  FOREIGN KEY (company_id,item_id) REFERENCES items(company_id,id) ON DELETE CASCADE
);
CREATE INDEX item_sale_rankings_order
  ON item_sale_rankings(company_id,as_of_date,net_sale_invoices DESC,item_id);

CREATE FUNCTION prepare_item_sale_rankings(
  p_day date DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Aden')::date
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  missing_days date[];
BEGIN
  IF p_day IS NULL THEN RAISE EXCEPTION 'A ranking date is required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(current_schema()||':item-sale-ranking-days'));
  SELECT array_agg(day) INTO missing_days
  FROM (SELECT p_day+offset_days AS day FROM generate_series(-1,1) offsets(offset_days)) target
  WHERE NOT EXISTS (SELECT 1 FROM item_sale_ranking_days ready WHERE ready.as_of_date=target.day);

  IF missing_days IS NOT NULL OR EXISTS (
    SELECT 1 FROM item_sale_ranking_days WHERE as_of_date<p_day-1
  ) THEN
    -- Wait for existing company mutations and block new ones, including new
    -- companies, while dates are prepared. Plain search reads continue.
    -- A table lock avoids row-lock/table-lock upgrades in company editing.
    LOCK TABLE companies IN EXCLUSIVE MODE;
  END IF;
  IF missing_days IS NOT NULL THEN
    INSERT INTO item_sale_ranking_days(as_of_date) SELECT unnest(missing_days);
    INSERT INTO item_sale_rankings(company_id,item_id,as_of_date,net_sale_invoices)
      SELECT d.company_id,d.item_id,target.day,
        SUM(d.sale_invoices::numeric-d.sale_return_invoices)
      FROM unnest(missing_days) target(day)
      JOIN item_daily_activity d ON d.document_date BETWEEN
        (target.day-INTERVAL '1 month'+INTERVAL '1 day')::date AND target.day
      GROUP BY d.company_id,d.item_id,target.day
      HAVING SUM(d.sale_invoices::numeric-d.sale_return_invoices)<>0;
  END IF;
  -- Keep yesterday for requests whose transaction began before midnight.
  DELETE FROM item_sale_ranking_days WHERE as_of_date<p_day-1;
END;
$$;

CREATE FUNCTION apply_item_sale_ranking_delta(
  p_company integer,p_item integer,p_date date,p_delta numeric
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_delta=0 THEN RETURN; END IF;
  PERFORM id FROM companies WHERE id=p_company FOR UPDATE;
  INSERT INTO item_sale_rankings AS cached(company_id,item_id,as_of_date,net_sale_invoices)
    SELECT p_company,p_item,as_of_date,p_delta FROM item_sale_ranking_days
    WHERE p_date BETWEEN (as_of_date-INTERVAL '1 month'+INTERVAL '1 day')::date AND as_of_date
    ORDER BY as_of_date
    ON CONFLICT (company_id,as_of_date,item_id) DO UPDATE
      SET net_sale_invoices=cached.net_sale_invoices+EXCLUDED.net_sale_invoices;
  DELETE FROM item_sale_rankings
    WHERE company_id=p_company AND item_id=p_item AND net_sale_invoices=0;
END;
$$;

CREATE FUNCTION update_item_sale_rankings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND
    (OLD.company_id,OLD.item_id,OLD.document_date,OLD.sale_invoices,OLD.sale_return_invoices)
    IS NOT DISTINCT FROM
    (NEW.company_id,NEW.item_id,NEW.document_date,NEW.sale_invoices,NEW.sale_return_invoices)
  THEN RETURN NULL; END IF;
  IF TG_OP IN ('UPDATE','DELETE') THEN
    PERFORM apply_item_sale_ranking_delta(OLD.company_id,OLD.item_id,OLD.document_date,
      OLD.sale_return_invoices::numeric-OLD.sale_invoices);
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    PERFORM apply_item_sale_ranking_delta(NEW.company_id,NEW.item_id,NEW.document_date,
      NEW.sale_invoices::numeric-NEW.sale_return_invoices);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER item_daily_activity_sale_rankings
  AFTER INSERT OR UPDATE OR DELETE ON item_daily_activity
  FOR EACH ROW EXECUTE FUNCTION update_item_sale_rankings();

SELECT prepare_item_sale_rankings();
