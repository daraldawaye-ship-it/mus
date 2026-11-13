-- Classification metadata only: the existing two-account journal is unchanged.
ALTER TABLE administrative_custody_transfers
  ADD COLUMN expense_kind text NOT NULL DEFAULT 'other',
  ADD COLUMN doctor_id integer,
  ADD COLUMN doctor_name varchar(240),
  ADD COLUMN doctor_main_name varchar(240),
  ADD COLUMN doctor_kind varchar(12),
  ADD COLUMN slip_count integer,
  ADD COLUMN accounted_cutoff_invoice_id integer,
  ADD COLUMN accounted_invoice_count integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT custody_expense_doctor_fk FOREIGN KEY(company_id,doctor_id) REFERENCES doctors(company_id,id),
  ADD CONSTRAINT custody_expense_fields CHECK (
    (expense_kind='other' AND doctor_id IS NULL AND doctor_name IS NULL AND doctor_main_name IS NULL AND doctor_kind IS NULL AND slip_count IS NULL)
    OR (expense_kind='medical' AND amount>0 AND doctor_id IS NOT NULL AND doctor_name IS NOT NULL AND doctor_main_name IS NOT NULL AND doctor_kind IS NOT NULL AND doctor_kind IN ('doctor','nurse') AND slip_count IS NULL)
    OR (expense_kind='slips' AND amount>0 AND doctor_id IS NOT NULL AND doctor_name IS NOT NULL AND doctor_main_name IS NOT NULL AND doctor_kind IS NOT NULL AND doctor_kind='nurse' AND slip_count IS NOT NULL AND slip_count>0)
  ),
  ADD CONSTRAINT custody_expense_marking CHECK (
    accounted_invoice_count>=0 AND (expense_kind='medical' OR (accounted_cutoff_invoice_id IS NULL AND accounted_invoice_count=0))
  );
CREATE INDEX custody_expense_beneficiary ON administrative_custody_transfers(company_id,doctor_kind,doctor_main_name,created_at DESC)
  WHERE doctor_id IS NOT NULL;

ALTER TABLE account_links DROP CONSTRAINT IF EXISTS account_links_purpose_check;
ALTER TABLE account_links ADD CONSTRAINT account_links_purpose_check CHECK (
  purpose IN (
    'salesRevenue','discountAllowed','discountEarned','inventory',
    'purchases','costOfGoodsSold','stockShortage','stockSurplus',
    'cashVariance','electronicWallet','administrativeCustody',
    'administrativeCustodyPouch','medicalSlipsExpense','medicalCommissionExpense',
    'salaryExpense','salaryPayable','rewardExpense','rewardPayable',
    'commissionExpense','commissionPayable','allowanceExpense','allowancePayable',
    'overtimeExpense','operatingRentExpense','operatingUtilitiesExpense',
    'operatingMaintenanceExpense','operatingCommunicationsExpense'
  )
);

CREATE INDEX custody_receipts_voucher_lookup ON administrative_custody_receipts(company_id,voucher_document_id)
  WHERE voucher_document_id IS NOT NULL;
