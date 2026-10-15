-- An order is a separate auditable request that claims existing manual stock reservations.
-- It is NOT an invoice and has no stock/accounting effect until an exact sale is posted.
CREATE TABLE customer_orders (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 company_id integer NOT NULL REFERENCES companies(id),
 order_number text NOT NULL,
 counterparty_account_id integer NOT NULL,
 branch_id integer NOT NULL,
 location_id integer NOT NULL,
 description text NOT NULL DEFAULT '' CHECK(length(description)<=1000),
 status text NOT NULL DEFAULT 'open' CHECK(status IN('open','fulfilled','cancelled')),
 created_by integer NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 fulfilled_invoice_id integer,
 fulfilled_at timestamptz,
 cancelled_by integer REFERENCES users(id),
 cancelled_at timestamptz,
 cancel_reason text,
 cancel_key uuid,
 idempotency_key uuid NOT NULL,
 creation_payload jsonb NOT NULL,
 UNIQUE(company_id,id),UNIQUE(company_id,order_number),UNIQUE(company_id,idempotency_key),
 UNIQUE(company_id,fulfilled_invoice_id),UNIQUE(company_id,cancel_key),
 FOREIGN KEY(company_id,counterparty_account_id) REFERENCES accounts(company_id,id),
 FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id),
 FOREIGN KEY(company_id,location_id) REFERENCES locations(company_id,id),
 FOREIGN KEY(company_id,fulfilled_invoice_id) REFERENCES invoices(company_id,id),
 CHECK (
  (status='open' AND fulfilled_invoice_id IS NULL AND fulfilled_at IS NULL AND cancelled_at IS NULL AND cancel_key IS NULL)
  OR (status='fulfilled' AND fulfilled_invoice_id IS NOT NULL AND fulfilled_at IS NOT NULL AND cancelled_at IS NULL)
  OR (status='cancelled' AND cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL AND cancel_key IS NOT NULL AND fulfilled_invoice_id IS NULL)
 )
);
CREATE INDEX customer_orders_open ON customer_orders(company_id,location_id,counterparty_account_id,id DESC) WHERE status='open';

CREATE TABLE customer_order_lines (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 company_id integer NOT NULL,
 order_id integer NOT NULL,
 line_number integer NOT NULL CHECK(line_number BETWEEN 1 AND 100),
 reservation_id integer NOT NULL,
 item_id integer NOT NULL,
 unit smallint NOT NULL CHECK(unit IN(1,2,3)),
 quantity_entered numeric(40,0) NOT NULL CHECK(quantity_entered>0),
 quantity_smallest numeric(40,0) NOT NULL CHECK(quantity_smallest>0),
 batch_key text NOT NULL DEFAULT '',
 UNIQUE(company_id,id),UNIQUE(company_id,order_id,line_number),UNIQUE(company_id,reservation_id),
 FOREIGN KEY(company_id,order_id) REFERENCES customer_orders(company_id,id),
 FOREIGN KEY(company_id,reservation_id) REFERENCES stock_reservations(company_id,id),
 FOREIGN KEY(company_id,item_id) REFERENCES items(company_id,id)
);
ALTER TABLE stock_reservations ADD COLUMN customer_order_id integer,
 ADD CONSTRAINT stock_reservations_customer_order_fk FOREIGN KEY(company_id,customer_order_id)
 REFERENCES customer_orders(company_id,id);
CREATE INDEX stock_reservations_order ON stock_reservations(company_id,customer_order_id)
 WHERE customer_order_id IS NOT NULL;

ALTER TABLE invoices ADD COLUMN customer_order_id integer,
 ADD CONSTRAINT invoices_customer_order_fk FOREIGN KEY(company_id,customer_order_id)
 REFERENCES customer_orders(company_id,id);
CREATE UNIQUE INDEX invoices_customer_order_once ON invoices(company_id,customer_order_id)
 WHERE customer_order_id IS NOT NULL;
