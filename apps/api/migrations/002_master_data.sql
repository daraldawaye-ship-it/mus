-- Expand accepted permissions without changing any existing employee grant.
ALTER TABLE employees DROP CONSTRAINT employees_permissions_check;
ALTER TABLE employees ADD CONSTRAINT employees_permissions_check CHECK (
  permissions <@ ARRAY[
    'company.edit', 'employees.view', 'audit.view',
    'accounts.view', 'accounts.manage', 'currencies.view', 'currencies.manage',
    'locations.view', 'locations.manage'
  ]::text[]
);

CREATE TABLE accounts (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id),
  code text NOT NULL CHECK (code ~ '^[0-9]{10}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  parent_id integer,
  kind text NOT NULL CHECK (kind IN ('group', 'posting')),
  category text NOT NULL CHECK (category IN ('asset', 'liability', 'equity', 'income', 'expense')),
  normal_side text NOT NULL CHECK (normal_side IN ('debit', 'credit')),
  active boolean NOT NULL DEFAULT true,
  range_start text CHECK (range_start ~ '^[0-9]{10}$'),
  range_end text CHECK (range_end ~ '^[0-9]{10}$'),
  created_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, code),
  FOREIGN KEY (company_id, parent_id) REFERENCES accounts(company_id, id),
  CHECK (parent_id IS NULL OR parent_id <> id),
  CHECK ((range_start IS NULL) = (range_end IS NULL)),
  CHECK (range_start IS NULL OR (kind = 'group' AND range_start <= range_end))
);
CREATE INDEX accounts_parent ON accounts(company_id, parent_id);

CREATE TABLE account_links (
  company_id integer NOT NULL REFERENCES companies(id),
  purpose text NOT NULL CHECK (purpose IN (
    'salesRevenue', 'discountAllowed', 'discountEarned', 'inventory',
    'purchases', 'costOfGoodsSold', 'stockShortage', 'stockSurplus'
  )),
  account_id integer,
  PRIMARY KEY (company_id, purpose),
  FOREIGN KEY (company_id, account_id) REFERENCES accounts(company_id, id)
);

CREATE TABLE company_currencies (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id),
  code text NOT NULL CHECK (code ~ '^[A-Z]{3}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  decimal_places integer NOT NULL CHECK (decimal_places BETWEEN 0 AND 6),
  active boolean NOT NULL DEFAULT true,
  created_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, code)
);

CREATE TABLE finance_settings (
  company_id integer PRIMARY KEY REFERENCES companies(id),
  base_currency_id integer NOT NULL,
  UNIQUE (company_id, base_currency_id),
  FOREIGN KEY (company_id, base_currency_id) REFERENCES company_currencies(company_id, id)
);

CREATE TABLE exchange_rates (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id),
  currency_id integer NOT NULL,
  base_currency_id integer NOT NULL,
  rate numeric(28,12) NOT NULL CHECK (rate > 0),
  effective_at timestamptz NOT NULL,
  source text NOT NULL CHECK (length(source) BETWEEN 1 AND 200),
  active boolean NOT NULL DEFAULT true,
  created_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, currency_id, effective_at),
  FOREIGN KEY (company_id, currency_id) REFERENCES company_currencies(company_id, id),
  FOREIGN KEY (company_id, base_currency_id) REFERENCES company_currencies(company_id, id),
  FOREIGN KEY (company_id, base_currency_id) REFERENCES finance_settings(company_id, base_currency_id),
  CHECK (currency_id <> base_currency_id)
);
CREATE INDEX exchange_rates_effective ON exchange_rates(company_id, currency_id, effective_at DESC, id DESC) WHERE active;

CREATE TABLE branches (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id),
  code text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{1,20}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  phone text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, code)
);

CREATE TABLE locations (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id),
  branch_id integer NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{1,20}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  kind text NOT NULL CHECK (kind IN ('showroom', 'warehouse')),
  active boolean NOT NULL DEFAULT true,
  created_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, branch_id, code),
  FOREIGN KEY (company_id, branch_id) REFERENCES branches(company_id, id)
);
CREATE UNIQUE INDEX locations_one_showroom ON locations(company_id, branch_id) WHERE kind = 'showroom';
CREATE INDEX locations_branch ON locations(company_id, branch_id, id);
