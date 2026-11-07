-- Immutable, idempotent transfers between the configured administrative
-- custody asset and the independently configured administrative custody pouch asset.
-- Amount is signed; either asset account may have a negative balance.
CREATE TABLE administrative_custody_transfers (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer NOT NULL,
  custody_account_id integer NOT NULL,
  pouch_account_id integer NOT NULL,
  amount numeric(28,6) NOT NULL CHECK (amount<>0),
  notes text NOT NULL DEFAULT '' CHECK (length(notes)<=1000),
  financial_document_id integer NOT NULL,
  idempotency_key uuid NOT NULL,
  request_payload jsonb NOT NULL,
  created_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (company_id,id),
  UNIQUE (company_id,idempotency_key),
  UNIQUE (company_id,financial_document_id),
  CHECK (custody_account_id<>pouch_account_id),
  FOREIGN KEY (company_id,custody_account_id) REFERENCES accounts(company_id,id),
  FOREIGN KEY (company_id,pouch_account_id) REFERENCES accounts(company_id,id),
  FOREIGN KEY (company_id,financial_document_id) REFERENCES financial_documents(company_id,id)
);
CREATE INDEX administrative_custody_transfers_timeline
  ON administrative_custody_transfers(company_id,created_at DESC,id DESC);

CREATE FUNCTION protect_administrative_custody_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Administrative custody transfers are immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER administrative_custody_transfers_immutable
  BEFORE UPDATE OR DELETE ON administrative_custody_transfers
  FOR EACH ROW EXECUTE FUNCTION protect_administrative_custody_transfer();
