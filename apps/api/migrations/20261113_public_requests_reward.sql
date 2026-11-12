-- Company-wide public requests and exactly-once employee reward.
-- The same item, Yemen-local date and actor can be submitted only once.
CREATE TABLE company_public_requests (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 company_id integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 item_id integer NOT NULL,
 item_name text NOT NULL,
 request_date date NOT NULL DEFAULT (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date,
 created_by integer NOT NULL REFERENCES users(id),
 created_by_name text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,id),
 CONSTRAINT company_public_request_unique UNIQUE(company_id,item_id,request_date,created_by),
 CONSTRAINT company_public_request_item_fk FOREIGN KEY(company_id,item_id)
   REFERENCES items(company_id,id)
);
CREATE INDEX company_public_requests_list_idx
 ON company_public_requests(company_id,created_at DESC,id DESC);

INSERT INTO page_registry(key) VALUES ('company.public-requests')
 ON CONFLICT(key) DO NOTHING;

-- Editable under the existing company reward-task page. A new successful
-- request is worth 20 points by default, unless the manager changes/disables it.
INSERT INTO reward_task_definitions
 (code,name,description,implemented,default_points,default_repeat_rule)
VALUES ('PUBLIC_REQUEST','طلب الجمهور',
 'مكافأة طلب جمهور جديد لصنف؛ مرة واحدة للصنف واليوم والموظف بحسب توقيت اليمن. لا مكافأة للتكرار.',true,20,'per-document')
ON CONFLICT(code) DO NOTHING;

INSERT INTO reward_task_settings
 (company_id,code,points,repeat_rule,enabled,page_key,updated_by)
SELECT c.id,'PUBLIC_REQUEST',20,'per-document',true,NULL,c.created_by
 FROM companies c
ON CONFLICT(company_id,code) DO NOTHING;

CREATE FUNCTION initialize_public_request_reward() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO reward_task_settings
  (company_id,code,points,repeat_rule,enabled,page_key,updated_by)
 VALUES(NEW.id,'PUBLIC_REQUEST',20,'per-document',true,NULL,NEW.created_by)
 ON CONFLICT(company_id,code) DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER company_public_request_reward AFTER INSERT ON companies
 FOR EACH ROW EXECUTE FUNCTION initialize_public_request_reward();

ALTER TABLE reward_task_settings
 ADD CONSTRAINT public_request_reward_repeat_guard
 CHECK (code <> 'PUBLIC_REQUEST' OR NOT enabled OR repeat_rule = 'per-document');

-- Ledger is immutable: credit only the new source row, never forge an invoice.
ALTER TABLE employee_wallet_entries
 ADD COLUMN public_request_id integer,
 ADD CONSTRAINT wallet_public_request_fk FOREIGN KEY(company_id,public_request_id)
    REFERENCES company_public_requests(company_id,id);

DO $$
DECLARE previous_guard text;
BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO previous_guard
 FROM pg_constraint
 WHERE conrelid='employee_wallet_entries'::regclass
   AND conname='wallet_entry_source_check';
 IF previous_guard IS NULL THEN RAISE EXCEPTION 'Missing wallet source guard'; END IF;
 ALTER TABLE employee_wallet_entries DROP CONSTRAINT wallet_entry_source_check;
 EXECUTE format($guard$
 ALTER TABLE employee_wallet_entries ADD CONSTRAINT wallet_entry_source_check CHECK (
   (%s) OR (
     kind='automatic' AND points>0 AND money=0
     AND public_request_id IS NOT NULL AND task_code='PUBLIC_REQUEST'
     AND task_revision>0 AND logical_line_count=1
     AND reference_id IS NULL AND invoice_id IS NULL
     AND financial_document_id IS NULL AND conversion_id IS NULL
     AND attendance_entry_id IS NULL AND clearance_earning_id IS NULL
     AND stock_operation_id IS NULL AND page_key IS NULL
   )
 )
 $guard$,previous_guard);
END $$;

ALTER TABLE employee_wallet_entries ADD CONSTRAINT wallet_public_request_source_guard CHECK (
 public_request_id IS NULL OR (
  kind='automatic' AND task_code='PUBLIC_REQUEST'
  AND invoice_id IS NULL AND financial_document_id IS NULL
  AND conversion_id IS NULL AND attendance_entry_id IS NULL
  AND clearance_earning_id IS NULL AND stock_operation_id IS NULL
  AND page_key IS NULL
 )
);
CREATE UNIQUE INDEX wallet_public_request_once
 ON employee_wallet_entries(company_id,employee_id,task_code,public_request_id)
 WHERE public_request_id IS NOT NULL;
