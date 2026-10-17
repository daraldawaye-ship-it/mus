-- Personal, scoped navigation shortcuts. Zero represents the public scope;
-- company entries are checked against live membership and page permissions.
CREATE TABLE user_page_shortcuts (
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_company_id integer NOT NULL DEFAULT 0 CHECK (scope_company_id >= 0),
  page_keys text[] NOT NULL DEFAULT '{}'::text[] CHECK (cardinality(page_keys) <= 40),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, scope_company_id)
);
