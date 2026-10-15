-- Counts are derived from immutable stock-operation records, not stock balance movements.
-- Zero-difference counts qualify; inventory and accounting source tables remain unchanged.
ALTER TABLE items
 ADD COLUMN settlement_approval_date date,
 ADD COLUMN settlement_display_date date;

ALTER TABLE item_statistics
 ADD COLUMN adjustments_all_time bigint NOT NULL DEFAULT 0 CHECK(adjustments_all_time>=0),
 ADD COLUMN adjustments_since_approval bigint NOT NULL DEFAULT 0 CHECK(adjustments_since_approval>=0),
 ADD COLUMN adjustments_since_display bigint NOT NULL DEFAULT 0 CHECK(adjustments_since_display>=0),
 ADD COLUMN last_showroom_adjustment_at timestamptz;

CREATE INDEX item_adjustment_count_lookup
 ON stock_operations(company_id,(creation_payload->>'itemId'),document_date,id DESC)
 WHERE kind='adjustment';

CREATE FUNCTION refresh_item_adjustment_counts(p_company integer,p_item integer)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 UPDATE item_statistics s SET
   adjustments_all_time=x.all_time,
   adjustments_since_approval=x.since_approval,
   adjustments_since_display=x.since_display,
   last_showroom_adjustment_at=x.last_showroom_at,
   updated_at=clock_timestamp()
 FROM items i
 CROSS JOIN LATERAL (
   SELECT count(*)::bigint AS all_time,
     count(*) FILTER (
       WHERE i.settlement_approval_date IS NOT NULL
         AND o.document_date>=i.settlement_approval_date
     )::bigint AS since_approval,
     count(*) FILTER (
       WHERE i.settlement_display_date IS NOT NULL
         AND o.document_date>=i.settlement_display_date
     )::bigint AS since_display,
     max(o.created_at) FILTER (WHERE l.kind='showroom') AS last_showroom_at
   FROM stock_operations o
   LEFT JOIN locations l ON l.company_id=o.company_id
     AND l.id=CASE WHEN (o.creation_payload->>'locationId') ~ '^[1-9][0-9]{0,9}$'
                    AND (o.creation_payload->>'locationId')::numeric<=2147483647
                   THEN (o.creation_payload->>'locationId')::integer ELSE NULL END
   WHERE o.company_id=p_company AND o.kind='adjustment'
     AND o.creation_payload->>'itemId'=p_item::text
 ) x
 WHERE i.company_id=p_company AND i.id=p_item
   AND s.company_id=i.company_id AND s.item_id=i.id;
END $$;

CREATE FUNCTION update_item_adjustment_counts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='items' THEN
   PERFORM refresh_item_adjustment_counts(NEW.company_id,NEW.id);
 ELSIF (NEW.creation_payload->>'itemId') ~ '^[1-9][0-9]{0,9}$'
   AND (NEW.creation_payload->>'itemId')::numeric<=2147483647 THEN
   PERFORM refresh_item_adjustment_counts(
     NEW.company_id,(NEW.creation_payload->>'itemId')::integer
   );
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER item_counts_on_adjustment
 AFTER INSERT ON stock_operations
 FOR EACH ROW WHEN (NEW.kind='adjustment')
 EXECUTE FUNCTION update_item_adjustment_counts();

CREATE TRIGGER item_counts_on_date_change
 AFTER UPDATE OF settlement_approval_date,settlement_display_date ON items
 FOR EACH ROW WHEN (
   OLD.settlement_approval_date IS DISTINCT FROM NEW.settlement_approval_date OR
   OLD.settlement_display_date IS DISTINCT FROM NEW.settlement_display_date
 )
 EXECUTE FUNCTION update_item_adjustment_counts();

-- Rebuild historical counts once, including zero-difference physical counts.
SELECT refresh_item_adjustment_counts(company_id,id) FROM items ORDER BY company_id,id;
