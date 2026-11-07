-- Immutable and idempotent transfers from a sales employee till to administrative custody.
CREATE TABLE administrative_custody_fundings (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 company_id integer NOT NULL,
 employee_id integer NOT NULL,
 employee_name text NOT NULL,
 cash_account_id integer NOT NULL,
 custody_account_id integer NOT NULL,
 amount numeric(28,6) NOT NULL CHECK(amount>0),
 notes text NOT NULL DEFAULT '' CHECK(length(notes)<=1000),
 financial_document_id integer NOT NULL,
 idempotency_key uuid NOT NULL,
 request_payload jsonb NOT NULL,
 created_by integer NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,id), UNIQUE(company_id,idempotency_key),
 UNIQUE(company_id,financial_document_id),
 CHECK(cash_account_id<>custody_account_id),
 FOREIGN KEY(company_id,employee_id) REFERENCES employees(company_id,id),
 FOREIGN KEY(company_id,cash_account_id) REFERENCES accounts(company_id,id),
 FOREIGN KEY(company_id,custody_account_id) REFERENCES accounts(company_id,id),
 FOREIGN KEY(company_id,financial_document_id) REFERENCES financial_documents(company_id,id)
);
CREATE INDEX administrative_custody_fundings_timeline
 ON administrative_custody_fundings(company_id,created_at DESC,id DESC);
CREATE FUNCTION protect_administrative_custody_funding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Administrative custody funding is immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER administrative_custody_fundings_immutable
 BEFORE UPDATE OR DELETE ON administrative_custody_fundings
 FOR EACH ROW EXECUTE FUNCTION protect_administrative_custody_funding();

-- Initial role is sales supervisor; future changes are made in Central Access.
INSERT INTO central_access_policies(company_id,resource_key,view_positions,edit_positions,updated_by)
SELECT c.id,'button:sales.custody-funding',
 ARRAY['sales-supervisor']::text[],ARRAY['sales-supervisor']::text[],u.id
FROM companies c CROSS JOIN (SELECT id FROM users WHERE owner=true LIMIT 1) u
ON CONFLICT(company_id,resource_key) DO NOTHING;
