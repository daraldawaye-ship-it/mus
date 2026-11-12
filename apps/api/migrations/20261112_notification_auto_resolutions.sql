-- Preserve whether a stock notification was closed by the system,
-- distinct from a user explicitly completing/reviewing it.
CREATE TABLE notification_auto_resolutions (
  notification_id integer PRIMARY KEY REFERENCES notifications(id),
  reason text NOT NULL CHECK (reason IN ('negative_balance_recovered','expired_batch_removed')),
  resolved_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
