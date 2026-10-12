-- Register management page without changing existing employee grants or data.
INSERT INTO page_registry(key) VALUES('company.configuration')
ON CONFLICT(key) DO NOTHING;
INSERT INTO permission_definitions(key,page_key,action,name,rule_role,required_permissions)
VALUES
('company.configuration:view','company.configuration','view','الخيارات والصلاحيات — عرض','permissions',ARRAY['pages.manage']::text[]),
('company.configuration:edit','company.configuration','edit','الخيارات والصلاحيات — تعديل','permissions',ARRAY['pages.manage']::text[])
ON CONFLICT(key) DO NOTHING;
