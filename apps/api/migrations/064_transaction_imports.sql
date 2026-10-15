-- Provenance for real operational documents, not an independent ledger.
-- The ordinary invoice API retains its 100-line limit; the owner import path
-- accepts complete historical invoices up to 200 rows without splitting them.
ALTER TABLE invoice_lines DROP CONSTRAINT invoice_lines_line_number_check;
ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_line_number_check CHECK(line_number BETWEEN 1 AND 200);
CREATE TABLE transaction_source_imports (
 company_id integer NOT NULL REFERENCES companies(id),
 source_system varchar(100) NOT NULL,
 source_kind varchar(20) NOT NULL CHECK(source_kind IN('invoice','voucher')),
 source_id varchar(100) NOT NULL,
 created_by integer NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 request_hash char(64) NOT NULL,
 source_metadata jsonb NOT NULL,
 invoice_id integer,
 financial_document_id integer,
 PRIMARY KEY(company_id,source_system,source_kind,source_id),
 FOREIGN KEY(company_id,invoice_id) REFERENCES invoices(company_id,id),
 FOREIGN KEY(company_id,financial_document_id) REFERENCES financial_documents(company_id,id),
 CHECK((source_kind='invoice' AND invoice_id IS NOT NULL AND financial_document_id IS NULL)
    OR (source_kind='voucher' AND invoice_id IS NULL AND financial_document_id IS NOT NULL))
);
CREATE UNIQUE INDEX transaction_import_invoice ON transaction_source_imports(company_id,invoice_id) WHERE invoice_id IS NOT NULL;
CREATE UNIQUE INDEX transaction_import_voucher ON transaction_source_imports(company_id,financial_document_id) WHERE financial_document_id IS NOT NULL;
CREATE FUNCTION protect_transaction_source_import() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND transaction_reset_company_allowed(OLD.company_id) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Transaction import provenance is immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER transaction_source_import_immutable BEFORE UPDATE OR DELETE ON transaction_source_imports
 FOR EACH ROW EXECUTE FUNCTION protect_transaction_source_import();

-- Retained even after a later explicit reset: a delayed retry must not resurrect
-- transactions that the owner has deliberately cleared.
CREATE TABLE transaction_import_batches (
 company_id integer NOT NULL REFERENCES companies(id),
 idempotency_key uuid NOT NULL,
 created_by integer NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 request_hash char(64) NOT NULL,
 result jsonb NOT NULL,
 PRIMARY KEY(company_id,idempotency_key)
);
CREATE TRIGGER transaction_import_batch_immutable BEFORE UPDATE OR DELETE ON transaction_import_batches
 FOR EACH ROW EXECUTE FUNCTION immutable_company_transaction_reset();
