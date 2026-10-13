-- Operational inventory uses exact smallest-unit quantities and one existing financial ledger.
ALTER TABLE employees DROP CONSTRAINT employees_permissions_check;
ALTER TABLE employees ADD CONSTRAINT employees_permissions_check CHECK (permissions <@ ARRAY[
 'company.edit','employees.view','audit.view','accounts.view','accounts.manage','currencies.view','currencies.manage',
 'locations.view','locations.manage','finance.view','finance.manage','finance.post','items.view','items.manage',
 'commerce.view','commerce.manage','inventory.view','inventory.manage','inventory.post']::text[]);

CREATE TABLE inventory_settings (
 company_id integer PRIMARY KEY REFERENCES companies(id),
 inventory_account_id integer NOT NULL, sales_account_id integer NOT NULL, cogs_account_id integer NOT NULL,
 surplus_account_id integer NOT NULL, shortage_account_id integer NOT NULL,
 costing_method text NOT NULL CHECK(costing_method='weighted_average'),
 allow_negative boolean NOT NULL DEFAULT false CHECK(NOT allow_negative),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), updated_by integer NOT NULL REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,inventory_account_id) REFERENCES accounts(company_id,id),
 FOREIGN KEY(company_id,sales_account_id) REFERENCES accounts(company_id,id),
 FOREIGN KEY(company_id,cogs_account_id) REFERENCES accounts(company_id,id),
 FOREIGN KEY(company_id,surplus_account_id) REFERENCES accounts(company_id,id),
 FOREIGN KEY(company_id,shortage_account_id) REFERENCES accounts(company_id,id)
);
CREATE TABLE invoice_counters(company_id integer PRIMARY KEY REFERENCES companies(id),next_number bigint NOT NULL DEFAULT 1 CHECK(next_number>0));
CREATE TABLE invoices (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,company_id integer NOT NULL REFERENCES companies(id),
 number text NOT NULL,kind text NOT NULL CHECK(kind IN('sale','purchase')),document_date date NOT NULL,
 currency_id integer NOT NULL,currency_code text NOT NULL,currency_name text NOT NULL,decimal_places integer NOT NULL CHECK(decimal_places BETWEEN 0 AND 6),
 base_currency_id integer NOT NULL,base_currency_code text NOT NULL,base_decimal_places integer NOT NULL CHECK(base_decimal_places BETWEEN 0 AND 6),
 exchange_rate numeric(28,12) NOT NULL CHECK(exchange_rate>0),
 branch_id integer NOT NULL,branch_name text NOT NULL,location_id integer NOT NULL,location_name text NOT NULL,
 counterparty_account_id integer NOT NULL,counterparty_account_code text NOT NULL,counterparty_account_name text NOT NULL,
 description text NOT NULL DEFAULT '' CHECK(length(description)<=1000),
 gross numeric(32,6) NOT NULL,discount numeric(32,6) NOT NULL,total numeric(32,6) NOT NULL CHECK(total<>0),base_total numeric(32,6) NOT NULL CHECK(base_total<>0),
 financial_document_id integer,cost_document_id integer,variance_document_id integer,
 created_by integer NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),idempotency_key uuid NOT NULL,creation_payload jsonb NOT NULL,
 UNIQUE(company_id,id),UNIQUE(company_id,number),UNIQUE(company_id,idempotency_key),UNIQUE(company_id,financial_document_id),UNIQUE(company_id,cost_document_id),UNIQUE(company_id,variance_document_id),
 FOREIGN KEY(company_id,currency_id) REFERENCES company_currencies(company_id,id),FOREIGN KEY(company_id,base_currency_id) REFERENCES company_currencies(company_id,id),
 FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id),FOREIGN KEY(company_id,location_id) REFERENCES locations(company_id,id),
 FOREIGN KEY(company_id,counterparty_account_id) REFERENCES accounts(company_id,id),
 FOREIGN KEY(company_id,financial_document_id) REFERENCES financial_documents(company_id,id),
 FOREIGN KEY(company_id,cost_document_id) REFERENCES financial_documents(company_id,id),
 FOREIGN KEY(company_id,variance_document_id) REFERENCES financial_documents(company_id,id),
 CHECK(total=gross-discount),CHECK((total>0 AND gross>0 AND discount>=0) OR (total<0 AND gross<0 AND discount<=0))
);
CREATE INDEX invoices_listing ON invoices(company_id,document_date DESC,id DESC);
CREATE TABLE invoice_lines (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,company_id integer NOT NULL,invoice_id integer NOT NULL,line_number integer NOT NULL CHECK(line_number BETWEEN 1 AND 100),
 item_id integer NOT NULL,item_code text NOT NULL,item_name text NOT NULL,unit integer NOT NULL CHECK(unit BETWEEN 1 AND 3),unit_name text NOT NULL,
 factor2 integer NOT NULL,factor3 integer NOT NULL,purchase_factor integer NOT NULL,
 quantity numeric(22,0) NOT NULL CHECK(quantity<>0),smallest_quantity numeric(40,0) NOT NULL CHECK(smallest_quantity<>0),unit_price numeric(28,6) NOT NULL CHECK(unit_price>=0),
 gross numeric(32,6) NOT NULL,discount numeric(32,6) NOT NULL,total numeric(32,6) NOT NULL,base_total numeric(32,6) NOT NULL,cost_base numeric(32,6) NOT NULL DEFAULT 0,
 expiry_date date,original_line_id integer,
 UNIQUE(company_id,id),UNIQUE(company_id,invoice_id,line_number),
 FOREIGN KEY(company_id,invoice_id) REFERENCES invoices(company_id,id),FOREIGN KEY(company_id,item_id) REFERENCES items(company_id,id),
 FOREIGN KEY(company_id,original_line_id) REFERENCES invoice_lines(company_id,id),
 CHECK(total=gross-discount),CHECK((quantity<0)=(original_line_id IS NOT NULL)),CHECK((quantity>0)=(smallest_quantity>0))
);
CREATE INDEX invoice_lines_original ON invoice_lines(company_id,original_line_id);
CREATE TABLE stock_item_valuations (
 company_id integer NOT NULL,item_id integer NOT NULL,quantity_smallest numeric(40,0) NOT NULL DEFAULT 0 CHECK(quantity_smallest>=0),value_base numeric(32,6) NOT NULL DEFAULT 0 CHECK(value_base>=0),
 PRIMARY KEY(company_id,item_id),FOREIGN KEY(company_id,item_id) REFERENCES items(company_id,id),CHECK(quantity_smallest<>0 OR value_base=0)
);
CREATE TABLE stock_balances (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,company_id integer NOT NULL,item_id integer NOT NULL,location_id integer NOT NULL,batch_key text NOT NULL DEFAULT '',
 quantity_smallest numeric(40,0) NOT NULL DEFAULT 0 CHECK(quantity_smallest>=0),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id),UNIQUE(company_id,item_id,location_id,batch_key),
 FOREIGN KEY(company_id,item_id) REFERENCES items(company_id,id),FOREIGN KEY(company_id,location_id) REFERENCES locations(company_id,id),
 CHECK(batch_key='' OR batch_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);
CREATE TABLE stock_operations (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,company_id integer NOT NULL REFERENCES companies(id),kind text NOT NULL CHECK(kind IN('transfer','adjustment')),
 document_date date NOT NULL,description text NOT NULL DEFAULT '',created_by integer NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 idempotency_key uuid NOT NULL,creation_payload jsonb NOT NULL,financial_document_id integer,
 UNIQUE(company_id,id),UNIQUE(company_id,idempotency_key),
 FOREIGN KEY(company_id,financial_document_id) REFERENCES financial_documents(company_id,id)
);
CREATE TABLE stock_movements (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,company_id integer NOT NULL,item_id integer NOT NULL,location_id integer NOT NULL,batch_key text NOT NULL DEFAULT '',
 quantity_smallest numeric(40,0) NOT NULL CHECK(quantity_smallest<>0),cost_base numeric(32,6) NOT NULL,
 kind text NOT NULL CHECK(kind IN('purchase','sale','sales_return','purchase_return','transfer_in','transfer_out','adjustment_surplus','adjustment_shortage','reversal')),
 invoice_id integer,invoice_line_id integer,operation_id integer,original_movement_id integer,document_date date NOT NULL,
 created_by integer NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id),
 FOREIGN KEY(company_id,item_id) REFERENCES items(company_id,id),FOREIGN KEY(company_id,location_id) REFERENCES locations(company_id,id),
 FOREIGN KEY(company_id,invoice_id) REFERENCES invoices(company_id,id),FOREIGN KEY(company_id,invoice_line_id) REFERENCES invoice_lines(company_id,id),
 FOREIGN KEY(company_id,operation_id) REFERENCES stock_operations(company_id,id),FOREIGN KEY(company_id,original_movement_id) REFERENCES stock_movements(company_id,id),
 CHECK((quantity_smallest>0 AND cost_base>=0) OR (quantity_smallest<0 AND cost_base<=0)),
 CHECK((invoice_id IS NOT NULL AND invoice_line_id IS NOT NULL AND operation_id IS NULL) OR (invoice_id IS NULL AND invoice_line_id IS NULL AND operation_id IS NOT NULL))
);
CREATE INDEX stock_movements_listing ON stock_movements(company_id,item_id,document_date DESC,id DESC);

CREATE FUNCTION protect_operational_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Operational history cannot be deleted' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='invoices' AND OLD.financial_document_id IS NOT NULL THEN RAISE EXCEPTION 'Posted invoices are immutable' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='invoice_lines' AND TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM invoices WHERE company_id=OLD.company_id AND id=OLD.invoice_id AND financial_document_id IS NOT NULL) THEN RAISE EXCEPTION 'Posted invoice lines are immutable' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='invoice_lines' AND EXISTS(SELECT 1 FROM invoices WHERE company_id=NEW.company_id AND id=NEW.invoice_id AND financial_document_id IS NOT NULL) THEN RAISE EXCEPTION 'Posted invoice lines are immutable' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='stock_movements' THEN RAISE EXCEPTION 'Stock movements are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER invoices_history BEFORE UPDATE OR DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION protect_operational_history();
CREATE TRIGGER invoice_lines_history BEFORE INSERT OR UPDATE OR DELETE ON invoice_lines FOR EACH ROW EXECUTE FUNCTION protect_operational_history();
CREATE TRIGGER stock_movements_history BEFORE UPDATE OR DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION protect_operational_history();
CREATE FUNCTION protect_stock_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Stock operations cannot be deleted' USING ERRCODE='23514'; END IF;
 IF NOT (OLD.financial_document_id IS NULL AND NEW.financial_document_id IS NOT NULL AND OLD.kind='adjustment'
 AND (to_jsonb(NEW)-'financial_document_id')=(to_jsonb(OLD)-'financial_document_id')
 AND NOT EXISTS(SELECT 1 FROM audit_events WHERE company_id=OLD.company_id AND target_type='stockOperation' AND target_id=OLD.id)) THEN
 RAISE EXCEPTION 'Posted stock operations are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER stock_operations_history BEFORE UPDATE OR DELETE ON stock_operations FOR EACH ROW EXECUTE FUNCTION protect_stock_operation();
CREATE FUNCTION protect_item_stock_units() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.unit1_name,NEW.unit2_name,NEW.unit3_name,NEW.factor2,NEW.factor3,NEW.has_expiry) IS DISTINCT FROM ROW(OLD.unit1_name,OLD.unit2_name,OLD.unit3_name,OLD.factor2,OLD.factor3,OLD.has_expiry)
 AND EXISTS(SELECT 1 FROM stock_movements WHERE company_id=OLD.company_id AND item_id=OLD.id) THEN RAISE EXCEPTION 'Operational item units and expiry cannot be reinterpreted' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER items_stock_units BEFORE UPDATE ON items FOR EACH ROW EXECUTE FUNCTION protect_item_stock_units();
CREATE FUNCTION protect_stock_location_branch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.branch_id<>OLD.branch_id AND EXISTS(SELECT 1 FROM stock_movements WHERE company_id=OLD.company_id AND location_id=OLD.id) THEN
 RAISE EXCEPTION 'Operational location branch cannot be reinterpreted' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER locations_stock_branch BEFORE UPDATE ON locations FOR EACH ROW EXECUTE FUNCTION protect_stock_location_branch();
CREATE FUNCTION protect_inventory_settings_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.inventory_account_id,NEW.sales_account_id,NEW.cogs_account_id,NEW.surplus_account_id,NEW.shortage_account_id) IS DISTINCT FROM ROW(OLD.inventory_account_id,OLD.sales_account_id,OLD.cogs_account_id,OLD.surplus_account_id,OLD.shortage_account_id)
 AND EXISTS(SELECT 1 FROM stock_movements WHERE company_id=OLD.company_id) THEN RAISE EXCEPTION 'Inventory account settings require a migration after operational history' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_settings_history BEFORE UPDATE ON inventory_settings FOR EACH ROW EXECUTE FUNCTION protect_inventory_settings_history();
CREATE FUNCTION protect_linked_stock_journal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status='posted' AND NEW.status='reversed' AND (
 EXISTS(SELECT 1 FROM invoices WHERE company_id=OLD.company_id AND OLD.id IN(financial_document_id,cost_document_id,variance_document_id))
 OR EXISTS(SELECT 1 FROM stock_operations WHERE company_id=OLD.company_id AND financial_document_id=OLD.id)) THEN
 RAISE EXCEPTION 'Stock-linked journals must be corrected through traced stock operations' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER financial_stock_link BEFORE UPDATE ON financial_documents FOR EACH ROW EXECUTE FUNCTION protect_linked_stock_journal();
CREATE FUNCTION check_invoice_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE doc invoices%ROWTYPE; line_count integer; sums record;
BEGIN
 IF TG_TABLE_NAME='invoices' THEN SELECT * INTO doc FROM invoices WHERE company_id=NEW.company_id AND id=NEW.id;
 ELSE SELECT * INTO doc FROM invoices WHERE company_id=NEW.company_id AND id=NEW.invoice_id; END IF;
 SELECT count(*) AS n,sum(gross) AS gross,sum(discount) AS discount,sum(total) AS total,sum(base_total) AS base_total INTO sums FROM invoice_lines WHERE company_id=doc.company_id AND invoice_id=doc.id;
 IF sums.n<1 OR ROW(sums.gross,sums.discount,sums.total,sums.base_total) IS DISTINCT FROM ROW(doc.gross,doc.discount,doc.total,doc.base_total)
 OR doc.financial_document_id IS NULL OR NOT EXISTS(SELECT 1 FROM financial_documents WHERE company_id=doc.company_id AND id=doc.financial_document_id AND status='posted' AND currency_id=doc.currency_id AND total_debit=abs(CASE WHEN doc.kind='sale' THEN doc.gross ELSE doc.total END))
 OR NOT EXISTS(SELECT 1 FROM financial_document_lines WHERE company_id=doc.company_id AND document_id=doc.financial_document_id AND account_id=doc.counterparty_account_id AND debit+credit=abs(doc.total) AND base_debit+base_credit=abs(doc.base_total))
 OR EXISTS(SELECT 1 FROM invoice_lines WHERE company_id=doc.company_id AND invoice_id=doc.id AND (quantity>0)<>(doc.total>0)) THEN
 RAISE EXCEPTION 'Invoice totals and posted journal must be atomic and consistent' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER invoices_integrity AFTER INSERT OR UPDATE ON invoices DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_invoice_integrity();
CREATE CONSTRAINT TRIGGER invoice_lines_integrity AFTER INSERT OR UPDATE ON invoice_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_invoice_integrity();
CREATE FUNCTION check_stock_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scope_company integer; scope_item integer; pool record; aggregate_balance numeric; aggregate_value numeric;
BEGIN
 scope_company:=COALESCE(NEW.company_id,OLD.company_id);scope_item:=COALESCE(NEW.item_id,OLD.item_id);
 SELECT quantity_smallest,value_base INTO pool FROM stock_item_valuations WHERE company_id=scope_company AND item_id=scope_item;
 SELECT COALESCE(sum(quantity_smallest),0) INTO aggregate_balance FROM stock_balances WHERE company_id=scope_company AND item_id=scope_item;
 SELECT COALESCE(sum(cost_base),0) INTO aggregate_value FROM stock_movements WHERE company_id=scope_company AND item_id=scope_item;
 IF pool IS NULL OR pool.quantity_smallest<>aggregate_balance OR pool.value_base<>aggregate_value
 OR EXISTS(SELECT 1 FROM stock_balances b WHERE b.company_id=scope_company AND b.item_id=scope_item
 AND b.quantity_smallest<>(SELECT COALESCE(sum(m.quantity_smallest),0) FROM stock_movements m WHERE m.company_id=b.company_id AND m.item_id=b.item_id AND m.location_id=b.location_id AND m.batch_key=b.batch_key))
 OR EXISTS(SELECT 1 FROM stock_movements m WHERE m.company_id=scope_company AND m.item_id=scope_item
 AND NOT EXISTS(SELECT 1 FROM stock_balances b WHERE b.company_id=m.company_id AND b.item_id=m.item_id AND b.location_id=m.location_id AND b.batch_key=m.batch_key)) THEN
 RAISE EXCEPTION 'Stock balances, valuation and movements must reconcile atomically' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER stock_balances_integrity AFTER INSERT OR UPDATE OR DELETE ON stock_balances DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_stock_integrity();
CREATE CONSTRAINT TRIGGER stock_valuations_integrity AFTER INSERT OR UPDATE OR DELETE ON stock_item_valuations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_stock_integrity();
CREATE CONSTRAINT TRIGGER stock_movements_integrity AFTER INSERT ON stock_movements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_stock_integrity();
