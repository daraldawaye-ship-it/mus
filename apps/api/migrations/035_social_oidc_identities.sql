-- Verified social identities are keyed by immutable provider subject, never by email.
CREATE TABLE social_identities (
  provider text NOT NULL CHECK (provider IN ('google','apple')),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
  user_id integer NOT NULL REFERENCES users(id),
  email_at_link text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider,subject),
  UNIQUE(provider,user_id)
);
CREATE INDEX social_identities_user ON social_identities(user_id);
-- Short-lived state is one-use; provider codes and tokens are never persisted.
CREATE TABLE social_auth_attempts (
  state_hash text PRIMARY KEY CHECK (length(state_hash)=64),
  provider text NOT NULL CHECK (provider IN ('google','apple')),
  nonce text NOT NULL CHECK (length(nonce) BETWEEN 16 AND 128),
  code_verifier text,
  intent text NOT NULL CHECK (intent IN ('login','link')),
  user_id integer REFERENCES users(id),
  return_to text NOT NULL DEFAULT '/',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((intent='link')=(user_id IS NOT NULL))
);
CREATE INDEX social_auth_attempts_expiry ON social_auth_attempts(expires_at);
