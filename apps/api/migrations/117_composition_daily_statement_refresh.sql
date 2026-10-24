-- Daily facts are rebuildable projections. Refresh shared composition scopes
-- once per statement instead of recomputing them for every affected item row.
-- All refreshes remain inside the source transaction and keep normal locks.
CREATE FUNCTION refresh_changed_composition_daily_scopes(p_scopes jsonb)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE changed record;
BEGIN
  FOR changed IN
    SELECT DISTINCT company_id,composition_id,document_date
    FROM jsonb_to_recordset(p_scopes)
      AS scope(company_id integer,composition_id integer,document_date date)
    ORDER BY company_id,composition_id,document_date
  LOOP
    PERFORM refresh_composition_daily_date(
      changed.company_id,changed.composition_id,changed.document_date);
  END LOOP;
  FOR changed IN
    SELECT DISTINCT company_id,composition_id
    FROM jsonb_to_recordset(p_scopes)
      AS scope(company_id integer,composition_id integer,document_date date)
    ORDER BY company_id,composition_id
  LOOP
    PERFORM refresh_composition_summary(changed.company_id,changed.composition_id);
  END LOOP;
END $$;

CREATE FUNCTION composition_daily_stats_changed_statement()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed_scopes jsonb;
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(scope)),'[]'::jsonb)
    INTO changed_scopes
    FROM (
      SELECT DISTINCT d.company_id,i.composition_id,d.document_date
      FROM new_daily_rows d JOIN items i
        ON i.company_id=d.company_id AND i.id=d.item_id
      WHERE i.composition_id IS NOT NULL
    ) scope;
  ELSIF TG_OP='DELETE' THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(scope)),'[]'::jsonb)
    INTO changed_scopes
    FROM (
      SELECT DISTINCT d.company_id,i.composition_id,d.document_date
      FROM old_daily_rows d JOIN items i
        ON i.company_id=d.company_id AND i.id=d.item_id
      WHERE i.composition_id IS NOT NULL
    ) scope;
  ELSE
    SELECT COALESCE(jsonb_agg(to_jsonb(scope)),'[]'::jsonb)
    INTO changed_scopes
    FROM (
      SELECT DISTINCT d.company_id,i.composition_id,d.document_date
      FROM (
        SELECT COALESCE(o.company_id,n.company_id) AS company_id,
          COALESCE(o.item_id,n.item_id) AS item_id,
          COALESCE(o.document_date,n.document_date) AS document_date
        FROM old_daily_rows o FULL JOIN new_daily_rows n
          USING(company_id,item_id,document_date)
        WHERE (to_jsonb(o)-'updated_at') IS DISTINCT FROM
          (to_jsonb(n)-'updated_at')
      ) d JOIN items i ON i.company_id=d.company_id AND i.id=d.item_id
      WHERE i.composition_id IS NOT NULL
    ) scope;
  END IF;
  PERFORM refresh_changed_composition_daily_scopes(changed_scopes);
  RETURN NULL;
END $$;

DROP TRIGGER item_comp_daily_changed ON item_daily_activity;
CREATE TRIGGER item_comp_daily_inserted
  AFTER INSERT ON item_daily_activity
  REFERENCING NEW TABLE AS new_daily_rows
  FOR EACH STATEMENT EXECUTE FUNCTION composition_daily_stats_changed_statement();
CREATE TRIGGER item_comp_daily_updated
  AFTER UPDATE ON item_daily_activity
  REFERENCING OLD TABLE AS old_daily_rows NEW TABLE AS new_daily_rows
  FOR EACH STATEMENT EXECUTE FUNCTION composition_daily_stats_changed_statement();
CREATE TRIGGER item_comp_daily_deleted
  AFTER DELETE ON item_daily_activity
  REFERENCING OLD TABLE AS old_daily_rows
  FOR EACH STATEMENT EXECUTE FUNCTION composition_daily_stats_changed_statement();

-- Ranking zero-row cleanup uses company+item; the existing ranking PK leads
-- with company+as_of_date, which made each delta scan the company's rankings.
CREATE INDEX item_sale_rankings_item
  ON item_sale_rankings(company_id,item_id);
