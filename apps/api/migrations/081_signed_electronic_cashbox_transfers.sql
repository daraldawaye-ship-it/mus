-- The employee's digital-wallet transfer follows the same signed convention
-- as their sales pouch: a positive amount is sent out from the employee till;
-- a negative amount is received back into the employee till.
-- Closing the till is a physical cash count, not a directional transfer,
-- so its counted amount remains nonnegative.
ALTER TABLE employee_cashbox_operations
  DROP CONSTRAINT employee_cashbox_operations_check;
ALTER TABLE employee_cashbox_operations
  ADD CONSTRAINT employee_cashbox_operations_check CHECK (
    (kind IN ('pouch','electronic') AND amount<>0
      AND variance_account_id IS NULL
      AND book_balance IS NULL AND variance_amount IS NULL)
    OR (kind='close' AND amount>=0 AND variance_account_id IS NOT NULL
      AND book_balance>=0 AND variance_amount=book_balance-amount)
  );
