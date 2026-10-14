import { Router, type Request } from "express";
import type { Pool, PoolClient } from "pg";
import {
  notificationSettingsSchema,
  notificationActionSchema,
  type NotificationRecord,
} from "../../../packages/contracts/src/index.ts";
import { transaction } from "./db.ts";
import { actor, handler, id, parse } from "./http.ts";
import {
  currentActor,
  companyAccess,
  ownerOnly,
  manageEmployees,
} from "./policies/access.ts";
import { HttpError, missing, deny } from "./errors.ts";
import { assertRequestPagesEnabled } from "./services/pages.ts";
import { audit } from "./services/audit.ts";
import { listQuery, searchPattern } from "./services/lists.ts";
import {
  templateQuery,
  templateDTO,
  effectiveTemplate,
  notificationSelect,
  inboxFilter,
  notificationDTO,
  nextReminder,
} from "./services/notifications.ts";

async function scope(client: PoolClient, req: Request, write = false) {
  const user = await currentActor(client, actor(req), write),
    companyId = req.params.companyId ? id(req.params.companyId) : null;
  const context =
    companyId !== null
      ? await companyAccess(client, user, companyId, undefined, write)
      : null;
  if (write) await assertRequestPagesEnabled(client, req, true);
  return {
    user,
    companyId,
    context,
    general: context?.general ?? user.owner,
    ownId: context?.employee?.id ?? null,
  };
}
export function notificationRoutes(pool: Pool) {
  const router = Router();
  for (const base of ["", "/companies/:companyId"]) {
    router.get(
      base + "/notification-templates",
      handler(async (req, res) => {
        const result = await transaction(pool, async (client) => {
          await client.query(
            "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
          );
          const { user, companyId, context } = await scope(client, req);
          context ? manageEmployees(user, context) : ownerOnly(user);
          const found = await client.query(
            templateQuery +
              " WHERE t.scope=CASE WHEN $1::integer IS NULL THEN 'public' ELSE 'company' END ORDER BY t.category,t.name,t.code",
            [companyId],
          );
          const employees = companyId
            ? (
                await client.query(
                  "SELECT e.id,e.name FROM employees e JOIN users u ON u.id=e.user_id AND NOT u.archived WHERE e.company_id=$1 AND e.active ORDER BY e.name,e.id",
                  [companyId],
                )
              ).rows
            : [];
          const roles = companyId
            ? (
                await client.query(
                  "SELECT id,name FROM company_roles WHERE company_id=$1 AND active ORDER BY name,id",
                  [companyId],
                )
              ).rows
            : [];
          return { templates: found.rows.map(templateDTO), employees, roles };
        });
        res.json(result);
      }),
    );
    router.put(
      base + "/notification-templates/:code",
      handler(async (req, res) => {
        const input = parse(notificationSettingsSchema, req.body),
          code = req.params.code;
        const result = await transaction(pool, async (client) => {
          const { user, companyId, context } = await scope(client, req, true);
          context ? manageEmployees(user, context) : ownerOnly(user);
          const before = await effectiveTemplate(
            client,
            companyId,
            typeof code === "string" ? code : "",
          );
          if (!before) missing();
          if (input.enabled && !before.implemented)
            throw new HttpError(
              400,
              "not_implemented",
              "هذا النوع مخطط ولم يُربط بحدث في النظام بعد",
            );
          if (!input.enabled && !before.canDisable && before.implemented)
            throw new HttpError(
              400,
              "critical_notification",
              "لا يمكن تعطيل هذا التنبيه",
            );
          if (before.code === "AUTH_PASSWORD_CHANGED" && !input.notifySubject)
            throw new HttpError(
              400,
              "critical_notification",
              "تنبيه تغيير كلمة المرور يجب أن يصل لصاحب الحساب",
            );
          if (before.revision !== input.revision)
            throw new HttpError(
              409,
              "conflict",
              "تغير كرت التنبيه؛ أعد تحميله قبل الحفظ",
            );
          if (
            companyId === null &&
            (input.roleIds.length || input.employeeIds.length)
          )
            throw new HttpError(
              400,
              "invalid_scope",
              "الأدوار والموظفون يخصون الشركات فقط",
            );
          if (companyId) {
            const validEmployees = (
              await client.query(
                "SELECT e.id FROM employees e JOIN users u ON u.id=e.user_id AND NOT u.archived WHERE e.company_id=$1 AND e.active AND e.id=ANY($2::integer[]) FOR SHARE OF e",
                [companyId, input.employeeIds],
              )
            ).rows;
            const validRoles = (
              await client.query(
                "SELECT id FROM company_roles WHERE company_id=$1 AND active AND id=ANY($2::integer[]) FOR SHARE",
                [companyId, input.roleIds],
              )
            ).rows;
            if (
              validEmployees.length !== input.employeeIds.length ||
              validRoles.length !== input.roleIds.length
            )
              throw new HttpError(
                400,
                "invalid_followers",
                "اختر أدوارًا وموظفين فعالين من الشركة نفسها",
              );
          }
          await client.query(
            `INSERT INTO notification_settings(company_id,code,importance,enabled,can_snooze,allow_repeat,repeat_interval,notify_managers,notify_subject,role_ids,employee_ids,updated_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(company_id,code) DO UPDATE SET importance=EXCLUDED.importance,enabled=EXCLUDED.enabled,can_snooze=EXCLUDED.can_snooze,
    allow_repeat=EXCLUDED.allow_repeat,repeat_interval=EXCLUDED.repeat_interval,notify_managers=EXCLUDED.notify_managers,notify_subject=EXCLUDED.notify_subject,role_ids=EXCLUDED.role_ids,employee_ids=EXCLUDED.employee_ids,
    revision=notification_settings.revision+1,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()`,
            [
              companyId,
              before.code,
              input.importance,
              input.enabled,
              input.canSnooze,
              input.allowRepeat,
              input.repeatInterval,
              input.notifyManagers,
              input.notifySubject,
              [...input.roleIds].sort((a, b) => a - b),
              [...input.employeeIds].sort((a, b) => a - b),
              user.id,
            ],
          );
          const after = await effectiveTemplate(client, companyId, before.code);
          await audit(
            client,
            user,
            "notification.settings",
            "notification-template",
            null,
            before,
            after,
            companyId,
          );
          return after;
        });
        res.json({ template: result });
      }),
    );
    router.get(
      base + "/notifications",
      handler(async (req, res) => {
        const result = await transaction(pool, async (client) => {
          await client.query(
            "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
          );
          const { user, companyId, context, general, ownId } = await scope(
              client,
              req,
            ),
            state = req.query.state ?? "active";
          if (
            typeof state !== "string" ||
            !["active", "snoozed", "done", "all"].includes(state)
          )
            throw new HttpError(400, "invalid_query", "حالة التنبيه غير صالحة");
          const query = listQuery(
            req.query,
            {
              id: "n.id",
              createdAt: "n.created_at",
              title: "n.title",
              code: "n.code",
              importance:
                "CASE n.importance WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END",
              readAt: "n.read_at",
              completedAt: "n.completed_at",
            },
            "createdAt:desc,id:desc",
          );
          const stateFilter =
            state === "active"
              ? "n.completed_at IS NULL AND (n.snoozed_until IS NULL OR n.snoozed_until<=clock_timestamp())"
              : state === "snoozed"
                ? "n.completed_at IS NULL AND n.snoozed_until>clock_timestamp()"
                : state === "done"
                  ? "n.completed_at IS NOT NULL"
                  : "true";
          const args = [
            user.id,
            companyId,
            ownId,
            general,
            searchPattern(query.q),
          ];
          const filter =
            inboxFilter +
            ` AND ${stateFilter} AND (n.title ILIKE $5 OR n.message ILIKE $5 OR n.code ILIKE $5)`;
          const from =
            " FROM notifications n JOIN notification_templates t ON t.code=n.code LEFT JOIN notification_settings s ON s.company_id IS NOT DISTINCT FROM n.company_id AND s.code=n.code";
          const total = (
            await client.query(
              "SELECT count(*)::integer AS total" + from + " WHERE " + filter,
              args,
            )
          ).rows[0].total;
          const unread = (
            await client.query(
              "SELECT count(*)::integer AS total" +
                from +
                " WHERE " +
                inboxFilter +
                " AND n.read_at IS NULL AND n.completed_at IS NULL AND (n.snoozed_until IS NULL OR n.snoozed_until<=clock_timestamp())",
              args.slice(0, 4),
            )
          ).rows[0].total;
          const rows = (
            await client.query(
              notificationSelect +
                ` WHERE ${filter} ORDER BY ${query.order} LIMIT $6 OFFSET $7`,
              [...args, query.pageSize, query.offset],
            )
          ).rows;
          const employees =
            companyId && context?.general
              ? (
                  await client.query(
                    "SELECT e.id,e.name FROM employees e JOIN users u ON u.id=e.user_id AND NOT u.archived WHERE e.company_id=$1 AND e.active ORDER BY e.name,e.id",
                    [companyId],
                  )
                ).rows
              : [];
          return {
            items: rows.map((r) => notificationDTO(r, general)),
            total,
            unread,
            page: query.page,
            pageSize: query.pageSize,
            employees,
          };
        });
        res.json(result);
      }),
    );
    router.post(
      base + "/notifications/:notificationId/action",
      handler(async (req, res) => {
        const input = parse(notificationActionSchema, req.body),
          notificationId = id(req.params.notificationId);
        const result = await transaction(pool, async (client) => {
          const { user, companyId, context, general, ownId } = await scope(
            client,
            req,
            true,
          );
          const row = (
            await client.query(
              notificationSelect +
                ` WHERE ${inboxFilter} AND n.id=$5 FOR UPDATE OF n`,
              [user.id, companyId, ownId, general, notificationId],
            )
          ).rows[0];
          if (!row) missing();
          const before = notificationDTO(row, general);
          if (input.action === "complete" && row.completed_at) return before;
          if (input.action === "read" && row.read_at) return before;
          if (row.completed_at)
            throw new HttpError(
              409,
              "completed",
              "التنبيه منجز ولا يقبل تعديل المتابعة",
            );
          if (row.revision !== input.revision)
            throw new HttpError(
              409,
              "conflict",
              "تغيرت متابعة التنبيه؛ حدّث القائمة وأعد المحاولة",
            );
          let targetId = row.id;
          if (input.action === "snooze") {
            if (!before.canSnooze) deny("لا يسمح كرت هذا النوع بالتأجيل");
            const until = new Date(input.until),
              now = (await client.query("SELECT clock_timestamp() AS now"))
                .rows[0].now as Date;
            if (
              until <= now ||
              until.getTime() > now.getTime() + 366 * 86400000
            )
              throw new HttpError(
                400,
                "invalid_snooze",
                "اختر تاريخًا لاحقًا خلال سنة",
              );
            await client.query(
              "UPDATE notifications SET snoozed_until=$1,read_at=COALESCE(read_at,clock_timestamp()),revision=revision+1,updated_at=clock_timestamp() WHERE id=$2",
              [until, row.id],
            );
          } else if (input.action === "repeat") {
            if (input.repeatInterval !== "none" && !before.canRepeat)
              throw new HttpError(
                400,
                "repeat_disabled",
                "التكرار غير مسموح في كرت هذا النوع",
              );
            const next = await nextReminder(client, input.repeatInterval);
            await client.query(
              "UPDATE notifications SET repeat_interval=$1,next_reminder_at=$2,revision=revision+1,updated_at=clock_timestamp() WHERE id=$3",
              [input.repeatInterval, next, row.id],
            );
          } else if (input.action === "priority") {
            if (!(row.company_id === null ? user.owner : context?.general))
              deny("تحديد أهمية التنبيه للمدير");
            await client.query(
              "UPDATE notifications SET importance=$1,revision=revision+1,updated_at=clock_timestamp() WHERE id=$2",
              [input.importance, row.id],
            );
          } else if (input.action === "assign") {
            if (row.code === "MEMO_RECEIVED")
              deny("لا يمكن إسناد تنبيه مذكرة إلى موظف آخر");
            if (!before.canAssign || !row.company_id || !context?.general)
              deny("إسناد المتابعة للمدير داخل الشركة");
            if (input.repeatInterval !== "none" && !before.canRepeat)
              throw new HttpError(
                400,
                "repeat_disabled",
                "التكرار غير مسموح في كرت هذا النوع",
              );
            const target = (
              await client.query(
                "SELECT e.user_id FROM employees e JOIN users u ON u.id=e.user_id AND NOT u.archived WHERE e.company_id=$1 AND e.id=$2 AND e.active FOR SHARE OF e",
                [row.company_id, input.employeeId],
              )
            ).rows[0];
            if (!target)
              throw new HttpError(
                400,
                "invalid_employee",
                "اختر موظفًا فعالًا من الشركة",
              );
            const next = await nextReminder(client, input.repeatInterval);
            const inserted = (
              await client.query(
                `INSERT INTO notifications(company_id,code,recipient_user_id,subject_employee_id,subject_key,event_key,title,message,importance,href,assigned,repeat_interval,next_reminder_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11,$12) ON CONFLICT DO NOTHING RETURNING id`,
                [
                  row.company_id,
                  row.code,
                  target.user_id,
                  row.subject_employee_id,
                  row.subject_key,
                  row.event_key,
                  row.title,
                  row.message,
                  row.importance,
                  row.href,
                  input.repeatInterval,
                  next,
                ],
              )
            ).rows[0];
            if (inserted) targetId = inserted.id;
            else {
              const existing = (
                await client.query(
                  "SELECT * FROM notifications WHERE company_id=$1 AND recipient_user_id=$2 AND code=$3 AND subject_key=$4 AND completed_at IS NULL ORDER BY id LIMIT 1 FOR UPDATE",
                  [row.company_id, target.user_id, row.code, row.subject_key],
                )
              ).rows[0];
              if (!existing)
                throw new HttpError(
                  409,
                  "already_completed",
                  "أنجز الموظف هذا التنبيه بالفعل",
                );
              targetId = existing.id;
              await client.query(
                "UPDATE notifications SET assigned=true,read_at=NULL,repeat_interval=$1,next_reminder_at=$2,revision=revision+1,updated_at=clock_timestamp() WHERE id=$3",
                [input.repeatInterval, next, targetId],
              );
            }
            await audit(
              client,
              user,
              "notification.assign",
              "notification",
              targetId,
              null,
              {
                fromNotificationId: row.id,
                employeeId: input.employeeId,
                repeatInterval: input.repeatInterval,
              },
              row.company_id,
            );
            return notificationDTO(
              (
                await client.query(notificationSelect + " WHERE n.id=$1", [
                  targetId,
                ])
              ).rows[0],
              general,
            );
          } else {
            await client.query(
              input.action === "complete"
                ? "UPDATE notifications SET completed_at=clock_timestamp(),read_at=COALESCE(read_at,clock_timestamp()),snoozed_until=NULL,next_reminder_at=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1"
                : "UPDATE notifications SET read_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1",
              [row.id],
            );
          }
          const after = notificationDTO(
            (
              await client.query(notificationSelect + " WHERE n.id=$1", [
                targetId,
              ])
            ).rows[0],
            general,
          );
          await audit(
            client,
            user,
            "notification.follow",
            "notification",
            row.id,
            before,
            after,
            row.company_id,
          );
          return after;
        });
        res.json({ notification: result });
      }),
    );
  }
  return router;
}
