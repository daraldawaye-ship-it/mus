-- Therapeutic classifications are regular published market cards.
ALTER TABLE medicine_market_cards DROP CONSTRAINT IF EXISTS medicine_market_cards_kind_check;
ALTER TABLE medicine_market_cards ADD CONSTRAINT medicine_market_cards_kind_check
 CHECK (kind IN ('medicine','composition','scientific-name','dosage-form','pharmacy',
 'wholesaler','agent','manufacturer','doctor','hospital','clinic','college','prescription','drug-classification'));
