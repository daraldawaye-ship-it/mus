-- Normalize descriptive account choices without changing ledger classification,
-- posting status, cash/bank flags, posted history or account identifiers.
-- Every new account inherits the administrative classification unless the
-- caller explicitly sets a more specific choice.
ALTER TABLE accounts ALTER COLUMN account_choice SET DEFAULT 'administrative';

-- Respect already chosen custom labels. Existing employee-owned accounts
-- that had no specific choice get the role used by their automation.
UPDATE accounts a
SET account_choice=CASE l.account_kind
  WHEN 'advance' THEN 'employee'
  WHEN 'sales_cash' THEN 'cashbox'
  WHEN 'sales_pouch' THEN 'pouch'
END
FROM employee_account_links l
WHERE a.company_id=l.company_id AND a.id=l.account_id
  AND (a.account_choice IS NULL OR a.account_choice='administrative');

-- Seeded chart accounts (sales, purchases, revenue, stock, etc.) and older
-- unclassified manual accounts become administrative. Explicit custom
-- choices, including archived/stopped labels, remain untouched.
UPDATE accounts
SET account_choice='administrative'
WHERE account_choice IS NULL;
