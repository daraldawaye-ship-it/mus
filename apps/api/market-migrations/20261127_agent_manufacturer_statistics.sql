-- One source of truth for the published manufacturer cards linked to an agent.
CREATE INDEX market_stats_manufacturer_agent ON medicine_market_cards(market_ref(data->>'agentId'))
  WHERE kind='manufacturer' AND status='published' AND NOT archived;

CREATE FUNCTION market_agent_manufacturers(target integer)
RETURNS TABLE (id integer, name text) LANGUAGE sql STABLE AS $$
  SELECT c.id,c.name FROM medicine_market_cards c
  WHERE c.kind='manufacturer' AND c.status='published' AND NOT c.archived
    AND market_ref(c.data->>'agentId')=target
$$;

CREATE OR REPLACE FUNCTION market_relation_counts(target integer) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
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
    SELECT jsonb_build_object('medicines',count(*),'compositions',count(DISTINCT c.id),
      'manufacturers',(SELECT count(*) FROM market_agent_manufacturers(target))) INTO result
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

CREATE OR REPLACE FUNCTION market_stat_neighbors(target integer,card_kind text,payload jsonb)
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
    RETURN NEXT market_ref(payload->>'agentId');
    RETURN QUERY SELECT DISTINCT market_ref(data->>'compositionId') FROM market_counted_cards
      WHERE kind='medicine' AND market_ref(data->>'manufacturerId')=target;
  ELSE NULL;
  END CASE;
END $$;

-- Cached relation totals predate the new key; invalidate only agent rows.
UPDATE market_card_statistics s SET relations=NULL,check_after='-infinity'
FROM medicine_market_cards c WHERE c.id=s.card_id AND c.kind='agent';
