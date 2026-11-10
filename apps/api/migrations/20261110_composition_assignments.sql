-- Durable retry receipt for the all-or-nothing composition assignment workflow.
CREATE TABLE item_composition_assignments (
  company_id integer NOT NULL REFERENCES companies(id),
  idempotency_key uuid NOT NULL,
  payload jsonb NOT NULL,
  composition_id integer NOT NULL,
  item_ids integer[] NOT NULL,
  updated_count integer NOT NULL,
  created_composition boolean NOT NULL,
  created_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(company_id,idempotency_key),
  FOREIGN KEY(company_id,composition_id) REFERENCES item_compositions(company_id,id)
);
