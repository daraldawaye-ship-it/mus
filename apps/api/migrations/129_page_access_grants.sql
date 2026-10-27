-- Granular page visibility grants for platform account types, monitors,
-- company employee positions and individual user IDs.
CREATE TABLE IF NOT EXISTS page_access_grants (
  id BIGSERIAL PRIMARY KEY,
  page_key TEXT NOT NULL REFERENCES page_registry(key) ON DELETE CASCADE,
  company_id BIGINT REFERENCES companies(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('view','create','edit','print','post','reverse')),
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user','kind','monitor','position')),
  principal_value TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('allow','deny')),
  created_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE NULLS NOT DISTINCT (page_key, company_id, action, principal_type, principal_value)
);
CREATE INDEX IF NOT EXISTS page_access_grants_lookup ON page_access_grants(page_key,company_id,action);
