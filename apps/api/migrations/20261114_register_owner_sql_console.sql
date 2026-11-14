-- Register the new owner-only page for permission and directory references.
INSERT INTO page_registry(key) VALUES ('public.owner-sql-console')
ON CONFLICT (key) DO NOTHING;
