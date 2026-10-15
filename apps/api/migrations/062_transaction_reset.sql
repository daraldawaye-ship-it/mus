-- Owner-authorized company transaction cleanup is invoked only through the scoped API.
-- Ordinary posted-document immutability remains unchanged. The server sets both
-- transaction-local values only after locking/authorizing the company and checking
-- the exact preview fingerprint. No table trigger or foreign key is disabled.
CREATE FUNCTION transaction_reset_company_allowed(p_company integer)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT p_company IS NOT NULL
   AND current_setting('tijara.transaction_reset_company',true)=p_company::text
   AND current_setting('tijara.transaction_reset_txid',true)=txid_current()::text
$$;

CREATE OR REPLACE FUNCTION protect_financial_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND transaction_reset_company_allowed(OLD.company_id) THEN RETURN OLD; END IF;
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Financial documents cannot be deleted' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW.company_id,NEW.id,NEW.number,NEW.created_by,NEW.created_at,NEW.idempotency_key,NEW.creation_payload)
    IS DISTINCT FROM ROW(OLD.company_id,OLD.id,OLD.number,OLD.created_by,OLD.created_at,OLD.idempotency_key,OLD.creation_payload) THEN
    RAISE EXCEPTION 'Financial identity is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.status<>'draft' AND NEW IS DISTINCT FROM OLD THEN
    IF NOT (OLD.status='posted' AND NEW.status='reversed' AND NEW.reversal_document_id IS NOT NULL
      AND NEW.revision=OLD.revision+1 AND
      (to_jsonb(NEW)-ARRAY['status','revision','reversal_document_id'])=(to_jsonb(OLD)-ARRAY['status','revision','reversal_document_id'])) THEN
      RAISE EXCEPTION 'Posted financial document is immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION protect_financial_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status text;
BEGIN
 IF TG_OP='DELETE' AND transaction_reset_company_allowed(OLD.company_id) THEN RETURN OLD; END IF;
  IF TG_OP<>'INSERT' THEN
    SELECT status INTO parent_status FROM financial_documents WHERE company_id=OLD.company_id AND id=OLD.document_id FOR SHARE;
    IF parent_status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'Posted financial lines are immutable' USING ERRCODE='23514'; END IF;
  END IF;
  IF TG_OP<>'DELETE' THEN
    SELECT status INTO parent_status FROM financial_documents WHERE company_id=NEW.company_id AND id=NEW.document_id FOR SHARE;
    IF parent_status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'Posted financial lines are immutable' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END $$;

CREATE OR REPLACE FUNCTION check_financial_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE doc financial_documents%ROWTYPE; original financial_documents%ROWTYPE; line_count integer; invalid_count integer;
  debit_sum numeric; credit_sum numeric; base_debit_sum numeric; base_credit_sum numeric;
BEGIN
 IF TG_OP='DELETE' AND transaction_reset_company_allowed(OLD.company_id) THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME='financial_documents' THEN
    SELECT * INTO doc FROM financial_documents WHERE company_id=NEW.company_id AND id=NEW.id;
  ELSE
    SELECT * INTO doc FROM financial_documents WHERE company_id=COALESCE(NEW.company_id,OLD.company_id) AND id=COALESCE(NEW.document_id,OLD.document_id);
  END IF;
  IF doc.status='draft' THEN RETURN NULL; END IF;
  SELECT count(*), count(*) FILTER(WHERE (debit=0 AND credit=0) OR (debit>0 AND credit>0)
    OR base_debit IS NULL OR base_credit IS NULL OR account_code IS NULL OR account_name IS NULL
    OR debit<>round(debit,doc.decimal_places) OR credit<>round(credit,doc.decimal_places)
    OR base_debit<>round(debit*doc.exchange_rate,doc.base_decimal_places) OR base_credit<>round(credit*doc.exchange_rate,doc.base_decimal_places)),
    sum(debit),sum(credit),sum(base_debit),sum(base_credit)
  INTO line_count,invalid_count,debit_sum,credit_sum,base_debit_sum,base_credit_sum
  FROM financial_document_lines WHERE company_id=doc.company_id AND document_id=doc.id;
  IF line_count<2 OR invalid_count>0 OR debit_sum<>doc.total_debit OR credit_sum<>doc.total_credit
    OR base_debit_sum<>doc.total_base_debit OR base_credit_sum<>doc.total_base_credit THEN
    RAISE EXCEPTION 'Posted double-entry document is inconsistent' USING ERRCODE='23514';
  END IF;
  IF doc.kind IN ('receipt','payment') THEN
    IF line_count<>2 OR NOT EXISTS(SELECT 1 FROM accounts WHERE company_id=doc.company_id AND id=doc.cash_account_id AND cash_or_bank AND kind='posting' AND category='asset')
       OR NOT EXISTS(SELECT 1 FROM financial_document_lines WHERE company_id=doc.company_id AND document_id=doc.id AND account_id=doc.cash_account_id
       AND ((doc.kind='receipt' AND debit>0 AND credit=0) OR (doc.kind='payment' AND credit>0 AND debit=0)))
       OR (SELECT count(DISTINCT account_id) FROM financial_document_lines WHERE company_id=doc.company_id AND document_id=doc.id)<>2 THEN
      RAISE EXCEPTION 'Voucher cash direction is inconsistent' USING ERRCODE='23514';
    END IF;
  END IF;
  IF doc.reverses_document_id IS NOT NULL THEN
    SELECT * INTO original FROM financial_documents WHERE company_id=doc.company_id AND id=doc.reverses_document_id;
    IF original.status<>'reversed' OR original.reversal_document_id<>doc.id
      OR ROW(doc.currency_id,doc.currency_code,doc.decimal_places,doc.base_currency_id,doc.base_currency_code,doc.base_decimal_places,doc.exchange_rate,doc.exchange_rate_id,doc.exchange_rate_source,doc.branch_id)
       IS DISTINCT FROM ROW(original.currency_id,original.currency_code,original.decimal_places,original.base_currency_id,original.base_currency_code,original.base_decimal_places,original.exchange_rate,original.exchange_rate_id,original.exchange_rate_source,original.branch_id)
      OR EXISTS((SELECT line_number,account_id,account_code,account_name,debit,credit,base_debit,base_credit FROM financial_document_lines WHERE company_id=doc.company_id AND document_id=doc.id)
        EXCEPT (SELECT line_number,account_id,account_code,account_name,credit,debit,base_credit,base_debit FROM financial_document_lines WHERE company_id=doc.company_id AND document_id=original.id))
      OR (SELECT count(*) FROM financial_document_lines WHERE company_id=doc.company_id AND document_id=original.id)<>line_count THEN
      RAISE EXCEPTION 'Reversal must preserve exact original snapshots' USING ERRCODE='23514';
    END IF;
  END IF;
  IF doc.status='reversed' AND NOT EXISTS(SELECT 1 FROM financial_documents WHERE company_id=doc.company_id AND id=doc.reversal_document_id AND status='posted' AND reverses_document_id=doc.id) THEN
    RAISE EXCEPTION 'Reversal link is inconsistent' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION protect_operational_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND transaction_reset_company_allowed(OLD.company_id) THEN RETURN OLD; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Operational history cannot be deleted' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='invoices' THEN
   IF TG_OP<>'INSERT' THEN
     IF OLD.posted THEN RAISE EXCEPTION 'Posted invoices are immutable' USING ERRCODE='23514'; END IF;
     IF NEW.financial_document_id IS NOT NULL THEN NEW.posted=true; END IF;
     IF NEW.posted THEN
       -- A negative net or first row never turns positive rows into returns.
       SELECT COALESCE(bool_and(quantity<0),false) INTO NEW.is_return
         FROM invoice_lines WHERE company_id=NEW.company_id AND invoice_id=NEW.id;
     END IF;
   END IF;
 ELSIF TG_TABLE_NAME='invoice_lines' THEN
   IF TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM invoices WHERE company_id=OLD.company_id AND id=OLD.invoice_id AND posted) THEN
     RAISE EXCEPTION 'Posted invoice lines are immutable' USING ERRCODE='23514';
   END IF;
   IF EXISTS(SELECT 1 FROM invoices WHERE company_id=NEW.company_id AND id=NEW.invoice_id AND posted) THEN
     RAISE EXCEPTION 'Posted invoice lines are immutable' USING ERRCODE='23514';
   END IF;
 ELSIF TG_TABLE_NAME='stock_movements' THEN
   IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Stock movements are immutable' USING ERRCODE='23514'; END IF;
   IF NEW.invoice_id IS NOT NULL THEN
     IF EXISTS(SELECT 1 FROM invoices WHERE company_id=NEW.company_id AND id=NEW.invoice_id AND posted)
       OR NOT EXISTS(SELECT 1 FROM invoice_lines WHERE company_id=NEW.company_id AND id=NEW.invoice_line_id AND invoice_id=NEW.invoice_id) THEN
       RAISE EXCEPTION 'Invoice stock movements require their unposted source line' USING ERRCODE='23514';
     END IF;
   ELSIF EXISTS(SELECT 1 FROM audit_events WHERE company_id=NEW.company_id AND target_type='stockOperation' AND target_id=NEW.operation_id) THEN
     RAISE EXCEPTION 'Posted stock operations cannot receive new movements' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION protect_stock_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND transaction_reset_company_allowed(OLD.company_id) THEN RETURN OLD; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Stock operations cannot be deleted' USING ERRCODE='23514'; END IF;
 IF NOT (OLD.financial_document_id IS NULL AND NEW.financial_document_id IS NOT NULL AND OLD.kind='adjustment'
 AND (to_jsonb(NEW)-'financial_document_id')=(to_jsonb(OLD)-'financial_document_id')
 AND NOT EXISTS(SELECT 1 FROM audit_events WHERE company_id=OLD.company_id AND target_type='stockOperation' AND target_id=OLD.id)) THEN
 RAISE EXCEPTION 'Posted stock operations are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION validate_option_value() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE definition option_definitions%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' AND transaction_reset_company_allowed(OLD.company_id)
   AND (OLD.invoice_id IS NOT NULL OR OLD.financial_document_id IS NOT NULL)
 THEN RETURN OLD; END IF;
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Clear optional values explicitly instead of deleting history' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.id,NEW.company_id,NEW.definition_id,NEW.record_kind,NEW.item_id,NEW.account_id,NEW.employee_id,
      NEW.invoice_id,NEW.financial_document_id,NEW.memo_id,NEW.created_by,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.company_id,OLD.definition_id,OLD.record_kind,OLD.item_id,OLD.account_id,OLD.employee_id,
      OLD.invoice_id,OLD.financial_document_id,OLD.memo_id,OLD.created_by,OLD.created_at)
      OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at THEN
      RAISE EXCEPTION 'Option value identity is immutable and revision must advance' USING ERRCODE='23514';
    END IF;
  END IF;
  SELECT * INTO definition FROM option_definitions WHERE company_id=NEW.company_id AND id=NEW.definition_id FOR SHARE;
  IF NOT FOUND OR NOT definition.active OR definition.native_binding IS NOT NULL
    OR NOT option_value_valid(definition.value_type,NEW.value,definition.choices)
    OR (definition.required AND (NEW.value='null'::jsonb OR NEW.value='""'::jsonb)) THEN
    RAISE EXCEPTION 'Invalid option value or protected native field' USING ERRCODE='23514';
  END IF;
  IF NEW.invoice_id IS NOT NULL OR (NEW.financial_document_id IS NOT NULL AND EXISTS(
    SELECT 1 FROM financial_documents WHERE company_id=NEW.company_id AND id=NEW.financial_document_id AND status<>'draft'
  )) OR (NEW.memo_id IS NOT NULL AND EXISTS(
    SELECT 1 FROM memos WHERE company_id=NEW.company_id AND id=NEW.memo_id AND status='completed'
  )) THEN RAISE EXCEPTION 'Finalized document or memo options are immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;


-- The ledger exception is narrower than the company transaction exception:
-- only the precomputed linked reward/reversal IDs may be removed.
CREATE FUNCTION transaction_reset_reward_allowed(p_company integer,p_entry integer)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT transaction_reset_company_allowed(p_company)
   AND p_entry::text=ANY(COALESCE(string_to_array(
     current_setting('tijara.transaction_reset_reward_ids',true),','),'{}'::text[]))
$$;

CREATE OR REPLACE FUNCTION protect_wallet_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original employee_wallet_entries; available numeric; reserved numeric; conversion wallet_conversions;
BEGIN
 IF TG_OP='DELETE' AND transaction_reset_reward_allowed(OLD.company_id,OLD.id)
   AND ((OLD.kind='automatic' AND (OLD.invoice_id IS NOT NULL OR OLD.financial_document_id IS NOT NULL))
     OR (OLD.kind='reversal' AND transaction_reset_reward_allowed(OLD.company_id,OLD.reference_id)))
 THEN RETURN OLD; END IF;
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

-- A single DELETE may contain both a reward and its exact reversal. Apply the
-- transition table's net once, rather than a row-order-dependent intermediate
-- debit. Nested balance updates retain the existing protected-wallet trigger.
CREATE FUNCTION apply_transaction_reset_wallet_deletions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM deleted_wallet_rewards d
   WHERE NOT COALESCE(transaction_reset_reward_allowed(d.company_id,d.id),false)) THEN
   RAISE EXCEPTION 'Wallet deletions require the scoped transaction reset' USING ERRCODE='23514';
 END IF;
 IF EXISTS(
   SELECT 1 FROM (
     SELECT company_id,employee_id,sum(points) AS points FROM deleted_wallet_rewards
     GROUP BY company_id,employee_id
   ) removed JOIN employee_wallets w USING(company_id,employee_id)
   WHERE w.points-removed.points<0 OR w.points-removed.points<COALESCE((
     SELECT sum(c.points) FROM wallet_conversions c WHERE c.company_id=w.company_id
       AND c.employee_id=w.employee_id AND c.status='pending'
   ),0)
 ) THEN
   RAISE EXCEPTION 'Reset cannot consume reserved or unavailable wallet points' USING ERRCODE='23514';
 END IF;
 UPDATE employee_wallets w SET points=w.points-removed.points,updated_at=clock_timestamp()
 FROM (
   SELECT company_id,employee_id,sum(points) AS points FROM deleted_wallet_rewards
   GROUP BY company_id,employee_id
 ) removed WHERE w.company_id=removed.company_id AND w.employee_id=removed.employee_id;
 RETURN NULL;
END $$;
CREATE TRIGGER wallet_balance_from_reset_deletion AFTER DELETE ON employee_wallet_entries
 REFERENCING OLD TABLE AS deleted_wallet_rewards FOR EACH STATEMENT
 EXECUTE FUNCTION apply_transaction_reset_wallet_deletions();
