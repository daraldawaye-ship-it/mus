import { Router } from "express";
import type { Pool } from "pg";
import {
  optionValueTypes,
  type ConfigurationFoundation,
} from "../../../packages/contracts/src/index.ts";
import { transaction } from "./db.ts";
import { actor, handler, id } from "./http.ts";
import { companyAccess, currentActor } from "./policies/access.ts";

/** Read-only summary of the active configuration administration. */
export function configurationRoutes(pool: Pool): Router {
  const router = Router();
  router.get(
    "/companies/:companyId/configuration-foundation",
    handler(async (req, res) => {
      const companyId = id(req.params.companyId);
      const result = await transaction(pool, async (client) => {
        await client.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        const user = await currentActor(client, actor(req), false);
        await companyAccess(client, user, companyId, "pages.manage");
        const summary = await client.query(
          `SELECT
        (SELECT count(*)::integer FROM option_definitions WHERE company_id=$1) AS options,
        (SELECT count(*)::integer FROM option_values WHERE company_id=$1) AS "storedValues",
        (SELECT count(*)::integer FROM permission_definitions) AS "permissionDefinitions",
        (SELECT count(*)::integer FROM company_roles WHERE company_id=$1) AS roles,
        (SELECT count(*)::integer FROM employee_role_assignments WHERE company_id=$1) AS "roleAssignments",
        (SELECT count(*)::integer FROM role_permission_rules WHERE company_id=$1) AS "roleRules",
        (SELECT count(*)::integer FROM employee_permission_rules WHERE company_id=$1) AS "employeeRules"`,
          [companyId],
        );
        const options = await client.query(
          `SELECT id,key,page_key AS "pageKey",record_kind AS "recordKind",name,description,
        value_type AS "valueType",default_value AS "defaultValue",choices,required,searchable,
        show_on_card AS "showOnCard",show_in_list AS "showInList",sort_order AS "sortOrder",active,
        is_system AS system,native_binding AS "nativeBinding",revision
        FROM option_definitions WHERE company_id=$1 ORDER BY page_key,sort_order,id LIMIT 100`,
          [companyId],
        );
        const roles = await client.query(
          "SELECT id,key,name,active FROM company_roles WHERE company_id=$1 ORDER BY id LIMIT 100",
          [companyId],
        );
        return {
          companyId,
          stage: "management",
          authorizationMode: "employee-permissions-and-page-rules",
          administrationAvailable: true,
          valueTypes: optionValueTypes,
          summary: summary.rows[0],
          options: options.rows,
          roles: roles.rows,
        } satisfies ConfigurationFoundation;
      });
      res.json(result);
    }),
  );
  return router;
}
