-- Physical counts only; never change money journals or re-count voucher copies.
CREATE TABLE slip_receipts (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id),
  expected_count bigint NOT NULL CHECK(expected_count>0),
  received_count bigint NOT NULL CHECK(received_count BETWEEN 0 AND 2147483647),
  difference_count bigint GENERATED ALWAYS AS (received_count-expected_count) STORED,
  created_by integer NOT NULL REFERENCES users(id),
  receiver_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  idempotency_key uuid NOT NULL,
  request_payload jsonb NOT NULL,
  UNIQUE(company_id,id), UNIQUE(company_id,idempotency_key)
);
CREATE TABLE slip_receipt_sources (
  company_id integer NOT NULL,
  source_id integer NOT NULL,
  receipt_id integer NOT NULL,
  PRIMARY KEY(company_id,source_id),
  FOREIGN KEY(company_id,source_id) REFERENCES administrative_custody_transfers(company_id,id),
  FOREIGN KEY(company_id,receipt_id) REFERENCES slip_receipts(company_id,id)
);
CREATE INDEX slip_receipts_timeline ON slip_receipts(company_id,created_at,id);
CREATE INDEX slip_receipt_sources_receipt ON slip_receipt_sources(company_id,receipt_id);
CREATE INDEX custody_pending_slips ON administrative_custody_transfers(company_id,id) WHERE expense_kind='slips';
CREATE TRIGGER slip_receipts_immutable BEFORE UPDATE OR DELETE ON slip_receipts
  FOR EACH ROW EXECUTE FUNCTION protect_administrative_custody_transfer();
CREATE TRIGGER slip_receipt_sources_immutable BEFORE UPDATE OR DELETE ON slip_receipt_sources
  FOR EACH ROW EXECUTE FUNCTION protect_administrative_custody_transfer();
INSERT INTO page_registry(key) VALUES('company.slip-movements') ON CONFLICT(key) DO NOTHING;
