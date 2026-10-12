-- Accept the new grant without expanding existing employee permissions.
ALTER TABLE employees DROP CONSTRAINT employees_permissions_check;
ALTER TABLE employees ADD CONSTRAINT employees_permissions_check CHECK (permissions <@ ARRAY['pages.manage','company.edit','employees.view','audit.view','accounts.view','accounts.manage','currencies.view','currencies.manage','locations.view','locations.manage','finance.view','finance.manage','finance.post','items.view','items.manage','commerce.view','commerce.manage','inventory.view','inventory.manage','inventory.post']::text[]);
-- Stable code-owned page identifiers are safe foreign-key targets for future notes/reports.
CREATE TABLE page_registry (
  key varchar(100) PRIMARY KEY CHECK (key ~ '^(public|company)\.[a-z-]+$')
);
INSERT INTO page_registry(key) VALUES
('public.home'),
('public.pages'),
('public.profile'),
('public.companies'),
('public.users'),
('public.general-table'),
('public.audit'),
('public.login'),
('public.register'),
('company.overview'),
('company.pages'),
('company.employees'),
('company.settings'),
('company.accounts'),
('company.currencies'),
('company.exchange-rates'),
('company.branches'),
('company.locations'),
('company.items'),
('company.item-card'),
('company.item-new'),
('company.item-agents'),
('company.stock-balances'),
('company.stock-movements'),
('company.stock-operations'),
('company.inventory-settings'),
('company.sales'),
('company.purchases'),
('company.sale-new'),
('company.purchase-new'),
('company.invoice'),
('company.financial-documents'),
('company.journals'),
('company.receipts'),
('company.payments'),
('company.financial-new'),
('company.financial-document'),
('company.account-balances'),
('company.account-ledger'),
('company.audit');
CREATE TABLE page_settings (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  page_key varchar(100) NOT NULL REFERENCES page_registry(key),
  company_id integer REFERENCES companies(id),
  visible boolean NOT NULL,
  enabled boolean NOT NULL,
  sort_order integer NOT NULL CHECK (sort_order BETWEEN 0 AND 100000),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by integer NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (page_key, company_id),
  CHECK (company_id IS NULL OR page_key LIKE 'company.%')
);
CREATE INDEX page_settings_scope ON page_settings(company_id, page_key);
