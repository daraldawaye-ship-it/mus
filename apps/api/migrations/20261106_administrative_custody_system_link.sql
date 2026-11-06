-- Reserve a system-account link for the administrative custody account.
-- This is a selectable, initially unbound purpose only: no ledger account,
-- posting, or automatic financial movement is created by this migration.
ALTER TABLE account_links DROP CONSTRAINT IF EXISTS account_links_purpose_check;
ALTER TABLE account_links ADD CONSTRAINT account_links_purpose_check CHECK (
  purpose IN (
    'salesRevenue','discountAllowed','discountEarned','inventory',
    'purchases','costOfGoodsSold','stockShortage','stockSurplus',
    'cashVariance','electronicWallet','administrativeCustody',
    'salaryExpense','salaryPayable','rewardExpense','rewardPayable',
    'commissionExpense','commissionPayable','allowanceExpense','allowancePayable',
    'overtimeExpense','operatingRentExpense','operatingUtilitiesExpense',
    'operatingMaintenanceExpense','operatingCommunicationsExpense'
  )
);
