-- Independent navigation entry; editing the image remains owner-only in
-- /companies/:companyId/letterhead and the media-upload endpoint.
-- Existing company.edit grants are unchanged.
INSERT INTO page_registry(key) VALUES ('company.letterhead')
ON CONFLICT DO NOTHING;
INSERT INTO permission_definitions (
  key, page_key, action, name, rule_role, required_permissions
) VALUES (
  'company.letterhead:view',
  'company.letterhead',
  'view',
  'ترويسة الشركة — عرض',
  'company-member',
  ARRAY[]::text[]
) ON CONFLICT (key) DO NOTHING;
