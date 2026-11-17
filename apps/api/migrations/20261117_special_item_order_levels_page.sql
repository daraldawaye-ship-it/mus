-- Dedicated read-only follow-up page for configured special item reorder limits.
INSERT INTO page_registry(key) VALUES ('company.item-order-levels')
ON CONFLICT (key) DO NOTHING;

-- Existing alert links are just navigation metadata: preserve event keys,
-- recipients, notification states and immutable history while opening the
-- report for the exact item mentioned in the incident.
UPDATE notifications
SET href='/companies/'||company_id::text||'/item-order-levels?itemId='||
  substring(subject_key from '^item:([0-9]+)'),
    updated_at=clock_timestamp()
WHERE code='ITEM_ORDER_LEVEL'
  AND company_id IS NOT NULL
  AND subject_key ~ '^item:[0-9]+(:|$)'
  AND href IS DISTINCT FROM '/companies/'||company_id::text||
    '/item-order-levels?itemId='||substring(subject_key from '^item:([0-9]+)');
