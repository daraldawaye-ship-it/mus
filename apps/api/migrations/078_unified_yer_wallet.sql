-- One wallet balance: 1 point = 1 Yemeni rial. Historical conversions
-- retain their immutable exchange-rate snapshots; all NEW conversions use 1.
UPDATE wallet_conversion_policies
SET point_value=1, revision=revision+1,
    updated_at=clock_timestamp()
WHERE point_value IS DISTINCT FROM 1;
ALTER TABLE wallet_conversion_policies ADD CONSTRAINT wallet_unit_yer_fixed
 CHECK (point_value IS NULL OR point_value=1);

-- Each eligible clearance line can credit the existing points ledger ONCE.
-- The source invoice's immutable FX rate converts commission to base YER.
-- No direct ledger money balance is introduced.
ALTER TABLE employee_wallet_entries
  ADD COLUMN clearance_earning_id integer,
  ADD FOREIGN KEY(company_id,clearance_earning_id)
    REFERENCES employee_clearance_earnings(company_id,id);
CREATE UNIQUE INDEX wallet_clearance_once
 ON employee_wallet_entries(company_id,clearance_earning_id)
 WHERE clearance_earning_id IS NOT NULL;
ALTER TABLE employee_wallet_entries DROP CONSTRAINT wallet_entry_kind_check;
ALTER TABLE employee_wallet_entries ADD CONSTRAINT wallet_entry_kind_check
 CHECK(kind IN ('manual','automatic','reversal','conversion','attendance','clearance'));

-- Preserve all legacy source requirements (including attendance) while
-- allowing a separately authenticated, positive clearance-wallet credit.
DO $$
DECLARE old_guard text;
BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO old_guard FROM pg_constraint
 WHERE conrelid='employee_wallet_entries'::regclass
   AND conname='wallet_entry_source_check';
 IF old_guard IS NULL THEN RAISE EXCEPTION 'Wallet source guard is missing'; END IF;
 ALTER TABLE employee_wallet_entries DROP CONSTRAINT wallet_entry_source_check;
 EXECUTE format('ALTER TABLE employee_wallet_entries ADD CONSTRAINT wallet_entry_source_check CHECK (
  (%s) OR (
   kind=''clearance'' AND points>0 AND money=0
   AND clearance_earning_id IS NOT NULL AND invoice_id IS NOT NULL
   AND reference_id IS NULL AND financial_document_id IS NULL
   AND conversion_id IS NULL AND attendance_entry_id IS NULL
   AND page_key IS NULL AND task_code IS NULL AND task_revision IS NULL
   AND logical_line_count IS NULL
  )
 )',old_guard);
END $$;

-- Validate the credited amount against the immutable source at COMMIT,
-- and never let a ledger credit be detached or reassigned.
CREATE FUNCTION check_wallet_clearance_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source employee_clearance_earnings; sale invoices;
BEGIN
 IF NEW.kind<>'clearance' THEN RETURN NULL; END IF;
 SELECT * INTO source FROM employee_clearance_earnings
  WHERE company_id=NEW.company_id AND id=NEW.clearance_earning_id;
 SELECT * INTO sale FROM invoices
  WHERE company_id=source.company_id AND id=source.invoice_id;
 IF source.id IS NULL OR sale.id IS NULL OR sale.kind<>'sale'
   OR NOT sale.posted OR sale.base_currency_code<>'YER'
   OR source.employee_id<>NEW.employee_id
   OR source.created_by<>NEW.created_by
   OR source.invoice_id<>NEW.invoice_id
   OR NEW.points<>round(source.amount*sale.exchange_rate)
   OR NEW.points<=0 THEN
   RAISE EXCEPTION 'Clearance wallet credit does not match its immutable source or YER rate' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER wallet_clearance_source AFTER INSERT
 ON employee_wallet_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION check_wallet_clearance_source();

-- Bring already-earned clearance commission into the wallet once. Historical
-- invoices without an accrual remain excluded: no speculative attribution.
-- Small currency amounts rounded below one rial remain in the original
-- earnings source (not represented as an invented zero-value wallet entry).
INSERT INTO employee_wallet_entries(
 company_id,employee_id,employee_name,kind,points,reason,
 invoice_id,clearance_earning_id,idempotency_key,request_payload,
 created_by,created_by_name,created_at)
SELECT ce.company_id,ce.employee_id,ce.employee_name,'clearance',
 round(ce.amount*i.exchange_rate),
 ('عمولة تصريف: '||ce.item_name||' — فاتورة '||i.number),
 ce.invoice_id,ce.id,gen_random_uuid(),
 jsonb_build_object('source','clearance','earningId',ce.id,
    'amount',ce.amount::text,'currency',ce.currency_code,
    'invoiceExchangeRate',i.exchange_rate::text,
    'walletYER',round(ce.amount*i.exchange_rate)::text),
 ce.created_by,u.display_name,ce.created_at
FROM employee_clearance_earnings ce
JOIN invoices i ON i.company_id=ce.company_id AND i.id=ce.invoice_id
JOIN users u ON u.id=ce.created_by
WHERE i.base_currency_code='YER'
  AND round(ce.amount*i.exchange_rate)>0
  AND NOT EXISTS(
    SELECT 1 FROM employee_wallet_entries w
     WHERE w.company_id=ce.company_id AND w.clearance_earning_id=ce.id
  )
ON CONFLICT DO NOTHING;
