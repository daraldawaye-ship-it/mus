-- Audited, non-financial unit-scale transition: exact first-unit quantities
-- remain unchanged, while physical smallest-unit balances gain a neutral
-- movement and the pooled quantity is rebased. No historic movements, invoice
-- snapshots or monetary values are rewritten.
ALTER TABLE stock_operations DROP CONSTRAINT IF EXISTS stock_operations_kind_check;
ALTER TABLE stock_operations ADD CONSTRAINT stock_operations_kind_check
  CHECK(kind IN ('transfer','adjustment','unit_rebase'));

ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_kind_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_kind_check
  CHECK(kind IN (
    'purchase','sale','sales_return','purchase_return',
    'transfer_in','transfer_out','adjustment_surplus','adjustment_shortage',
    'reversal','unit_rebase'
  ));

CREATE OR REPLACE FUNCTION protect_item_stock_units()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  history_exists boolean;
  nonzero_stock boolean;
  stable_pack boolean;
  expected_token text;
BEGIN
  IF ROW(NEW.unit1_name,NEW.unit2_name,NEW.unit3_name,NEW.factor2,NEW.factor3,NEW.has_expiry)
     IS NOT DISTINCT FROM
     ROW(OLD.unit1_name,OLD.unit2_name,OLD.unit3_name,OLD.factor2,OLD.factor3,OLD.has_expiry)
  THEN RETURN NEW; END IF;

  -- Token exists ONLY in the single authorized, item-locked transaction
  -- which also creates a unit_rebase operation with per-batch neutral
  -- movements and updates the pooled stock quantity. Other callers remain
  -- protected by this trigger and the independent deferred stock-integrity
  -- constraints. A naked change in factor2 or factor3 cannot pass.
  expected_token := OLD.company_id::text || ':' || OLD.id::text || ':' ||
    (OLD.factor2::numeric * OLD.factor3::numeric)::text || ':' ||
    (NEW.factor2::numeric * NEW.factor3::numeric)::text;
  IF current_setting('alraesy.item_unit_rebase',true)=expected_token
     AND OLD.unit1_name IS NOT DISTINCT FROM NEW.unit1_name
     AND OLD.has_expiry IS NOT DISTINCT FROM NEW.has_expiry
     AND OLD.factor2::numeric * OLD.factor3::numeric <>
         NEW.factor2::numeric * NEW.factor3::numeric
     AND (NEW.factor2<=1 OR length(btrim(NEW.unit2_name))>0)
     AND (NEW.factor3<=1 OR
       (NEW.factor2>1 AND length(btrim(NEW.unit3_name))>0))
     AND EXISTS(
       SELECT 1 FROM stock_operations o
       WHERE o.company_id=OLD.company_id AND o.kind='unit_rebase'
         AND o.creation_payload->>'itemId'=OLD.id::text
         AND (o.creation_payload->'before'->>'factor2')::int=OLD.factor2
         AND (o.creation_payload->'before'->>'factor3')::int=OLD.factor3
         AND (o.creation_payload->'after'->>'factor2')::int=NEW.factor2
         AND (o.creation_payload->'after'->>'factor3')::int=NEW.factor3
     )
  THEN RETURN NEW; END IF;

  SELECT EXISTS(
    SELECT 1 FROM stock_movements
    WHERE company_id=OLD.company_id AND item_id=OLD.id
  ) INTO history_exists;
  SELECT EXISTS(
    SELECT 1 FROM stock_balances
    WHERE company_id=OLD.company_id AND item_id=OLD.id AND quantity_smallest<>0
  ) INTO nonzero_stock;
  IF NOT history_exists AND NOT nonzero_stock THEN RETURN NEW; END IF;

  stable_pack := OLD.unit1_name IS NOT DISTINCT FROM NEW.unit1_name
    AND OLD.has_expiry IS NOT DISTINCT FROM NEW.has_expiry
    AND OLD.factor2::numeric * OLD.factor3::numeric =
        NEW.factor2::numeric * NEW.factor3::numeric
    AND NOT (NEW.factor3>1 AND NEW.factor2<=1)
    AND NOT (NEW.factor2>1 AND length(btrim(NEW.unit2_name))=0)
    AND NOT (NEW.factor3>1 AND length(btrim(NEW.unit3_name))=0);
  IF stable_pack THEN
    IF EXISTS(
      SELECT 1 FROM stock_balances
      WHERE company_id=OLD.company_id AND item_id=OLD.id
        AND MOD(quantity_smallest,
                OLD.factor2::numeric*OLD.factor3::numeric)<>0
    ) THEN
      RAISE EXCEPTION 'Secondary unit edit requires whole first-unit stock in every batch'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF nonzero_stock THEN
    RAISE EXCEPTION 'Changing stock unit multiplier requires an audited conversion'
      USING ERRCODE='23514';
  END IF;
  IF history_exists AND (
    OLD.unit1_name IS DISTINCT FROM NEW.unit1_name
    OR OLD.has_expiry IS DISTINCT FROM NEW.has_expiry
    OR (OLD.factor2>1 AND
        (OLD.factor2 IS DISTINCT FROM NEW.factor2 OR
         OLD.unit2_name IS DISTINCT FROM NEW.unit2_name))
    OR (OLD.factor3>1 AND
        (OLD.factor3 IS DISTINCT FROM NEW.factor3 OR
         OLD.unit3_name IS DISTINCT FROM NEW.unit3_name))
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
