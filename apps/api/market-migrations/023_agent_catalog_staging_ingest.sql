-- Owner-only /medicine-market/staging/import retains its existing authorization,
-- size limits, SHA-256 checks and all-or-nothing transaction. Only sources explicitly
-- marked metadata.targetTable=market_agent_catalog_staging use this projection.
-- Original files and row payloads remain unchanged; no live market cards are touched.
ALTER TABLE market_agent_catalog_staging
  ADD COLUMN source_sha256 text,
  ADD COLUMN source_drive_id text,
  ADD COLUMN import_source_id bigint REFERENCES market_import_sources(id),
  ADD COLUMN source_payload jsonb;
CREATE UNIQUE INDEX market_agent_catalog_staging_identity
  ON market_agent_catalog_staging(source_sha256,source_sheet,source_row);

CREATE FUNCTION project_agent_catalog_staging_row() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  src market_import_sources%ROWTYPE;
  payload jsonb := NEW.payload;
  saved_id bigint;
  was_inserted boolean;
  receipt jsonb;
BEGIN
  SELECT * INTO src FROM market_import_sources WHERE id=NEW.source_id;
  IF src.metadata->>'targetTable' IS DISTINCT FROM 'market_agent_catalog_staging' THEN
    RETURN NEW;
  END IF;
  IF jsonb_typeof(payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'agent_catalog_payload_object_required';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_each(payload) e
    WHERE e.key NOT IN ('agent','department','manufacturer','sort_order',
      'product_name_ar','product_name_en','composition','usage','dosage_form',
      'package','price','bonus','notes','agent_phone','address')
      OR jsonb_typeof(e.value) NOT IN ('string','null')
      OR length(e.value #>> '{}') > 20000
  ) THEN
    RAISE EXCEPTION 'invalid_agent_catalog_source_field';
  END IF;
  INSERT INTO market_agent_catalog_staging (
    agent,department,manufacturer,sort_order,product_name_ar,product_name_en,
    composition,usage,dosage_form,package,price,bonus,notes,agent_phone,address,
    source_file,source_sheet,source_row,source_sha256,source_drive_id,import_source_id,source_payload
  ) VALUES (
    payload->>'agent',payload->>'department',payload->>'manufacturer',payload->>'sort_order',
    payload->>'product_name_ar',payload->>'product_name_en',payload->>'composition',
    payload->>'usage',payload->>'dosage_form',payload->>'package',payload->>'price',
    payload->>'bonus',payload->>'notes',payload->>'agent_phone',payload->>'address',
    src.filename,NEW.section,NEW.position::text,src.sha256,src.drive_id,src.id,payload
  ) ON CONFLICT (source_sha256,source_sheet,source_row) DO NOTHING RETURNING id INTO saved_id;
  was_inserted := saved_id IS NOT NULL;
  IF NOT was_inserted THEN
    SELECT id INTO saved_id FROM market_agent_catalog_staging
      WHERE source_sha256=src.sha256 AND source_sheet=NEW.section AND source_row=NEW.position::text
        AND source_payload=payload;
    IF saved_id IS NULL THEN
      RAISE EXCEPTION 'agent_catalog_existing_source_conflict';
    END IF;
  END IF;
  -- Readback receipt through existing GET /medicine-market/staging. It commits
  -- together with the projected rows and source integrity verification.
  receipt := COALESCE(src.metadata->'agentCatalogReceipt','{}'::jsonb);
  receipt := jsonb_build_object(
    'rows',COALESCE((receipt->>'rows')::integer,0)+1,
    'inserted',COALESCE((receipt->>'inserted')::integer,0)+(CASE WHEN was_inserted THEN 1 ELSE 0 END),
    'reused',COALESCE((receipt->>'reused')::integer,0)+(CASE WHEN was_inserted THEN 0 ELSE 1 END),
    'firstId',COALESCE((receipt->>'firstId')::bigint,saved_id),
    'lastId',saved_id
  );
  UPDATE market_import_sources SET metadata=jsonb_set(metadata,'{agentCatalogReceipt}',receipt,true)
    WHERE id=src.id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER project_agent_catalog_staging_row
AFTER INSERT ON market_import_rows
FOR EACH ROW EXECUTE FUNCTION project_agent_catalog_staging_row();
