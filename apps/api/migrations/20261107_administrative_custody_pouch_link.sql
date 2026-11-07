-- Administrative custody has its own independently linked pouch,
-- distinct from the company electronic wallet and every employee pouch.
ALTER TABLE account_links DROP CONSTRAINT IF EXISTS account_links_purpose_check;
ALTER TABLE account_links ADD CONSTRAINT account_links_purpose_check CHECK (
  purpose IN (
    'salesRevenue','discountAllowed','discountEarned','inventory',
    'purchases','costOfGoodsSold','stockShortage','stockSurplus',
    'cashVariance','electronicWallet','administrativeCustody',
    'administrativeCustodyPouch',
    'salaryExpense','salaryPayable','rewardExpense','rewardPayable',
    'commissionExpense','commissionPayable','allowanceExpense','allowancePayable',
    'overtimeExpense','operatingRentExpense','operatingUtilitiesExpense',
    'operatingMaintenanceExpense','operatingCommunicationsExpense'
  )
);
