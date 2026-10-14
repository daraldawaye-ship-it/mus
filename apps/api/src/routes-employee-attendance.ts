import { Router, type Request } from "express";
import type { Pool, PoolClient } from "pg";
import { employeeAttendanceSettingsSchema } from "../../../packages/contracts/src/index.ts";
import { actor, handler, id, parse } from "./http.ts";
import { transaction } from "./db.ts";
import {
  companyAccess,
  currentActor,
  manageEmployees,
} from "./policies/access.ts";
import { deny, missing } from "./errors.ts";
import {
  assertDirectoryAccess,
  assertRequestPagesEnabled,
  directoryEntries,
} from "./services/pages.ts";
import {
  getAttendanceSettings,
  saveAttendanceSettings,
} from "./services/attendance-settings.ts";

async function access(client: PoolClient, req: Request, write = false) {
  const companyId = id(req.params.companyId);
  const employeeId = id(req.params.employeeId);
  const user = await currentActor(client, actor(req), write);
  const context = await companyAccess(
    client,
    user,
    companyId,
    undefined,
    write,
  );
  if (write) {
    manageEmployees(user, context);
    await assertRequestPagesEnabled(client, req, true);
  } else if (!context.general && context.employee?.id !== employeeId) {
    deny("يمكنك عرض إعدادات دوامك فقط");
  }
  const entries = await directoryEntries(client, user, companyId);
  assertDirectoryAccess(
    entries.find((entry) => entry.key === "company.attendance")!,
    write ? "edit" : "view",
  );
  if (write)
    assertDirectoryAccess(
      entries.find((entry) => entry.key === "company.employees")!,
      "edit",
    );
  // Management can prepare/reactivate an inactive employee's profile without
  // granting them attendance access. Other users still read only their active self.
  const employee = await client.query(
    `SELECT e.id FROM employees e JOIN users u ON u.id=e.user_id
     WHERE e.company_id=$1 AND e.id=$2 AND ($3::boolean OR (e.active AND NOT u.archived))
     ${write ? "FOR UPDATE OF e" : ""}`,
    [companyId, employeeId, context.general],
  );
  if (!employee.rowCount) missing("الموظف غير موجود أو غير فعال في هذه الشركة");
  return { companyId, employeeId, user };
}

export function employeeAttendanceRoutes(pool: Pool) {
  const router = Router();
  const base =
    "/companies/:companyId/employees/:employeeId/attendance-settings";
  router.get(
    base,
    handler(async (req, res) => {
      const settings = await transaction(pool, async (client) => {
        await client.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        const { companyId, employeeId } = await access(client, req);
        return getAttendanceSettings(client, companyId, employeeId);
      });
      res.json({ settings });
    }),
  );
  router.put(
    base,
    handler(async (req, res) => {
      const input = parse(employeeAttendanceSettingsSchema, req.body);
      const settings = await transaction(pool, async (client) => {
        const { companyId, employeeId, user } = await access(client, req, true);
        return saveAttendanceSettings(
          client,
          user,
          companyId,
          employeeId,
          input,
        );
      });
      res.json({ settings });
    }),
  );
  return router;
}
