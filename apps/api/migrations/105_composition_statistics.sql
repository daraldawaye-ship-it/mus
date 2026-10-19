-- Rebuildable read projections for composition price groups.
-- Grouping uses the current item-card selling price:
-- NULL threshold -> one "all" group; ZERO threshold -> all items "higher"
-- including free/unpriced items; positive threshold -> positive price
-- strictly above belongs "higher", zero/unpriced and <= threshold "lower".
-- Do not modify invoices, item unit prices, stock movements or daily facts.

CREATE TABLE item_composition_statistics (
  company_id integer NOT NULL,
  composition_id integer NOT NULL,
  group_key text NOT NULL CHECK (group_key IN ('all','higher','lower')),
  linked_items integer NOT NULL DEFAULT 0,
  available_alternatives integer NOT NULL DEFAULT 0,
  available_unit1 numeric NOT NULL DEFAULT 0,
  minimum_sale_price numeric,
  maximum_sale_price numeric,
  minimum_purchase_price numeric,
  maximum_purchase_price numeric,
  top_selling_item_id integer,
  top_selling_item_name text,
  top_selling_times numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(company_id,composition_id,group_key),
  FOREIGN KEY(company_id,composition_id) REFERENCES item_compositions(company_id,id),
  FOREIGN KEY(company_id,top_selling_item_id) REFERENCES items(company_id,id)
);

CREATE TABLE item_composition_daily_statistics (
  company_id integer NOT NULL,
  composition_id integer NOT NULL,
  group_key text NOT NULL CHECK(group_key IN ('all','higher','lower')),
  document_date date NOT NULL,
  sale_times numeric NOT NULL DEFAULT 0,
  sale_unit1 numeric NOT NULL DEFAULT 0,
  purchase_times numeric NOT NULL DEFAULT 0,
  purchase_unit1 numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(company_id,composition_id,group_key,document_date),
  FOREIGN KEY(company_id,composition_id) REFERENCES item_compositions(company_id,id)
);
CREATE INDEX composition_daily_stats_lookup
  ON item_composition_daily_statistics(company_id,composition_id,document_date);

CREATE OR REPLACE FUNCTION composition_price_group(
  p_threshold numeric,p_price numeric
) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_threshold IS NULL THEN 'all'
    WHEN p_threshold=0 THEN 'higher'
    WHEN COALESCE(p_price,0)>p_threshold THEN 'higher'
    ELSE 'lower' END
$$;

CREATE OR REPLACE FUNCTION refresh_composition_summary(p_company integer,p_composition integer)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(p_company,p_composition);
  DELETE FROM item_composition_statistics WHERE company_id=p_company AND composition_id=p_composition;
  INSERT INTO item_composition_statistics(
    company_id,composition_id,group_key,linked_items,available_alternatives,
    available_unit1,minimum_sale_price,maximum_sale_price,
    minimum_purchase_price,maximum_purchase_price,
    top_selling_item_id,top_selling_item_name,top_selling_times
  )
  WITH composition AS (
    SELECT price_split_threshold FROM item_compositions
    WHERE company_id=p_company AND id=p_composition
  ), groups AS (
    SELECT v.group_key FROM composition c CROSS JOIN
    (VALUES ('all'),('higher'),('lower')) AS v(group_key)
    WHERE (c.price_split_threshold IS NULL AND v.group_key='all')
       OR (c.price_split_threshold IS NOT NULL AND v.group_key IN ('higher','lower'))
  ), item_sales AS (
    SELECT d.item_id,
      SUM(d.sale_invoices-d.sale_return_invoices)::numeric AS sale_times
    FROM item_daily_activity d
    WHERE d.company_id=p_company AND d.document_date >=
      ((clock_timestamp() AT TIME ZONE 'Asia/Aden')::date-INTERVAL '12 months'+INTERVAL '1 day')::date
      AND d.document_date <= (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date
    GROUP BY d.item_id
  ), ranked AS (
    SELECT i.id,i.name,i.sale_price1,i.purchase_price,
      s.stock_total,i.factor2,i.factor3,
      composition_price_group(c.price_split_threshold,i.sale_price1) AS group_key,
      COALESCE(a.sale_times,0) AS times,
      ROW_NUMBER() OVER (
        PARTITION BY composition_price_group(c.price_split_threshold,i.sale_price1)
        ORDER BY COALESCE(a.sale_times,0) DESC,i.id
      ) AS rank
    FROM items i JOIN composition c ON TRUE
    LEFT JOIN item_statistics s ON s.company_id=i.company_id AND s.item_id=i.id
    LEFT JOIN item_sales a ON a.item_id=i.id
    WHERE i.company_id=p_company AND i.composition_id=p_composition
  )
  SELECT p_company,p_composition,g.group_key,
    COUNT(r.id)::integer,
    COUNT(r.id) FILTER(WHERE COALESCE(r.stock_total,0)>0)::integer,
    COALESCE(SUM(GREATEST(COALESCE(r.stock_total,0),0)::numeric/
      NULLIF((r.factor2::numeric*r.factor3::numeric),0)),0),
    MIN(NULLIF(r.sale_price1,0)),MAX(NULLIF(r.sale_price1,0)),
    MIN(NULLIF(r.purchase_price,0)),MAX(NULLIF(r.purchase_price,0)),
    MAX(r.id) FILTER(WHERE r.rank=1 AND r.times>0),
    MAX(r.name) FILTER(WHERE r.rank=1 AND r.times>0),
    COALESCE(MAX(r.times) FILTER(WHERE r.rank=1 AND r.times>0),0)
  FROM groups g LEFT JOIN ranked r ON r.group_key=g.group_key
  GROUP BY g.group_key;
END $$;

CREATE OR REPLACE FUNCTION refresh_composition_daily_date(
  p_company integer,p_composition integer,p_date date
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(p_company,p_composition);
  DELETE FROM item_composition_daily_statistics
  WHERE company_id=p_company AND composition_id=p_composition AND document_date=p_date;
  INSERT INTO item_composition_daily_statistics(
    company_id,composition_id,group_key,document_date,
    sale_times,sale_unit1,purchase_times,purchase_unit1
  )
  SELECT p_company,p_composition,
    composition_price_group(c.price_split_threshold,i.sale_price1),p_date,
    SUM(d.sale_invoices-d.sale_return_invoices),
    SUM((d.sale_quantity-d.sale_return_quantity)::numeric/
      NULLIF((i.factor2::numeric*i.factor3::numeric),0)),
    SUM(d.purchase_invoices-d.purchase_return_invoices),
    SUM((d.purchase_quantity-d.purchase_return_quantity)::numeric/
      NULLIF((i.factor2::numeric*i.factor3::numeric),0))
  FROM item_daily_activity d JOIN items i
    ON i.company_id=d.company_id AND i.id=d.item_id
  JOIN item_compositions c ON c.company_id=i.company_id AND c.id=i.composition_id
  WHERE d.company_id=p_company AND i.composition_id=p_composition
    AND d.document_date=p_date
  GROUP BY composition_price_group(c.price_split_threshold,i.sale_price1);
END $$;

CREATE OR REPLACE FUNCTION rebuild_composition_daily(p_company integer,p_composition integer)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(p_company,p_composition);
  DELETE FROM item_composition_daily_statistics
  WHERE company_id=p_company AND composition_id=p_composition;
  INSERT INTO item_composition_daily_statistics(
    company_id,composition_id,group_key,document_date,
    sale_times,sale_unit1,purchase_times,purchase_unit1
  )
  SELECT p_company,p_composition,
    composition_price_group(c.price_split_threshold,i.sale_price1),
    d.document_date,
    SUM(d.sale_invoices-d.sale_return_invoices),
    SUM((d.sale_quantity-d.sale_return_quantity)::numeric/
      NULLIF((i.factor2::numeric*i.factor3::numeric),0)),
    SUM(d.purchase_invoices-d.purchase_return_invoices),
    SUM((d.purchase_quantity-d.purchase_return_quantity)::numeric/
      NULLIF((i.factor2::numeric*i.factor3::numeric),0))
  FROM item_daily_activity d JOIN items i
    ON i.company_id=d.company_id AND i.id=d.item_id
  JOIN item_compositions c ON c.company_id=i.company_id AND c.id=i.composition_id
  WHERE d.company_id=p_company AND i.composition_id=p_composition
  GROUP BY d.document_date,composition_price_group(c.price_split_threshold,i.sale_price1);
END $$;

CREATE OR REPLACE FUNCTION composition_daily_stats_changed()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_composition integer; new_composition integer;
BEGIN
  IF TG_OP<>'INSERT' THEN
    SELECT composition_id INTO old_composition FROM items
    WHERE company_id=OLD.company_id AND id=OLD.item_id;
    IF old_composition IS NOT NULL THEN
      PERFORM refresh_composition_daily_date(OLD.company_id,old_composition,OLD.document_date);
      PERFORM refresh_composition_summary(OLD.company_id,old_composition);
    END IF;
  END IF;
  IF TG_OP<>'DELETE' THEN
    SELECT composition_id INTO new_composition FROM items
    WHERE company_id=NEW.company_id AND id=NEW.item_id;
    IF new_composition IS NOT NULL AND
      (TG_OP='INSERT' OR old_composition IS DISTINCT FROM new_composition
        OR OLD.document_date IS DISTINCT FROM NEW.document_date) THEN
      PERFORM refresh_composition_daily_date(NEW.company_id,new_composition,NEW.document_date);
      PERFORM refresh_composition_summary(NEW.company_id,new_composition);
    ELSIF new_composition IS NOT NULL AND TG_OP='UPDATE' THEN
      -- The same item/date was updated: the OLD block already refreshed it.
      NULL;
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER item_comp_daily_changed
AFTER INSERT OR UPDATE OR DELETE ON item_daily_activity
FOR EACH ROW EXECUTE FUNCTION composition_daily_stats_changed();

CREATE OR REPLACE FUNCTION composition_stock_stats_changed()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE comp integer;
BEGIN
  SELECT composition_id INTO comp FROM items
  WHERE company_id=COALESCE(NEW.company_id,OLD.company_id)
    AND id=COALESCE(NEW.item_id,OLD.item_id);
  IF comp IS NOT NULL THEN
    PERFORM refresh_composition_summary(
      COALESCE(NEW.company_id,OLD.company_id),comp);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER item_comp_stock_changed
AFTER INSERT OR UPDATE OR DELETE ON item_statistics
FOR EACH ROW EXECUTE FUNCTION composition_stock_stats_changed();

CREATE OR REPLACE FUNCTION composition_item_master_changed()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.composition_id IS NOT NULL THEN
      PERFORM rebuild_composition_daily(OLD.company_id,OLD.composition_id);
      PERFORM refresh_composition_summary(OLD.company_id,OLD.composition_id);
    END IF;
  ELSE
    IF TG_OP='UPDATE' AND OLD.composition_id IS NOT NULL AND
       (OLD.composition_id IS DISTINCT FROM NEW.composition_id OR
        OLD.sale_price1 IS DISTINCT FROM NEW.sale_price1 OR
        OLD.factor2 IS DISTINCT FROM NEW.factor2 OR
        OLD.factor3 IS DISTINCT FROM NEW.factor3) THEN
      PERFORM rebuild_composition_daily(OLD.company_id,OLD.composition_id);
      PERFORM refresh_composition_summary(OLD.company_id,OLD.composition_id);
    END IF;
    IF NEW.composition_id IS NOT NULL THEN
      IF TG_OP='INSERT' OR
        OLD.composition_id IS DISTINCT FROM NEW.composition_id OR
        OLD.sale_price1 IS DISTINCT FROM NEW.sale_price1 OR
        OLD.factor2 IS DISTINCT FROM NEW.factor2 OR
        OLD.factor3 IS DISTINCT FROM NEW.factor3 THEN
        PERFORM rebuild_composition_daily(NEW.company_id,NEW.composition_id);
      END IF;
      PERFORM refresh_composition_summary(NEW.company_id,NEW.composition_id);
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER item_comp_master_changed
AFTER INSERT OR UPDATE OF composition_id,sale_price1,purchase_price,factor2,factor3
  OR DELETE ON items
FOR EACH ROW EXECUTE FUNCTION composition_item_master_changed();

CREATE OR REPLACE FUNCTION composition_threshold_changed()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' OR NEW.price_split_threshold IS DISTINCT FROM OLD.price_split_threshold THEN
    PERFORM rebuild_composition_daily(NEW.company_id,NEW.id);
    PERFORM refresh_composition_summary(NEW.company_id,NEW.id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER item_comp_threshold_changed
AFTER INSERT OR UPDATE OF price_split_threshold ON item_compositions
FOR EACH ROW EXECUTE FUNCTION composition_threshold_changed();

-- Populate all existing compositions once, without scanning invoice_lines.
SELECT rebuild_composition_daily(company_id,id) FROM item_compositions ORDER BY company_id,id;
SELECT refresh_composition_summary(company_id,id) FROM item_compositions ORDER BY company_id,id;
