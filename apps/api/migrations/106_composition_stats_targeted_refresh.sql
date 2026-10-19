-- Keep per-posting composition statistics updates proportional to linked items,
-- not to the company's complete daily invoice history.
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
    FROM items source
    JOIN item_daily_activity d ON d.company_id=source.company_id AND d.item_id=source.id
    WHERE source.company_id=p_company AND source.composition_id=p_composition
      AND d.document_date >=
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
