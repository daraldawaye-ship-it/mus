-- Company/employee control values are separate from per-record option values.
-- Existing businesses inherit the catalog defaults without rewriting records.
CREATE TABLE company_control_values (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id),
  control_key varchar(100) NOT NULL,
  employee_id integer REFERENCES employees(id),
  value jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by integer NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (company_id,control_key,employee_id)
);
CREATE INDEX company_control_employee ON company_control_values(company_id,employee_id);
CREATE TABLE company_control_policies (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id),
  control_key varchar(100) NOT NULL,
  accountant_allowed boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
  updated_by integer NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id,control_key)
);
CREATE TABLE company_control_editor_grants (
  company_id integer NOT NULL REFERENCES companies(id),
  control_key varchar(100) NOT NULL,
  employee_id integer NOT NULL REFERENCES employees(id),
  granted_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,control_key,employee_id)
);
CREATE INDEX company_control_editors_lookup ON company_control_editor_grants(company_id,employee_id,control_key);

INSERT INTO page_registry(key) VALUES('company.control') ON CONFLICT DO NOTHING;
INSERT INTO permission_definitions(key,page_key,action,name,rule_role,required_permissions)
VALUES ('company.control:view','company.control','view','الكنترول — عرض','company-member',ARRAY[]::text[])
ON CONFLICT(key) DO NOTHING;
