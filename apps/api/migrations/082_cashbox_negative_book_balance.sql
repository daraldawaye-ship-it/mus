-- Permit closing a till whose BOOK balance is negative. Counted cash
-- stays nonnegative: the difference (book balance - counted cash) is posted
-- to the configured over/short account, and the till is zeroed in one journal.
-- Historical operations and audit records are immutable and unaffected.
ALTER TABLE employee_cashbox_operations
  DROP CONSTRAINT employee_cashbox_operations_check;
ALTER TABLE employee_cashbox_operations
  ADD CONSTRAINT employee_cashbox_operations_check CHECK (
    (kind IN ('pouch','electronic') AND amount<>0
      AND variance_account_id IS NULL
      AND book_balance IS NULL AND variance_amount IS NULL)
    OR (kind='close' AND amount>=0 AND variance_account_id IS NOT NULL
      AND book_balance IS NOT NULL
      AND variance_amount=book_balance-amount)
  );
