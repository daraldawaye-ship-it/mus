-- Allow ordinary signed-in company members to connect ChatGPT using site-only
-- OAuth scopes. This changes only the allowed consent strings; it grants no
-- company permissions, global table access, or additional records. The API
-- checks company membership and permissions for every individual operation.
ALTER TABLE chatgpt_oauth_codes
  DROP CONSTRAINT IF EXISTS chatgpt_oauth_codes_scope_check;
ALTER TABLE chatgpt_oauth_codes
  ADD CONSTRAINT chatgpt_oauth_codes_scope_check
  CHECK (scope IN (
    'general_table.read',
    'general_table.read general_table.write',
    'tijara.read',
    'tijara.read tijara.write',
    'general_table.read tijara.read',
    'general_table.read general_table.write tijara.read tijara.write'
  ));

ALTER TABLE chatgpt_oauth_tokens
  DROP CONSTRAINT IF EXISTS chatgpt_oauth_tokens_scope_check;
ALTER TABLE chatgpt_oauth_tokens
  ADD CONSTRAINT chatgpt_oauth_tokens_scope_check
  CHECK (scope IN (
    'general_table.read',
    'general_table.read general_table.write',
    'tijara.read',
    'tijara.read tijara.write',
    'general_table.read tijara.read',
    'general_table.read general_table.write tijara.read tijara.write'
  ));
