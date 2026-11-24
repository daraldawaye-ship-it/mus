CREATE TABLE inquiry_hidden_queue (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id),
  created_by integer NOT NULL REFERENCES users(id),
  idempotency_key uuid NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  release_group text NOT NULL CHECK (release_group IN ('ordinary','pharmacist-item-match')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_day date,
  released_slot integer CHECK(released_slot BETWEEN 1 AND 5),
  released_at timestamptz,
  released_inquiry_id integer UNIQUE REFERENCES inquiry_requests(id),
  UNIQUE(company_id,created_by,idempotency_key),
  UNIQUE(company_id,released_day,released_slot),
  CHECK ((released_day IS NULL AND released_slot IS NULL AND released_at IS NULL AND released_inquiry_id IS NULL) OR
         (released_day IS NOT NULL AND released_slot IS NOT NULL AND released_at IS NOT NULL AND released_inquiry_id IS NOT NULL))
);
CREATE INDEX inquiry_hidden_waiting_idx ON inquiry_hidden_queue(company_id,id) WHERE released_day IS NULL;
CREATE INDEX inquiry_hidden_daily_idx ON inquiry_hidden_queue(company_id,released_day) WHERE released_day IS NOT NULL;
CREATE TABLE inquiry_hidden_runs (
  company_id integer NOT NULL REFERENCES companies(id),
  idempotency_key uuid NOT NULL,
  release_day date NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY(company_id,idempotency_key)
);
