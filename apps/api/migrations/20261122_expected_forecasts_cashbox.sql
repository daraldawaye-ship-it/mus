-- Optional planning metadata only. Existing cards keep NULL and retain their original payloads.
ALTER TABLE expected_cards ADD COLUMN cash_account_id integer;
ALTER TABLE expected_cards ADD CONSTRAINT expected_cards_cash_account_company_fk
  FOREIGN KEY (company_id,cash_account_id) REFERENCES accounts(company_id,id);
CREATE INDEX expected_cards_cash_account ON expected_cards(company_id,cash_account_id)
  WHERE cash_account_id IS NOT NULL;
