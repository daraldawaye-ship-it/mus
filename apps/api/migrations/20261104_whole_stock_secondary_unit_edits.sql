-- A whole quantity in the first unit permits non-destructive edits of
-- the second/third labels and their distribution, provided the total number
-- of smallest units per first unit is UNCHANGED. The source of truth is each
-- authoritative stock_balances batch, not a potentially offsetting company sum.
-- The previous zero-stock activation exception remains for unused unit slots.
-- Never rewrite existing invoices, movements, balances or valuations.
CREATE OR REPLACE FUNCTION protect_item_stock_units()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  history_exists boolean;
  nonzero_stock boolean;
  stable_pack boolean;
BEGIN
  IF ROW(NEW.unit1_name,NEW.unit2_name,NEW.unit3_name,NEW.factor2,NEW.factor3,NEW.has_expiry)
     IS NOT DISTINCT FROM
     ROW(OLD.unit1_name,OLD.unit2_name,OLD.unit3_name,OLD.factor2,OLD.factor3,OLD.has_expiry)
  THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM stock_movements
    WHERE company_id=OLD.company_id AND item_id=OLD.id
  ) INTO history_exists;
  SELECT EXISTS(
    SELECT 1 FROM stock_balances
    WHERE company_id=OLD.company_id AND item_id=OLD.id
      AND quantity_smallest<>0
  ) INTO nonzero_stock;
  IF NOT history_exists AND NOT nonzero_stock THEN
    RETURN NEW;
  END IF;

  stable_pack := OLD.unit1_name IS NOT DISTINCT FROM NEW.unit1_name
    AND OLD.has_expiry IS NOT DISTINCT FROM NEW.has_expiry
    AND OLD.factor2::numeric * OLD.factor3::numeric =
        NEW.factor2::numeric * NEW.factor3::numeric
    AND NOT (NEW.factor3>1 AND NEW.factor2<=1)
    AND NOT (NEW.factor2>1 AND length(btrim(NEW.unit2_name))=0)
    AND NOT (NEW.factor3>1 AND length(btrim(NEW.unit3_name))=0);

  IF stable_pack THEN
    -- 12 smallest units in a pack of 12 are whole, but 13 are fractional.
    -- Check EVERY batch including return/warehouse locations.
    IF EXISTS (
      SELECT 1 FROM stock_balances
      WHERE company_id=OLD.company_id AND item_id=OLD.id
        AND MOD(quantity_smallest,
            OLD.factor2::numeric * OLD.factor3::numeric)<>0
    ) THEN
      RAISE EXCEPTION 'Secondary unit edit requires whole first-unit stock in every batch'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  -- Changing factor2*factor3 while there is stock silently reinterprets
  -- physical quantities and accounting valuation. Never do this in card PATCH.
  IF nonzero_stock THEN
    RAISE EXCEPTION 'Changing stock unit multiplier requires an audited conversion'
      USING ERRCODE='23514';
  END IF;

  -- Existing zero-stock exception: activate only never-used unit slots.
  IF history_exists AND (
    OLD.unit1_name IS DISTINCT FROM NEW.unit1_name
    OR OLD.has_expiry IS DISTINCT FROM NEW.has_expiry
    OR (OLD.factor2>1 AND
        (OLD.factor2 IS DISTINCT FROM NEW.factor2
         OR OLD.unit2_name IS DISTINCT FROM NEW.unit2_name))
    OR (OLD.factor3>1 AND
        (OLD.factor3 IS DISTINCT FROM NEW.factor3
         OR OLD.unit3_name IS DISTINCT FROM NEW.unit3_name))
    OR (NEW.factor3>1 AND NEW.factor2<=1)
    OR (OLD.factor3>1 AND OLD.factor2<=1 AND NEW.factor2>1)
    OR (NEW.factor2>1 AND length(btrim(NEW.unit2_name))=0)
    OR (NEW.factor3>1 AND length(btrim(NEW.unit3_name))=0)
  ) THEN
    RAISE EXCEPTION 'Operational item units and expiry cannot be reinterpreted'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
