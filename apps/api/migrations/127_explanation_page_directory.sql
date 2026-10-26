-- Register reader, editor, and owner-only access management in the central pages directory.
INSERT INTO page_registry(key) VALUES
 ('public.explanations-reader'),
 ('public.explanations-editor'),
 ('public.explanations-access')
ON CONFLICT DO NOTHING;
