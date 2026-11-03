-- Company-scoped browser/PWA installations: recognition only, NOT an access control.
-- A random client UUID is hashed before persistence; UA metadata is informational.
CREATE TABLE IF NOT EXISTS company_known_devices (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  identity_hash CHAR(64) NOT NULL,
  label TEXT NOT NULL DEFAULT '' CHECK (char_length(label) <= 80),
  category TEXT NOT NULL DEFAULT 'unclassified'
    CHECK (category IN ('unclassified', 'pharmacy', 'employee')),
  approved BOOLEAN NOT NULL DEFAULT FALSE,
  device_kind TEXT NOT NULL DEFAULT 'desktop_browser'
    CHECK (device_kind IN ('desktop_browser','mobile_browser','android_app','iphone_app')),
  browser TEXT NOT NULL DEFAULT '',
  operating_system TEXT NOT NULL DEFAULT '',
  first_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  last_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  UNIQUE(company_id, identity_hash)
);
CREATE INDEX IF NOT EXISTS company_known_devices_recent_idx
  ON company_known_devices(company_id,last_seen_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS company_known_device_users (
  device_id BIGINT NOT NULL REFERENCES company_known_devices(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(device_id,user_id)
);
CREATE INDEX IF NOT EXISTS company_known_device_users_user_idx
  ON company_known_device_users(user_id,last_seen_at DESC);
INSERT INTO page_registry(key) VALUES ('company.approved-devices')
ON CONFLICT(key) DO NOTHING;
