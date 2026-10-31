-- Register the previously published item options page in the real page
-- registry so its per-position page grants can be saved through admin UI/API.
-- Do NOT grant access in code or seed a role: user-managed grants are made
-- separately through PUT /page-catalog/:pageKey/grants.
INSERT INTO page_registry(key) VALUES ('company.item-options-list')
ON CONFLICT(key) DO NOTHING;
