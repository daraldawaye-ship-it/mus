-- One-time additive currency backfill. Existing currency attributes, IDs, rates,
-- financial documents and established base currencies are not modified.
-- The app applies migrations in a schema-locked transaction.
DO $backfill$
DECLARE
  company_row RECORD;
  before_currencies jsonb;
  after_currencies jsonb;
  before_settings jsonb;
  after_settings jsonb;
  candidate_base_id integer;
BEGIN
  FOR company_row IN SELECT id, created_by FROM companies ORDER BY id LOOP
    SELECT COALESCE(jsonb_agg(to_jsonb(cur) ORDER BY cur.id), '[]'::jsonb)
      INTO before_currencies
      FROM company_currencies cur WHERE cur.company_id = company_row.id;
    SELECT to_jsonb(fs) INTO before_settings
      FROM finance_settings fs WHERE fs.company_id = company_row.id;

    INSERT INTO company_currencies (
      company_id, code, name, decimal_places, active, created_by
    )
    SELECT company_row.id, defaults.code, defaults.name, 2, true, company_row.created_by
    FROM (VALUES
      ('YER', 'ريال يمني'),
      ('SAR', 'ريال سعودي'),
      ('USD', 'دولار أمريكي')
    ) AS defaults(code, name)
    ON CONFLICT (company_id, code) DO NOTHING;

    -- Select YER as the default only if no base exists, respecting a
    -- previously deactivated YER and allowing another active currency instead.
    SELECT cur.id INTO candidate_base_id
      FROM company_currencies cur
      WHERE cur.company_id = company_row.id AND cur.active
      ORDER BY CASE WHEN cur.code = 'YER' THEN 0 ELSE 1 END, cur.id
      LIMIT 1;
    IF candidate_base_id IS NOT NULL THEN
      INSERT INTO finance_settings(company_id, base_currency_id)
      VALUES (company_row.id, candidate_base_id)
      ON CONFLICT (company_id) DO NOTHING;
    END IF;

    SELECT COALESCE(jsonb_agg(to_jsonb(cur) ORDER BY cur.id), '[]'::jsonb)
      INTO after_currencies
      FROM company_currencies cur WHERE cur.company_id = company_row.id;
    SELECT to_jsonb(fs) INTO after_settings
      FROM finance_settings fs WHERE fs.company_id = company_row.id;

    IF before_currencies IS DISTINCT FROM after_currencies
       OR before_settings IS DISTINCT FROM after_settings THEN
      INSERT INTO audit_events (
        actor_id, actor_name, scope, company_id, action,
        target_type, target_id, before_value, after_value
      ) VALUES (
        NULL, 'النظام', 'company', company_row.id,
        'currencies.initialize', 'financeSettings', company_row.id,
        jsonb_build_object('currencies', before_currencies, 'settings', before_settings),
        jsonb_build_object('currencies', after_currencies, 'settings', after_settings)
      );
    END IF;
  END LOOP;
END
$backfill$;
