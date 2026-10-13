import { Router, type Request } from "express";
import type { Pool, PoolClient } from "pg";
import {
  walletAwardSchema,
  walletReversalSchema,
  rewardTaskSettingsSchema,
  pageVisitEventSchema,
  walletPolicySchema,
  employeeWalletAccountSchema,
  walletConversionSchema,
  walletConversionDecisionSchema,
} from "../../../packages/contracts/src/wallet.ts";
import { pageDefinitions } from "../../../packages/contracts/src/pages.ts";
import { actor, handler, id, parse } from "./http.ts";
import { transaction } from "./db.ts";
import {
  companyAccess,
  currentActor,
  manageEmployees,
} from "./policies/access.ts";
import { HttpError, missing, deny } from "./errors.ts";
import { audit } from "./services/audit.ts";
import { awardCompanyPageVisit } from "./services/wallet-page-visit.ts";
import {
  assertRequestPagesEnabled,
  directoryEntries,
} from "./services/pages.ts";
import { listQuery, searchPattern } from "./services/lists.ts";
import {
  walletPolicy,
  walletBaseCurrency,
  employeeWalletAccount,
  saveWalletPolicy,
  saveEmployeeWalletAccount,
  walletConversionPreview,
} from "./services/wallet-policy.ts";
import {
  walletConversionQuery,
  walletConversionDTO,
  createWalletConversion,
  decideWalletConversion,
} from "./services/wallet-conversions.ts";
import {
  walletEntryQuery,
  walletEntryDTO,
  walletSummary,
  rewardTaskQuery,
  rewardTaskDTO,
  rewardTask,
  replayWalletEntry,
} from "./services/wallet.ts";

async function scope(client: PoolClient, req: Request, write = false) {
  const companyId = id(req.params.companyId),
    user = await currentActor(client, actor(req), write);
  const context = await companyAccess(
    client,
    user,
    companyId,
    undefined,
    write,
  );
  if (write) await assertRequestPagesEnabled(client, req, true);
  return { companyId, user, context, ownId: context.employee?.id ?? null };
}
async function activeEmployee(
  client: PoolClient,
  companyId: number,
  employeeId: number,
) {
  const found = await client.query(
    `SELECT e.id,e.name FROM employees e JOIN users u ON u.id=e.user_id AND NOT u.archived
    WHERE e.company_id=$1 AND e.id=$2 AND e.active FOR UPDATE OF e`,
    [companyId, employeeId],
  );
  if (!found.rows[0])
    throw new HttpError(
      400,
      "invalid_employee",
      "اختر موظفًا فعالًا من الشركة نفسها",
    );
  await client.query(
    "SELECT 1 FROM employee_wallets WHERE company_id=$1 AND employee_id=$2 FOR UPDATE",
    [companyId, employeeId],
  );
  return found.rows[0];
}
export function walletRoutes(pool: Pool) {
  const router = Router(),
    base = "/companies/:companyId";
  router.get(
    base + "/wallet-settings",
    handler(async (req, res) => {
      const result = await transaction(pool, async (client) => {
        await client.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        const { companyId, user, context } = await scope(client, req);
        manageEmployees(user, context);
        const policy = await walletPolicy(client, companyId),
          baseCurrency = await walletBaseCurrency(client, companyId),
          employees = (
            await client.query(
              `SELECT e.id,e.name FROM employees e JOIN users u ON u.id=e.user_id AND NOT u.archived
             WHERE e.company_id=$1 AND e.active ORDER BY e.name,e.id`,
              [companyId],
            )
          ).rows;
        return { policy, baseCurrency, employees };
      });
      res.json(result);
    }),
  );
  router.put(
    base + "/wallet-settings",
    handler(async (req, res) => {
      const input = parse(walletPolicySchema, req.body);
      const policy = await transaction(pool, async (client) => {
        const { companyId, user, context } = await scope(client, req, true);
        manageEmployees(user, context);
        return saveWalletPolicy(client, user, companyId, input);
      });
      res.json({ policy });
    }),
  );
  router.get(
    base + "/wallet-settings/employee-accounts/:employeeId",
    handler(async (req, res) => {
      const binding = await transaction(pool, async (client) => {
        await client.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        const { companyId, user, context } = await scope(client, req);
        manageEmployees(user, context);
        return employeeWalletAccount(
          client,
          companyId,
          id(req.params.employeeId),
        );
      });
      res.json({ binding });
    }),
  );
  router.put(
    base + "/wallet-settings/employee-accounts/:employeeId",
    handler(async (req, res) => {
      const input = parse(employeeWalletAccountSchema, req.body),
        employeeId = id(req.params.employeeId);
      const binding = await transaction(pool, async (client) => {
        const { companyId, user, context } = await scope(client, req, true);
        manageEmployees(user, context);
        return saveEmployeeWalletAccount(
          client,
          user,
          companyId,
          employeeId,
          input,
        );
      });
      res.json({ binding });
    }),
  );
  router.get(
    base + "/wallet/conversion-preview",
    handler(async (req, res) => {
      const preview = await transaction(pool, async (client) => {
        await client.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        const { companyId, user, context, ownId } = await scope(client, req),
          employeeId =
            req.query.employeeId === undefined
              ? ownId
              : id(
                  typeof req.query.employeeId === "string"
                    ? req.query.employeeId
                    : undefined,
                );
        if (employeeId === null)
          throw new HttpError(
            400,
            "employee_required",
            "اختر موظفًا لمعاينة قيمة نقاط محفظته",
          );
        if (!context.general && employeeId !== ownId)
          deny("يمكنك معاينة محفظتك فقط");
        const preview = await walletConversionPreview(
            client,
            companyId,
            employeeId,
          ),
          pages = await directoryEntries(client, user, companyId),
          allowed =
            employeeId === ownId &&
            pages.some(
              (page) =>
                page.key === "company.wallet-conversions" &&
                page.actionAccess.create && page.actionAccess.view,
            );
        return {
          ...preview,
          canConvert: preview.canConvert && allowed,
          unavailableReason: allowed
            ? preview.unavailableReason
            : employeeId !== ownId
              ? "يمكن للموظف طلب تحويل محفظته فقط"
              : "طلب التحويل غير متاح ضمن صلاحياتك أو إعدادات الصفحات",
        };
      });
      res.json({ preview });
    }),
  );
  router.get(
    base + "/wallet-conversions",
    handler(async (req, res) => {
      const result = await transaction(pool, async (client) => {
        await client.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        const { companyId, context, ownId } = await scope(client, req);
        const employeeId =
          req.query.employeeId === undefined
            ? context.general
              ? null
              : ownId
            : id(
                typeof req.query.employeeId === "string"
                  ? req.query.employeeId
                  : undefined,
              );
        if (!context.general && employeeId !== ownId)
          deny("يمكنك عرض تحويلات محفظتك فقط");
        if (
          employeeId !== null &&
          !(
            await client.query(
              "SELECT 1 FROM employees WHERE company_id=$1 AND id=$2",
              [companyId, employeeId],
            )
          ).rowCount
        )
          missing();
        const status = req.query.status ?? "";
        if (
          typeof status !== "string" ||
          (status !== "" &&
            !["pending", "posted", "rejected", "cancelled"].includes(status))
        )
          throw new HttpError(400, "invalid_query", "حالة التحويل غير صالحة");
        const query = listQuery(
          req.query,
          {
            id: "x.id",
            employeeName: "x.employee_name",
            status: "x.status",
            points: "x.points",
            amount: "x.amount",
            createdAt: "x.created_at",
            createdByName: "x.created_by_name",
          },
          "createdAt:desc,id:desc",
        );
        const args = [companyId, employeeId, status, searchPattern(query.q)],
          filter = ` WHERE x.company_id=$1 AND ($2::integer IS NULL OR x.employee_id=$2)
            AND ($3='' OR x.status=$3) AND (x.employee_name ILIKE $4 ESCAPE '\\' OR x.account_name ILIKE $4 ESCAPE '\\'
              OR x.created_by_name ILIKE $4 ESCAPE '\\' OR COALESCE(x.decision_reason,'') ILIKE $4 ESCAPE '\\')`;
        const total = Number(
            (
              await client.query(
                "SELECT count(*) FROM wallet_conversions x" + filter,
                args,
              )
            ).rows[0].count,
          ),
          found = await client.query(
            walletConversionQuery +
              filter +
              ` ORDER BY ${query.order} LIMIT $5 OFFSET $6`,
            [...args, query.pageSize, query.offset],
          );
        return {
          items: found.rows.map(walletConversionDTO),
          total,
          page: query.page,
          pageSize: query.pageSize,
          canManage: context.general,
        };
      });
      res.json(result);
    }),
  );
  router.post(
    base + "/wallet-conversions",
    handler(async (req, res) => {
      const input = parse(walletConversionSchema, req.body);
      const conversion = await transaction(pool, async (client) => {
        const { companyId, user, ownId } = await scope(client, req, true);
        if (input.employeeId !== ownId) deny("يمكنك طلب تحويل محفظتك فقط");
        return createWalletConversion(client, companyId, user, input);
      });
      res.json({ conversion });
    }),
  );
  for (const action of ["approve", "reject", "cancel"] as const)
    router.post(
      base + `/wallet-conversions/:id/${action}`,
      handler(async (req, res) => {
        const input = parse(walletConversionDecisionSchema, req.body),
          conversionId = id(req.params.id);
        const conversion = await transaction(pool, async (client) => {
          const { companyId, user, context, ownId } = await scope(
            client,
            req,
            true,
          );
          if (action === "cancel") {
            const found = await client.query(
              "SELECT employee_id FROM wallet_conversions WHERE company_id=$1 AND id=$2",
              [companyId, conversionId],
            );
            if (!found.rows[0]) missing();
            if (found.rows[0].employee_id !== ownId)
              deny("يمكنك إلغاء طلب تحويلك فقط");
          } else manageEmployees(user, context);
          return decideWalletConversion(
            client,
            companyId,
            user,
            conversionId,
            action,
            input,
          );
        });
        res.json({ conversion });
      }),
    );
  router.post(
    base + "/reward-events/page-visit",
    handler(async (req, res) => {
      const input = parse(pageVisitEventSchema, req.body);
      const result = await transaction(pool, async (client) => {
        const { companyId, user } = await scope(client, req, true);
        return awardCompanyPageVisit(
          client,
          companyId,
          user,
          input.pageKey,
          input.idempotencyKey,
        );
      });
      res.json(result);
    }),
  );
  router.get(
    base + "/wallet/summary",
    handler(async (req, res) => {
      const result = await transaction(pool, async (client) => {
        await client.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        const { companyId, ownId } = await scope(client, req);
        return {
          wallet:
            ownId === null
              ? null
              : await walletSummary(client, companyId, ownId),
        };
      });
      res.json(result);
    }),
  );
  router.get(
    base + "/wallet",
    handler(async (req, res) => {
      const result = await transaction(pool, async (client) => {
        await client.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        const { companyId, context, ownId } = await scope(client, req);
        const employees = context.general
          ? (
              await client.query(
                `SELECT e.id,e.name FROM employees e JOIN users u ON u.id=e.user_id AND NOT u.archived
        WHERE e.company_id=$1 AND e.active ORDER BY e.name,e.id`,
                [companyId],
              )
            ).rows
          : [];
        const selected =
          req.query.employeeId === undefined
            ? (ownId ?? employees[0]?.id ?? null)
            : id(
                typeof req.query.employeeId === "string"
                  ? req.query.employeeId
                  : undefined,
              );
        if (!context.general && selected !== ownId)
          deny("يمكنك عرض محفظتك فقط");
        if (
          selected !== null &&
          !(
            await client.query(
              "SELECT 1 FROM employees WHERE company_id=$1 AND id=$2",
              [companyId, selected],
            )
          ).rowCount
        )
          missing();
        const columns = {
          id: "l.id",
          createdAt: "l.created_at",
          points: "l.points",
          employeeName: "l.employee_name",
          createdByName: "l.created_by_name",
          reason: "l.reason",
          kind: "l.kind",
        };
        const query = listQuery(req.query, columns, "createdAt:desc,id:desc");
        const args = [companyId, selected, searchPattern(query.q)];
        const filter = ` WHERE l.company_id=$1 AND l.employee_id=$2 AND (l.reason ILIKE $3 ESCAPE '\\' OR l.employee_name ILIKE $3 ESCAPE '\\' OR l.created_by_name ILIKE $3 ESCAPE '\\')`;
        const total = Number(
          (
            await client.query(
              "SELECT count(*) FROM employee_wallet_entries l" + filter,
              args,
            )
          ).rows[0].count,
        );
        const rows = await client.query(
          walletEntryQuery +
            filter +
            ` ORDER BY ${query.order} LIMIT $4 OFFSET $5`,
          [...args, query.pageSize, query.offset],
        );
        return {
          items: rows.rows.map(walletEntryDTO),
          total,
          page: query.page,
          pageSize: query.pageSize,
          wallet:
            selected === null
              ? null
              : await walletSummary(client, companyId, selected),
          employees,
          canManage: context.general,
        };
      });
      res.json(result);
    }),
  );
  router.post(
    base + "/wallet/awards",
    handler(async (req, res) => {
      const input = parse(walletAwardSchema, req.body);
      const entry = await transaction(pool, async (client) => {
        const { companyId, user, context } = await scope(client, req, true);
        manageEmployees(user, context);
        const payload = {
          kind: "manual",
          employeeId: input.employeeId,
          points: input.points,
          reason: input.reason,
        };
        const previous = await replayWalletEntry(
          client,
          companyId,
          user.id,
          input.idempotencyKey,
          payload,
        );
        if (previous) return previous;
        const employee = await activeEmployee(
          client,
          companyId,
          input.employeeId,
        );
        const before = await walletSummary(client, companyId, employee.id);
        const inserted = await client.query(
          `INSERT INTO employee_wallet_entries(company_id,employee_id,employee_name,kind,points,reason,idempotency_key,request_payload,created_by,created_by_name)
        VALUES($1,$2,$3,'manual',$4,$5,$6,$7,$8,$9) RETURNING id`,
          [
            companyId,
            employee.id,
            employee.name,
            input.points,
            input.reason,
            input.idempotencyKey,
            JSON.stringify(payload),
            user.id,
            user.displayName,
          ],
        );
        const after = walletEntryDTO(
          (
            await client.query(
              walletEntryQuery + " WHERE l.company_id=$1 AND l.id=$2",
              [companyId, inserted.rows[0].id],
            )
          ).rows[0],
        );
        await audit(
          client,
          user,
          "wallet.award",
          "wallet-entry",
          after.id,
          { wallet: before },
          {
            entry: after,
            wallet: await walletSummary(client, companyId, employee.id),
          },
          companyId,
        );
        return after;
      });
      res.json({ entry });
    }),
  );
  router.post(
    base + "/wallet/reversals",
    handler(async (req, res) => {
      const input = parse(walletReversalSchema, req.body);
      const entry = await transaction(pool, async (client) => {
        const { companyId, user, context } = await scope(client, req, true);
        manageEmployees(user, context);
        const payload = {
          kind: "reversal",
          entryId: input.entryId,
          reason: input.reason,
        };
        const previous = await replayWalletEntry(
          client,
          companyId,
          user.id,
          input.idempotencyKey,
          payload,
        );
        if (previous) return previous;
        const found = await client.query(
          walletEntryQuery + " WHERE l.company_id=$1 AND l.id=$2",
          [companyId, input.entryId],
        );
        if (!found.rows[0]) missing();
        const original = walletEntryDTO(found.rows[0]);
        if (!["manual", "automatic"].includes(original.kind))
          throw new HttpError(
            400,
            "invalid_reversal",
            "يمكن عكس مكافأة أصلية إدارية أو آلية فقط",
          );
        if (original.reversedByEntryId !== null)
          throw new HttpError(
            409,
            "already_reversed",
            "عُكست هذه المكافأة سابقًا",
          );
        const employee = await activeEmployee(
          client,
          companyId,
          original.employeeId,
        );
        const before = await walletSummary(client, companyId, employee.id);
        if (!before || BigInt(before.points) < BigInt(original.points))
          throw new HttpError(
            409,
            "insufficient_points",
            "الرصيد المتاح لا يكفي لعكس المكافأة",
          );
        const inserted = await client.query(
          `INSERT INTO employee_wallet_entries(company_id,employee_id,employee_name,kind,points,reason,reference_id,idempotency_key,request_payload,created_by,created_by_name)
        VALUES($1,$2,$3,'reversal',$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [
            companyId,
            employee.id,
            employee.name,
            (-BigInt(original.points)).toString(),
            input.reason,
            original.id,
            input.idempotencyKey,
            JSON.stringify(payload),
            user.id,
            user.displayName,
          ],
        );
        const after = walletEntryDTO(
          (
            await client.query(
              walletEntryQuery + " WHERE l.company_id=$1 AND l.id=$2",
              [companyId, inserted.rows[0].id],
            )
          ).rows[0],
        );
        await audit(
          client,
          user,
          "wallet.reverse",
          "wallet-entry",
          after.id,
          { entry: original, wallet: before },
          {
            entry: after,
            wallet: await walletSummary(client, companyId, employee.id),
          },
          companyId,
        );
        return after;
      });
      res.json({ entry });
    }),
  );
  router.get(
    base + "/reward-tasks",
    handler(async (req, res) => {
      const result = await transaction(pool, async (client) => {
        await client.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        const { companyId, user, context } = await scope(client, req);
        manageEmployees(user, context);
        const tasks = (
          await client.query(rewardTaskQuery + " ORDER BY d.code", [companyId])
        ).rows.map(rewardTaskDTO);
        const roles = (
          await client.query(
            "SELECT id,name FROM company_roles WHERE company_id=$1 AND active ORDER BY name,id",
            [companyId],
          )
        ).rows;
        const pages = pageDefinitions
          .filter((page) => page.scope === "company")
          .map((page) => ({ key: page.key, name: page.name }));
        return { tasks, roles, pages };
      });
      res.json(result);
    }),
  );
  router.put(
    base + "/reward-tasks/:code",
    handler(async (req, res) => {
      const input = parse(rewardTaskSettingsSchema, req.body),
        code = typeof req.params.code === "string" ? req.params.code : "";
      const task = await transaction(pool, async (client) => {
        const { companyId, user, context } = await scope(client, req, true);
        manageEmployees(user, context);
        const before = await rewardTask(client, companyId, code);
        if (!before) missing();
        if (input.enabled && !before.implemented)
          throw new HttpError(
            400,
            "not_implemented",
            "هذه المهمة مخططة؛ لا يمكن تفعيلها قبل ربط الحدث الآلي في النظام",
          );
        if (
          input.enabled &&
          [
            "SALE_SAVED",
            "PURCHASE_SAVED",
            "SALE_LINES",
            "PURCHASE_LINES",
            "RECEIPT_PRINT",
            "PAYMENT_PRINT",
          ].includes(code) &&
          input.repeatRule !== "per-document"
        )
          throw new HttpError(
            400,
            "invalid_repeat_rule",
            "مكافآت الفواتير والطباعة تُحتسب مرة لكل مستند جديد فقط",
          );
        if (
          input.enabled &&
          code === "PAGE_VISIT" &&
          (!input.pageKey ||
            input.points === "0" ||
            input.repeatRule === "per-document")
        )
          throw new HttpError(
            400,
            "invalid_page_visit",
            "مكافأة زيارة الصفحة تتطلب صفحة محددة ونقاطًا موجبة وتكرارًا زمنيًا",
          );
        if (
          input.enabled &&
          code === "DAILY_LOGIN" &&
          (input.repeatRule !== "daily" || input.points === "0")
        )
          throw new HttpError(
            400,
            "invalid_daily_login",
            "مكافأة دخول الشركة تتطلب نقاطًا موجبة وتكرارًا يوميًا",
          );
        if (input.revision !== before.revision)
          throw new HttpError(
            409,
            "conflict",
            "تغير كرت المهمة؛ أعد تحميله قبل الحفظ",
          );
        if (
          input.pageKey !== null &&
          (code !== "PAGE_VISIT" ||
            !pageDefinitions.some(
              (page) => page.key === input.pageKey && page.scope === "company",
            ))
        )
          throw new HttpError(
            400,
            "invalid_page",
            "اختر صفحة شركة من الدليل لمهمة زيارة الصفحة فقط",
          );
        const roles = await client.query(
          "SELECT id FROM company_roles WHERE company_id=$1 AND active AND id=ANY($2::integer[]) FOR SHARE",
          [companyId, input.roleIds],
        );
        if (roles.rowCount !== input.roleIds.length)
          throw new HttpError(
            400,
            "invalid_roles",
            "اختر أدوارًا فعالة من الشركة نفسها",
          );
        await client.query(
          `INSERT INTO reward_task_settings(company_id,code,points,repeat_rule,enabled,page_key,daily_limit,updated_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(company_id,code) DO UPDATE SET points=EXCLUDED.points,repeat_rule=EXCLUDED.repeat_rule,
        enabled=EXCLUDED.enabled,page_key=EXCLUDED.page_key,daily_limit=EXCLUDED.daily_limit,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp(),revision=reward_task_settings.revision+1`,
          [
            companyId,
            code,
            input.points,
            input.repeatRule,
            input.enabled,
            input.pageKey,
            input.dailyLimit,
            user.id,
          ],
        );
        await client.query(
          "DELETE FROM reward_task_roles WHERE company_id=$1 AND code=$2",
          [companyId, code],
        );
        await client.query(
          "INSERT INTO reward_task_roles(company_id,code,role_id) SELECT $1,$2,unnest($3::integer[])",
          [companyId, code, [...input.roleIds].sort((a, b) => a - b)],
        );
        const after = await rewardTask(client, companyId, code);
        await audit(
          client,
          user,
          "wallet.task",
          "reward-task",
          null,
          before,
          after,
          companyId,
        );
        return after;
      });
      res.json({ task });
    }),
  );
  return router;
}
