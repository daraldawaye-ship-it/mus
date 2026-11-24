-- Establish the reactivation baseline, not a new inventory movement.
-- Use the same company lock as the existing periodic notification scanner.
SELECT id FROM companies WHERE id=2 FOR UPDATE;

ALTER TABLE negative_stock_notification_incidents
  ADD COLUMN suppressed_episode integer CHECK (suppressed_episode > 0);

WITH current_negative AS (
  SELECT s.company_id,s.item_id,s.location_id
  FROM stock_balances s
  JOIN items i ON i.company_id=s.company_id AND i.id=s.item_id AND i.active
  JOIN locations l ON l.company_id=s.company_id AND l.id=s.location_id AND l.active
  JOIN branches b ON b.company_id=l.company_id AND b.id=l.branch_id AND b.active
  WHERE s.company_id=2
  GROUP BY s.company_id,s.item_id,s.location_id
  HAVING sum(s.quantity_smallest)<0
)
INSERT INTO negative_stock_notification_incidents(company_id,item_id,location_id,episode,active,suppressed_episode)
SELECT company_id,item_id,location_id,1,true,1 FROM current_negative
ON CONFLICT(company_id,item_id,location_id) DO UPDATE
SET active=true,suppressed_episode=negative_stock_notification_incidents.episode,
    updated_at=clock_timestamp();

-- Register recovery already reflected in the stock snapshot even if a worker
-- hasn't observed it yet. The normal scanner handles historical notice closure.
UPDATE negative_stock_notification_incidents state
SET active=false,updated_at=clock_timestamp()
WHERE state.company_id=2 AND state.active AND state.suppressed_episode IS NULL;
