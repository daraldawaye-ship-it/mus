-- Accept a named, unclassified beneficiary only in administrative custody.
-- Preserve existing signed transfers, links and accounting-mark constraints.
ALTER TABLE administrative_custody_transfers
  DROP CONSTRAINT custody_expense_fields,
  ADD CONSTRAINT custody_expense_fields CHECK (
    (expense_kind='other' AND doctor_id IS NULL AND doctor_name IS NULL AND doctor_main_name IS NULL AND doctor_kind IS NULL AND slip_count IS NULL)
    OR (expense_kind='medical' AND amount>0 AND doctor_id IS NOT NULL AND doctor_name IS NOT NULL AND doctor_main_name IS NOT NULL AND doctor_kind IS NOT NULL AND doctor_kind IN ('doctor','nurse','unassigned') AND slip_count IS NULL)
    OR (expense_kind='slips' AND amount>0 AND doctor_id IS NOT NULL AND doctor_name IS NOT NULL AND doctor_main_name IS NOT NULL AND doctor_kind IS NOT NULL AND doctor_kind IN ('nurse','unassigned') AND slip_count IS NOT NULL AND slip_count>0)
  ),
  ADD CONSTRAINT custody_unassigned_no_sales_mark CHECK (
    doctor_kind IS DISTINCT FROM 'unassigned' OR (accounted_cutoff_invoice_id IS NULL AND accounted_invoice_count=0)
  );
