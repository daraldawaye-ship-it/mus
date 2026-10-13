-- Optional descriptive card choice; existing accounts remain unchanged.
-- Distinct keys cashbox / cashboxSecond deliberately share the Arabic label.
ALTER TABLE accounts ADD COLUMN account_choice text;
ALTER TABLE accounts ADD CONSTRAINT accounts_choice_known CHECK (
  account_choice IS NULL OR account_choice IN ('company','customer','expense','wholesale','distributor','doctor','employee','pledges','cashbox','custody','pouch','administrative','purchaseCashbox','cashboxSecond','pharmacy','archived','stopped','followUp')
);
CREATE INDEX accounts_choice ON accounts(company_id,account_choice) WHERE account_choice IS NOT NULL;
