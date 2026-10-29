-- Include source-only historical sales in frequency statistics and item search,
-- without creating invoices, stock movements, financial documents or balances.
-- The source invoice is counted only while no posted source mapping exists.
LOCK TABLE companies IN EXCLUSIVE MODE;

CREATE TABLE item_provisional_sale_occurrences (
  company_id integer NOT NULL,
  source_system varchar(100) NOT NULL,
  source_id varchar(100) NOT NULL,
  item_id integer NOT NULL,
  document_date date NOT NULL,
  positive boolean NOT NULL,
  negative boolean NOT NULL,
  PRIMARY KEY (company_id,source_system,source_id,item_id),
  FOREIGN KEY (company_id,item_id) REFERENCES items(company_id,id) ON DELETE CASCADE,
  CHECK (positive OR negative)
);
CREATE INDEX item_provisional_sale_by_item_day
  ON item_provisional_sale_occurrences(company_id,item_id,document_date);

-- Only numbers from the preserved source are used. Invalid individual lines
-- are not fabricated into a sale; posted invoices always retain precedence.
INSERT INTO item_provisional_sale_occurrences
  (company_id,source_system,source_id,item_id,document_date,positive,negative)
SELECT s.company_id,s.source_system,s.source_id,it.id,s.posting_date,
       bool_or((line.value->>'quantity')::numeric>0),
       bool_or((line.value->>'quantity')::numeric<0)
FROM legacy_import_staging s
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(s.source_document#>'{payload,lines}')='array'
       THEN s.source_document#>'{payload,lines}' ELSE '[]'::jsonb END
) line(value)
JOIN items it ON it.company_id=s.company_id AND it.id=(
  CASE WHEN line.value->>'itemId' ~ '^[0-9]{1,10}$'
       THEN (line.value->>'itemId')::numeric ELSE NULL::numeric END
)
WHERE s.source_kind='invoice'
  AND s.source_document#>>'{payload,kind}'='sale'
  AND line.value->>'quantity' ~ '^[+-]?[0-9]{1,30}(\.[0-9]{1,18})?$'
  AND NOT EXISTS (
    SELECT 1 FROM transaction_source_imports t
    WHERE t.company_id=s.company_id AND t.source_system=s.source_system
      AND t.source_kind='invoice' AND t.source_id=s.source_id
  )
GROUP BY s.company_id,s.source_system,s.source_id,it.id,s.posting_date
HAVING bool_or((line.value->>'quantity')::numeric<>0);

-- Recompute the occurrence projection for one immutable source identity.
-- Called both when source-only receipts change and when an invoice becomes
-- financially/stock posted. Both changes participate in the same transaction.
CREATE FUNCTION refresh_item_provisional_sale(
  p_company integer,p_system varchar,p_source varchar
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM item_provisional_sale_occurrences
  WHERE company_id=p_company AND source_system=p_system AND source_id=p_source;

  INSERT INTO item_provisional_sale_occurrences
    (company_id,source_system,source_id,item_id,document_date,positive,negative)
  SELECT s.company_id,s.source_system,s.source_id,it.id,s.posting_date,
         bool_or((line.value->>'quantity')::numeric>0),
         bool_or((line.value->>'quantity')::numeric<0)
  FROM legacy_import_staging s
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(s.source_document#>'{payload,lines}')='array'
         THEN s.source_document#>'{payload,lines}' ELSE '[]'::jsonb END
  ) line(value)
  JOIN items it ON it.company_id=s.company_id AND it.id=(
    CASE WHEN line.value->>'itemId' ~ '^[0-9]{1,10}$'
         THEN (line.value->>'itemId')::numeric ELSE NULL::numeric END
  )
  WHERE s.company_id=p_company AND s.source_system=p_system
    AND s.source_id=p_source AND s.source_kind='invoice'
    AND s.source_document#>>'{payload,kind}'='sale'
    AND line.value->>'quantity' ~ '^[+-]?[0-9]{1,30}(\.[0-9]{1,18})?$'
    AND NOT EXISTS (
      SELECT 1 FROM transaction_source_imports t
      WHERE t.company_id=s.company_id AND t.source_system=s.source_system
        AND t.source_kind='invoice' AND t.source_id=s.source_id
    )
  GROUP BY s.company_id,s.source_system,s.source_id,it.id,s.posting_date
  HAVING bool_or((line.value->>'quantity')::numeric<>0);
END;
$$;

CREATE FUNCTION sync_provisional_from_staging() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') AND OLD.source_kind='invoice' THEN
    PERFORM refresh_item_provisional_sale(OLD.company_id,OLD.source_system,OLD.source_id);
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') AND NEW.source_kind='invoice' THEN
    IF TG_OP='INSERT' OR (OLD.company_id,OLD.source_system,OLD.source_id)
      IS DISTINCT FROM (NEW.company_id,NEW.source_system,NEW.source_id) THEN
      PERFORM refresh_item_provisional_sale(NEW.company_id,NEW.source_system,NEW.source_id);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER provisional_sale_from_stage
  AFTER INSERT OR DELETE OR UPDATE OF source_document,posting_date,status,source_system,source_id,source_kind
  ON legacy_import_staging
  FOR EACH ROW EXECUTE FUNCTION sync_provisional_from_staging();

CREATE FUNCTION sync_provisional_from_posting() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') AND OLD.source_kind='invoice' THEN
    PERFORM refresh_item_provisional_sale(OLD.company_id,OLD.source_system,OLD.source_id);
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') AND NEW.source_kind='invoice' THEN
    PERFORM refresh_item_provisional_sale(NEW.company_id,NEW.source_system,NEW.source_id);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER provisional_sale_from_source_import
  AFTER INSERT OR DELETE OR UPDATE OF source_system,source_id,source_kind,invoice_id
  ON transaction_source_imports
  FOR EACH ROW EXECUTE FUNCTION sync_provisional_from_posting();

-- All sales counts in the search cache reflect both posted daily activity
-- and still-unposted source-only occurrences (never both at once).
CREATE OR REPLACE FUNCTION prepare_item_sale_rankings(
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
    LOCK TABLE companies IN EXCLUSIVE MODE;
  END IF;
  IF missing_days IS NOT NULL THEN
    INSERT INTO item_sale_ranking_days(as_of_date) SELECT unnest(missing_days);
    INSERT INTO item_sale_rankings(company_id,item_id,as_of_date,net_sale_invoices)
      SELECT d.company_id,d.item_id,target.day,SUM(d.net)
      FROM unnest(missing_days) target(day)
      JOIN (
        SELECT company_id,item_id,document_date,
               sale_invoices::numeric-sale_return_invoices AS net
          FROM item_daily_activity
        UNION ALL
        SELECT company_id,item_id,document_date,
               positive::integer-negative::integer AS net
          FROM item_provisional_sale_occurrences
      ) d ON d.document_date BETWEEN
        (target.day-INTERVAL '1 month'+INTERVAL '1 day')::date AND target.day
      GROUP BY d.company_id,d.item_id,target.day
      HAVING SUM(d.net)<>0;
  END IF;
  DELETE FROM item_sale_ranking_days WHERE as_of_date<p_day-1;
END;
$$;

-- Replace only a rebuildable derived cache; never touch posted source facts.
DELETE FROM item_sale_rankings;
INSERT INTO item_sale_rankings(company_id,item_id,as_of_date,net_sale_invoices)
SELECT d.company_id,d.item_id,days.as_of_date,SUM(d.net)
FROM item_sale_ranking_days days
JOIN (
  SELECT company_id,item_id,document_date,
         sale_invoices::numeric-sale_return_invoices AS net FROM item_daily_activity
  UNION ALL
  SELECT company_id,item_id,document_date,
         positive::integer-negative::integer AS net FROM item_provisional_sale_occurrences
) d ON d.document_date BETWEEN
  (days.as_of_date-INTERVAL '1 month'+INTERVAL '1 day')::date AND days.as_of_date
GROUP BY d.company_id,d.item_id,days.as_of_date
HAVING SUM(d.net)<>0;

CREATE FUNCTION update_provisional_sale_rankings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    PERFORM apply_item_sale_ranking_delta(OLD.company_id,OLD.item_id,OLD.document_date,
      OLD.negative::integer-OLD.positive::integer);
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    PERFORM apply_item_sale_ranking_delta(NEW.company_id,NEW.item_id,NEW.document_date,
      NEW.positive::integer-NEW.negative::integer);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER provisional_sale_rankings
  AFTER INSERT OR UPDATE OR DELETE ON item_provisional_sale_occurrences
  FOR EACH ROW EXECUTE FUNCTION update_provisional_sale_rankings();
