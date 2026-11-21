-- A correction is a separate balanced financial journal, never a receivable
-- custody transfer. Retain the immutable source and an auditable one-to-one link.
CREATE TABLE administrative_custody_medical_corrections (
  company_id integer NOT NULL,
  source_transfer_id integer NOT NULL,
  financial_document_id integer NOT NULL,
  idempotency_key uuid NOT NULL,
  request_payload jsonb NOT NULL,
  created_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (company_id,source_transfer_id),
  UNIQUE (company_id,financial_document_id),
  UNIQUE (company_id,idempotency_key),
  FOREIGN KEY (company_id,source_transfer_id) REFERENCES administrative_custody_transfers(company_id,id),
  FOREIGN KEY (company_id,financial_document_id) REFERENCES financial_documents(company_id,id)
);
CREATE TRIGGER administrative_custody_medical_corrections_immutable
  BEFORE UPDATE OR DELETE ON administrative_custody_medical_corrections
  FOR EACH ROW EXECUTE FUNCTION protect_administrative_custody_transfer();
