-- Positive employee clearance earnings are monetary accrual records, NOT
-- wallet reward points, cash disbursements or accounting journal entries.
-- Only new posted invoices are eligible; do not backfill historic documents.
CREATE TABLE employee_clearance_earnings (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer NOT NULL,
  employee_id integer NOT NULL,
  employee_name text NOT NULL,
  invoice_id integer NOT NULL,
  invoice_line_id integer NOT NULL,
  item_id integer NOT NULL,
  item_name text NOT NULL,
  document_date date NOT NULL,
  currency_id integer NOT NULL,
  currency_code text NOT NULL,
  commission_rate numeric(7,4) NOT NULL CHECK (commission_rate>0 AND commission_rate<=100),
  amount numeric(28,6) NOT NULL CHECK (amount>0),
  created_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(company_id,id),
  UNIQUE(company_id,invoice_line_id),
  FOREIGN KEY(company_id,employee_id) REFERENCES employees(company_id,id),
  FOREIGN KEY(company_id,invoice_id) REFERENCES invoices(company_id,id),
  FOREIGN KEY(company_id,invoice_line_id) REFERENCES invoice_lines(company_id,id),
  FOREIGN KEY(company_id,item_id) REFERENCES items(company_id,id),
  FOREIGN KEY(company_id,currency_id) REFERENCES company_currencies(company_id,id)
);
CREATE INDEX clearance_earnings_employee ON employee_clearance_earnings(company_id,employee_id,created_at DESC,id DESC);
CREATE INDEX clearance_earnings_invoice ON employee_clearance_earnings(company_id,invoice_id);
CREATE FUNCTION protect_clearance_earnings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Employee clearance earnings are immutable; returns never deduct automatically' USING ERRCODE='23514';
END $$;
CREATE TRIGGER clearance_earnings_immutable BEFORE UPDATE OR DELETE ON employee_clearance_earnings
 FOR EACH ROW EXECUTE FUNCTION protect_clearance_earnings();

-- Linked returns only create a case for management to inspect. They do not
-- generate a negative employee earning or change an existing entitlement.
CREATE TABLE employee_clearance_return_reviews (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer NOT NULL,
  invoice_id integer NOT NULL,
  invoice_line_id integer NOT NULL,
  original_invoice_line_id integer NOT NULL,
  original_employee_id integer,
  item_name text NOT NULL,
  document_date date NOT NULL,
  currency_code text NOT NULL,
  candidate_amount numeric(28,6) NOT NULL CHECK (candidate_amount>=0),
  status varchar(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reviewed')),
  review_note varchar(1000),
  reviewed_by integer REFERENCES users(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(company_id,id),
  UNIQUE(company_id,invoice_line_id),
  FOREIGN KEY(company_id,invoice_id) REFERENCES invoices(company_id,id),
  FOREIGN KEY(company_id,invoice_line_id) REFERENCES invoice_lines(company_id,id),
  FOREIGN KEY(company_id,original_invoice_line_id) REFERENCES invoice_lines(company_id,id),
  FOREIGN KEY(company_id,original_employee_id) REFERENCES employees(company_id,id),
  CHECK ((status='pending' AND reviewed_by IS NULL AND reviewed_at IS NULL AND review_note IS NULL)
      OR (status='reviewed' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND length(trim(review_note))>0))
);
CREATE INDEX clearance_reviews_pending ON employee_clearance_return_reviews(company_id,status,created_at DESC,id DESC);
CREATE FUNCTION protect_clearance_return_reviews() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE'
    OR OLD.status<>'pending' OR NEW.status<>'reviewed'
    OR (to_jsonb(NEW)-ARRAY['status','review_note','reviewed_by','reviewed_at'])
       IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','review_note','reviewed_by','reviewed_at'])
  THEN RAISE EXCEPTION 'Return review history may only be acknowledged by management once' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER clearance_return_review_history BEFORE UPDATE OR DELETE
 ON employee_clearance_return_reviews FOR EACH ROW EXECUTE FUNCTION protect_clearance_return_reviews();
