-- Expected cash planning is independent of every accounting projection.
CREATE TABLE expected_cards (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id),
  account_id integer NOT NULL,
  section text NOT NULL DEFAULT '' CHECK (length(section) <= 120),
  currency_code text NOT NULL DEFAULT '',
  amount numeric(28,6) NOT NULL,
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  recurrence text NOT NULL CHECK (recurrence IN ('daily','weekly','monthly','once')),
  weekday integer CHECK (weekday BETWEEN 0 AND 6),
  month_day integer CHECK (month_day BETWEEN 1 AND 31),
  once_date date,
  start_date date NOT NULL,
  end_date date NOT NULL,
  expiry_mode text NOT NULL CHECK (expiry_mode IN ('carry','complete')),
  created_by integer NOT NULL REFERENCES users(id),
  created_by_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  idempotency_key uuid NOT NULL,
  creation_payload jsonb NOT NULL,
  UNIQUE (company_id,id),
  UNIQUE (company_id,idempotency_key),
  FOREIGN KEY (company_id,account_id) REFERENCES accounts(company_id,id),
  CHECK (end_date >= start_date),
  CHECK (end_date <= (start_date + interval '6 months')::date),
  CHECK ((recurrence='weekly') = (weekday IS NOT NULL)),
  CHECK ((recurrence='monthly') = (month_day IS NOT NULL)),
  CHECK ((recurrence='once') = (once_date IS NOT NULL)),
  CHECK (once_date IS NULL OR once_date BETWEEN start_date AND end_date)
);
CREATE INDEX expected_cards_company_account ON expected_cards(company_id,account_id,id);
CREATE INDEX expected_cards_company_section ON expected_cards(company_id,section,id);

CREATE TABLE expected_movements (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id),
  card_id integer NOT NULL,
  original_date date NOT NULL,
  movement_date date NOT NULL,
  amount numeric(28,6) NOT NULL,
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed')),
  completed_amount numeric(28,6),
  completed_at timestamptz,
  completed_by integer REFERENCES users(id),
  completed_by_name text NOT NULL DEFAULT '',
  completion_source text CHECK (completion_source IN ('manual','automatic')),
  posted_by integer REFERENCES users(id),
  posted_by_name text NOT NULL,
  posted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (company_id,card_id,original_date),
  FOREIGN KEY (company_id,card_id) REFERENCES expected_cards(company_id,id),
  CHECK ((status='pending' AND completed_amount IS NULL AND completed_at IS NULL AND completed_by IS NULL AND completed_by_name='' AND completion_source IS NULL)
    OR (status='completed' AND completed_amount IS NOT NULL AND completed_at IS NOT NULL AND completion_source IS NOT NULL
      AND ((completion_source='manual' AND completed_by IS NOT NULL) OR (completion_source='automatic' AND completed_by IS NULL))))
);
CREATE INDEX expected_movements_company_date ON expected_movements(company_id,movement_date,id);
CREATE INDEX expected_movements_card ON expected_movements(company_id,card_id,id);
CREATE INDEX expected_movements_overdue ON expected_movements(movement_date,company_id,id) WHERE status='pending';

INSERT INTO page_registry(key) VALUES ('company.expected-cards'),('company.expected-movements')
ON CONFLICT (key) DO NOTHING;
