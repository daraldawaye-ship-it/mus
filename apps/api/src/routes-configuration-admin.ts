import { Router } from "express";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { z } from "zod";
import {
  pageByKey,
  optionValueTypes,
  optionValueError,
  type OptionValueType,
} from "../../../packages/contracts/src/index.ts";
import { transaction } from "./db.ts";
import { actor, handler, id, parse } from "./http.ts";
import { HttpError, missing } from "./errors.ts";
import { companyAccess, currentActor } from "./policies/access.ts";
import { audit } from "./services/audit.ts";
import { assertRequestPagesEnabled } from "./services/pages.ts";

const key = z.string().regex(/^[a-z][a-z0-9_.-]{0,99}$/);
const recordKind = z.enum([
  "item",
  "account",
  "employee",
  "invoice",
  "financial-document",
]);
const scalar = z.union([z.boolean(), z.string().max(2000), z.null()]);
const choice = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_-]{0,59}$/),
    label: z.string().trim().min(1).max(120),
  })
  .strict();
const optionInput = z
  .object({
    key,
    pageKey: z.string().max(100),
    recordKind,
    name: z.string().trim().min(1).max(120),
    description: z.string().max(1000).default(""),
    valueType: z.enum(optionValueTypes),
    defaultValue: scalar.default(null),
    choices: z.array(choice).max(100).default([]),
    required: z.boolean().default(false),
    searchable: z.boolean().default(false),
    showOnCard: z.boolean().default(true),
    showInList: z.boolean().default(false),
    sortOrder: z.number().int().min(0).max(100000).default(0),
    active: z.boolean().default(true),
  })
  .strict();
// Patch schemas must not inherit creation defaults: omitted fields stay untouched.
const optionPatch = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(1000).optional(),
    valueType: z.enum(optionValueTypes).optional(),
    defaultValue: scalar.optional(),
    choices: z.array(choice).max(100).optional(),
    required: z.boolean().optional(),
    searchable: z.boolean().optional(),
    showOnCard: z.boolean().optional(),
    showInList: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(100000).optional(),
    active: z.boolean().optional(),
    revision: z.number().int().positive(),
  })
  .strict();
const roleInput = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_-]{0,99}$/),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(1000).default(""),
  })
  .strict();
const rolePatch = roleInput
  .omit({ key: true })
  .partial()
  .extend({
    description: z.string().max(1000).optional(),
    active: z.boolean().optional(),
    revision: z.number().int().positive(),
  })
  .strict();
const ruleInput = z
  .object({
    permissionKey: z.string().min(1).max(140),
    effect: z.enum(["allow", "deny"]).nullable(),
    revision: z.number().int().positive().nullable(),
  })
  .strict();
const assignmentInput = z
  .object({
    employeeId: z.number().int().positive(),
    roleId: z.number().int().positive(),
    active: z.boolean(),
    revision: z.number().int().positive().nullable(),
  })
  .strict();
const employeeRuleInput = ruleInput.extend({
  employeeId: z.number().int().positive(),
});
const valueInput = z
  .object({
    definitionId: z.number().int().positive(),
    value: scalar,
    revision: z.number().int().positive().nullable(),
  })
  .strict();

const optionSelect = `SELECT id,key,page_key AS "pageKey",record_kind AS "recordKind",name,description,
 value_type AS "valueType",default_value AS "defaultValue",choices,required,searchable,
 show_on_card AS "showOnCard",show_in_list AS "showInList",sort_order AS "sortOrder",active,
 is_system AS system,native_binding AS "nativeBinding",revision
 FROM option_definitions`;

function conflict() {
  throw new HttpError(
    409,
    "conflict",
    "تغيرت البيانات منذ فتحها؛ أعد تحميلها قبل الحفظ.",
  );
}
async function authorize(
  client: PoolClient,
  req: import("express").Request,
  writes: boolean,
  roles = false,
) {
  const companyId = id(req.params.companyId);
  const user = await currentActor(client, actor(req), writes);
  const context = await companyAccess(
    client,
    user,
    companyId,
    "pages.manage",
    writes,
  );
  if (writes) await assertRequestPagesEnabled(client, req, true);
  if (writes && roles && !context.general)
    throw new HttpError(
      403,
      "forbidden",
      "تعديل أدوار وصلاحيات الموظفين للمالك والمدير العام فقط.",
    );
  return { companyId, user, context };
}
async function getOne(
  client: PoolClient,
  table: string,
  where: string,
  args: unknown[],
  locked = true,
) {
  // table/where are fixed server-owned SQL fragments, never user input.
  const x = await client.query(
    `SELECT * FROM ${table} WHERE ${where} ${locked ? "FOR UPDATE" : ""}`,
    args,
  );
  if (!x.rows[0]) missing();
  return x.rows[0] as QueryResultRow;
}
function revision(row: QueryResultRow, expected: number | null) {
  if ((row.revision ?? null) !== expected) conflict();
}
function validOption(type: string, value: unknown, choices: { key: string }[]) {
  if (value !== null && typeof value !== "string" && typeof value !== "boolean")
    return false;
  return (
    optionValueError(
      {
        valueType: type as OptionValueType,
        required: false,
        choices: choices.map((c) => ({ ...c, label: c.key })),
      },
      value,
    ) === null
  );
}
function checkOption(input: z.infer<typeof optionInput>) {
  if (
    input.valueType === "list"
      ? !input.choices.length
      : input.choices.length > 0
  )
    throw new HttpError(
      400,
      "validation",
      "خيارات القائمة مطلوبة لنوع القائمة فقط.",
    );
  if (new Set(input.choices.map((x) => x.key)).size !== input.choices.length)
    throw new HttpError(400, "validation", "قِيَم القائمة يجب ألا تتكرر.");
  if (!validOption(input.valueType, input.defaultValue, input.choices))
    throw new HttpError(
      400,
      "validation",
      "القيمة الافتراضية لا تطابق نوع الخيار.",
    );
  if (
    input.required &&
    (input.defaultValue === null || input.defaultValue === "")
  )
    throw new HttpError(
      400,
      "validation",
      "الخيار الإلزامي يحتاج قيمة افتراضية صالحة.",
    );
}
export function configurationAdministrationRoutes(pool: Pool): Router {
  const router = Router(),
    base = "/companies/:companyId/configuration";
  router.get(
    base + "/directory",
    handler(async (req, res) => {
      const result = await transaction(pool, async (client) => {
        await client.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        const { companyId } = await authorize(client, req, false);
        const options = await client.query(
          optionSelect + " WHERE company_id=$1 ORDER BY page_key,sort_order,id",
          [companyId],
        );
        const roles = await client.query(
          "SELECT id,key,name,description,is_system AS system,active,revision FROM company_roles WHERE company_id=$1 ORDER BY name,id",
          [companyId],
        );
        const definitions = await client.query(
          'SELECT key,page_key AS "pageKey",action,name,required_permissions AS "requiredPermissions",rule_role AS "ruleRole",active FROM permission_definitions ORDER BY page_key,action',
        );
        const employees = await client.query(
          'SELECT e.id,e.user_id AS "userId",e.name,e.role,e.permissions,e.active,e.is_general_manager AS "generalManager",u.owner FROM employees e JOIN users u ON u.id=e.user_id WHERE e.company_id=$1 ORDER BY e.name,e.id',
          [companyId],
        );
        const roleRules = await client.query(
          'SELECT id,role_id AS "roleId",permission_key AS "permissionKey",effect,active,revision FROM role_permission_rules WHERE company_id=$1 ORDER BY role_id,id',
          [companyId],
        );
        const assignments = await client.query(
          'SELECT id,employee_id AS "employeeId",role_id AS "roleId",active,revision FROM employee_role_assignments WHERE company_id=$1 ORDER BY employee_id,id',
          [companyId],
        );
        const employeeRules = await client.query(
          'SELECT id,employee_id AS "employeeId",permission_key AS "permissionKey",effect,active,revision FROM employee_permission_rules WHERE company_id=$1 ORDER BY employee_id,id',
          [companyId],
        );
        return {
          options: options.rows,
          roles: roles.rows,
          definitions: definitions.rows,
          employees: employees.rows,
          roleRules: roleRules.rows,
          assignments: assignments.rows,
          employeeRules: employeeRules.rows,
        };
      });
      res.json(result);
    }),
  );
  router.post(
    base + "/options",
    handler(async (req, res) => {
      const input = parse(optionInput, req.body);
      checkOption(input);
      if (input.recordKind !== "item" && input.recordKind !== "account")
        throw new HttpError(
          400,
          "validation",
          "الخيارات الإضافية متاحة حاليًا لكروت الأصناف والحسابات.",
        );
      const result = await transaction(pool, async (client) => {
        const { companyId, user } = await authorize(client, req, true);
        if (!pageByKey(input.pageKey) || !input.pageKey.startsWith("company."))
          throw new HttpError(
            400,
            "validation",
            "اختر صفحة صحيحة من دليل الصفحات.",
          );
        const target = await client.query(
          "SELECT 1 FROM option_record_targets WHERE page_key=$1 AND record_kind=$2",
          [input.pageKey, input.recordKind],
        );
        if (!target.rowCount)
          throw new HttpError(
            400,
            "validation",
            "هذه الصفحة لا تقبل هذا النوع من السجلات.",
          );
        const created = await client.query(
          `INSERT INTO option_definitions
      (company_id,key,page_key,record_kind,name,description,value_type,default_value,choices,required,searchable,show_on_card,show_in_list,sort_order,active,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$16) RETURNING id`,
          [
            companyId,
            input.key,
            input.pageKey,
            input.recordKind,
            input.name,
            input.description,
            input.valueType,
            JSON.stringify(input.defaultValue),
            JSON.stringify(input.choices),
            input.required,
            input.searchable,
            input.showOnCard,
            input.showInList,
            input.sortOrder,
            input.active,
            user.id,
          ],
        );
        const next = (
          await client.query(optionSelect + " WHERE company_id=$1 AND id=$2", [
            companyId,
            created.rows[0].id,
          ])
        ).rows[0];
        await audit(
          client,
          user,
          "configuration.options.create",
          "option",
          next.id,
          null,
          next,
          companyId,
        );
        return next;
      });
      res.status(201).json({ option: result });
    }),
  );
  router.patch(
    base + "/options/:optionId",
    handler(async (req, res) => {
      const input = parse(optionPatch, req.body);
      const result = await transaction(pool, async (client) => {
        const { companyId, user } = await authorize(client, req, true);
        const row = await getOne(
          client,
          "option_definitions",
          "company_id=$1 AND id=$2",
          [companyId, id(req.params.optionId)],
        );
        revision(row, input.revision);
        const before = (
          await client.query(optionSelect + " WHERE company_id=$1 AND id=$2", [
            companyId,
            row.id,
          ])
        ).rows[0];
        const merged = { ...before, ...input, system: false } as z.infer<
          typeof optionInput
        > & { system: boolean };
        checkOption(merged);
        if (
          row.is_system &&
          (input.valueType !== undefined ||
            input.choices !== undefined ||
            input.defaultValue !== undefined ||
            input.required !== undefined ||
            input.active === false)
        )
          throw new HttpError(
            403,
            "protected_option",
            "الخيارات الأساسية مرتبطة بقواعد النظام، ولا يمكن تغيير أنواعها أو إيقافها.",
          );
        if (
          (input.valueType && input.valueType !== row.value_type) ||
          (input.choices &&
            JSON.stringify(input.choices) !== JSON.stringify(row.choices))
        ) {
          const used = await client.query(
            "SELECT 1 FROM option_values WHERE company_id=$1 AND definition_id=$2 LIMIT 1",
            [companyId, row.id],
          );
          if (used.rowCount)
            throw new HttpError(
              409,
              "conflict",
              "لا يمكن تغيير نوع أو قائمة خيار سبق استخدامه.",
            );
        }
        await client.query(
          `UPDATE option_definitions SET name=$1,description=$2,value_type=$3,
      default_value=$4::jsonb,choices=$5::jsonb,required=$6,searchable=$7,show_on_card=$8,
      show_in_list=$9,sort_order=$10,active=$11,revision=revision+1,updated_by=$12,updated_at=now()
      WHERE company_id=$13 AND id=$14`,
          [
            merged.name,
            merged.description,
            merged.valueType,
            JSON.stringify(merged.defaultValue),
            JSON.stringify(merged.choices),
            merged.required,
            merged.searchable,
            merged.showOnCard,
            merged.showInList,
            merged.sortOrder,
            merged.active,
            user.id,
            companyId,
            row.id,
          ],
        );
        const next = (
          await client.query(optionSelect + " WHERE company_id=$1 AND id=$2", [
            companyId,
            row.id,
          ])
        ).rows[0];
        await audit(
          client,
          user,
          "configuration.options.update",
          "option",
          row.id,
          before,
          next,
          companyId,
        );
        return next;
      });
      res.json({ option: result });
    }),
  );
  router.post(
    base + "/roles",
    handler(async (req, res) => {
      const input = parse(roleInput, req.body);
      const role = await transaction(pool, async (client) => {
        const { companyId, user } = await authorize(client, req, true, true);
        if (
          [
            "employee",
            "administrative",
            "accountant",
            "sales",
            "purchases",
          ].includes(input.key)
        )
          throw new HttpError(409, "conflict", "هذا المعرف محجوز لدور نظامي.");
        const row = (
          await client.query(
            "INSERT INTO company_roles(company_id,key,name,description,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$5) RETURNING *",
            [companyId, input.key, input.name, input.description, user.id],
          )
        ).rows[0];
        await audit(
          client,
          user,
          "configuration.roles.create",
          "role",
          row.id,
          null,
          row,
          companyId,
        );
        return row;
      });
      res.status(201).json({ role });
    }),
  );
  router.patch(
    base + "/roles/:roleId",
    handler(async (req, res) => {
      const input = parse(rolePatch, req.body);
      const role = await transaction(pool, async (client) => {
        const { companyId, user } = await authorize(client, req, true, true);
        const before = await getOne(
          client,
          "company_roles",
          "company_id=$1 AND id=$2",
          [companyId, id(req.params.roleId)],
        );
        revision(before, input.revision);
        const result = await client.query(
          "UPDATE company_roles SET name=$1,description=$2,active=$3,updated_by=$4 WHERE company_id=$5 AND id=$6 RETURNING *",
          [
            input.name ?? before.name,
            input.description ?? before.description,
            input.active ?? before.active,
            user.id,
            companyId,
            before.id,
          ],
        );
        await audit(
          client,
          user,
          "configuration.roles.update",
          "role",
          before.id,
          before,
          result.rows[0],
          companyId,
        );
        return result.rows[0];
      });
      res.json({ role });
    }),
  );
  router.put(
    base + "/roles/:roleId/rules",
    handler(async (req, res) => {
      const input = parse(ruleInput, req.body);
      const rule = await transaction(pool, async (client) => {
        const { companyId, user } = await authorize(client, req, true, true);
        const role = await getOne(
          client,
          "company_roles",
          "company_id=$1 AND id=$2",
          [companyId, id(req.params.roleId)],
        );
        if (!role.active && input.effect)
          throw new HttpError(409, "conflict", "الدور مؤرشف.");
        const definition = await client.query(
          "SELECT key FROM permission_definitions WHERE key=$1 AND active",
          [input.permissionKey],
        );
        if (!definition.rowCount) missing("تعريف الصلاحية غير موجود.");
        const before =
          (
            await client.query(
              "SELECT * FROM role_permission_rules WHERE company_id=$1 AND role_id=$2 AND permission_key=$3 FOR UPDATE",
              [companyId, role.id, input.permissionKey],
            )
          ).rows[0] ?? null;
        revision(before ?? { revision: null }, input.revision);
        const after = before
          ? (
              await client.query(
                "UPDATE role_permission_rules SET effect=$1,active=$2,updated_by=$3 WHERE id=$4 RETURNING *",
                [
                  input.effect ?? before.effect,
                  input.effect !== null,
                  user.id,
                  before.id,
                ],
              )
            ).rows[0]
          : input.effect === null
            ? null
            : (
                await client.query(
                  "INSERT INTO role_permission_rules(company_id,role_id,permission_key,effect,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$5) RETURNING *",
                  [
                    companyId,
                    role.id,
                    input.permissionKey,
                    input.effect,
                    user.id,
                  ],
                )
              ).rows[0];
        if (after)
          await audit(
            client,
            user,
            "configuration.permissions.role",
            "roleRule",
            after.id,
            before,
            after,
            companyId,
          );
        return after;
      });
      res.json({ rule });
    }),
  );
  router.put(
    base + "/assignments",
    handler(async (req, res) => {
      const input = parse(assignmentInput, req.body);
      const assigned = await transaction(pool, async (client) => {
        const { companyId, user } = await authorize(client, req, true, true);
        const employee = await getOne(
          client,
          "employees",
          "company_id=$1 AND id=$2",
          [companyId, input.employeeId],
        );
        const account = await client.query(
          "SELECT owner FROM users WHERE id=$1",
          [employee.user_id],
        );
        if (
          !employee.active ||
          employee.is_general_manager ||
          account.rows[0]?.owner
        )
          throw new HttpError(
            403,
            "protected_employee",
            "أدوار المالك والمدير العام والموظف المؤرشف محمية.",
          );
        const role = await getOne(
          client,
          "company_roles",
          "company_id=$1 AND id=$2",
          [companyId, input.roleId],
        );
        if (!role.active && input.active)
          throw new HttpError(409, "conflict", "لا يمكن إسناد دور مؤرشف.");
        const before =
          (
            await client.query(
              "SELECT * FROM employee_role_assignments WHERE company_id=$1 AND employee_id=$2 AND role_id=$3 FOR UPDATE",
              [companyId, input.employeeId, input.roleId],
            )
          ).rows[0] ?? null;
        revision(before ?? { revision: null }, input.revision);
        const next = before
          ? (
              await client.query(
                "UPDATE employee_role_assignments SET active=$1,updated_by=$2 WHERE id=$3 RETURNING *",
                [input.active, user.id, before.id],
              )
            ).rows[0]
          : (
              await client.query(
                "INSERT INTO employee_role_assignments(company_id,employee_id,role_id,active,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$5) RETURNING *",
                [
                  companyId,
                  input.employeeId,
                  input.roleId,
                  input.active,
                  user.id,
                ],
              )
            ).rows[0];
        await audit(
          client,
          user,
          "configuration.permissions.assignment",
          "roleAssignment",
          next.id,
          before,
          next,
          companyId,
        );
        return next;
      });
      res.json({ assignment: assigned });
    }),
  );
  router.put(
    base + "/employee-rules",
    handler(async (req, res) => {
      const input = parse(employeeRuleInput, req.body);
      const rule = await transaction(pool, async (client) => {
        const { companyId, user } = await authorize(client, req, true, true);
        const employee = await getOne(
          client,
          "employees",
          "company_id=$1 AND id=$2",
          [companyId, input.employeeId],
        );
        const account = await client.query(
          "SELECT owner FROM users WHERE id=$1",
          [employee.user_id],
        );
        if (
          !employee.active ||
          employee.is_general_manager ||
          account.rows[0]?.owner
        )
          throw new HttpError(
            403,
            "protected_employee",
            "صلاحيات المالك والمدير العام والموظف المؤرشف محمية.",
          );
        const definition = await client.query(
          "SELECT key FROM permission_definitions WHERE key=$1 AND active",
          [input.permissionKey],
        );
        if (!definition.rowCount) missing("تعريف الصلاحية غير موجود.");
        const before =
          (
            await client.query(
              "SELECT * FROM employee_permission_rules WHERE company_id=$1 AND employee_id=$2 AND permission_key=$3 FOR UPDATE",
              [companyId, input.employeeId, input.permissionKey],
            )
          ).rows[0] ?? null;
        revision(before ?? { revision: null }, input.revision);
        const next = before
          ? (
              await client.query(
                "UPDATE employee_permission_rules SET effect=$1,active=$2,updated_by=$3 WHERE id=$4 RETURNING *",
                [
                  input.effect ?? before.effect,
                  input.effect !== null,
                  user.id,
                  before.id,
                ],
              )
            ).rows[0]
          : input.effect === null
            ? null
            : (
                await client.query(
                  "INSERT INTO employee_permission_rules(company_id,employee_id,permission_key,effect,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$5) RETURNING *",
                  [
                    companyId,
                    input.employeeId,
                    input.permissionKey,
                    input.effect,
                    user.id,
                  ],
                )
              ).rows[0];
        if (next)
          await audit(
            client,
            user,
            "configuration.permissions.employee",
            "employeeRule",
            next.id,
            before,
            next,
            companyId,
          );
        return next;
      });
      res.json({ rule });
    }),
  );
  router.get(
    base + "/record-options",
    handler(async (req, res) => {
      const companyId = id(req.params.companyId),
        kind = parse(recordKind, req.query.recordKind),
        recordId = id(String(req.query.recordId ?? ""));
      const result = await transaction(pool, async (client) => {
        await client.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        const user = await currentActor(client, actor(req), false);
        const perm =
          kind === "item"
            ? "items.view"
            : kind === "account"
              ? "accounts.view"
              : "employees.view";
        // Never expose another company or archived employee record; this phase
        // supports item and account cards, not finalized financial documents.
        if (kind !== "item" && kind !== "account")
          throw new HttpError(
            400,
            "validation",
            "هذا النوع من السجلات غير مدعوم بعد.",
          );
        await companyAccess(client, user, companyId, perm, false);
        const table = kind === "item" ? "items" : "accounts";
        const baseRow = await client.query(
          `SELECT * FROM ${table} WHERE company_id=$1 AND id=$2`,
          [companyId, recordId],
        );
        if (!baseRow.rowCount) missing();
        const defs = (
          await client.query(
            optionSelect +
              " WHERE company_id=$1 AND record_kind=$2 AND show_on_card=true ORDER BY sort_order,id",
            [companyId, kind],
          )
        ).rows;
        const stored = (
          await client.query(
            `SELECT id,definition_id AS "definitionId",value,revision FROM option_values
        WHERE company_id=$1 AND record_kind=$2 AND ${kind === "item" ? "item_id" : "account_id"}=$3`,
            [companyId, kind, recordId],
          )
        ).rows;
        return {
          definitions: defs,
          values: stored,
          native: {
            archived: !baseRow.rows[0].active,
            hasExpiry: kind === "item" ? baseRow.rows[0].has_expiry : null,
          },
        };
      });
      res.json(result);
    }),
  );
  router.put(
    base + "/record-options",
    handler(async (req, res) => {
      const input = parse(valueInput, req.body),
        kind = parse(recordKind, req.query.recordKind),
        recordId = id(String(req.query.recordId ?? ""));
      const result = await transaction(pool, async (client) => {
        const companyId = id(req.params.companyId),
          user = await currentActor(client, actor(req));
        if (kind !== "item" && kind !== "account")
          throw new HttpError(
            400,
            "validation",
            "هذا النوع من السجلات غير مدعوم بعد.",
          );
        await companyAccess(
          client,
          user,
          companyId,
          kind === "item" ? "items.manage" : "accounts.manage",
          true,
        );
        await assertRequestPagesEnabled(client, req, true);
        const table = kind === "item" ? "items" : "accounts",
          col = kind === "item" ? "item_id" : "account_id";
        const record = await client.query(
          `SELECT id FROM ${table} WHERE company_id=$1 AND id=$2 FOR UPDATE`,
          [companyId, recordId],
        );
        if (!record.rowCount) missing();
        const def = await getOne(
          client,
          "option_definitions",
          "company_id=$1 AND id=$2",
          [companyId, input.definitionId],
          false,
        );
        if (def.record_kind !== kind || !def.active || def.native_binding)
          throw new HttpError(
            403,
            "protected_option",
            "هذا الخيار غير قابل لتغيير القيمة.",
          );
        if (
          !validOption(def.value_type, input.value, def.choices) ||
          (def.required && (input.value === null || input.value === ""))
        )
          throw new HttpError(
            400,
            "validation",
            "القيمة لا تطابق نوع الخيار أو إلزاميته.",
          );
        const before =
          (
            await client.query(
              `SELECT * FROM option_values WHERE company_id=$1 AND definition_id=$2 AND ${col}=$3 FOR UPDATE`,
              [companyId, input.definitionId, recordId],
            )
          ).rows[0] ?? null;
        revision(before ?? { revision: null }, input.revision);
        const next = before
          ? (
              await client.query(
                "UPDATE option_values SET value=$1::jsonb,revision=revision+1,updated_by=$2,updated_at=now() WHERE id=$3 RETURNING *",
                [JSON.stringify(input.value), user.id, before.id],
              )
            ).rows[0]
          : (
              await client.query(
                `INSERT INTO option_values(company_id,definition_id,record_kind,${col},value,created_by,updated_by)
           VALUES($1,$2,$3,$4,$5::jsonb,$6,$6) RETURNING *`,
                [
                  companyId,
                  input.definitionId,
                  kind,
                  recordId,
                  JSON.stringify(input.value),
                  user.id,
                ],
              )
            ).rows[0];
        await audit(
          client,
          user,
          "configuration.options.value",
          "optionValue",
          next.id,
          before,
          next,
          companyId,
        );
        return {
          id: next.id,
          definitionId: next.definition_id,
          value: next.value,
          revision: next.revision,
        };
      });
      res.json({ value: result });
    }),
  );
  return router;
}
