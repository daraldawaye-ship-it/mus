-- Receipt only: counts and exact request, never a copy of deleted transactions.
-- Retained after cleanup so retrying an accepted UUID cannot delete later work.
CREATE TABLE company_transaction_resets (
  company_id integer NOT NULL REFERENCES companies(id),
  idempotency_key uuid NOT NULL,
  created_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  creation_payload jsonb NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY (company_id,idempotency_key)
);
CREATE FUNCTION immutable_company_transaction_reset() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Transaction reset receipts are immutable';
END;
$$;
CREATE TRIGGER company_transaction_reset_immutable
  BEFORE UPDATE OR DELETE ON company_transaction_resets
  FOR EACH ROW EXECUTE FUNCTION immutable_company_transaction_reset();
