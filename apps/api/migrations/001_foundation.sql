CREATE TABLE users (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  display_name text NOT NULL,
  email text NOT NULL UNIQUE,
  phone text NOT NULL DEFAULT '',
  image text NOT NULL DEFAULT '',
  password_hash text NOT NULL,
  kind text NOT NULL DEFAULT 'member' CHECK (kind IN ('admin', 'supervisor', 'member')),
  owner boolean NOT NULL DEFAULT false,
  archived boolean NOT NULL DEFAULT false,
  suspended boolean NOT NULL DEFAULT false,
  editor boolean NOT NULL DEFAULT false,
  monitor boolean NOT NULL DEFAULT false,
  last_company_id integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT owner OR NOT archived)
);
CREATE UNIQUE INDEX one_platform_owner ON users(owner) WHERE owner;

CREATE TABLE companies (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  phone text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  created_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD CONSTRAINT users_last_company_fk
  FOREIGN KEY (last_company_id) REFERENCES companies(id);

CREATE TABLE employees (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id),
  user_id integer NOT NULL REFERENCES users(id),
  name text NOT NULL,
  phone text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT 'employee'
    CHECK (role IN ('employee', 'administrative', 'accountant', 'sales', 'purchases')),
  active boolean NOT NULL DEFAULT true,
  is_general_manager boolean NOT NULL DEFAULT false,
  permissions text[] NOT NULL DEFAULT '{}'
    CHECK (permissions <@ ARRAY['company.edit', 'employees.view', 'audit.view']::text[]),
  created_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, user_id)
);
CREATE INDEX employees_user_access ON employees(user_id, company_id) WHERE active;

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  csrf text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE appearance (
  user_id integer NOT NULL REFERENCES users(id),
  scope text NOT NULL CHECK (scope = 'public' OR scope ~ '^company:[1-9][0-9]*$'),
  mode text NOT NULL CHECK (mode IN ('light', 'dark')),
  color text NOT NULL CHECK (color ~ '^#[0-9a-f]{6}$'),
  PRIMARY KEY (user_id, scope)
);

CREATE TABLE audit_events (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id integer REFERENCES users(id),
  actor_name text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('public', 'company')),
  company_id integer REFERENCES companies(id),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id integer,
  before_value jsonb,
  after_value jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (scope = 'public' AND company_id IS NULL) OR
    (scope = 'company' AND company_id IS NOT NULL)
  )
);
CREATE INDEX audit_scope_page ON audit_events(company_id, id DESC);
CREATE INDEX users_phone ON users(phone) WHERE phone <> '';
