import { Router } from "express";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { transaction } from "./db.ts";
import { HttpError } from "./errors.ts";
import { actor, handler, id, parse } from "./http.ts";
import { companyAccess, currentActor } from "./policies/access.ts";
import { audit } from "./services/audit.ts";
import { assertRequestPagesEnabled } from "./services/pages.ts";
import { controlByKey, controlCatalog, validControlValue } from "./services/control-catalog.ts";

const valueInput = z.object({
  employeeId: z.number().int().positive().nullable().default(null),
  value: z.union([z.boolean(), z.number().int(), z.null()]),
  revision: z.number().int().positive().nullable(),
}).strict();
const policyInput = z.object({
  accountantAllowed: z.boolean(),
  employeeIds: z.array(z.number().int().positive()).max(100),
  revision: z.number().int().positive().nullable(),
}).strict();
const fail = (status: number, code: string, message: string): never => {
  throw new HttpError(status, code, message);
};
const changed = () => fail(409, "conflict", "تغيّرت الإعدادات منذ فتحها؛ أعد تحميل الصفحة.");
async function employeeAt(client: PoolClient, companyId: number, employeeId: number) {
  const found = await client.query(
    "SELECT id,role,user_id FROM employees WHERE company_id=$1 AND id=$2 AND active",
    [companyId, employeeId],
  );
  if (!found.rows[0]) fail(400, "invalid_employee", "الموظف غير فعال أو لا يتبع الشركة.");
  return found.rows[0] as { id: number; role: string; user_id: number };
}
function sameRevision(actual: number | null, expected: number | null) {
  if (actual !== expected) changed();
}
export function controlRoutes(pool: Pool): Router {
  const router = Router();
  router.get("/companies/:companyId/control", handler(async (req, res) => {
    const companyId = id(req.params.companyId);
    const result = await transaction(pool, async client => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const user = await currentActor(client, actor(req), false);
      const context = await companyAccess(client, user, companyId);
      const requested = req.query.employeeId === undefined ? null :
        id(typeof req.query.employeeId === "string" ? req.query.employeeId : undefined);
      const employeeId = requested ?? context.employee?.id ?? null;
      if (employeeId) {
        const target = await employeeAt(client, companyId, employeeId);
        if (!user.owner && target.user_id !== user.id)
          fail(403, "forbidden", "لا يمكن عرض كنترول موظف آخر.");
      }
      const [stored, policies, grants, employees] = await Promise.all([
        client.query("SELECT id,control_key,employee_id,value,revision FROM company_control_values WHERE company_id=$1", [companyId]),
        client.query("SELECT id,control_key,accountant_allowed,revision FROM company_control_policies WHERE company_id=$1", [companyId]),
        client.query("SELECT control_key,employee_id FROM company_control_editor_grants WHERE company_id=$1", [companyId]),
        user.owner ? client.query("SELECT id,name,role FROM employees WHERE company_id=$1 AND active ORDER BY name,id", [companyId]) : Promise.resolve({rows: []}),
      ]);
      const options = controlCatalog.map(option => {
        const subject = option.scope === "employee" ? employeeId : null;
        const entry = stored.rows.find(row =>
          row.control_key === option.key && row.employee_id === subject);
        const policy = policies.rows.find(row => row.control_key === option.key);
        const accountantAllowed = policy?.accountant_allowed ?? !!option.accountantDefault;
        const editorIds = grants.rows.filter(row => row.control_key === option.key).map(row => row.employee_id as number);
        const allowed = !!context.employee &&
          ((context.employee.role === "accountant" && accountantAllowed) ||
           editorIds.includes(context.employee.id));
        return {
          ...option,
          value: entry?.value ?? option.defaultValue,
          revision: entry?.revision ?? null,
          canEdit: user.owner || (allowed && (option.scope === "company" || subject === context.employee?.id)),
          policy: user.owner ? {
            accountantAllowed,
            employeeIds: editorIds,
            revision: policy?.revision ?? null,
          } : null,
        };
      });
      return { companyId, employeeId, owner: user.owner, employees: employees.rows, options };
    });
    res.json(result);
  }));

  router.put("/companies/:companyId/control/:key", handler(async (req, res) => {
    const companyId = id(req.params.companyId);
    const key = typeof req.params.key === "string" ? req.params.key : "";
    const option = controlByKey(key);
    if (!option) fail(404, "not_found", "الخيار غير معروف.");
    const input = parse(valueInput, req.body);
    if (input.value !== null && !validControlValue(option!, input.value))
      fail(400, "invalid_control", "القيمة خارج نطاق هذا الخيار.");
    if (option!.scope === "company" && input.employeeId !== null)
      fail(400, "invalid_scope", "الخيار خاص بالشركة.");
    if (option!.scope === "employee" && input.employeeId === null)
      fail(400, "invalid_scope", "اختر الموظف لهذا الخيار.");
    const result = await transaction(pool, async client => {
      const user = await currentActor(client, actor(req));
      const context = await companyAccess(client, user, companyId, undefined, true);
      await assertRequestPagesEnabled(client, req, true);
      if (input.employeeId) await employeeAt(client, companyId, input.employeeId);
      const policy = await client.query(
        "SELECT accountant_allowed FROM company_control_policies WHERE company_id=$1 AND control_key=$2",
        [companyId, key],
      );
      const grant = context.employee
        ? await client.query(
          "SELECT 1 FROM company_control_editor_grants WHERE company_id=$1 AND control_key=$2 AND employee_id=$3",
          [companyId, key, context.employee.id],
        )
        : {rowCount: 0};
      const canEdit = user.owner || (!!context.employee &&
        (context.employee.role === "accountant" &&
          (policy.rows[0]?.accountant_allowed ?? !!option!.accountantDefault) || !!grant.rowCount) &&
        (option!.scope === "company" || input.employeeId === context.employee.id));
      if (!canEdit) fail(403, "forbidden", "لم يمنحك المالك صلاحية تعديل هذا الخيار.");
      const current = await client.query(
        "SELECT * FROM company_control_values WHERE company_id=$1 AND control_key=$2 AND employee_id IS NOT DISTINCT FROM $3::integer FOR UPDATE",
        [companyId, key, input.employeeId],
      );
      const previous = current.rows[0];
      sameRevision(previous?.revision ?? null, input.revision);
      let row = null;
      if (input.value === null) {
        if (previous) await client.query("DELETE FROM company_control_values WHERE id=$1", [previous.id]);
      } else if (previous) {
        const saved = await client.query(
          "UPDATE company_control_values SET value=$1::jsonb,revision=revision+1,updated_by=$2,updated_at=now() WHERE id=$3 RETURNING *",
          [JSON.stringify(input.value), user.id, previous.id],
        );
        row = saved.rows[0];
      } else {
        const saved = await client.query(
          "INSERT INTO company_control_values(company_id,control_key,employee_id,value,updated_by) VALUES($1,$2,$3,$4::jsonb,$5) RETURNING *",
          [companyId, key, input.employeeId, JSON.stringify(input.value), user.id],
        );
        row = saved.rows[0];
      }
      await audit(client, user, "control.value", "company-control-value",
        row?.id ?? previous?.id ?? null,
        previous ? {key,employeeId:input.employeeId,value:previous.value,revision:previous.revision} : null,
        row ? {key,employeeId:input.employeeId,value:row.value,revision:row.revision} : null,
        companyId);
      return {key,value:row?.value ?? option!.defaultValue,revision:row?.revision ?? null};
    });
    res.json(result);
  }));

  router.put("/companies/:companyId/control/:key/policy", handler(async (req, res) => {
    const companyId = id(req.params.companyId);
    const key = typeof req.params.key === "string" ? req.params.key : "";
    const option = controlByKey(key);
    if (!option) fail(404, "not_found", "الخيار غير معروف.");
    const input = parse(policyInput, req.body);
    if (new Set(input.employeeIds).size !== input.employeeIds.length)
      fail(400,"invalid_grants","تكرر الموظف ضمن التفويض.");
    const result = await transaction(pool, async client => {
      const user = await currentActor(client, actor(req));
      await companyAccess(client, user, companyId, undefined, true);
      await assertRequestPagesEnabled(client, req, true);
      if (!user.owner) fail(403, "forbidden", "المالك فقط يحدد المفوضين بتعديل الخيارات.");
      for (const employeeId of input.employeeIds)
        await employeeAt(client, companyId, employeeId);
      const old = await client.query(
        "SELECT * FROM company_control_policies WHERE company_id=$1 AND control_key=$2 FOR UPDATE",
        [companyId, key],
      );
      const beforeGrants = await client.query(
        "SELECT employee_id FROM company_control_editor_grants WHERE company_id=$1 AND control_key=$2 ORDER BY employee_id",
        [companyId, key],
      );
      const previous = old.rows[0];
      sameRevision(previous?.revision ?? null, input.revision);
      const saved = previous
        ? await client.query(
            "UPDATE company_control_policies SET accountant_allowed=$1,revision=revision+1,updated_by=$2,updated_at=now() WHERE id=$3 RETURNING *",
            [input.accountantAllowed,user.id,previous.id],
          )
        : await client.query(
            "INSERT INTO company_control_policies(company_id,control_key,accountant_allowed,updated_by) VALUES($1,$2,$3,$4) RETURNING *",
            [companyId,key,input.accountantAllowed,user.id],
          );
      await client.query(
        "DELETE FROM company_control_editor_grants WHERE company_id=$1 AND control_key=$2",
        [companyId,key],
      );
      for (const employeeId of input.employeeIds)
        await client.query(
          "INSERT INTO company_control_editor_grants(company_id,control_key,employee_id,granted_by) VALUES($1,$2,$3,$4)",
          [companyId,key,employeeId,user.id],
        );
      const record = saved.rows[0];
      await audit(client,user,"control.policy","company-control-policy",record.id,
        {key,accountantAllowed:previous?.accountant_allowed ?? !!option!.accountantDefault,
          employeeIds:beforeGrants.rows.map(row=>row.employee_id),revision:previous?.revision ?? null},
        {key,accountantAllowed:input.accountantAllowed,employeeIds:input.employeeIds,
          revision:record.revision},companyId);
      return {key,accountantAllowed:input.accountantAllowed,
        employeeIds:input.employeeIds,revision:record.revision};
    });
    res.json(result);
  }));
  return router;
}
