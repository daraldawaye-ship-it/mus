-- Monthly staged sale frequency is materialized once per Aden day and maintained
-- incrementally when staged invoice contributions change. Search never aggregates
-- invoice JSON or the full daily activity table.
CREATE TABLE IF NOT EXISTS staged_item_sale_rankings (
  company_id integer NOT NULL,
  item_id integer NOT NULL,
  as_of_date date NOT NULL,
  net_sale_invoices bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(company_id,item_id,as_of_date)
);
CREATE INDEX IF NOT EXISTS staged_item_sale_rankings_day
  ON staged_item_sale_rankings(as_of_date,company_id,item_id);
CREATE TABLE IF NOT EXISTS staged_item_sale_ranking_days (
  as_of_date date PRIMARY KEY
);

CREATE OR REPLACE FUNCTION prepare_staged_item_sale_rankings()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  as_of date := (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Aden')::date;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('staged_item_sale_ranking_prepare'));
  IF EXISTS (SELECT 1 FROM staged_item_sale_ranking_days WHERE as_of_date=as_of) THEN
    RETURN;
  END IF;
  INSERT INTO staged_item_sale_rankings(company_id,item_id,as_of_date,net_sale_invoices)
  SELECT company_id,item_id,as_of,
    sum(sale_invoices-sale_return_invoices)::bigint
  FROM staged_item_daily_activity_cache
  WHERE document_date BETWEEN (as_of-interval '1 month'+interval '1 day')::date AND as_of
  GROUP BY company_id,item_id
  ON CONFLICT(company_id,item_id,as_of_date) DO UPDATE
    SET net_sale_invoices=EXCLUDED.net_sale_invoices;
  INSERT INTO staged_item_sale_ranking_days(as_of_date) VALUES(as_of)
  ON CONFLICT DO NOTHING;
  DELETE FROM staged_item_sale_rankings WHERE as_of_date < as_of - 7;
  DELETE FROM staged_item_sale_ranking_days WHERE as_of_date < as_of - 7;
END $$;

CREATE OR REPLACE FUNCTION update_staged_item_sale_rankings()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  as_of date := (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Aden')::date;
  diff bigint;
  activity_date date;
  activity_company integer;
  activity_item integer;
BEGIN
  IF TG_OP='INSERT' THEN
    diff := NEW.sale_invoices-NEW.sale_return_invoices;
    activity_date := NEW.document_date;
    activity_company := NEW.company_id;
    activity_item := NEW.item_id;
  ELSIF TG_OP='DELETE' THEN
    diff := -(OLD.sale_invoices-OLD.sale_return_invoices);
    activity_date := OLD.document_date;
    activity_company := OLD.company_id;
    activity_item := OLD.item_id;
  ELSE
    diff := (NEW.sale_invoices-NEW.sale_return_invoices)
          - (OLD.sale_invoices-OLD.sale_return_invoices);
    activity_date := NEW.document_date;
    activity_company := NEW.company_id;
    activity_item := NEW.item_id;
  END IF;
  IF diff=0 OR NOT EXISTS (SELECT 1 FROM staged_item_sale_ranking_days WHERE as_of_date=as_of)
    THEN RETURN NULL; END IF;
  IF activity_date
      BETWEEN (as_of-interval '1 month'+interval '1 day')::date AND as_of THEN
    INSERT INTO staged_item_sale_rankings AS ranking
      (company_id,item_id,as_of_date,net_sale_invoices)
    VALUES (activity_company,activity_item,as_of,diff)
    ON CONFLICT(company_id,item_id,as_of_date) DO UPDATE
      SET net_sale_invoices=ranking.net_sale_invoices+EXCLUDED.net_sale_invoices;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER staged_monthly_rank_insert
  AFTER INSERT ON staged_item_daily_activity_cache
  FOR EACH ROW EXECUTE FUNCTION update_staged_item_sale_rankings();
CREATE TRIGGER staged_monthly_rank_update
  AFTER UPDATE ON staged_item_daily_activity_cache
  FOR EACH ROW EXECUTE FUNCTION update_staged_item_sale_rankings();
CREATE TRIGGER staged_monthly_rank_delete
  AFTER DELETE ON staged_item_daily_activity_cache
  FOR EACH ROW EXECUTE FUNCTION update_staged_item_sale_rankings();

SELECT prepare_staged_item_sale_rankings();
