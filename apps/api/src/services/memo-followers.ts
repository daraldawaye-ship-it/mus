// Scoped memo-view predicate. Employee roles include both current named-role
// assignments and the active legacy employee classification.
export function memoFollowerSql(memoAlias: string, employeeParameter: string) {
  return `EXISTS(
    SELECT 1 FROM memo_followers mf
    WHERE mf.company_id=${memoAlias}.company_id AND mf.memo_id=${memoAlias}.id
      AND (
        mf.employee_id=${employeeParameter}::integer
        OR (mf.role_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM company_roles cr
          JOIN employees me ON me.company_id=cr.company_id AND me.id=${employeeParameter}::integer AND me.active
          WHERE cr.company_id=mf.company_id AND cr.id=mf.role_id AND cr.active
            AND (me.role=cr.key OR EXISTS (
              SELECT 1 FROM employee_role_assignments era
              WHERE era.company_id=cr.company_id AND era.role_id=cr.id
                AND era.employee_id=me.id AND era.active
            ))
        ))
      )
  )`;
}
