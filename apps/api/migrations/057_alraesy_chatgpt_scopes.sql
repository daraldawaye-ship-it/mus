-- Separate Alraesy read/write grants from the legacy general-table-only connector.
-- Existing OAuth authorizations remain unchanged and cannot use the new tools.
ALTER TABLE chatgpt_oauth_codes DROP CONSTRAINT chatgpt_oauth_codes_scope_check;
ALTER TABLE chatgpt_oauth_codes
  ADD CONSTRAINT chatgpt_oauth_codes_scope_check
  CHECK (scope IN (
    'general_table.read','general_table.read general_table.write',
    'alraesy.read','alraesy.read alraesy.write'
  ));
ALTER TABLE chatgpt_oauth_tokens DROP CONSTRAINT chatgpt_oauth_tokens_scope_check;
ALTER TABLE chatgpt_oauth_tokens
  ADD CONSTRAINT chatgpt_oauth_tokens_scope_check
  CHECK (scope IN (
    'general_table.read','general_table.read general_table.write',
    'alraesy.read','alraesy.read alraesy.write'
  ));
