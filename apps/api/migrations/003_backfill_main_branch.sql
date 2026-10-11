-- One-time, additive backfill for companies created before automatic HQ provisioning.
-- A company that already has ANY branch is left completely unchanged.
-- The application's schema_migrations lock and transaction make this atomic.
DO $backfill$
DECLARE
  existing_company RECORD;
  new_branch RECORD;
  new_showroom RECORD;
BEGIN
  FOR existing_company IN
    SELECT c.id, c.phone, c.address, c.created_by
    FROM companies c
    WHERE NOT EXISTS (
      SELECT 1 FROM branches b WHERE b.company_id = c.id
    )
    ORDER BY c.id
  LOOP
    INSERT INTO branches(company_id, code, name, phone, address, active, created_by)
    VALUES (existing_company.id, 'HQ', 'الفرع الرئيسي',
            existing_company.phone, existing_company.address, true,
            existing_company.created_by)
    RETURNING * INTO new_branch;

    INSERT INTO locations(company_id, branch_id, code, name, kind, active, created_by)
    VALUES (existing_company.id, new_branch.id, 'SHOWROOM', 'المعرض',
            'showroom', true, existing_company.created_by)
    RETURNING * INTO new_showroom;

    -- Record migration actions as system actions, with canonical UI field names.
    INSERT INTO audit_events(
      actor_id, actor_name, scope, company_id, action, target_type,
      target_id, before_value, after_value
    )
    VALUES (
      NULL, 'النظام', 'company', existing_company.id, 'branch.create', 'branch',
      new_branch.id, NULL,
      jsonb_build_object(
        'id', new_branch.id, 'companyId', new_branch.company_id,
        'code', new_branch.code, 'name', new_branch.name,
        'phone', new_branch.phone, 'address', new_branch.address,
        'active', new_branch.active, 'createdBy', new_branch.created_by,
        'createdAt', new_branch.created_at
      )
    );

    INSERT INTO audit_events(
      actor_id, actor_name, scope, company_id, action, target_type,
      target_id, before_value, after_value
    )
    VALUES (
      NULL, 'النظام', 'company', existing_company.id, 'location.create', 'location',
      new_showroom.id, NULL,
      jsonb_build_object(
        'id', new_showroom.id, 'companyId', new_showroom.company_id,
        'branchId', new_showroom.branch_id,
        'code', new_showroom.code, 'name', new_showroom.name,
        'kind', new_showroom.kind, 'active', new_showroom.active,
        'branchName', new_branch.name, 'branchActive', new_branch.active,
        'effectiveActive', (new_showroom.active AND new_branch.active),
        'createdBy', new_showroom.created_by, 'createdAt', new_showroom.created_at
      )
    );
  END LOOP;
END
$backfill$;
