-- Import account names without truncation. Keep original 10-digit codes,
-- parent relationships, posted balances, cash and bank flags untouched.
ALTER TABLE accounts DROP CONSTRAINT accounts_name_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_name_check
  CHECK (length(name) BETWEEN 1 AND 240);

-- Source-account identity map. Re-import is idempotent by company + source
-- + old identifier, even when names repeat, change or contain long notes.
CREATE TABLE legacy_account_imports (
  company_id integer NOT NULL REFERENCES companies(id),
  source text NOT NULL CHECK (length(source) BETWEEN 1 AND 100),
  legacy_id integer NOT NULL CHECK (legacy_id>0),
  account_id integer NOT NULL,
  original_category text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id,source,legacy_id),
  UNIQUE(company_id,source,account_id),
  FOREIGN KEY(company_id,account_id) REFERENCES accounts(company_id,id)
);
CREATE INDEX legacy_account_imports_account ON legacy_account_imports(company_id,account_id);
