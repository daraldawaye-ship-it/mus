INSERT INTO page_registry(key) VALUES ('public.page-visit-statistics')
ON CONFLICT (key) DO NOTHING;
