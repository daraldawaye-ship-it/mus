-- Default operational accounting without posting unapproved payroll or valuing points.
-- All changes are company-scoped and additive: existing account codes, links,
-- wallet policies and historical postings are never rewritten.
ALTER TABLE account_links DROP CONSTRAINT account_links_purpose_check;
ALTER TABLE account_links ADD CONSTRAINT account_links_purpose_check CHECK (purpose IN (
  'salesRevenue','discountAllowed','discountEarned','inventory',
  'purchases','costOfGoodsSold','stockShortage','stockSurplus',
  'salaryExpense','salaryPayable','rewardExpense','rewardPayable',
  'commissionExpense','commissionPayable','allowanceExpense','allowancePayable',
  'overtimeExpense','operatingRentExpense','operatingUtilitiesExpense',
  'operatingMaintenanceExpense','operatingCommunicationsExpense'
));

CREATE FUNCTION ensure_company_operational_accounts(
  p_company_id integer, p_actor_id integer
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  seed record;
  parent_row accounts%ROWTYPE;
  existing_row accounts%ROWTYPE;
  created_account_id integer;
BEGIN
  -- The five original roots must have been initialized first. This also
  -- avoids silently replacing custom charts in older, uninitialized companies.
  IF NOT EXISTS (
    SELECT 1 FROM accounts WHERE company_id=p_company_id
      AND code='1000000000' AND kind='group' AND category='asset' AND active
  ) OR NOT EXISTS (
    SELECT 1 FROM accounts WHERE company_id=p_company_id
      AND code='2000000000' AND kind='group' AND category='liability' AND active
  ) OR NOT EXISTS (
    SELECT 1 FROM accounts WHERE company_id=p_company_id
      AND code='5000000000' AND kind='group' AND category='expense' AND active
  ) THEN
    RETURN;
  END IF;

  FOR seed IN
    SELECT * FROM (VALUES
      ('1113000000','الحوافظ','asset','group','1000000000','1113000001','1113999999',NULL),
      ('1140000000','سلف الموظفين','asset','group','1000000000','1140000001','1140999999',NULL),
      ('2120000000','مستحقات الموظفين','liability','group','2000000000','2120000001','2120999999',NULL),
      ('2120000001','الرواتب والأجور المستحقة','liability','posting','2120000000',NULL,NULL,'salaryPayable'),
      ('2120000002','مكافآت الموظفين المستحقة','liability','posting','2120000000',NULL,NULL,'rewardPayable'),
      ('2120000003','عمولات الموظفين المستحقة','liability','posting','2120000000',NULL,NULL,'commissionPayable'),
      ('2120000004','البدلات والمستحقات الأخرى للموظفين','liability','posting','2120000000',NULL,NULL,'allowancePayable'),
      ('5500000000','مصروفات شؤون الموظفين','expense','group','5000000000','5500000001','5500999999',NULL),
      ('5500000001','مصروف الرواتب والأجور','expense','posting','5500000000',NULL,NULL,'salaryExpense'),
      ('5500000002','مصروف مكافآت الموظفين','expense','posting','5500000000',NULL,NULL,'rewardExpense'),
      ('5500000003','مصروف عمولات التصريف','expense','posting','5500000000',NULL,NULL,'commissionExpense'),
      ('5500000004','مصروف بدلات الموظفين','expense','posting','5500000000',NULL,NULL,'allowanceExpense'),
      ('5500000005','مصروف الساعات الإضافية','expense','posting','5500000000',NULL,NULL,'overtimeExpense'),
      ('5600000000','مصروفات التشغيل والإدارة','expense','group','5000000000','5600000001','5600999999',NULL),
      ('5600000001','مصروف الإيجارات','expense','posting','5600000000',NULL,NULL,'operatingRentExpense'),
      ('5600000002','مصروف الكهرباء والمياه','expense','posting','5600000000',NULL,NULL,'operatingUtilitiesExpense'),
      ('5600000003','مصروف الصيانة','expense','posting','5600000000',NULL,NULL,'operatingMaintenanceExpense'),
      ('5600000004','مصروف الاتصالات والخدمات','expense','posting','5600000000',NULL,NULL,'operatingCommunicationsExpense')
    ) AS v(code,name,category,kind,parent_code,range_start,range_end,purpose)
  LOOP
    SELECT * INTO parent_row FROM accounts
     WHERE company_id=p_company_id AND code=seed.parent_code;
    IF NOT FOUND OR parent_row.kind<>'group'
      OR parent_row.category<>seed.category OR NOT parent_row.active THEN
      CONTINUE;
    END IF;
    created_account_id := NULL;
    INSERT INTO accounts(company_id,code,name,parent_id,kind,category,normal_side,
                         active,range_start,range_end,created_by,cash_or_bank,account_choice)
    VALUES(p_company_id,seed.code,seed.name,parent_row.id,seed.kind,seed.category,
           CASE WHEN seed.category IN ('asset','expense') THEN 'debit' ELSE 'credit' END,
           true,seed.range_start,seed.range_end,p_actor_id,false,
           CASE WHEN seed.kind='posting' AND seed.category='expense'
                THEN 'expense' ELSE 'administrative' END)
    ON CONFLICT(company_id,code) DO NOTHING
    RETURNING id INTO created_account_id;
    IF created_account_id IS NOT NULL THEN
      INSERT INTO option_values(company_id,definition_id,record_kind,account_id,
                                value,created_by,updated_by)
      SELECT o.company_id,o.id,'account',created_account_id,o.default_value,
             p_actor_id,p_actor_id
      FROM option_definitions o
      WHERE o.company_id=p_company_id AND o.record_kind='account'
        AND o.active=true AND o.native_binding IS NULL
        AND o.default_value<>'null'::jsonb;
    END IF;

    IF seed.purpose IS NOT NULL THEN
      -- Only bind a compatible posting account; collisions remain untouched.
      SELECT * INTO existing_row FROM accounts
       WHERE company_id=p_company_id AND code=seed.code;
      IF FOUND AND existing_row.kind='posting'
        AND existing_row.category=seed.category AND existing_row.active
        AND existing_row.parent_id=parent_row.id THEN
        INSERT INTO account_links(company_id,purpose,account_id)
        VALUES(p_company_id,seed.purpose,existing_row.id)
        ON CONFLICT(company_id,purpose) DO NOTHING;
      END IF;
    END IF;
  END LOOP;

  -- Prepare a valid expense destination for future point conversions.
  -- Do not invent a point exchange value or authorization mode, and never
  -- override any wallet policy a company already configured.
  INSERT INTO wallet_conversion_policies(
    company_id,point_value,currency_id,expense_account_id,approval_mode,updated_by
  )
  SELECT p_company_id,NULL,f.base_currency_id,a.id,NULL,p_actor_id
    FROM finance_settings f
    JOIN accounts a ON a.company_id=f.company_id AND a.code='5500000002'
      AND a.kind='posting' AND a.category='expense' AND a.active
    WHERE f.company_id=p_company_id
  ON CONFLICT(company_id) DO NOTHING;
END $$;

-- Companies that already have an initialized chart receive missing defaults.
-- Companies with uninitialized or conflicting charts remain unchanged.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT id,created_by FROM companies LOOP
    PERFORM ensure_company_operational_accounts(c.id,c.created_by);
  END LOOP;
END $$;
