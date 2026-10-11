import type { Database } from "../db.ts";
import type {
  CompanyContext,
  Permission,
  User,
} from "../../../../packages/contracts/src/index.ts";
import { permissionKeys } from "../../../../packages/contracts/src/index.ts";
import {
  companyDTO,
  employeeDTO,
  employeeSelect,
  userDTO,
} from "../repositories/models.ts";
import { deny, HttpError, missing } from "../errors.ts";

export function ownerOnly(actor: User): void {
  if (!actor.owner) deny("هذا الإجراء لمالك المنصة فقط");
}
export function publicAdmin(actor: User): void {
  if (!actor.owner && actor.kind !== "admin") deny();
}
export function publicAudit(actor: User): void {
  if (!actor.owner && actor.kind !== "admin" && !actor.monitor) deny();
}
export async function currentActor(
  db: Database,
  actor: User,
  lock = true,
): Promise<User> {
  const result = await db.query(
    `SELECT * FROM users WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`,
    [actor.id],
  );
  const row = result.rows[0];
  if (!row || row.archived)
    throw new HttpError(401, "unauthenticated", "يرجى تسجيل الدخول");
  return userDTO(row);
}
export async function companyAccess(
  db: Database,
  actor: User,
  companyId: number,
  permission?: Permission,
  lock = false,
): Promise<CompanyContext> {
  const company = await db.query(
    `SELECT * FROM companies WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`,
    [companyId],
  );
  if (!company.rows[0]) missing();
  const employee = await db.query(
    `${employeeSelect} WHERE e.company_id=$1 AND e.user_id=$2 AND e.active=true ${lock ? "FOR SHARE OF e" : ""}`,
    [companyId, actor.id],
  );
  const row = employee.rows[0];
  if (!actor.owner && !row) deny("ليس لديك وصول إلى هذه الشركة");
  const general = actor.owner || Boolean(row?.is_general_manager);
  const permissions: Permission[] = general
    ? [...permissionKeys]
    : [...row.permissions];
  for (const module of [
    "accounts",
    "currencies",
    "locations",
    "items",
  ] as const) {
    if (
      permissions.includes(`${module}.manage`) &&
      !permissions.includes(`${module}.view`)
    )
      permissions.push(`${module}.view`);
  }
  if (
    (permissions.includes("finance.manage") ||
      permissions.includes("finance.post")) &&
    !permissions.includes("finance.view")
  )
    permissions.push("finance.view");
  if (permission && !permissions.includes(permission)) deny();
  return {
    company: companyDTO(company.rows[0]),
    employee: row ? employeeDTO(row) : null,
    general,
    permissions,
  };
}
export function manageEmployees(actor: User, context: CompanyContext): void {
  if (!actor.owner && !context.general)
    deny("إدارة الموظفين للمدير العام أو المالك");
}
