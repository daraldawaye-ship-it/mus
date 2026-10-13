INSERT INTO page_registry(key) VALUES ('company.wallet'),('company.reward-tasks');
INSERT INTO permission_definitions(key,page_key,action,name,rule_role,required_permissions) VALUES
 ('company.wallet:view','company.wallet','view','المحفظة والنقاط — عرض','company-member','{}'),
 ('company.wallet:create','company.wallet','create','المحفظة والنقاط — إضافة مكافأة','company-general','{}'),
 ('company.wallet:reverse','company.wallet','reverse','المحفظة والنقاط — عكس مكافأة','company-general','{}'),
 ('company.reward-tasks:view','company.reward-tasks','view','مهام المكافآت — عرض','company-general','{}'),
 ('company.reward-tasks:edit','company.reward-tasks','edit','مهام المكافآت — تعديل','company-general','{}');

-- The financial component is a zero-only scaffold until conversion/commission
-- policies are agreed. Points never imply a monetary exchange rate.
CREATE TABLE employee_wallets (
 company_id integer NOT NULL,
 employee_id integer NOT NULL,
 points numeric(28,0) NOT NULL DEFAULT 0 CHECK(points>=0),
 money numeric(28,6) NOT NULL DEFAULT 0 CHECK(money=0),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,employee_id),
 FOREIGN KEY(company_id,employee_id) REFERENCES employees(company_id,id)
);
INSERT INTO employee_wallets(company_id,employee_id) SELECT company_id,id FROM employees;

CREATE FUNCTION initialize_employee_wallet() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO employee_wallets(company_id,employee_id) VALUES(NEW.company_id,NEW.id);
 RETURN NEW;
END $$;
CREATE TRIGGER employee_wallet_init AFTER INSERT ON employees FOR EACH ROW EXECUTE FUNCTION initialize_employee_wallet();

CREATE TABLE employee_wallet_entries (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 company_id integer NOT NULL,
 employee_id integer NOT NULL,
 employee_name text NOT NULL,
 kind varchar(20) NOT NULL CHECK(kind IN('manual','reversal')),
 points numeric(28,0) NOT NULL,
 money numeric(28,6) NOT NULL DEFAULT 0 CHECK(money=0),
 reason varchar(500) NOT NULL CHECK(length(trim(reason))>0),
 reference_id integer,
 idempotency_key uuid NOT NULL,
 request_payload jsonb NOT NULL,
 created_by integer NOT NULL REFERENCES users(id),
 created_by_name text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,id),
 UNIQUE(company_id,idempotency_key),
 FOREIGN KEY(company_id,employee_id) REFERENCES employee_wallets(company_id,employee_id),
 FOREIGN KEY(company_id,reference_id) REFERENCES employee_wallet_entries(company_id,id),
 CHECK((kind='manual' AND points>0 AND reference_id IS NULL) OR (kind='reversal' AND points<0 AND reference_id IS NOT NULL))
);
CREATE UNIQUE INDEX employee_wallet_single_reversal ON employee_wallet_entries(company_id,reference_id) WHERE kind='reversal';
CREATE INDEX employee_wallet_history ON employee_wallet_entries(company_id,employee_id,created_at DESC,id DESC);

CREATE FUNCTION protect_wallet_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original employee_wallet_entries;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Wallet ledger is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.kind='reversal' THEN
  SELECT * INTO original FROM employee_wallet_entries WHERE company_id=NEW.company_id AND id=NEW.reference_id;
  IF NOT FOUND OR original.kind<>'manual' OR NEW.employee_id<>original.employee_id OR NEW.points<>-original.points OR NEW.money<>-original.money THEN
   RAISE EXCEPTION 'Reversal must exactly invert the original reward in the same wallet' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER wallet_history BEFORE INSERT OR UPDATE OR DELETE ON employee_wallet_entries FOR EACH ROW EXECUTE FUNCTION protect_wallet_history();

CREATE FUNCTION apply_wallet_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE employee_wallets SET points=points+NEW.points,updated_at=clock_timestamp() WHERE company_id=NEW.company_id AND employee_id=NEW.employee_id;
 RETURN NEW;
END $$;
CREATE TRIGGER wallet_balance_from_entry AFTER INSERT ON employee_wallet_entries FOR EACH ROW EXECUTE FUNCTION apply_wallet_entry();

CREATE FUNCTION protect_wallet_balance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Wallet balance/history cannot be deleted' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.points<>0 OR NEW.money<>0 THEN RAISE EXCEPTION 'A wallet starts at zero' USING ERRCODE='23514'; END IF;
 ELSIF pg_trigger_depth()<2 OR (to_jsonb(NEW)-ARRAY['points','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['points','updated_at']) THEN
  RAISE EXCEPTION 'Wallet balance changes only through immutable ledger entries' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER wallet_balance_protected BEFORE INSERT OR UPDATE OR DELETE ON employee_wallets FOR EACH ROW EXECUTE FUNCTION protect_wallet_balance();

CREATE TABLE reward_task_definitions (
 code varchar(100) PRIMARY KEY,
 name text NOT NULL,
 description text NOT NULL,
 implemented boolean NOT NULL DEFAULT false,
 default_points numeric(18,0) NOT NULL CHECK(default_points>=0),
 default_repeat_rule varchar(30) NOT NULL CHECK(default_repeat_rule IN('per-document','daily','rolling-seven-days','unlimited')),
 CHECK(NOT implemented)
);
INSERT INTO reward_task_definitions(code,name,description,default_points,default_repeat_rule) VALUES
 ('SALE_SAVED','حفظ فاتورة مبيعات','مكافأة نجاح حفظ فاتورة مبيعات جديدة. الربط الآلي في الدفعة التالية.',5,'per-document'),
 ('PURCHASE_SAVED','حفظ فاتورة مشتريات','مكافأة نجاح حفظ فاتورة مشتريات جديدة. الربط الآلي في الدفعة التالية.',10,'per-document'),
 ('SALE_LINES','سطور فاتورة المبيعات','عدد النقاط لكل سطر محفوظ بما فيه المردود. ضوابط تكرار الصنف وربط الحدث في الدفعة التالية.',2,'per-document'),
 ('PURCHASE_LINES','سطور فاتورة المشتريات','عدد النقاط لكل سطر محفوظ بما فيه المردود. القيمة تحتاج ضبط الإدارة قبل الربط الآلي.',0,'per-document'),
 ('RECEIPT_PRINT','طلب طباعة سند قبض','مكافأة طلب الطباعة، ولا تثبت خروج الورقة فعليًا. الربط الآلي في الدفعة التالية.',5,'per-document'),
 ('PAYMENT_PRINT','طلب طباعة سند صرف','مكافأة طلب الطباعة، ولا تثبت خروج الورقة فعليًا. الربط الآلي في الدفعة التالية.',5,'per-document'),
 ('DAILY_LOGIN','تسجيل الدخول اليومي','مكافأة الدخول مرة في اليوم داخل الشركة، بعد تثبيت سياسة نطاق الدخول في الدفعة التالية.',50,'daily'),
 ('PAGE_VISIT','زيارة صفحة','مكافأة زيارة صفحة مسجلة في دليل الصفحات. القيمة والصفحة تضبطهما الإدارة والربط الآلي لاحقًا.',0,'daily');

CREATE TABLE reward_task_settings (
 company_id integer NOT NULL REFERENCES companies(id),
 code varchar(100) NOT NULL REFERENCES reward_task_definitions(code),
 points numeric(18,0) NOT NULL CHECK(points>=0),
 repeat_rule varchar(30) NOT NULL CHECK(repeat_rule IN('per-document','daily','rolling-seven-days','unlimited')),
 enabled boolean NOT NULL DEFAULT false CHECK(NOT enabled),
 page_key varchar(100) REFERENCES page_registry(key),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_by integer NOT NULL REFERENCES users(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,code),
 CHECK(page_key IS NULL OR code='PAGE_VISIT')
);
CREATE TABLE reward_task_roles (
 company_id integer NOT NULL,
 code varchar(100) NOT NULL,
 role_id integer NOT NULL,
 PRIMARY KEY(company_id,code,role_id),
 FOREIGN KEY(company_id,code) REFERENCES reward_task_settings(company_id,code),
 FOREIGN KEY(company_id,role_id) REFERENCES company_roles(company_id,id)
);
CREATE FUNCTION protect_reward_task_setting() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.company_id<>OLD.company_id OR NEW.code<>OLD.code OR NEW.revision<>OLD.revision+1 THEN
  RAISE EXCEPTION 'Reward task identity is immutable and revision must advance' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reward_task_setting_revision BEFORE UPDATE OR DELETE ON reward_task_settings FOR EACH ROW EXECUTE FUNCTION protect_reward_task_setting();
