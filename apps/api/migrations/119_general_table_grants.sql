-- Default-deny permissions for the public general table, scoped to each named table.
-- Existing rows are preserved and no users are automatically granted access.
CREATE TABLE general_table_grants (
  user_id integer NOT NULL REFERENCES users(id),
  table_name varchar(120) NOT NULL CHECK(length(btrim(table_name))>0),
  role varchar(10) NOT NULL CHECK(role IN ('viewer','editor')),
  granted_by integer NOT NULL REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,table_name)
);
CREATE INDEX general_table_grants_table_idx ON general_table_grants(table_name,user_id);
