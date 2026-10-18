-- Pledged goods define a customer ledger account; creation is not a financial posting.
CREATE TABLE account_pledges (
 company_id integer NOT NULL REFERENCES companies(id),
 account_id integer NOT NULL,
 idempotency_key uuid NOT NULL,
 request_payload jsonb NOT NULL,
 customer_name text NOT NULL,
 phone text NOT NULL,
 collateral text NOT NULL,
 duration_days integer NOT NULL CHECK (duration_days BETWEEN 1 AND 36500),
 received_by integer NOT NULL REFERENCES users(id),
 received_by_name text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz,
 revised_by integer REFERENCES users(id),
 PRIMARY KEY (company_id,account_id),
 UNIQUE (company_id,idempotency_key),
 FOREIGN KEY (company_id,account_id) REFERENCES accounts(company_id,id)
);
CREATE INDEX account_pledges_search ON account_pledges(company_id,created_at DESC);
ALTER TABLE employee_wallet_entries ADD COLUMN pledge_account_id integer,
 ADD FOREIGN KEY (company_id,pledge_account_id) REFERENCES account_pledges(company_id,account_id);
INSERT INTO reward_task_definitions(code,name,description,implemented,default_points,default_repeat_rule)
VALUES ('PLEDGE_CREATED','إضافة رهن','مكافأة 50 نقطة عند إنشاء حساب رهن جديد لموظف الشركة، مرة واحدة فقط.',true,50,'per-document');
DO $$
DECLARE old_check text;
BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO old_check
 FROM pg_constraint WHERE conrelid='employee_wallet_entries'::regclass AND conname='wallet_entry_source_check';
 IF old_check IS NULL THEN RAISE EXCEPTION 'Wallet source constraint missing'; END IF;
 ALTER TABLE employee_wallet_entries DROP CONSTRAINT wallet_entry_source_check;
 EXECUTE format('ALTER TABLE employee_wallet_entries ADD CONSTRAINT wallet_entry_source_check CHECK ((pledge_account_id IS NULL AND (%s)) OR (kind=''automatic'' AND points=50 AND money=0 AND reference_id IS NULL AND invoice_id IS NULL AND financial_document_id IS NULL AND page_key IS NULL AND attendance_entry_id IS NULL AND conversion_id IS NULL AND pledge_account_id IS NOT NULL AND task_code=''PLEDGE_CREATED'' AND task_revision=1 AND logical_line_count=1))',old_check);
END $$;
CREATE UNIQUE INDEX wallet_once_per_pledge ON employee_wallet_entries(company_id,pledge_account_id) WHERE pledge_account_id IS NOT NULL;
