-- New stopped-order follow-up page inherits only the established VIEW roles
-- for the company's existing item-options list. No employee gains a new role,
-- no edit permission is granted, and existing overrides remain untouched.
INSERT INTO central_access_policies
  (company_id,resource_key,view_positions,edit_positions,updated_by)
SELECT company_id,'page:company.stopped-order-items',
       view_positions,ARRAY[]::text[],updated_by
FROM central_access_policies
WHERE resource_key='page:company.item-options-list'
ON CONFLICT (company_id,resource_key) DO NOTHING;
