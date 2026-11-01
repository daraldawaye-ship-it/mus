-- Register the two *navigable* read-only pages, not only their API routes.
-- The site catalog reads pageDefinitions, but page_registry is used by
-- page grants, settings and page-disabled checks.
INSERT INTO page_registry(key)
VALUES ('public.last-present'), ('company.attendance-current')
ON CONFLICT (key) DO NOTHING;
