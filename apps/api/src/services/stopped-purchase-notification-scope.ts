// Alias n is the already-authorized notification row. Use its stored item key,
// never the rendered name or code. Unknown legacy keys still keep their history.
export const stoppedPurchaseNotificationIsEligible = `(CASE
  WHEN n.code = 'PURCHASE_STOPPED_ORDER' AND n.company_id IS NOT NULL THEN NOT EXISTS (
    SELECT 1 FROM items checked_item
    WHERE checked_item.company_id = n.company_id
      AND checked_item.id = substring(n.subject_key from '^purchase:[1-9][0-9]*:item:([1-9][0-9]{0,15})$')::bigint
      AND checked_item.order_alert_quantity IS NOT NULL
  )
  ELSE true END)`;
