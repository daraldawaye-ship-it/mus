-- Opt-in write scope for ChatGPT. Existing read-only authorizations keep read-only access.
ALTER TABLE chatgpt_oauth_codes
  ADD COLUMN scope text NOT NULL DEFAULT 'general_table.read'
  CONSTRAINT chatgpt_oauth_codes_scope_check
  CHECK (scope IN ('general_table.read', 'general_table.read general_table.write'));

ALTER TABLE chatgpt_oauth_tokens
  DROP CONSTRAINT chatgpt_oauth_tokens_scope_check;

ALTER TABLE chatgpt_oauth_tokens
  ADD CONSTRAINT chatgpt_oauth_tokens_scope_check
  CHECK (scope IN ('general_table.read', 'general_table.read general_table.write'));
