-- Dedicated navigable report; its data remains read-only and subject to existing item/invoice permissions.
INSERT INTO page_registry(key) VALUES ('company.purchase-comparison')
ON CONFLICT (key) DO NOTHING;
