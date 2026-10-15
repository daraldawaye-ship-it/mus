-- New access requires explicit OAuth consent. Never widen an existing token.
ALTER TABLE chatgpt_oauth_codes DROP CONSTRAINT chatgpt_oauth_codes_scope_check;
ALTER TABLE chatgpt_oauth_tokens DROP CONSTRAINT chatgpt_oauth_tokens_scope_check;
ALTER TABLE chatgpt_oauth_codes ADD CONSTRAINT chatgpt_oauth_codes_scope_check CHECK
 (scope IN ('general_table.read','general_table.read general_table.write',
 'general_table.read tijara.read','general_table.read general_table.write tijara.read tijara.write'));
ALTER TABLE chatgpt_oauth_tokens ADD CONSTRAINT chatgpt_oauth_tokens_scope_check CHECK
 (scope IN ('general_table.read','general_table.read general_table.write',
 'general_table.read tijara.read','general_table.read general_table.write tijara.read tijara.write'));
