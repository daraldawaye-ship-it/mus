-- The cancellation day is protected history, not a future forecast.
UPDATE expected_movements m
SET archived_at=NULL, revision=m.revision+1, updated_at=clock_timestamp()
FROM expected_cards c
WHERE (m.company_id,m.card_id)=(c.company_id,c.id)
  AND m.archived_at=c.archived_at
  AND m.status='pending'
  AND (m.original_date<=c.archive_day OR m.movement_date<=c.archive_day);
