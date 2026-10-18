ALTER TABLE accounts
 ADD COLUMN account_limit numeric(28,6) CHECK (account_limit >= 0),
 ADD COLUMN daily_limit numeric(28,6) CHECK (daily_limit >= 0),
 ADD COLUMN weekly_limit numeric(28,6) CHECK (weekly_limit >= 0),
 ADD COLUMN monthly_limit numeric(28,6) CHECK (monthly_limit >= 0),
 ADD COLUMN privacy_level smallint NOT NULL DEFAULT 1 CHECK (privacy_level BETWEEN 1 AND 5),
 ADD COLUMN last_approval_date date,
 ADD COLUMN goods_value_account_id integer,
 ADD COLUMN owner_phone text NOT NULL DEFAULT '',
 ADD COLUMN daily_default numeric(28,6) CHECK (daily_default >= 0),
 ADD COLUMN weekly_default numeric(28,6) CHECK (weekly_default >= 0),
 ADD COLUMN monthly_default numeric(28,6) CHECK (monthly_default >= 0),
 ADD CONSTRAINT accounts_goods_value_fk FOREIGN KEY (company_id,goods_value_account_id) REFERENCES accounts(company_id,id);
