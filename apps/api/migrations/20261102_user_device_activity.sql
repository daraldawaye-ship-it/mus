-- Device login and server-confirmed Web Push registration, without IP, UA history
-- or sensitive push endpoint material. Unknown history stays NULL.
CREATE TABLE IF NOT EXISTS user_device_activity (
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_kind text NOT NULL CHECK (device_kind IN
    ('desktop_browser','mobile_browser','android_app','iphone_app')),
  last_login_at timestamptz,
  last_push_confirmed_at timestamptz,
  PRIMARY KEY (user_id, device_kind)
);
ALTER TABLE web_push_subscriptions
  ADD COLUMN IF NOT EXISTS device_kind text;
ALTER TABLE web_push_subscriptions
  ADD CONSTRAINT web_push_subscription_device_kind_check
    CHECK (device_kind IS NULL OR device_kind IN
      ('desktop_browser','mobile_browser','android_app','iphone_app'));
CREATE INDEX IF NOT EXISTS web_push_user_kind_idx
  ON web_push_subscriptions(user_id,device_kind);
