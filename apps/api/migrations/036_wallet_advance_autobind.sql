-- Backfill an automatic wallet settlement account only where no binding exists.
-- Historical/manual bindings and existing posted/pending conversions are untouched.
-- Future employees receive their advance wallet binding in the employee-creation transaction.
INSERT INTO employee_wallet_accounts(company_id,employee_id,account_id,updated_by)
SELECT link.company_id,link.employee_id,link.account_id,e.created_by
FROM employee_account_links link
JOIN employees e ON e.company_id=link.company_id AND e.id=link.employee_id
JOIN accounts a ON a.company_id=link.company_id AND a.id=link.account_id
WHERE link.account_kind='advance'
  AND a.active=true AND a.kind='posting' AND a.category='asset'
  AND NOT EXISTS (
    SELECT 1 FROM employee_wallet_accounts b
    WHERE b.company_id=link.company_id AND b.employee_id=link.employee_id
  )
ON CONFLICT(company_id,employee_id) DO NOTHING;
