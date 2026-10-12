-- Add missing operational settings; preserve every established company mapping.
CREATE FUNCTION initialize_company_inventory_settings(target_company integer, creator integer)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  setting record; picked integer; parent integer; picked_code text;
  used integer[] := ARRAY[]::integer[]; prefix bigint; created_account jsonb;
  previous_link jsonb; changed_link jsonb; created_settings jsonb;
BEGIN
  PERFORM id FROM companies WHERE id=target_company FOR UPDATE;
  IF EXISTS(SELECT 1 FROM inventory_settings WHERE company_id=target_company) THEN RETURN false; END IF;
  FOR setting IN SELECT * FROM (VALUES
    ('inventory','asset','debit','1130000001','1130000000','حساب المخزون'),
    ('salesRevenue','income','credit','4100000001','4000000000','إيراد المبيعات'),
    ('costOfGoodsSold','expense','debit','5300000001','5000000000','تكلفة المبيعات'),
    ('stockSurplus','income','credit','4300000001','4000000000','فائض المخزون'),
    ('stockShortage','expense','debit','5400000001','5000000000','عجز المخزون')
  ) AS defaults(purpose,category,normal_side,code,parent_code,name) LOOP
    SELECT a.id INTO picked FROM account_links l JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id
      WHERE l.company_id=target_company AND l.purpose=setting.purpose AND a.active AND a.kind='posting'
      AND a.category=setting.category AND a.id<>ALL(used);
    IF picked IS NULL THEN
      SELECT id INTO picked FROM accounts WHERE company_id=target_company AND code=setting.code
        AND active AND kind='posting' AND category=setting.category AND id<>ALL(used);
    END IF;
    IF picked IS NULL THEN
      picked_code:=setting.code;
      IF EXISTS(SELECT 1 FROM accounts WHERE company_id=target_company AND code=picked_code) THEN
        prefix:=CASE setting.category WHEN 'asset' THEN 1 WHEN 'income' THEN 4 ELSE 5 END;
        SELECT (COALESCE(max(code::bigint),prefix*1000000000)+1)::text INTO picked_code
          FROM accounts WHERE company_id=target_company AND code::bigint BETWEEN prefix*1000000000 AND (prefix+1)*1000000000-1;
        IF picked_code::bigint >= (prefix+1)*1000000000 THEN RAISE EXCEPTION 'Account code range exhausted'; END IF;
      END IF;
      SELECT id INTO parent FROM accounts WHERE company_id=target_company AND code=setting.parent_code AND active AND kind='group' AND category=setting.category;
      INSERT INTO accounts(company_id,code,name,parent_id,kind,category,normal_side,active,created_by)
        VALUES(target_company,picked_code,setting.name,parent,'posting',setting.category,setting.normal_side,true,creator)
        RETURNING id,to_jsonb(accounts) INTO picked,created_account;
      INSERT INTO audit_events(actor_name,scope,company_id,action,target_type,target_id,after_value)
        VALUES('النظام','company',target_company,'account.create','account',picked,created_account);
    END IF;
    used:=array_append(used,picked);
    SELECT to_jsonb(l) INTO previous_link FROM account_links l WHERE company_id=target_company AND purpose=setting.purpose;
    INSERT INTO account_links(company_id,purpose,account_id) VALUES(target_company,setting.purpose,picked)
      ON CONFLICT(company_id,purpose) DO UPDATE SET account_id=EXCLUDED.account_id WHERE account_links.account_id IS NULL
      RETURNING to_jsonb(account_links) INTO changed_link;
    IF changed_link IS NOT NULL THEN
      INSERT INTO audit_events(actor_name,scope,company_id,action,target_type,before_value,after_value)
        VALUES('النظام','company',target_company,'accountLink.update','accountLink',previous_link,changed_link);
    END IF;
  END LOOP;
  INSERT INTO inventory_settings(company_id,inventory_account_id,sales_account_id,cogs_account_id,surplus_account_id,shortage_account_id,costing_method,allow_negative,updated_by)
    VALUES(target_company,used[1],used[2],used[3],used[4],used[5],'weighted_average',false,creator)
    RETURNING to_jsonb(inventory_settings) INTO created_settings;
  INSERT INTO audit_events(actor_name,scope,company_id,action,target_type,target_id,after_value)
    VALUES('النظام','company',target_company,'inventory.settings','inventorySettings',target_company,created_settings);
  RETURN true;
END $$;

SELECT initialize_company_inventory_settings(id,created_by) FROM companies ORDER BY id;
