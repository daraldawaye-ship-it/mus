-- Register the previously defined settlement-follow-up page in the persisted
-- page registry so per-position grants can be managed without hardcoded bypasses.
INSERT INTO page_registry(key)
VALUES ('company.settlement-follow-up')
ON CONFLICT (key) DO NOTHING;
