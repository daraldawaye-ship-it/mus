-- Independent configuration slot only; no account links are inserted or changed.
ALTER TABLE account_links DROP CONSTRAINT IF EXISTS account_links_purpose_check;
ALTER TABLE account_links ADD CONSTRAINT account_links_purpose_check CHECK (
  purpose IN (
    'salesRevenue','discountAllowed','discountEarned','inventory',
    'purchases','costOfGoodsSold','stockShortage','stockSurplus','damagedGoodsExpense',
    'cashVariance','electronicWallet','administrativeCustody',
    'administrativeCustodyPouch','medicalSlipsExpense','medicalCommissionExpense',
    'salaryExpense','salaryPayable','rewardExpense','rewardPayable',
    'commissionExpense','commissionPayable','allowanceExpense','allowancePayable',
    'overtimeExpense','operatingRentExpense','operatingUtilitiesExpense',
    'operatingMaintenanceExpense','operatingCommunicationsExpense'
  )
);
