-- One shortage incident per company/item, independent of scan day.
-- Legacy daily alerts remain in history and are not resent on rollout.
CREATE TABLE item_order_notification_incidents (
  company_id integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  item_id integer NOT NULL,
  episode integer NOT NULL DEFAULT 1 CHECK (episode>0),
  active boolean NOT NULL DEFAULT true,
  legacy_suppressed boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (company_id,item_id)
);

-- Existing low-stock items that previously generated a daily notification
-- begin in an active incident; no duplicate launch-day alert is sent.
INSERT INTO item_order_notification_incidents(company_id,item_id,episode,active,legacy_suppressed)
SELECT DISTINCT i.company_id,i.id,1,true,true
FROM items i
JOIN item_order_reminder_days old
  ON old.company_id=i.company_id AND old.item_id=i.id
LEFT JOIN item_statistics s ON s.company_id=i.company_id AND s.item_id=i.id
WHERE i.active AND i.order_alert_quantity IS NOT NULL
  AND COALESCE(s.stock_showroom,0)+COALESCE(s.stock_warehouse,0)
      <= i.order_alert_quantity*i.factor2::numeric*i.factor3::numeric
ON CONFLICT DO NOTHING;

-- New automatic resolution classification, not a manual review.
ALTER TABLE notification_auto_resolutions
  DROP CONSTRAINT notification_auto_resolutions_reason_check;
ALTER TABLE notification_auto_resolutions
  ADD CONSTRAINT notification_auto_resolutions_reason_check
  CHECK (reason IN (
    'negative_balance_recovered',
    'expired_batch_removed',
    'item_order_level_recovered'
  ));
