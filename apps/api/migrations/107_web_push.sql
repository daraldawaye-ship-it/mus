-- Device opt-in for standard HTTPS Web Push. Endpoints and authentication
-- material are private to the backend, never returned in an inbox response.
CREATE TABLE web_push_subscriptions(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_hash text NOT NULL,
  endpoint_hash char(64) NOT NULL UNIQUE,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX web_push_user_session ON web_push_subscriptions(user_id,session_hash);
-- Durable per-device delivery ledger. A notification is never re-sent after a
-- confirmed response, and multiple workers claim distinct pending rows.
CREATE TABLE web_push_deliveries(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  notification_id integer NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  subscription_id bigint NOT NULL REFERENCES web_push_subscriptions(id) ON DELETE CASCADE,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivered_at timestamptz,
  cancelled_at timestamptz,
  last_status integer,
  UNIQUE(notification_id,subscription_id)
);
CREATE INDEX web_push_delivery_queue ON web_push_deliveries(next_attempt_at,id)
 WHERE delivered_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX web_push_unsent_notification ON notifications(created_at,id)
 WHERE read_at IS NULL AND completed_at IS NULL;
