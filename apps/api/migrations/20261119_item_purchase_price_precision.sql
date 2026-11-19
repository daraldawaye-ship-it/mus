-- A weighted purchase-card price is a unit cost, not a posted money amount.
-- Keep sale prices at currency precision and preserve all stored values/history.
CREATE OR REPLACE FUNCTION check_item_price_precision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE places integer;
BEGIN
  SELECT decimal_places INTO places FROM company_currencies
    WHERE company_id=NEW.company_id AND id=NEW.currency_id FOR SHARE;
  -- The composite foreign key still enforces the company/currency reference.
  IF places IS NOT NULL AND (
    NEW.sale_price1<>round(NEW.sale_price1,places)
    OR NEW.sale_price2<>round(NEW.sale_price2,places)
    OR NEW.sale_price3<>round(NEW.sale_price3,places)
    OR NEW.purchase_price<>round(NEW.purchase_price,GREATEST(4,places))
  ) THEN
    RAISE EXCEPTION 'Item prices exceed currency precision' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
