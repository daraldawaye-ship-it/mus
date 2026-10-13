-- Item-specific clearance commission, optional and disabled by default.
-- No existing invoice is repriced; snapshots on historical rows remain zero.
ALTER TABLE items
  ADD COLUMN commission_rate numeric(7,4) NOT NULL DEFAULT 0
    CHECK (commission_rate >= 0 AND commission_rate <= 100),
  ADD COLUMN clearance_from date,
  ADD COLUMN clearance_to date,
  ADD CONSTRAINT item_clearance_period CHECK (
    (commission_rate = 0 OR (clearance_from IS NOT NULL AND clearance_to IS NOT NULL))
    AND (clearance_from IS NULL OR clearance_to IS NULL OR clearance_from <= clearance_to)
  );

ALTER TABLE invoice_lines
  ADD COLUMN commission_rate numeric(7,4) NOT NULL DEFAULT 0
    CHECK (commission_rate >= 0 AND commission_rate <= 100),
  ADD COLUMN commission_amount numeric(28,6) NOT NULL DEFAULT 0;

-- Snapshot values are audit/eligibility amounts, not payroll or cash disbursements.
COMMENT ON COLUMN invoice_lines.commission_amount IS
 'Historical, exact item clearance commission; unposted as an employee payable until a beneficiary and financial policy are configured.';
