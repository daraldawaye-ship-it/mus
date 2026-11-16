-- All objects here belong to the isolated market schema.
SET LOCAL statement_timeout='60s';
CREATE TABLE market_card_statistics (
  card_id integer PRIMARY KEY REFERENCES medicine_market_cards(id) ON DELETE CASCADE,
  opens bigint NOT NULL DEFAULT 0, comments bigint NOT NULL DEFAULT 0, likes bigint NOT NULL DEFAULT 0,
  relations jsonb, check_after timestamptz NOT NULL DEFAULT '-infinity'
);
CREATE INDEX market_card_statistics_due ON market_card_statistics(check_after,card_id);

-- The request key also remembers suppressed opens. Replaying one later cannot create a view.
CREATE TABLE market_card_open_events (
  card_id integer NOT NULL REFERENCES medicine_market_cards(id) ON DELETE CASCADE,
  user_id integer NOT NULL, request_key uuid NOT NULL, opened_at timestamptz NOT NULL,
  counted boolean NOT NULL, PRIMARY KEY(card_id,user_id,request_key)
);
CREATE INDEX market_card_last_open ON market_card_open_events(card_id,user_id,opened_at DESC) WHERE counted;

CREATE FUNCTION market_record_open(p_card integer,p_user integer,p_key uuid)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE observed timestamptz; accepted boolean; inserted integer;
BEGIN
  PERFORM pg_advisory_xact_lock(p_card,p_user);
  observed := clock_timestamp();
  SELECT NOT EXISTS (SELECT FROM market_card_open_events WHERE card_id=p_card
    AND user_id=p_user AND counted AND opened_at > observed - interval '1 hour') INTO accepted;
  INSERT INTO market_card_open_events VALUES(p_card,p_user,p_key,observed,accepted)
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted=1 AND accepted THEN
    UPDATE market_card_statistics SET opens=opens+1 WHERE card_id=p_card;
  END IF;
  RETURN (SELECT opens FROM market_card_statistics WHERE card_id=p_card);
END $$;

-- Accept numeric identifiers and older string identifiers. Ignore malformed source values.
CREATE FUNCTION market_ref(value text) RETURNS integer LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE WHEN value ~ '^[1-9][0-9]{0,9}$'
    AND (length(value)<10 OR value COLLATE "C" <= '2147483647') THEN value::integer END
$$;
CREATE FUNCTION market_ingredient_ids(data jsonb) RETURNS integer[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY(SELECT DISTINCT id FROM
    (SELECT market_ref(e->>'scientificId') id FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(data->'ingredients')='array' THEN data->'ingredients' ELSE '[]'::jsonb END) e) ids
    WHERE id IS NOT NULL ORDER BY id)
$$;
CREATE VIEW market_counted_cards AS SELECT id,kind,data FROM medicine_market_cards
  WHERE status='published' AND NOT archived;
CREATE INDEX market_stats_medicine_composition ON medicine_market_cards(market_ref(data->>'compositionId'))
  WHERE kind='medicine' AND status='published' AND NOT archived;
CREATE INDEX market_stats_medicine_agent ON medicine_market_cards(market_ref(data->>'agentId'))
  WHERE kind='medicine' AND status='published' AND NOT archived;
CREATE INDEX market_stats_medicine_manufacturer ON medicine_market_cards(market_ref(data->>'manufacturerId'))
  WHERE kind='medicine' AND status='published' AND NOT archived;
CREATE INDEX market_stats_composition_ingredients ON medicine_market_cards USING gin(market_ingredient_ids(data))
  WHERE kind='composition' AND status='published' AND NOT archived;

CREATE FUNCTION market_relation_counts(target integer) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE card market_counted_cards%ROWTYPE; result jsonb;
BEGIN
  SELECT * INTO card FROM market_counted_cards WHERE id=target;
  CASE card.kind
  WHEN 'composition' THEN
    SELECT jsonb_build_object('medicines',count(*),'agents',count(DISTINCT a.id),
      'manufacturers',count(DISTINCT f.id),'scientificNames',
      (SELECT count(*) FROM market_counted_cards s WHERE s.kind='scientific-name'
        AND s.id=ANY(market_ingredient_ids(card.data)))) INTO result
    FROM market_counted_cards m
    LEFT JOIN market_counted_cards a ON a.kind='agent' AND a.id=market_ref(m.data->>'agentId')
    LEFT JOIN market_counted_cards f ON f.kind='manufacturer' AND f.id=market_ref(m.data->>'manufacturerId')
    WHERE m.kind='medicine' AND market_ref(m.data->>'compositionId')=target;
  WHEN 'agent' THEN
    SELECT jsonb_build_object('medicines',count(*),'compositions',count(DISTINCT c.id)) INTO result
    FROM market_counted_cards m LEFT JOIN market_counted_cards c
      ON c.kind='composition' AND c.id=market_ref(m.data->>'compositionId')
    WHERE m.kind='medicine' AND market_ref(m.data->>'agentId')=target;
  WHEN 'manufacturer' THEN
    SELECT jsonb_build_object('medicines',count(*)) INTO result FROM market_counted_cards m
      WHERE m.kind='medicine' AND market_ref(m.data->>'manufacturerId')=target;
  WHEN 'scientific-name' THEN
    SELECT jsonb_build_object('compositions',count(DISTINCT c.id),'medicines',count(m.id)) INTO result
    FROM market_counted_cards c LEFT JOIN market_counted_cards m
      ON m.kind='medicine' AND market_ref(m.data->>'compositionId')=c.id
    WHERE c.kind='composition' AND market_ingredient_ids(c.data) @> ARRAY[target];
  ELSE result := '{}'::jsonb;
  END CASE;
  RETURN result;
END $$;

-- Old and new endpoints both matter, including transitive ingredient/agent links.
CREATE FUNCTION market_stat_neighbors(target integer,card_kind text,payload jsonb)
RETURNS SETOF integer LANGUAGE plpgsql STABLE AS $$
DECLARE composition integer := market_ref(payload->>'compositionId');
BEGIN
  RETURN NEXT target;
  CASE card_kind
  WHEN 'medicine' THEN
    RETURN NEXT composition;
    RETURN NEXT market_ref(payload->>'agentId');
    RETURN NEXT market_ref(payload->>'manufacturerId');
    RETURN QUERY SELECT unnest(market_ingredient_ids(data)) FROM market_counted_cards
      WHERE id=composition AND kind='composition';
  WHEN 'composition' THEN
    RETURN QUERY SELECT unnest(market_ingredient_ids(payload));
    RETURN QUERY SELECT DISTINCT market_ref(data->>'agentId') FROM market_counted_cards
      WHERE kind='medicine' AND market_ref(data->>'compositionId')=target;
  WHEN 'scientific-name' THEN
    RETURN QUERY SELECT id FROM market_counted_cards WHERE kind='composition'
      AND market_ingredient_ids(data) @> ARRAY[target];
  WHEN 'agent' THEN
    RETURN QUERY SELECT DISTINCT market_ref(data->>'compositionId') FROM market_counted_cards
      WHERE kind='medicine' AND market_ref(data->>'agentId')=target;
  WHEN 'manufacturer' THEN
    RETURN QUERY SELECT DISTINCT market_ref(data->>'compositionId') FROM market_counted_cards
      WHERE kind='medicine' AND market_ref(data->>'manufacturerId')=target;
  ELSE NULL;
  END CASE;
END $$;

CREATE FUNCTION market_invalidate_links() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    INSERT INTO market_card_statistics(card_id) VALUES(NEW.id) ON CONFLICT DO NOTHING;
  END IF;
  IF COALESCE(NEW.kind,OLD.kind) NOT IN ('medicine','composition','scientific-name','agent','manufacturer') THEN RETURN NULL; END IF;
  IF TG_OP='UPDATE' AND (OLD.kind,OLD.archived,OLD.status,OLD.data->'compositionId',OLD.data->'agentId',
      OLD.data->'manufacturerId',OLD.data->'ingredients') IS NOT DISTINCT FROM
      (NEW.kind,NEW.archived,NEW.status,NEW.data->'compositionId',NEW.data->'agentId',
      NEW.data->'manufacturerId',NEW.data->'ingredients') THEN RETURN NULL; END IF;

  -- Serialize graph changes so concurrent edits to opposite ends see the prior committed edge.
  PERFORM pg_advisory_xact_lock(704885186012::bigint);
  UPDATE market_card_statistics SET relations=NULL,check_after='-infinity'
    WHERE card_id IN (SELECT * FROM market_stat_neighbors(OLD.id,OLD.kind,OLD.data)
                      UNION SELECT * FROM market_stat_neighbors(NEW.id,NEW.kind,NEW.data));
  RETURN NULL;
END $$;
CREATE TRIGGER market_stats_card AFTER INSERT OR UPDATE OR DELETE ON medicine_market_cards
  FOR EACH ROW EXECUTE FUNCTION market_invalidate_links();

CREATE FUNCTION market_engagement_delta() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE before_count integer:=0; after_count integer:=0;
BEGIN
  IF TG_TABLE_NAME='medicine_market_comments' THEN
    IF TG_OP<>'INSERT' THEN before_count:=(OLD.status='approved')::int; END IF;
    IF TG_OP<>'DELETE' THEN after_count:=(NEW.status='approved')::int; END IF;
  ELSE
    IF TG_OP<>'INSERT' THEN before_count:=OLD.liked::int; END IF;
    IF TG_OP<>'DELETE' THEN after_count:=NEW.liked::int; END IF;
  END IF;
  IF before_count=after_count AND OLD.card_id IS NOT DISTINCT FROM NEW.card_id THEN RETURN NULL; END IF;
  IF before_count=1 THEN
    UPDATE market_card_statistics SET comments=comments-(TG_TABLE_NAME='medicine_market_comments')::int,
      likes=likes-(TG_TABLE_NAME='medicine_market_reactions')::int WHERE card_id=OLD.card_id;
  END IF;
  IF after_count=1 THEN
    UPDATE market_card_statistics SET comments=comments+(TG_TABLE_NAME='medicine_market_comments')::int,
      likes=likes+(TG_TABLE_NAME='medicine_market_reactions')::int WHERE card_id=NEW.card_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER market_stats_comment AFTER INSERT OR UPDATE OR DELETE ON medicine_market_comments
  FOR EACH ROW EXECUTE FUNCTION market_engagement_delta();
CREATE TRIGGER market_stats_like AFTER INSERT OR UPDATE OR DELETE ON medicine_market_reactions
  FOR EACH ROW EXECUTE FUNCTION market_engagement_delta();

-- PostgreSQL holds the migration locks until commit, including the baseline and trigger installation.
INSERT INTO market_card_statistics(card_id,comments,likes)
SELECT c.id, coalesce(comments.n,0), coalesce(likes.n,0) FROM medicine_market_cards c
LEFT JOIN (SELECT card_id,count(*) n FROM medicine_market_comments WHERE status='approved' GROUP BY card_id) comments ON comments.card_id=c.id
LEFT JOIN (SELECT card_id,count(*) n FROM medicine_market_reactions WHERE liked GROUP BY card_id) likes ON likes.card_id=c.id;

-- Take row locks first, then read sources on a fresh READ COMMITTED snapshot.
-- A concurrent engagement writer either commits before that snapshot or applies its delta afterwards.
CREATE FUNCTION market_check_statistics(batch_size integer) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE ids integer[];
BEGIN
  SELECT ARRAY(SELECT card_id FROM market_card_statistics WHERE check_after<=now()
    ORDER BY check_after,card_id LIMIT batch_size FOR UPDATE SKIP LOCKED) INTO ids;
  IF cardinality(ids)=0 THEN RETURN 0; END IF;
  UPDATE market_card_statistics s SET
    opens=(SELECT count(*) FROM market_card_open_events e WHERE e.card_id=s.card_id AND e.counted),
    comments=(SELECT count(*) FROM medicine_market_comments c WHERE c.card_id=s.card_id AND c.status='approved'),
    likes=(SELECT count(*) FROM medicine_market_reactions r WHERE r.card_id=s.card_id AND r.liked),
    relations=market_relation_counts(s.card_id),check_after=clock_timestamp()+interval '7 days'
    WHERE s.card_id=ANY(ids);
  RETURN cardinality(ids);
END $$;
