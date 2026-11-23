// This shortcut is scoped to Dar Aldawa; it does not grant access to the report.
export function canSubmitStaffWorkPanelPublicRequest(
  companyId: number | null | undefined,
  user: { owner: boolean; suspended: boolean; archived: boolean },
  employee: { active: boolean; positions: readonly string[] } | null | undefined,
): boolean {
  return companyId === 2 && !user.owner && !user.suspended && !user.archived &&
    !!employee?.active && employee.positions.some(position => position === "sales" || position === "cashier");
}
