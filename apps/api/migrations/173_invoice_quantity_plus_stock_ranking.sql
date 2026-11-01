-- Cached net sold quantities for invoice-item suggestion ordering.
-- No invoice, stock movement, ledger or financial balance is changed.
LOCK TABLE companies IN EXCLUSIVE MODE;
ALTER TABLE item_sale_rankings ADD COLUMN net_sale_quantity numeric NOT NULL DEFAULT 0;
ALTER TABLE staged_item_sale_rankings ADD COLUMN net_sale_quantity numeric NOT NULL DEFAULT 0;

INSERT INTO item_sale_rankings(company_id,item_id,as_of_date,net_sale_invoices,net_sale_quantity)
SELECT d.company_id,d.item_id,ready.as_of_date,0,SUM(d.sale_quantity-d.sale_return_quantity)
FROM item_sale_ranking_days ready JOIN item_daily_activity d
 ON d.document_date BETWEEN (ready.as_of_date-interval '1 month'+interval '1 day')::date AND ready.as_of_date
GROUP BY d.company_id,d.item_id,ready.as_of_date
HAVING SUM(d.sale_quantity-d.sale_return_quantity)<>0
ON CONFLICT(company_id,as_of_date,item_id) DO UPDATE SET net_sale_quantity=EXCLUDED.net_sale_quantity;
INSERT INTO staged_item_sale_rankings(company_id,item_id,as_of_date,net_sale_invoices,net_sale_quantity)
SELECT d.company_id,d.item_id,ready.as_of_date,0,SUM(d.sale_quantity-d.sale_return_quantity)
FROM staged_item_sale_ranking_days ready JOIN staged_item_daily_activity_cache d
 ON d.document_date BETWEEN (ready.as_of_date-interval '1 month'+interval '1 day')::date AND ready.as_of_date
GROUP BY d.company_id,d.item_id,ready.as_of_date
HAVING SUM(d.sale_quantity-d.sale_return_quantity)<>0
ON CONFLICT(company_id,item_id,as_of_date) DO UPDATE SET net_sale_quantity=EXCLUDED.net_sale_quantity;

CREATE OR REPLACE FUNCTION prepare_item_sale_rankings(
 p_day date DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Aden')::date
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE missing_days date[];
BEGIN
 IF p_day IS NULL THEN RAISE EXCEPTION 'A ranking date is required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext(current_schema()||':item-sale-ranking-days'));
 SELECT array_agg(day) INTO missing_days
 FROM (SELECT p_day+offset_days AS day FROM generate_series(-1,1) offsets(offset_days)) target
 WHERE NOT EXISTS (SELECT 1 FROM item_sale_ranking_days ready WHERE ready.as_of_date=target.day);
 IF missing_days IS NOT NULL OR EXISTS
  (SELECT 1 FROM item_sale_ranking_days WHERE as_of_date<p_day-1)
 THEN LOCK TABLE companies IN EXCLUSIVE MODE; END IF;
 IF missing_days IS NOT NULL THEN
  INSERT INTO item_sale_ranking_days(as_of_date) SELECT unnest(missing_days);
  INSERT INTO item_sale_rankings(company_id,item_id,as_of_date,net_sale_invoices,net_sale_quantity)
   SELECT d.company_id,d.item_id,target.day,
    SUM(d.sale_invoices::numeric-d.sale_return_invoices),
    SUM(d.sale_quantity-d.sale_return_quantity)
   FROM unnest(missing_days) target(day)
   JOIN item_daily_activity d ON d.document_date BETWEEN
    (target.day-INTERVAL '1 month'+INTERVAL '1 day')::date AND target.day
   GROUP BY d.company_id,d.item_id,target.day
   HAVING SUM(d.sale_invoices::numeric-d.sale_return_invoices)<>0
      OR SUM(d.sale_quantity-d.sale_return_quantity)<>0;
 END IF;
 DELETE FROM item_sale_ranking_days WHERE as_of_date<p_day-1;
END; $$;

CREATE OR REPLACE FUNCTION apply_item_sale_ranking_delta(
 p_company integer,p_item integer,p_date date,p_delta numeric
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF p_delta=0 THEN RETURN; END IF;
 PERFORM id FROM companies WHERE id=p_company FOR UPDATE;
 INSERT INTO item_sale_rankings AS cached(company_id,item_id,as_of_date,net_sale_invoices)
  SELECT p_company,p_item,as_of_date,p_delta FROM item_sale_ranking_days
  WHERE p_date BETWEEN (as_of_date-INTERVAL '1 month'+INTERVAL '1 day')::date AND as_of_date
  ORDER BY as_of_date
  ON CONFLICT(company_id,as_of_date,item_id) DO UPDATE
   SET net_sale_invoices=cached.net_sale_invoices+EXCLUDED.net_sale_invoices;
 DELETE FROM item_sale_rankings WHERE company_id=p_company AND item_id=p_item
  AND net_sale_invoices=0 AND net_sale_quantity=0;
END; $$;

CREATE FUNCTION apply_item_sale_quantity_delta(
 p_company integer,p_item integer,p_date date,p_delta numeric
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF p_delta=0 THEN RETURN; END IF;
 PERFORM id FROM companies WHERE id=p_company FOR UPDATE;
 INSERT INTO item_sale_rankings AS cached(company_id,item_id,as_of_date,net_sale_quantity,net_sale_invoices)
  SELECT p_company,p_item,as_of_date,p_delta,0 FROM item_sale_ranking_days
  WHERE p_date BETWEEN (as_of_date-INTERVAL '1 month'+INTERVAL '1 day')::date AND as_of_date
  ORDER BY as_of_date
  ON CONFLICT(company_id,as_of_date,item_id) DO UPDATE
   SET net_sale_quantity=cached.net_sale_quantity+EXCLUDED.net_sale_quantity;
 DELETE FROM item_sale_rankings WHERE company_id=p_company AND item_id=p_item
  AND net_sale_invoices=0 AND net_sale_quantity=0;
END; $$;

CREATE OR REPLACE FUNCTION update_item_sale_rankings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND
  (OLD.company_id,OLD.item_id,OLD.document_date,OLD.sale_invoices,OLD.sale_return_invoices,
   OLD.sale_quantity,OLD.sale_return_quantity)
  IS NOT DISTINCT FROM
  (NEW.company_id,NEW.item_id,NEW.document_date,NEW.sale_invoices,NEW.sale_return_invoices,
   NEW.sale_quantity,NEW.sale_return_quantity)
 THEN RETURN NULL; END IF;
 IF TG_OP IN ('UPDATE','DELETE') THEN
  PERFORM apply_item_sale_ranking_delta(OLD.company_id,OLD.item_id,OLD.document_date,
   OLD.sale_return_invoices::numeric-OLD.sale_invoices);
  PERFORM apply_item_sale_quantity_delta(OLD.company_id,OLD.item_id,OLD.document_date,
   OLD.sale_return_quantity-OLD.sale_quantity);
 END IF;
 IF TG_OP IN ('INSERT','UPDATE') THEN
  PERFORM apply_item_sale_ranking_delta(NEW.company_id,NEW.item_id,NEW.document_date,
   NEW.sale_invoices::numeric-NEW.sale_return_invoices);
  PERFORM apply_item_sale_quantity_delta(NEW.company_id,NEW.item_id,NEW.document_date,
   NEW.sale_quantity-NEW.sale_return_quantity);
 END IF;
 RETURN NULL;
END; $$;

CREATE OR REPLACE FUNCTION prepare_staged_item_sale_rankings()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE as_of date := (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Aden')::date;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('staged_item_sale_ranking_prepare'));
 IF EXISTS (SELECT 1 FROM staged_item_sale_ranking_days WHERE as_of_date=as_of) THEN RETURN; END IF;
 INSERT INTO staged_item_sale_rankings(company_id,item_id,as_of_date,net_sale_invoices,net_sale_quantity)
 SELECT company_id,item_id,as_of,
  SUM(sale_invoices-sale_return_invoices)::bigint,
  SUM(sale_quantity-sale_return_quantity)
 FROM staged_item_daily_activity_cache
 WHERE document_date BETWEEN (as_of-interval '1 month'+interval '1 day')::date AND as_of
 GROUP BY company_id,item_id
 ON CONFLICT(company_id,item_id,as_of_date) DO UPDATE SET
  net_sale_invoices=EXCLUDED.net_sale_invoices,
  net_sale_quantity=EXCLUDED.net_sale_quantity;
 INSERT INTO staged_item_sale_ranking_days(as_of_date) VALUES(as_of) ON CONFLICT DO NOTHING;
 DELETE FROM staged_item_sale_rankings WHERE as_of_date < as_of - 7;
 DELETE FROM staged_item_sale_ranking_days WHERE as_of_date < as_of - 7;
END; $$;

CREATE FUNCTION apply_staged_item_sale_ranking_delta(
 p_company integer,p_item integer,p_date date,p_times bigint,p_qty numeric
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF p_times=0 AND p_qty=0 THEN RETURN; END IF;
 INSERT INTO staged_item_sale_rankings AS cached
  (company_id,item_id,as_of_date,net_sale_invoices,net_sale_quantity)
 SELECT p_company,p_item,as_of_date,p_times,p_qty FROM staged_item_sale_ranking_days
 WHERE p_date BETWEEN (as_of_date-interval '1 month'+interval '1 day')::date AND as_of_date
 ORDER BY as_of_date
 ON CONFLICT(company_id,item_id,as_of_date) DO UPDATE SET
  net_sale_invoices=cached.net_sale_invoices+EXCLUDED.net_sale_invoices,
  net_sale_quantity=cached.net_sale_quantity+EXCLUDED.net_sale_quantity;
 DELETE FROM staged_item_sale_rankings WHERE company_id=p_company AND item_id=p_item
  AND net_sale_invoices=0 AND net_sale_quantity=0;
END; $$;

CREATE OR REPLACE FUNCTION update_staged_item_sale_rankings()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND
  (OLD.company_id,OLD.item_id,OLD.document_date,OLD.sale_invoices,OLD.sale_return_invoices,
   OLD.sale_quantity,OLD.sale_return_quantity)
  IS NOT DISTINCT FROM
  (NEW.company_id,NEW.item_id,NEW.document_date,NEW.sale_invoices,NEW.sale_return_invoices,
   NEW.sale_quantity,NEW.sale_return_quantity)
 THEN RETURN NULL; END IF;
 IF TG_OP IN ('DELETE','UPDATE') THEN
  PERFORM apply_staged_item_sale_ranking_delta(OLD.company_id,OLD.item_id,OLD.document_date,
   OLD.sale_return_invoices-OLD.sale_invoices,OLD.sale_return_quantity-OLD.sale_quantity);
 END IF;
 IF TG_OP IN ('INSERT','UPDATE') THEN
  PERFORM apply_staged_item_sale_ranking_delta(NEW.company_id,NEW.item_id,NEW.document_date,
   NEW.sale_invoices-NEW.sale_return_invoices,NEW.sale_quantity-NEW.sale_return_quantity);
 END IF;
 RETURN NULL;
END; $$;
