-- Private, per-user ChatGPT connection. Never store bearer tokens or codes in cleartext.
CREATE TABLE chatgpt_oauth_clients (
 client_id text PRIMARY KEY,
 redirect_uris jsonb NOT NULL,
 client_name text NOT NULL DEFAULT 'ChatGPT',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE chatgpt_oauth_codes (
 code_hash text PRIMARY KEY,
 client_id text NOT NULL REFERENCES chatgpt_oauth_clients(client_id),
 user_id integer NOT NULL REFERENCES users(id),
 redirect_uri text NOT NULL,
 code_challenge text NOT NULL,
 resource text NOT NULL,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chatgpt_oauth_codes_expiry ON chatgpt_oauth_codes(expires_at);
CREATE TABLE chatgpt_oauth_tokens (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 access_hash text NOT NULL UNIQUE,
 refresh_hash text NOT NULL UNIQUE,
 client_id text NOT NULL REFERENCES chatgpt_oauth_clients(client_id),
 user_id integer NOT NULL REFERENCES users(id),
 resource text NOT NULL,
 scope text NOT NULL DEFAULT 'general_table.read'
   CHECK (scope='general_table.read'),
 access_expires_at timestamptz NOT NULL,
 refresh_expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 last_used_at timestamptz
);
CREATE INDEX chatgpt_oauth_tokens_user ON chatgpt_oauth_tokens(user_id,created_at DESC);
CREATE INDEX chatgpt_oauth_tokens_refresh_expiry ON chatgpt_oauth_tokens(refresh_expires_at);
