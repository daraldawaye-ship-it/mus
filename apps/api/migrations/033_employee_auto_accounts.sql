-- Atomic account ownership for newly registered company employees.
-- Existing employee history is unchanged; employee accounts are provisioned on new POST only.
ALTER TABLE employees
  ADD CONSTRAINT employees_company_id_id_unique UNIQUE (company_id,id);

CREATE TABLE employee_account_links (
  company_id integer NOT NULL,
  employee_id integer NOT NULL,
  account_kind text NOT NULL CHECK (account_kind IN ('advance','sales_cash','sales_pouch')),
  account_id integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (company_id,employee_id,account_kind),
  UNIQUE (company_id,account_id),
  FOREIGN KEY (company_id,employee_id) REFERENCES employees(company_id,id),
  FOREIGN KEY (company_id,account_id) REFERENCES accounts(company_id,id)
);
CREATE INDEX employee_account_links_employee ON employee_account_links(company_id,employee_id);
