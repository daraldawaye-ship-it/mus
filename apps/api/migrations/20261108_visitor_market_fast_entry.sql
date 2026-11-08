-- Temporary public-market onboarding. A known starter password cannot authenticate after participation.
CREATE TABLE IF NOT EXISTS visitor_phone_accounts (
  user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  default_password_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS visitor_device_tokens (
  token_hash char(64) PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS visitor_device_tokens_user_idx ON visitor_device_tokens(user_id,expires_at);

-- Guest sessions may edit the public market but never access company/private APIs.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS visitor_only boolean NOT NULL DEFAULT false;
