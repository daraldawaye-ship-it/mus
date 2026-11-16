// Invoice alias i. A replacement that was corrected again is itself an original.
export const currentPurchase = `NOT EXISTS (
  SELECT 1 FROM purchase_invoice_corrections pc
  WHERE pc.company_id=i.company_id AND (pc.original_id=i.id OR pc.reversal_id=i.id)
)`;
