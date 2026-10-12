-- Enable signed stock quantities and signed pooled book value while preserving
-- the sum of immutable stock movements and journal-linked invoice variances.
ALTER TABLE inventory_settings DROP CONSTRAINT IF EXISTS inventory_settings_allow_negative_check;
ALTER TABLE inventory_settings ALTER COLUMN allow_negative SET DEFAULT true;
UPDATE inventory_settings SET allow_negative=true,revision=revision+1,
  updated_at=clock_timestamp() WHERE allow_negative=false;

ALTER TABLE stock_balances DROP CONSTRAINT IF EXISTS stock_balances_quantity_smallest_check;
ALTER TABLE stock_item_valuations DROP CONSTRAINT IF EXISTS stock_item_valuations_quantity_smallest_check;
ALTER TABLE stock_item_valuations DROP CONSTRAINT IF EXISTS stock_item_valuations_value_base_check;
ALTER TABLE stock_item_valuations DROP CONSTRAINT IF EXISTS stock_item_valuations_check;
ALTER TABLE stock_item_valuations ADD CONSTRAINT stock_item_valuations_sign_check CHECK (
 (quantity_smallest>0 AND value_base>=0)
 OR (quantity_smallest<0 AND value_base<=0)
 OR (quantity_smallest=0 AND value_base=0)
);
-- Permit standalone customer returns (quantity negative with no invoice-line
-- reference); purchase returns may still require their original server-side.
DO $drop_constraint$
DECLARE c record;
BEGIN
 FOR c IN SELECT conname FROM pg_constraint
    WHERE conrelid='invoice_lines'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%original_line_id IS NOT NULL%'
 LOOP
   EXECUTE format('ALTER TABLE invoice_lines DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $drop_constraint$;
ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_link_direction_check
 CHECK(original_line_id IS NULL OR quantity<0);

-- The existing deferred integrity check already verifies all stock movement
-- quantities and costs for each invoice line, including returns without links.
-- A positive purchase can now carry a linked variance journal to reconcile
-- stock previously sold or transferred below zero.
CREATE OR REPLACE FUNCTION check_invoice_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE doc invoices%ROWTYPE; sums record; main_amount numeric; variance numeric;
BEGIN
 IF TG_TABLE_NAME='invoices' THEN SELECT * INTO doc FROM invoices WHERE company_id=NEW.company_id AND id=NEW.id;
 ELSE SELECT * INTO doc FROM invoices WHERE company_id=NEW.company_id AND id=NEW.invoice_id; END IF;
 SELECT count(*) AS n,sum(gross) AS gross,sum(discount) AS discount,sum(total) AS total,sum(base_total) AS base_total,sum(cost_base) AS cost_base
 INTO sums FROM invoice_lines WHERE company_id=doc.company_id AND invoice_id=doc.id;
 IF NOT doc.posted OR sums.n<1 OR
 ROW(sums.gross,sums.discount,sums.total,sums.base_total) IS DISTINCT FROM ROW(doc.gross,doc.discount,doc.total,doc.base_total)
 OR EXISTS(SELECT 1 FROM invoice_lines l WHERE l.company_id=doc.company_id AND l.invoice_id=doc.id AND (
   (l.quantity<0)<>doc.is_return OR l.gross<>l.quantity*l.unit_price
   OR abs(l.discount)>abs(l.gross) OR (NOT doc.is_return AND l.discount<0) OR (doc.is_return AND l.discount>0)
   OR l.smallest_quantity<>l.quantity*(CASE WHEN l.unit=1 THEN l.factor2::numeric*l.factor3 WHEN l.unit=2 THEN l.factor3 ELSE 1 END)
   OR COALESCE((SELECT sum(m.quantity_smallest) FROM stock_movements m WHERE m.company_id=l.company_id AND m.invoice_line_id=l.id),0)
      <>CASE WHEN doc.kind='sale' THEN -l.smallest_quantity ELSE l.smallest_quantity END
   OR COALESCE((SELECT sum(m.cost_base) FROM stock_movements m WHERE m.company_id=l.company_id AND m.invoice_line_id=l.id),0)
      <>CASE WHEN doc.kind='sale' THEN -l.cost_base ELSE l.cost_base END
 )) THEN RAISE EXCEPTION 'Invoice totals, direction and stock sources must be consistent' USING ERRCODE='23514'; END IF;
 main_amount=abs(CASE WHEN doc.kind='sale' THEN doc.gross ELSE doc.total END);
 IF main_amount=0 THEN
   IF doc.financial_document_id IS NOT NULL THEN RAISE EXCEPTION 'Zero monetary effect must not invent a journal' USING ERRCODE='23514'; END IF;
 ELSE
   IF doc.financial_document_id IS NULL OR NOT EXISTS(SELECT 1 FROM financial_documents d WHERE d.company_id=doc.company_id AND d.id=doc.financial_document_id
     AND d.status='posted' AND d.currency_id=doc.currency_id AND d.base_currency_id=doc.base_currency_id AND d.exchange_rate=doc.exchange_rate
     AND d.branch_id=doc.branch_id AND d.document_date=doc.document_date AND d.total_debit=main_amount) THEN
     RAISE EXCEPTION 'Invoice monetary journal must be posted and match its snapshots' USING ERRCODE='23514';
   END IF;
 END IF;
 IF doc.total=0 THEN
   IF EXISTS(SELECT 1 FROM financial_document_lines WHERE company_id=doc.company_id AND document_id=doc.financial_document_id AND account_id=doc.counterparty_account_id) THEN
     RAISE EXCEPTION 'Zero invoice net must not charge or refund the counterparty' USING ERRCODE='23514';
   END IF;
 ELSIF NOT EXISTS(SELECT 1 FROM financial_document_lines WHERE company_id=doc.company_id AND document_id=doc.financial_document_id
   AND account_id=doc.counterparty_account_id AND debit+credit=abs(doc.total) AND base_debit+base_credit=abs(doc.base_total)) THEN
   RAISE EXCEPTION 'Invoice counterparty effect must match its exact net' USING ERRCODE='23514';
 END IF;
 IF doc.kind='sale' AND sums.cost_base<>0 THEN
   IF doc.cost_document_id IS NULL OR NOT EXISTS(SELECT 1 FROM financial_documents WHERE company_id=doc.company_id AND id=doc.cost_document_id
      AND status='posted' AND currency_id=doc.base_currency_id AND branch_id=doc.branch_id AND document_date=doc.document_date AND total_debit=abs(sums.cost_base)) THEN
     RAISE EXCEPTION 'Sales inventory cost must have its posted base-currency journal' USING ERRCODE='23514';
   END IF;
 ELSIF doc.cost_document_id IS NOT NULL THEN RAISE EXCEPTION 'Invoice has an unexpected cost journal' USING ERRCODE='23514'; END IF;
 variance=sums.cost_base-doc.base_total;
 IF doc.kind='purchase' AND variance<>0 THEN
   IF doc.variance_document_id IS NULL OR NOT EXISTS(SELECT 1 FROM financial_documents WHERE company_id=doc.company_id AND id=doc.variance_document_id
      AND status='posted' AND currency_id=doc.base_currency_id AND branch_id=doc.branch_id AND document_date=doc.document_date AND total_debit=abs(variance)) THEN
     RAISE EXCEPTION 'Purchase inventory valuation variance must have a posted base-currency journal' USING ERRCODE='23514';
   END IF;
 ELSIF doc.variance_document_id IS NOT NULL THEN RAISE EXCEPTION 'Invoice has an unexpected variance journal' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;

-- Preserve this default for companies created after this migration.
CREATE OR REPLACE FUNCTION initialize_company_inventory_settings(target_company integer, creator integer)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  setting record; picked integer; parent integer; picked_code text;
  used integer[] := ARRAY[]::integer[]; prefix bigint; created_account jsonb;
  previous_link jsonb; changed_link jsonb; created_settings jsonb;
BEGIN
  PERFORM id FROM companies WHERE id=target_company FOR UPDATE;
  IF EXISTS(SELECT 1 FROM inventory_settings WHERE company_id=target_company) THEN RETURN false; END IF;
  FOR setting IN SELECT * FROM (VALUES
    ('inventory','asset','debit','1130000001','1130000000','حساب المخزون'),
    ('salesRevenue','income','credit','4100000001','4000000000','إيراد المبيعات'),
    ('costOfGoodsSold','expense','debit','5300000001','5000000000','تكلفة المبيعات'),
    ('stockSurplus','income','credit','4300000001','4000000000','فائض المخزون'),
    ('stockShortage','expense','debit','5400000001','5000000000','عجز المخزون')
  ) AS defaults(purpose,category,normal_side,code,parent_code,name) LOOP
    SELECT a.id INTO picked FROM account_links l JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id
      WHERE l.company_id=target_company AND l.purpose=setting.purpose AND a.active AND a.kind='posting'
      AND a.category=setting.category AND a.id<>ALL(used);
    IF picked IS NULL THEN
      SELECT id INTO picked FROM accounts WHERE company_id=target_company AND code=setting.code
        AND active AND kind='posting' AND category=setting.category AND id<>ALL(used);
    END IF;
    IF picked IS NULL THEN
      picked_code:=setting.code;
      IF EXISTS(SELECT 1 FROM accounts WHERE company_id=target_company AND code=picked_code) THEN
        prefix:=CASE setting.category WHEN 'asset' THEN 1 WHEN 'income' THEN 4 ELSE 5 END;
        SELECT (COALESCE(max(code::bigint),prefix*1000000000)+1)::text INTO picked_code
          FROM accounts WHERE company_id=target_company AND code::bigint BETWEEN prefix*1000000000 AND (prefix+1)*1000000000-1;
        IF picked_code::bigint >= (prefix+1)*1000000000 THEN RAISE EXCEPTION 'Account code range exhausted'; END IF;
      END IF;
      SELECT id INTO parent FROM accounts WHERE company_id=target_company AND code=setting.parent_code AND active AND kind='group' AND category=setting.category;
      INSERT INTO accounts(company_id,code,name,parent_id,kind,category,normal_side,active,created_by)
        VALUES(target_company,picked_code,setting.name,parent,'posting',setting.category,setting.normal_side,true,creator)
        RETURNING id,to_jsonb(accounts) INTO picked,created_account;
      INSERT INTO audit_events(actor_name,scope,company_id,action,target_type,target_id,after_value)
        VALUES('النظام','company',target_company,'account.create','account',picked,created_account);
    END IF;
    used:=array_append(used,picked);
    SELECT to_jsonb(l) INTO previous_link FROM account_links l WHERE company_id=target_company AND purpose=setting.purpose;
    INSERT INTO account_links(company_id,purpose,account_id) VALUES(target_company,setting.purpose,picked)
      ON CONFLICT(company_id,purpose) DO UPDATE SET account_id=EXCLUDED.account_id WHERE account_links.account_id IS NULL
      RETURNING to_jsonb(account_links) INTO changed_link;
    IF changed_link IS NOT NULL THEN
      INSERT INTO audit_events(actor_name,scope,company_id,action,target_type,before_value,after_value)
        VALUES('النظام','company',target_company,'accountLink.update','accountLink',previous_link,changed_link);
    END IF;
  END LOOP;
  INSERT INTO inventory_settings(company_id,inventory_account_id,sales_account_id,cogs_account_id,surplus_account_id,shortage_account_id,costing_method,allow_negative,updated_by)
    VALUES(target_company,used[1],used[2],used[3],used[4],used[5],'weighted_average',true,creator)
    RETURNING to_jsonb(inventory_settings) INTO created_settings;
  INSERT INTO audit_events(actor_name,scope,company_id,action,target_type,target_id,after_value)
    VALUES('النظام','company',target_company,'inventory.settings','inventorySettings',target_company,created_settings);
  RETURN true;
END $$;
