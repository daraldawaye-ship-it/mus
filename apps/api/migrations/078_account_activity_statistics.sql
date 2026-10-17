-- Operational activity is distinct from a balance source revision. An invoice
-- can name a supplier without charging that account, including at zero net.
-- Its operation-cache invalidation must not invalidate an unchanged balance quote.
ALTER TABLE account_statistics
  ADD COLUMN operations_generation uuid,
  ADD COLUMN operations_currency_id integer,
  ADD COLUMN operations_currency_code text,
  ADD COLUMN operations_currency_decimal_places integer,
  ADD CONSTRAINT account_statistics_operations_currency_fk
    FOREIGN KEY (company_id,operations_currency_id) REFERENCES company_currencies(company_id,id),
  ADD CONSTRAINT account_statistics_operations_currency_code
    CHECK (operations_currency_code ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT account_statistics_operations_currency_precision
    CHECK (operations_currency_decimal_places BETWEEN 0 AND 6);

-- Earlier readiness markers were not this materialized operation projection.
-- Preserve the previous metadata instead of synthesizing a computation.
UPDATE account_statistics SET
  activity_state=CASE WHEN activity_state='ready' THEN 'stale' ELSE activity_state END,
  commerce_state=CASE WHEN commerce_state='ready' THEN 'stale' ELSE commerce_state END
WHERE activity_state='ready' OR commerce_state='ready';

ALTER TABLE account_statistics
  ADD CONSTRAINT account_statistics_operations_ready_snapshot CHECK (
    (activity_state<>'ready' AND commerce_state<>'ready') OR (
      operations_generation IS NOT NULL AND operations_currency_id IS NOT NULL
      AND operations_currency_code IS NOT NULL AND operations_currency_decimal_places IS NOT NULL
    )
  );

ALTER TABLE invoices ADD COLUMN counterparty_cash_snapshot boolean;

-- Capture only a new posting, under the source transaction. Existing posted
-- invoices remain immutable, including historical NULL classification values.
CREATE FUNCTION snapshot_invoice_counterparty_cash() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cash_value boolean;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.posted THEN RETURN NEW; END IF;
  END IF;
  -- invoices_history can promote a row when its financial link is assigned;
  -- recognize that transition even if posted was not in the UPDATE target list.
  IF NEW.posted OR NEW.financial_document_id IS NOT NULL THEN
    SELECT cash_or_bank INTO cash_value FROM accounts
      WHERE company_id=NEW.company_id AND id=NEW.counterparty_account_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invoice cash classification requires its company counterparty'
        USING ERRCODE='23514', CONSTRAINT='invoices_counterparty_cash_snapshot';
    END IF;
    NEW.counterparty_cash_snapshot := cash_value;
  ELSE
    NEW.counterparty_cash_snapshot := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoices_counterparty_cash_snapshot BEFORE INSERT OR UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION snapshot_invoice_counterparty_cash();

CREATE INDEX invoices_counterparty_operations
  ON invoices(company_id,counterparty_account_id,document_date DESC,id DESC) WHERE posted;

-- One logical source row per account/family/document. NOT MATERIALIZED permits
-- company/account predicates on this view to reach the indexed source branches.
CREATE VIEW account_operation_events AS
WITH invoice_facts AS NOT MATERIALIZED (
  SELECT i.company_id,i.id,i.number,i.kind,i.document_date,
    i.currency_id,i.currency_code,i.decimal_places,
    i.base_currency_id,i.base_currency_code,i.base_decimal_places,
    i.counterparty_account_id,i.supplier_account_id,i.total,i.base_total,
    i.financial_document_id,i.cost_document_id,i.variance_document_id,
    EXISTS(SELECT 1 FROM invoice_lines l
      WHERE l.company_id=i.company_id AND l.invoice_id=i.id AND l.quantity>0) AS has_positive,
    EXISTS(SELECT 1 FROM invoice_lines l
      WHERE l.company_id=i.company_id AND l.invoice_id=i.id AND l.quantity<0) AS has_correction,
    COALESCE(i.counterparty_cash_snapshot,
      CASE WHEN EXISTS (
        SELECT 1 FROM financial_document_lines fl
        JOIN financial_documents fd ON fd.company_id=fl.company_id AND fd.id=fl.document_id
        WHERE fl.company_id=i.company_id AND fl.document_id=i.financial_document_id
          AND fl.account_id=i.counterparty_account_id AND fd.status IN ('posted','reversed')
      ) THEN a.cash_or_bank ELSE NULL END
    ) AS cash_classification,
    EXISTS (
      SELECT 1 FROM invoice_lines returned
      JOIN invoice_lines original_line ON original_line.company_id=returned.company_id
        AND original_line.id=returned.original_line_id
      JOIN invoices original_invoice ON original_invoice.company_id=original_line.company_id
        AND original_invoice.id=original_line.invoice_id AND original_invoice.posted
      WHERE returned.company_id=i.company_id AND returned.invoice_id=i.id AND returned.quantity<0
        AND i.supplier_account_id IS NOT NULL AND original_invoice.supplier_account_id IS NOT NULL
        AND original_invoice.supplier_account_id<>i.supplier_account_id
    ) AS supplier_conflict
  FROM invoices i
  JOIN accounts a ON a.company_id=i.company_id AND a.id=i.counterparty_account_id
  WHERE i.posted
), invoice_activity_accounts AS NOT MATERIALIZED (
  SELECT company_id,id AS invoice_id,counterparty_account_id AS account_id FROM invoices WHERE posted
  UNION
  SELECT company_id,id,supplier_account_id FROM invoices WHERE posted AND supplier_account_id IS NOT NULL
  UNION
  SELECT i.company_id,i.id,l.account_id FROM financial_document_lines l
  JOIN financial_documents d ON d.company_id=l.company_id AND d.id=l.document_id
    AND d.status IN ('posted','reversed')
  JOIN invoices i ON i.company_id=l.company_id
    AND l.document_id IN (i.financial_document_id,i.cost_document_id,i.variance_document_id)
  WHERE i.posted
), financial_accounts AS NOT MATERIALIZED (
  SELECT DISTINCT company_id,document_id,account_id FROM financial_document_lines
), financial_facts AS NOT MATERIALIZED (
  SELECT d.company_id,d.id,d.number,d.document_date,d.kind,
    d.currency_id,d.currency_code,d.decimal_places,
    d.base_currency_id,d.base_currency_code,d.base_decimal_places,
    d.total_debit,d.total_base_debit,d.reverses_document_id,
    CASE WHEN d.reverses_document_id IS NULL THEN d.kind ELSE original.kind END AS voucher_family,
    CASE WHEN reversal.status IN ('posted','reversed') THEN reversal.document_date ELSE NULL END AS cancelled_on
  FROM financial_documents d
  LEFT JOIN financial_documents original ON original.company_id=d.company_id AND original.id=d.reverses_document_id
    AND original.status IN ('posted','reversed')
  LEFT JOIN financial_documents reversal ON reversal.company_id=d.company_id AND reversal.id=d.reversal_document_id
  WHERE d.status IN ('posted','reversed')
    AND NOT EXISTS (
      SELECT 1 FROM invoices i WHERE i.company_id=d.company_id AND i.posted
        AND d.id IN (i.financial_document_id,i.cost_document_id,i.variance_document_id)
    )
)
SELECT i.company_id,scope.account_id,'activity'::text AS family,
  'invoice'::text AS source_kind,i.id AS source_id,i.number AS source_number,i.document_date,
  i.currency_id,i.currency_code,i.decimal_places,
  i.base_currency_id,i.base_currency_code,i.base_decimal_places,
  i.total AS amount,i.base_total AS base_amount,i.has_correction AS is_correction,
  true AS last_eligible,NULL::date AS cancelled_on,
  (i.kind<>'purchase' OR i.cash_classification IS NOT NULL) AS cash_classification_known,i.supplier_conflict
FROM invoice_facts i JOIN invoice_activity_accounts scope ON scope.company_id=i.company_id AND scope.invoice_id=i.id
UNION ALL
SELECT i.company_id,i.counterparty_account_id,'sale'::text,'invoice'::text,i.id,i.number,i.document_date,
  i.currency_id,i.currency_code,i.decimal_places,i.base_currency_id,i.base_currency_code,i.base_decimal_places,
  i.total,i.base_total,i.has_correction,i.has_positive,NULL::date,true,i.supplier_conflict
FROM invoice_facts i WHERE i.kind='sale'
UNION ALL
SELECT i.company_id,i.supplier_account_id,'purchase'::text,'invoice'::text,i.id,i.number,i.document_date,
  i.currency_id,i.currency_code,i.decimal_places,i.base_currency_id,i.base_currency_code,i.base_decimal_places,
  i.total,i.base_total,i.has_correction,i.has_positive,NULL::date,i.cash_classification IS NOT NULL,i.supplier_conflict
FROM invoice_facts i WHERE i.kind='purchase' AND i.supplier_account_id IS NOT NULL
UNION ALL
SELECT i.company_id,i.supplier_account_id,'purchase_cash'::text,'invoice'::text,i.id,i.number,i.document_date,
  i.currency_id,i.currency_code,i.decimal_places,i.base_currency_id,i.base_currency_code,i.base_decimal_places,
  i.total,i.base_total,i.has_correction,i.has_positive,NULL::date,true,i.supplier_conflict
FROM invoice_facts i WHERE i.kind='purchase' AND i.supplier_account_id IS NOT NULL AND i.cash_classification=true
UNION ALL
SELECT d.company_id,scope.account_id,'activity'::text,'financial_document'::text,d.id,d.number,d.document_date,
  d.currency_id,d.currency_code,d.decimal_places,d.base_currency_id,d.base_currency_code,d.base_decimal_places,
  CASE WHEN d.reverses_document_id IS NULL THEN d.total_debit ELSE -d.total_debit END,
  CASE WHEN d.reverses_document_id IS NULL THEN d.total_base_debit ELSE -d.total_base_debit END,
  d.reverses_document_id IS NOT NULL,true,NULL::date,true,false
FROM financial_facts d JOIN financial_accounts scope ON scope.company_id=d.company_id AND scope.document_id=d.id
UNION ALL
SELECT d.company_id,scope.account_id,d.voucher_family,'financial_document'::text,d.id,d.number,d.document_date,
  d.currency_id,d.currency_code,d.decimal_places,d.base_currency_id,d.base_currency_code,d.base_decimal_places,
  CASE WHEN d.reverses_document_id IS NULL THEN d.total_debit ELSE -d.total_debit END,
  CASE WHEN d.reverses_document_id IS NULL THEN d.total_base_debit ELSE -d.total_base_debit END,
  d.reverses_document_id IS NOT NULL,d.reverses_document_id IS NULL,
  CASE WHEN d.reverses_document_id IS NULL THEN d.cancelled_on ELSE NULL END,true,false
FROM financial_facts d JOIN financial_accounts scope ON scope.company_id=d.company_id AND scope.document_id=d.id
WHERE d.voucher_family IN ('payment','receipt');

CREATE FUNCTION invalidate_account_operation_statistics(p_company integer,p_account integer)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM companies WHERE id=p_company FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM initialize_account_statistics(p_company,p_account);
  UPDATE account_statistics SET
    activity_state=CASE WHEN activity_state='ready' THEN 'stale' ELSE activity_state END,
    commerce_state=CASE WHEN commerce_state='ready' THEN 'stale' ELSE commerce_state END,
    updated_at=clock_timestamp()
  WHERE company_id=p_company AND account_id=p_account;
END $$;

CREATE FUNCTION invalidate_invoice_account_operation_statistics() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_invoice invoices%ROWTYPE; affected_account integer;
BEGIN
  IF TG_OP='DELETE' THEN
    source_invoice := OLD;
    IF NOT source_invoice.posted THEN RETURN OLD; END IF;
  ELSE
    IF NOT NEW.posted THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' THEN
      IF OLD.posted THEN RETURN NEW; END IF;
    END IF;
    source_invoice := NEW;
  END IF;
  FOR affected_account IN
    SELECT account_id FROM (
      SELECT source_invoice.counterparty_account_id AS account_id
      UNION SELECT source_invoice.supplier_account_id
      UNION SELECT l.account_id FROM financial_document_lines l
        WHERE l.company_id=source_invoice.company_id
          AND l.document_id IN (source_invoice.financial_document_id,source_invoice.cost_document_id,source_invoice.variance_document_id)
    ) affected WHERE account_id IS NOT NULL ORDER BY account_id
  LOOP
    PERFORM invalidate_account_operation_statistics(source_invoice.company_id,affected_account);
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoices_account_operation_statistics AFTER INSERT OR UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION invalidate_invoice_account_operation_statistics();

CREATE FUNCTION refresh_account_activity_statistics(p_company integer,p_account integer,p_asof date)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  today_in_aden date := (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date;
  cached account_statistics%ROWTYPE;
  current_generation uuid;
  current_currency_id integer;
  current_currency_code text;
  current_currency_places integer;
BEGIN
  IF p_asof IS NULL OR p_asof<DATE '0003-01-01' OR p_asof>today_in_aden THEN
    RAISE EXCEPTION 'Activity date must be between 0003-01-01 and the current Asia/Aden date'
      USING ERRCODE='22023';
  END IF;
  PERFORM id FROM companies WHERE id=p_company FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM id FROM accounts WHERE company_id=p_company AND id=p_account AND kind='posting' FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM initialize_account_statistics(p_company,p_account);
  SELECT * INTO cached FROM account_statistics
    WHERE company_id=p_company AND account_id=p_account FOR UPDATE;

  SELECT generation INTO current_generation FROM account_balance_sources WHERE company_id=p_company FOR SHARE;
  IF NOT FOUND THEN
    PERFORM invalidate_account_operation_statistics(p_company,p_account);
    RETURN false;
  END IF;
  SELECT base_currency_id INTO current_currency_id FROM finance_settings WHERE company_id=p_company FOR SHARE;
  IF NOT FOUND THEN
    PERFORM invalidate_account_operation_statistics(p_company,p_account);
    RETURN false;
  END IF;
  SELECT code,decimal_places INTO current_currency_code,current_currency_places FROM company_currencies
    WHERE company_id=p_company AND id=current_currency_id AND active FOR SHARE;
  IF NOT FOUND THEN
    PERFORM invalidate_account_operation_statistics(p_company,p_account);
    RETURN false;
  END IF;

  IF cached.policy_version=1 AND cached.activity_state='ready' AND cached.commerce_state='ready'
    AND cached.activity_computed_revision=cached.source_revision AND cached.commerce_computed_revision=cached.source_revision
    AND cached.activity_as_of_date=p_asof AND cached.commerce_as_of_date=p_asof
    AND cached.operations_generation=current_generation
    AND cached.operations_currency_id=current_currency_id AND cached.operations_currency_code=current_currency_code
    AND cached.operations_currency_decimal_places=current_currency_places THEN
    RETURN true;
  END IF;

  -- A legacy zero-only invoice can predate a permitted base-currency change.
  -- Zero contributes no cross-currency money; any nonzero mismatch is refused.
  IF EXISTS (
    SELECT 1 FROM account_operation_events e WHERE e.company_id=p_company AND e.account_id=p_account
      AND e.document_date<=p_asof AND e.base_currency_id<>current_currency_id AND e.base_amount<>0
  ) OR EXISTS (
    SELECT 1 FROM financial_document_lines l
    JOIN financial_documents d ON d.company_id=l.company_id AND d.id=l.document_id
    WHERE l.company_id=p_company AND l.account_id=p_account AND d.status IN ('posted','reversed')
      AND d.document_date<=p_asof AND d.base_currency_id<>current_currency_id
      AND (l.base_debit<>0 OR l.base_credit<>0)
  ) THEN
    PERFORM invalidate_account_operation_statistics(p_company,p_account);
    RETURN false;
  END IF;

  DELETE FROM account_daily_activity WHERE company_id=p_company AND account_id=p_account;
  INSERT INTO account_daily_activity(company_id,account_id,document_date,currency_id,family,
    base_currency_id,document_count,amount,base_amount,base_debit,base_credit,source_revision)
  SELECT e.company_id,e.account_id,e.document_date,e.currency_id,e.family,
    current_currency_id,count(*)::bigint,
    CASE WHEN e.family='activity' THEN NULL::numeric ELSE sum(e.amount) END,
    CASE WHEN e.family='activity' THEN NULL::numeric ELSE sum(e.base_amount) END,
    NULL::numeric,NULL::numeric,cached.source_revision
  FROM account_operation_events e
  WHERE e.company_id=p_company AND e.account_id=p_account AND e.document_date<=p_asof
  GROUP BY e.company_id,e.account_id,e.document_date,e.currency_id,e.family;

  INSERT INTO account_daily_activity(company_id,account_id,document_date,currency_id,family,
    base_currency_id,document_count,amount,base_amount,base_debit,base_credit,source_revision)
  SELECT l.company_id,l.account_id,d.document_date,d.currency_id,'ledger',current_currency_id,
    count(DISTINCT d.id)::bigint,sum(l.debit-l.credit),sum(l.base_debit-l.base_credit),
    sum(l.base_debit),sum(l.base_credit),cached.source_revision
  FROM financial_document_lines l
  JOIN financial_documents d ON d.company_id=l.company_id AND d.id=l.document_id
  WHERE l.company_id=p_company AND l.account_id=p_account AND d.status IN ('posted','reversed')
    AND d.document_date<=p_asof
  GROUP BY l.company_id,l.account_id,d.document_date,d.currency_id;

  UPDATE account_statistics SET
    policy_version=1,
    operations_generation=current_generation,
    operations_currency_id=current_currency_id,operations_currency_code=current_currency_code,
    operations_currency_decimal_places=current_currency_places,
    activity_state='ready',activity_computed_revision=source_revision,
    activity_as_of_date=p_asof,activity_computed_at=clock_timestamp(),
    commerce_state='ready',commerce_computed_revision=source_revision,
    commerce_as_of_date=p_asof,commerce_computed_at=clock_timestamp(),updated_at=clock_timestamp()
  WHERE company_id=p_company AND account_id=p_account;
  RETURN true;
END $$;

-- No initial scans of operational history or eager refresh on source writes.
