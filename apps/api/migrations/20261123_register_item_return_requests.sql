INSERT INTO page_registry(key) VALUES ('company.item-return-requests')
ON CONFLICT (key) DO NOTHING;
