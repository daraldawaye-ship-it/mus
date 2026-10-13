INSERT INTO page_registry(key) VALUES('company.wallet-settings');
INSERT INTO permission_definitions(key,page_key,action,name,rule_role,required_permissions) VALUES
 ('company.wallet-settings:view','company.wallet-settings','view','إعدادات المحفظة — عرض','company-general','{}'),
 ('company.wallet-settings:edit','company.wallet-settings','edit','إعدادات المحفظة — تعديل','company-general','{}');

-- Explicit configuration only. No default financial value, approval policy,
-- account creation, balance mutation or conversion execution is implied.
CREATE TABLE wallet_conversion_policies (
 company_id integer PRIMARY KEY REFERENCES companies(id),
 point_value numeric(28,12) CHECK(point_value>0),
 currency_id integer,
 expense_account_id integer,
 approval_mode varchar(10) CHECK(approval_mode IN('direct','approval')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_by integer NOT NULL REFERENCES users(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(company_id,currency_id) REFERENCES company_currencies(company_id,id),
 FOREIGN KEY(company_id,expense_account_id) REFERENCES accounts(company_id,id)
);
CREATE TABLE employee_wallet_accounts (
 company_id integer NOT NULL,
 employee_id integer NOT NULL,
 account_id integer,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_by integer NOT NULL REFERENCES users(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,employee_id),
 FOREIGN KEY(company_id,employee_id) REFERENCES employees(company_id,id),
 FOREIGN KEY(company_id,account_id) REFERENCES accounts(company_id,id)
);
CREATE INDEX employee_wallet_accounts_account ON employee_wallet_accounts(company_id,account_id) WHERE account_id IS NOT NULL;

CREATE FUNCTION protect_wallet_conversion_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'Wallet policy is retained; clear its configuration with a revisioned update' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND (NEW.company_id<>OLD.company_id OR NEW.revision<>OLD.revision+1) THEN
  RAISE EXCEPTION 'Wallet policy company is immutable and revision must advance' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER wallet_conversion_policy_revision BEFORE UPDATE OR DELETE ON wallet_conversion_policies FOR EACH ROW EXECUTE FUNCTION protect_wallet_conversion_policy();

CREATE FUNCTION protect_employee_wallet_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'Wallet account binding is retained; clear it with a revisioned update' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND (ROW(NEW.company_id,NEW.employee_id) IS DISTINCT FROM ROW(OLD.company_id,OLD.employee_id) OR NEW.revision<>OLD.revision+1) THEN
  RAISE EXCEPTION 'Wallet account identity is immutable and revision must advance' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER employee_wallet_account_revision BEFORE UPDATE OR DELETE ON employee_wallet_accounts FOR EACH ROW EXECUTE FUNCTION protect_employee_wallet_account();
