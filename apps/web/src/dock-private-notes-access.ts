import type { CompanyContext, User } from "../../../packages/contracts/src/index";

export function showWorkPanelPrivateNotes(
  user: User | null | undefined,
  context: CompanyContext | undefined,
  employeePreview: boolean,
): boolean {
  if (!user || user.suspended || user.archived || employeePreview) return false;
  if (user.owner) return true;
  const employee = context?.employee;
  return !!employee?.active &&
    (employee.positions.includes("sales") || employee.positions.includes("cashier"));
}
