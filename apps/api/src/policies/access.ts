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
import {
  permissionRequest,
  permissionRuleEffects,
  requestPermissionTargets,
  requirementForAction,
} from "../services/permission-rules.ts";

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
  // Deferred/rebuilding runs have incomplete caches. Nondeferred runs retain
  // normal company access, permissions and transaction locks. Only
  // the owner-controlled run/status transactions carry this local context.
  const importing = await db.query(`SELECT 1 FROM legacy_import_runs
    WHERE company_id=$1 AND status<>'completed'
      AND (defer_projections OR status='rebuilding')
      AND idempotency_key::text IS DISTINCT FROM current_setting('alraesy.legacy_import_run',true)
    LIMIT 1`,[companyId]);
  if(importing.rowCount)
    throw new HttpError(409,"import_in_progress","الشركة في وضع ترحيل جماعي؛ تُستأنف العمليات بعد إكمال حساب المخزون والأرصدة.");
  const general = actor.owner || Boolean(row?.is_general_manager);
  // Keep the old employee grants as the base. Rule assignments never touch
  // employees.permissions and never extend another company's permissions.
  const legacy: Permission[] = general
    ? [...permissionKeys]
    : [...row.permissions];
  // "أمين صندوق" is an employee position, not a general financial role.
  // It grants only visibility into the employee's own linked sales cashbox.
  // Voucher creation/posting remain independently controlled by finance grants.
  if (!general && row && (row.position_keys ?? []).includes("cashier") &&
      !legacy.includes("finance.own-cashbox.view")) {
    legacy.push("finance.own-cashbox.view");
  }
  for (const module of [
    "accounts",
    "currencies",
    "locations",
    "items",
    "commerce",
    "inventory",
  ] as const) {
    if (
      legacy.includes(`${module}.manage`) &&
      !legacy.includes(`${module}.view`)
    )
      legacy.push(`${module}.view`);
  }
  if (legacy.includes("inventory.post") && !legacy.includes("inventory.view"))
    legacy.push("inventory.view");
  if (
    (legacy.includes("finance.manage") || legacy.includes("finance.post")) &&
    !legacy.includes("finance.view")
  )
    legacy.push("finance.view");
  const effects =
    !general && row
      ? await permissionRuleEffects(db, companyId, row.id)
      : new Map<string, "allow" | "deny">();
  const targets = general
    ? []
    : await requestPermissionTargets(
        db,
        permissionRequest.getStore(),
        companyId,
        permission,
      );
  if (targets.flat().some((key) => effects.get(key) === "deny"))
    deny("هذا الإجراء ممنوع صراحةً ضمن صلاحيات الشركة.");
  const explicitGrant =
    !!permission &&
    targets.length > 0 &&
    targets.every((group) =>
      group.some(
        (key) =>
          effects.get(key) === "allow" &&
          requirementForAction(key).includes(permission),
      ),
    );
  const permissions: Permission[] = [...legacy];
  // Context is a navigation hint only. Server authorization below checks
  // the exact request action; a grant on edit cannot grant create or post.
  for (const [key, effect] of effects) {
    if (effect !== "allow") continue;
    for (const granted of requirementForAction(key))
      if (!permissions.includes(granted)) permissions.push(granted);
  }
  for (const module of [
    "accounts",
    "currencies",
    "locations",
    "items",
    "commerce",
    "inventory",
  ] as const) {
    if (
      permissions.includes(`${module}.manage`) &&
      !permissions.includes(`${module}.view`)
    )
      permissions.push(`${module}.view`);
  }
  if (
    permissions.includes("inventory.post") &&
    !permissions.includes("inventory.view")
  )
    permissions.push("inventory.view");
  if (
    (permissions.includes("finance.manage") ||
      permissions.includes("finance.post")) &&
    !permissions.includes("finance.view")
  )
    permissions.push("finance.view");
  if (permission && !legacy.includes(permission) && !explicitGrant) deny();
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
