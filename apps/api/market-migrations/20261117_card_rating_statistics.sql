-- Store market card ratings in the same per-card statistics projection as
-- opens, approved comments, likes, and relationship counters.
-- Keep historical ratings in medicine_market_reactions as the source of truth.
-- Prevent a rating write from interleaving between backfill and trigger install.
LOCK TABLE medicine_market_reactions IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE market_card_statistics
  ADD COLUMN rating_count bigint NOT NULL DEFAULT 0 CHECK (rating_count >= 0),
  ADD COLUMN rating_total bigint NOT NULL DEFAULT 0 CHECK (rating_total >= 0),
  ADD COLUMN rating_average numeric GENERATED ALWAYS AS
    (CASE WHEN rating_count > 0
      THEN round(rating_total::numeric / rating_count::numeric, 2)
      ELSE NULL::numeric END) STORED;

-- Existing live ratings become visible without requiring anyone to vote again.
UPDATE market_card_statistics s SET
  rating_count=r.count,
  rating_total=r.total
FROM (
  SELECT card_id, count(rating)::bigint AS count,
    coalesce(sum(rating),0)::bigint AS total
  FROM medicine_market_reactions
  WHERE rating IS NOT NULL
  GROUP BY card_id
) r
WHERE s.card_id=r.card_id;

-- A rating can be given, changed, removed or moved. Liking/unliking alone
-- does not affect the score. The existing like-count trigger stays intact.
CREATE FUNCTION market_rating_statistics_delta()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_card integer; new_card integer;
  old_rating integer:=0; new_rating integer:=0;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_card := OLD.card_id;
    old_rating := coalesce(OLD.rating,0);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_card := NEW.card_id;
    new_rating := coalesce(NEW.rating,0);
  END IF;
  IF old_card IS NOT DISTINCT FROM new_card THEN
    IF old_rating <> new_rating THEN
      UPDATE market_card_statistics SET
        rating_count=rating_count+(new_rating>0)::integer-(old_rating>0)::integer,
        rating_total=rating_total+new_rating-old_rating
      WHERE card_id=new_card;
    END IF;
  ELSE
    IF old_card IS NOT NULL AND old_rating>0 THEN
      UPDATE market_card_statistics SET rating_count=rating_count-1,
        rating_total=rating_total-old_rating WHERE card_id=old_card;
    END IF;
    IF new_card IS NOT NULL AND new_rating>0 THEN
      UPDATE market_card_statistics SET rating_count=rating_count+1,
        rating_total=rating_total+new_rating WHERE card_id=new_card;
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER market_stats_rating
AFTER INSERT OR UPDATE OR DELETE ON medicine_market_reactions
FOR EACH ROW EXECUTE FUNCTION market_rating_statistics_delta();

-- Existing per-card weekly verifier reconciles the projection from its
-- original interaction rows. Keep the same batch size and seven-day schedule.
CREATE OR REPLACE FUNCTION market_check_statistics(batch_size integer)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE ids integer[];
BEGIN
  SELECT ARRAY(
    SELECT card_id FROM market_card_statistics WHERE check_after<=now()
    ORDER BY check_after,card_id LIMIT batch_size FOR UPDATE SKIP LOCKED
  ) INTO ids;
  IF cardinality(ids)=0 THEN RETURN 0; END IF;
  UPDATE market_card_statistics s SET
    opens=(SELECT count(*) FROM market_card_open_events e WHERE e.card_id=s.card_id AND e.counted),
    comments=(SELECT count(*) FROM medicine_market_comments c WHERE c.card_id=s.card_id AND c.status='approved'),
    likes=(SELECT count(*) FROM medicine_market_reactions r WHERE r.card_id=s.card_id AND r.liked),
    rating_count=(SELECT count(r.rating) FROM medicine_market_reactions r WHERE r.card_id=s.card_id),
    rating_total=(SELECT coalesce(sum(r.rating),0) FROM medicine_market_reactions r WHERE r.card_id=s.card_id),
    relations=market_relation_counts(s.card_id),
    check_after=clock_timestamp()+interval '7 days'
    WHERE s.card_id=ANY(ids);
  RETURN cardinality(ids);
END $$;
