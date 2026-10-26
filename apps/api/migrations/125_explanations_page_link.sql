-- Link the initial explanation collection to the existing legal cases workspace.
INSERT INTO explanation_links(group_id,node_id,target_type,target_key)
SELECT id,NULL,'page','public.legal-cases'
FROM explanation_groups WHERE slug='mustafa-cases'
AND NOT EXISTS (
 SELECT 1 FROM explanation_links l
 WHERE l.group_id=explanation_groups.id AND l.node_id IS NULL
 AND l.target_type='page' AND l.target_key='public.legal-cases'
);
