-- Employee till shortcuts: a general-purpose cash shortage/overage account,
-- with an optional company electronic-wallet destination. Existing companies
-- receive a safe default; new companies call the same helper after chart setup.
ALTER TABLE account_links DROP CONSTRAINT account_links_purpose_check;
ALTER TABLE account_links ADD CONSTRAINT account_links_purpose_check CHECK (purpose IN (
 'salesRevenue','discountAllowed','discountEarned','inventory','purchases',
 'costOfGoodsSold','stockShortage','stockSurplus',
 'salaryExpense','salaryPayable','rewardExpense','rewardPayable',
 'commissionExpense','commissionPayable','allowanceExpense','allowancePayable',
 'overtimeExpense','operatingRentExpense','operatingUtilitiesExpense',
 'operatingMaintenanceExpense','operatingCommunicationsExpense',
 'cashVariance','electronicWallet'
));

CREATE FUNCTION ensure_company_cash_variance(p_company_id integer,p_actor_id integer)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE root accounts%ROWTYPE; a accounts%ROWTYPE; k bigint; chosen integer;
BEGIN
 SELECT * INTO root FROM accounts WHERE company_id=p_company_id
   AND code='5000000000' AND category='expense' AND kind='group' AND active;
 IF NOT FOUND THEN RETURN; END IF;
 -- Do not reuse an unrelated account if the preferred code is already taken.
 FOR k IN 5499999000..5499999999 LOOP
   SELECT * INTO a FROM accounts WHERE company_id=p_company_id AND code=k::text;
   IF FOUND THEN
     IF a.kind='posting' AND a.category='expense' AND a.active
       AND a.parent_id=root.id AND a.name='عجز وزيادة الصناديق' THEN
       chosen:=a.id; EXIT;
     END IF;
     CONTINUE;
   END IF;
   INSERT INTO accounts(company_id,code,name,parent_id,kind,category,normal_side,
                        active,created_by,cash_or_bank,account_choice)
   VALUES(p_company_id,k::text,'عجز وزيادة الصناديق',root.id,'posting',
          'expense','debit',true,p_actor_id,false,'administrative')
   ON CONFLICT(company_id,code) DO NOTHING RETURNING id INTO chosen;
   IF chosen IS NOT NULL THEN EXIT; END IF;
 END LOOP;
 IF chosen IS NULL THEN RETURN; END IF;
 INSERT INTO account_links(company_id,purpose,account_id)
 VALUES(p_company_id,'cashVariance',chosen)
 ON CONFLICT(company_id,purpose) DO NOTHING;
END $$;

DO $$
DECLARE c record;
BEGIN
 FOR c IN SELECT id,created_by FROM companies ORDER BY id LOOP
   PERFORM ensure_company_cash_variance(c.id,c.created_by);
 END LOOP;
END $$;

CREATE TABLE employee_cashbox_operations (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 company_id integer NOT NULL,
 employee_id integer NOT NULL,
 employee_name text NOT NULL,
 kind varchar(18) NOT NULL CHECK(kind IN('pouch','electronic','close')),
 amount numeric(28,6) NOT NULL,
 notes text NOT NULL DEFAULT '' CHECK(length(notes)<=1000),
 cash_account_id integer NOT NULL,
 destination_account_id integer NOT NULL,
 variance_account_id integer,
 book_balance numeric(28,6),
 variance_amount numeric(28,6),
 financial_document_id integer NOT NULL,
 idempotency_key uuid NOT NULL,
 request_payload jsonb NOT NULL,
 created_by integer NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,id),
 UNIQUE(company_id,idempotency_key),
 UNIQUE(company_id,financial_document_id),
 FOREIGN KEY(company_id,employee_id) REFERENCES employees(company_id,id),
 FOREIGN KEY(company_id,cash_account_id) REFERENCES accounts(company_id,id),
 FOREIGN KEY(company_id,destination_account_id) REFERENCES accounts(company_id,id),
 FOREIGN KEY(company_id,variance_account_id) REFERENCES accounts(company_id,id),
 FOREIGN KEY(company_id,financial_document_id) REFERENCES financial_documents(company_id,id),
 CHECK ((kind='pouch' AND amount<>0 AND variance_account_id IS NULL
    AND book_balance IS NULL AND variance_amount IS NULL) OR
   (kind='electronic' AND amount>0 AND variance_account_id IS NULL
    AND book_balance IS NULL AND variance_amount IS NULL) OR
   (kind='close' AND amount>=0 AND variance_account_id IS NOT NULL
    AND book_balance>=0 AND variance_amount=book_balance-amount))
);
CREATE INDEX employee_cashbox_operations_timeline
 ON employee_cashbox_operations(company_id,employee_id,created_at DESC,id DESC);
CREATE FUNCTION protect_employee_cashbox_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Employee cashbox operation history is immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER employee_cashbox_operations_immutable BEFORE UPDATE OR DELETE
 ON employee_cashbox_operations FOR EACH ROW EXECUTE FUNCTION protect_employee_cashbox_operation();
