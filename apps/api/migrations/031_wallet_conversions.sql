INSERT INTO page_registry(key) VALUES('company.wallet-conversions');
INSERT INTO permission_definitions(key,page_key,action,name,rule_role,required_permissions) VALUES
 ('company.wallet-conversions:view','company.wallet-conversions','view','تحويلات النقاط — عرض','company-member','{}'),
 ('company.wallet-conversions:create','company.wallet-conversions','create','تحويلات النقاط — طلب تحويل','company-member','{}'),
 ('company.wallet-conversions:post','company.wallet-conversions','post','تحويلات النقاط — اعتماد أو رفض','company-general','{}'),
 ('company.wallet-conversions:edit','company.wallet-conversions','edit','تحويلات النقاط — إلغاء الطلب الشخصي','company-member','{}');

-- Pending rows reserve points without changing the immutable ledger balance.
-- Every financial snapshot is retained independently of later configuration edits.
CREATE TABLE wallet_conversions (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 company_id integer NOT NULL,
 employee_id integer NOT NULL,
 employee_name text NOT NULL,
 points numeric(28,0) NOT NULL CHECK(points>0),
 point_value numeric(28,12) NOT NULL CHECK(point_value>0),
 amount numeric(28,6) NOT NULL CHECK(amount>0),
 currency_id integer NOT NULL,
 currency_code text NOT NULL,
 decimal_places integer NOT NULL CHECK(decimal_places BETWEEN 0 AND 6),
 expense_account_id integer NOT NULL,
 expense_account_code text NOT NULL,
 expense_account_name text NOT NULL,
 account_id integer NOT NULL,
 account_code text NOT NULL,
 account_name text NOT NULL,
 approval_mode varchar(10) NOT NULL CHECK(approval_mode IN('direct','approval')),
 policy_revision integer NOT NULL CHECK(policy_revision>0),
 account_revision integer NOT NULL CHECK(account_revision>0),
 status varchar(10) NOT NULL DEFAULT 'pending' CHECK(status IN('pending','posted','rejected','cancelled')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 financial_document_id integer,
 entry_id integer,
 idempotency_key uuid NOT NULL,
 request_payload jsonb NOT NULL,
 created_by integer NOT NULL REFERENCES users(id),
 created_by_name text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 decided_at timestamptz,
 decided_by integer REFERENCES users(id),
 decided_by_name text,
 decision_reason varchar(500),
 decision_key uuid,
 decision_payload jsonb,
 UNIQUE(company_id,id),
 UNIQUE(company_id,idempotency_key),
 UNIQUE(company_id,decision_key),
 UNIQUE(company_id,financial_document_id),
 UNIQUE(company_id,entry_id),
 FOREIGN KEY(company_id,employee_id) REFERENCES employee_wallets(company_id,employee_id),
 FOREIGN KEY(company_id,currency_id) REFERENCES company_currencies(company_id,id),
 FOREIGN KEY(company_id,expense_account_id) REFERENCES accounts(company_id,id),
 FOREIGN KEY(company_id,account_id) REFERENCES accounts(company_id,id),
 FOREIGN KEY(company_id,financial_document_id) REFERENCES financial_documents(company_id,id),
 FOREIGN KEY(company_id,entry_id) REFERENCES employee_wallet_entries(company_id,id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(expense_account_id<>account_id),
 CHECK(amount=round(points*point_value,decimal_places)),
 CHECK((status='posted')=(financial_document_id IS NOT NULL AND entry_id IS NOT NULL)),
 CHECK(status='posted' OR (financial_document_id IS NULL AND entry_id IS NULL)),
 CHECK((status='pending')=(decided_at IS NULL)),
 CHECK((decided_at IS NULL)=(decided_by IS NULL)),
 CHECK((decided_at IS NULL)=(decided_by_name IS NULL)),
 CHECK((decision_key IS NULL)=(decision_payload IS NULL)),
 CHECK(status<>'pending' OR (decision_key IS NULL AND decision_reason IS NULL)),
 CHECK(status NOT IN('rejected','cancelled') OR (decision_reason IS NOT NULL AND length(trim(decision_reason))>0)),
 CHECK((status='pending' OR approval_mode='direct') OR decision_key IS NOT NULL)
);
CREATE UNIQUE INDEX wallet_one_pending_conversion ON wallet_conversions(company_id,employee_id) WHERE status='pending';
CREATE INDEX wallet_conversions_history ON wallet_conversions(company_id,employee_id,created_at DESC,id DESC);

ALTER TABLE employee_wallet_entries ADD COLUMN conversion_id integer,
 ADD FOREIGN KEY(company_id,conversion_id) REFERENCES wallet_conversions(company_id,id);
ALTER TABLE employee_wallet_entries DROP CONSTRAINT wallet_entry_kind_check;
ALTER TABLE employee_wallet_entries ADD CONSTRAINT wallet_entry_kind_check CHECK(kind IN('manual','automatic','reversal','conversion'));
ALTER TABLE employee_wallet_entries DROP CONSTRAINT wallet_entry_source_check;
ALTER TABLE employee_wallet_entries ADD CONSTRAINT wallet_entry_source_check CHECK (
 (kind='manual' AND points>0 AND reference_id IS NULL AND invoice_id IS NULL AND financial_document_id IS NULL
  AND page_key IS NULL AND task_code IS NULL AND task_revision IS NULL AND logical_line_count IS NULL AND conversion_id IS NULL)
 OR (kind='reversal' AND points<0 AND reference_id IS NOT NULL AND invoice_id IS NULL AND financial_document_id IS NULL
  AND page_key IS NULL AND task_code IS NULL AND task_revision IS NULL AND logical_line_count IS NULL AND conversion_id IS NULL)
 OR (kind='automatic' AND points>0 AND reference_id IS NULL AND invoice_id IS NOT NULL AND financial_document_id IS NULL
  AND page_key IS NULL AND task_code IN('SALE_SAVED','PURCHASE_SAVED','SALE_LINES','PURCHASE_LINES')
  AND task_revision>0 AND logical_line_count BETWEEN 1 AND 100 AND conversion_id IS NULL)
 OR (kind='automatic' AND points>0 AND reference_id IS NULL AND invoice_id IS NULL AND financial_document_id IS NOT NULL
  AND page_key IS NULL AND task_code IN('RECEIPT_PRINT','PAYMENT_PRINT') AND task_revision>0 AND logical_line_count=1 AND conversion_id IS NULL)
 OR (kind='automatic' AND points>0 AND reference_id IS NULL AND invoice_id IS NULL AND financial_document_id IS NULL
  AND page_key IS NOT NULL AND task_code='PAGE_VISIT' AND task_revision>0 AND logical_line_count=1 AND conversion_id IS NULL)
 OR (kind='automatic' AND points>0 AND reference_id IS NULL AND invoice_id IS NULL AND financial_document_id IS NULL
  AND page_key IS NULL AND task_code='DAILY_LOGIN' AND task_revision>0 AND logical_line_count=1 AND conversion_id IS NULL)
 OR (kind='conversion' AND points<0 AND reference_id IS NULL AND invoice_id IS NULL AND financial_document_id IS NOT NULL
  AND page_key IS NULL AND task_code IS NULL AND task_revision IS NULL AND logical_line_count IS NULL AND conversion_id IS NOT NULL)
);
CREATE UNIQUE INDEX wallet_one_conversion_entry ON employee_wallet_entries(company_id,conversion_id) WHERE conversion_id IS NOT NULL;

CREATE OR REPLACE FUNCTION protect_wallet_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original employee_wallet_entries; available numeric; reserved numeric; conversion wallet_conversions;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Wallet ledger is immutable' USING ERRCODE='23514'; END IF;
 SELECT points INTO available FROM employee_wallets WHERE company_id=NEW.company_id AND employee_id=NEW.employee_id FOR UPDATE;
 IF NEW.kind='reversal' THEN
  SELECT * INTO original FROM employee_wallet_entries WHERE company_id=NEW.company_id AND id=NEW.reference_id;
  IF NOT FOUND OR original.kind NOT IN('manual','automatic') OR NEW.employee_id<>original.employee_id
     OR NEW.points<>-original.points OR NEW.money<>-original.money THEN
   RAISE EXCEPTION 'Reversal must exactly invert the original reward in the same wallet' USING ERRCODE='23514';
  END IF;
 ELSIF NEW.kind='conversion' THEN
  SELECT * INTO conversion FROM wallet_conversions WHERE company_id=NEW.company_id AND id=NEW.conversion_id;
  IF NOT FOUND OR conversion.status<>'pending' OR NEW.employee_id<>conversion.employee_id OR NEW.points<>-conversion.points
   OR NEW.financial_document_id<>conversion.financial_document_id AND conversion.financial_document_id IS NOT NULL THEN
   RAISE EXCEPTION 'Conversion debit must exactly match its pending request' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.points<0 THEN
  SELECT COALESCE(sum(points),0) INTO reserved FROM wallet_conversions WHERE company_id=NEW.company_id
   AND employee_id=NEW.employee_id AND status='pending' AND id IS DISTINCT FROM NEW.conversion_id;
  IF available+NEW.points<reserved THEN
   RAISE EXCEPTION 'Wallet debit cannot consume reserved or unavailable points' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION protect_wallet_conversion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total numeric; reserved numeric;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Wallet conversion history cannot be deleted' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'pending' OR NEW.revision<>1 THEN RAISE EXCEPTION 'A conversion starts pending at revision one' USING ERRCODE='23514'; END IF;
  SELECT points INTO total FROM employee_wallets WHERE company_id=NEW.company_id AND employee_id=NEW.employee_id FOR UPDATE;
  SELECT COALESCE(sum(points),0) INTO reserved FROM wallet_conversions WHERE company_id=NEW.company_id AND employee_id=NEW.employee_id AND status='pending';
  IF NEW.points<>total-reserved THEN RAISE EXCEPTION 'Conversion must reserve the complete available wallet' USING ERRCODE='23514'; END IF;
 ELSE
  IF OLD.status<>'pending' OR NEW.status='pending' OR NEW.revision<>OLD.revision+1
   OR (to_jsonb(NEW)-ARRAY['status','revision','financial_document_id','entry_id','decided_at','decided_by','decided_by_name','decision_reason','decision_key','decision_payload'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','revision','financial_document_id','entry_id','decided_at','decided_by','decided_by_name','decision_reason','decision_key','decision_payload']) THEN
   RAISE EXCEPTION 'Conversion snapshot is immutable and only a pending request can be decided once' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER wallet_conversion_history BEFORE INSERT OR UPDATE OR DELETE ON wallet_conversions FOR EACH ROW EXECUTE FUNCTION protect_wallet_conversion();

CREATE FUNCTION check_wallet_conversion_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE conversion wallet_conversions; entry employee_wallet_entries; doc financial_documents; total numeric; reserved numeric;
BEGIN
 IF TG_TABLE_NAME='wallet_conversions' THEN
  SELECT * INTO conversion FROM wallet_conversions WHERE company_id=NEW.company_id AND id=NEW.id;
 ELSE
  IF NEW.conversion_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO conversion FROM wallet_conversions WHERE company_id=NEW.company_id AND id=NEW.conversion_id;
 END IF;
 SELECT points INTO total FROM employee_wallets WHERE company_id=conversion.company_id AND employee_id=conversion.employee_id;
 SELECT COALESCE(sum(points),0) INTO reserved FROM wallet_conversions WHERE company_id=conversion.company_id AND employee_id=conversion.employee_id AND status='pending';
 IF reserved>total THEN RAISE EXCEPTION 'Reserved wallet points exceed the ledger balance' USING ERRCODE='23514'; END IF;
 IF conversion.status='pending' THEN
  IF EXISTS(SELECT 1 FROM employee_wallet_entries WHERE company_id=conversion.company_id AND conversion_id=conversion.id) THEN
   RAISE EXCEPTION 'Pending approval reserves points without creating a debit' USING ERRCODE='23514';
  END IF;
  IF conversion.approval_mode='direct' THEN RAISE EXCEPTION 'Direct conversion must post atomically' USING ERRCODE='23514'; END IF;
 ELSIF conversion.status='posted' THEN
  SELECT * INTO entry FROM employee_wallet_entries WHERE company_id=conversion.company_id AND id=conversion.entry_id;
  SELECT * INTO doc FROM financial_documents WHERE company_id=conversion.company_id AND id=conversion.financial_document_id;
  IF entry.id IS NULL OR doc.id IS NULL OR entry.kind<>'conversion' OR entry.conversion_id<>conversion.id
   OR entry.employee_id<>conversion.employee_id OR entry.points<>-conversion.points OR entry.financial_document_id<>doc.id
   OR doc.kind<>'journal' OR doc.status<>'posted' OR doc.currency_id<>conversion.currency_id OR doc.base_currency_id<>conversion.currency_id
   OR doc.decimal_places<>conversion.decimal_places OR doc.base_decimal_places<>conversion.decimal_places OR doc.exchange_rate<>1
   OR doc.currency_code<>conversion.currency_code OR doc.reverses_document_id IS NOT NULL OR doc.reversal_document_id IS NOT NULL
   OR doc.total_debit<>conversion.amount OR doc.total_credit<>conversion.amount OR doc.total_base_debit<>conversion.amount OR doc.total_base_credit<>conversion.amount
   OR (SELECT count(*) FROM financial_document_lines WHERE company_id=conversion.company_id AND document_id=doc.id)<>2
   OR NOT EXISTS(SELECT 1 FROM financial_document_lines WHERE company_id=conversion.company_id AND document_id=doc.id
     AND account_id=conversion.expense_account_id AND debit=conversion.amount AND credit=0 AND base_debit=conversion.amount AND base_credit=0)
   OR NOT EXISTS(SELECT 1 FROM financial_document_lines WHERE company_id=conversion.company_id AND document_id=doc.id
     AND account_id=conversion.account_id AND credit=conversion.amount AND debit=0 AND base_credit=conversion.amount AND base_debit=0) THEN
   RAISE EXCEPTION 'Posted conversion must have one exact debit and balanced linked financial journal' USING ERRCODE='23514';
  END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM employee_wallet_entries WHERE company_id=conversion.company_id AND conversion_id=conversion.id) THEN
   RAISE EXCEPTION 'Rejected or cancelled conversion cannot debit points' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER wallet_conversion_integrity AFTER INSERT OR UPDATE ON wallet_conversions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_wallet_conversion_integrity();
CREATE CONSTRAINT TRIGGER wallet_conversion_entry_integrity AFTER INSERT ON employee_wallet_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_wallet_conversion_integrity();

CREATE FUNCTION protect_wallet_journal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.reverses_document_id IS NOT NULL AND EXISTS(SELECT 1 FROM wallet_conversions WHERE company_id=NEW.company_id AND financial_document_id=NEW.reverses_document_id) THEN
  RAISE EXCEPTION 'Wallet-linked journal cannot be reversed independently' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND NEW.status='reversed' AND EXISTS(SELECT 1 FROM wallet_conversions WHERE company_id=OLD.company_id AND financial_document_id=OLD.id) THEN
  RAISE EXCEPTION 'Wallet-linked journal cannot be reversed independently' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER wallet_journal_guard BEFORE INSERT OR UPDATE ON financial_documents FOR EACH ROW EXECUTE FUNCTION protect_wallet_journal();
