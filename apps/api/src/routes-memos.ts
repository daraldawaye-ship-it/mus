import { Router, type Request } from "express";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { z } from "zod";
import {
  memoCreateSchema,
  memoActionSchema,
  type MemoDetail,
  type MemoRecord,
  type MemoList,
  type MemoSummary,
} from "../../../packages/contracts/src/index.ts";
import { actor, handler, id, parse } from "./http.ts";
import { transaction } from "./db.ts";
import { companyAccess, currentActor } from "./policies/access.ts";
import { HttpError, missing, deny } from "./errors.ts";
import { audit } from "./services/audit.ts";
import { emitNotification } from "./services/notifications.ts";
import { listQuery, searchPattern } from "./services/lists.ts";
import {
  assertDirectoryAccess,
  assertRequestPagesEnabled,
  directoryEntries,
} from "./services/pages.ts";

async function scope(client: PoolClient, req: Request, write = false) {
  const companyId = id(req.params.companyId);
  const user = await currentActor(client, actor(req), write);
  const context = await companyAccess(
    client,
    user,
    companyId,
    undefined,
    write,
  );
  return { companyId, user, context, ownId: context.employee?.id ?? null };
}
type Scope = Awaited<ReturnType<typeof scope>>;
async function access(
  client: PoolClient,
  req: Request,
  current: Scope,
  action: "view" | "create" | "edit",
  detail = false,
  write = false,
) {
  if (write) await assertRequestPagesEnabled(client, req, true);
  const entries = await directoryEntries(
    client,
    current.user,
    current.companyId,
  );
  const entry = entries.find((entry) => entry.key === "company.memos")!;
  assertDirectoryAccess(entry, "view");
  if (action !== "view") assertDirectoryAccess(entry, action);
  if (detail)
    assertDirectoryAccess(
      entries.find((entry) => entry.key === "company.memo-detail")!,
    );
}
const readJoins = `LEFT JOIN memo_reads own_read ON own_read.company_id=m.company_id AND own_read.memo_id=m.id AND own_read.user_id=$2
 LEFT JOIN memo_reads recipient_read ON recipient_read.company_id=m.company_id AND recipient_read.memo_id=m.id AND recipient_read.user_id=m.recipient_user_id
 LEFT JOIN memo_assignment_reads current_read ON current_read.company_id=m.company_id AND current_read.memo_id=m.id AND current_read.assignment_revision=m.current_assignment_revision AND current_read.user_id=m.current_user_id`;
const time = (value: Date | null | undefined) => value?.toISOString() ?? null;
function summary(row: QueryResultRow): MemoSummary {
  return {
    id: row.id,
    companyId: row.company_id,
    title: row.title,
    type: row.type,
    status: "pending",
    revision: row.revision,
    senderUserId: row.sender_user_id,
    senderName: row.sender_name,
    recipientEmployeeId: row.recipient_employee_id,
    recipientUserId: row.recipient_user_id,
    recipientName: row.recipient_name,
    createdAt: row.created_at.toISOString(),
    readAt: time(row.read_at),
    recipientReadAt: time(row.recipient_read_at),
    currentUserId: row.current_user_id,
    currentEmployeeId: row.current_employee_id,
    currentName: row.current_name,
    currentAssignedAt: row.current_assigned_at.toISOString(),
    currentAssignmentRevision: row.current_assignment_revision,
    currentReadAt: time(row.current_read_at),
  };
}
function record(row: QueryResultRow): MemoRecord {
  return { ...summary(row), body: row.body };
}
async function detail(
  client: PoolClient,
  current: Scope,
  memoId: number,
): Promise<MemoDetail> {
  const row = (
    await client.query(
      `SELECT m.*,own_read.read_at,recipient_read.read_at AS recipient_read_at,current_read.read_at AS current_read_at FROM memos m ${readJoins}
     WHERE m.company_id=$1 AND m.id=$3 AND ($4::boolean OR m.sender_user_id=$2 OR (m.current_user_id=$2 AND (m.current_employee_id IS NULL OR m.current_employee_id=$5::integer)) OR EXISTS(SELECT 1 FROM memo_participants p WHERE p.company_id=m.company_id AND p.memo_id=m.id AND p.user_id=$2 AND (p.employee_id IS NULL OR p.employee_id=$5::integer)))`,
      [
        current.companyId,
        current.user.id,
        memoId,
        current.context.general,
        current.ownId,
      ],
    )
  ).rows[0];
  if (!row) missing();
  const events = (
    await client.query(
      "SELECT id,kind,actor_user_id,actor_name,created_at,body,target_user_id,target_employee_id,target_name,assignment_revision FROM memo_events WHERE company_id=$1 AND memo_id=$2 ORDER BY created_at,id",
      [current.companyId, memoId],
    )
  ).rows.map((event) => ({
    id: event.id,
    kind: event.kind,
    actorUserId: event.actor_user_id,
    actorName: event.actor_name,
    createdAt: event.created_at.toISOString(),
    body: event.body,
    targetUserId: event.target_user_id,
    targetEmployeeId: event.target_employee_id,
    targetName: event.target_name,
    assignmentRevision: event.assignment_revision,
  }));
  const participant = !!(
    await client.query(
      "SELECT 1 FROM memo_participants WHERE company_id=$1 AND memo_id=$2 AND user_id=$3 AND (employee_id IS NULL OR employee_id=$4::integer)",
      [current.companyId, memoId, current.user.id, current.ownId],
    )
  ).rowCount;
  const entry = (
    await directoryEntries(client, current.user, current.companyId)
  ).find((entry) => entry.key === "company.memos")!;
  const currentAssignee =
    row.current_user_id === current.user.id &&
    (row.current_employee_id === null ||
      row.current_employee_id === current.ownId);
  const canReply =
    (participant ||
      currentAssignee ||
      row.sender_user_id === current.user.id) &&
    entry.enabled &&
    entry.actionAccess.edit;
  return {
    ...record(row),
    events,
    canReply,
    canTransfer: canReply && currentAssignee,
  };
}
async function supersedeMemoAlerts(
  client: PoolClient,
  current: Scope,
  memoId: number,
  code: string,
  userId: number | null,
  reason: string,
) {
  const alerts = (
    await client.query(
      `UPDATE notifications SET completed_at=clock_timestamp(),read_at=COALESCE(read_at,clock_timestamp()),snoozed_until=NULL,next_reminder_at=NULL,revision=revision+1,updated_at=clock_timestamp()
     WHERE company_id=$1 AND subject_key=$2 AND code=$3 AND ($4::integer IS NULL OR recipient_user_id=$4) AND completed_at IS NULL RETURNING id,revision,completed_at`,
      [current.companyId, `memo:${memoId}`, code, userId],
    )
  ).rows;
  for (const alert of alerts)
    await audit(
      client,
      current.user,
      "notification.follow",
      "notification",
      alert.id,
      { completedAt: null },
      {
        action: "supersede",
        reason,
        completedAt: alert.completed_at.toISOString(),
        revision: alert.revision,
      },
      current.companyId,
    );
}
export function memoRoutes(pool: Pool) {
  const router = Router(),
    base = "/companies/:companyId/memos";
  router.get(
    base,
    handler(async (req, res) => {
      const query = listQuery(
        req.query,
        {
          id: "m.id",
          createdAt: "m.created_at",
          title: "m.title",
          type: "m.type",
        },
        "createdAt:desc",
      );
      const box = req.query.box ?? "required";
      if (
        typeof box !== "string" ||
        !["required", "sent", "following", "all"].includes(box)
      )
        throw new HttpError(400, "invalid_query", "قائمة المذكرات غير صالحة");
      const result = await transaction(
        pool,
        async (client): Promise<MemoList> => {
          await client.query(
            "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
          );
          const current = await scope(client, req);
          await access(client, req, current, "view");
          if (box === "all" && !current.context.general) deny();
          const values: unknown[] = [current.companyId, current.user.id];
          let filter = "TRUE";
          if (box === "required") {
            values.push(current.ownId);
            filter =
              "m.current_user_id=$2 AND (m.current_employee_id IS NULL OR m.current_employee_id=$3::integer)";
          } else if (box === "sent") filter = "m.sender_user_id=$2";
          else if (box === "following") {
            values.push(current.ownId);
            filter =
              "m.sender_user_id=$2 OR (m.current_user_id=$2 AND (m.current_employee_id IS NULL OR m.current_employee_id=$3::integer)) OR EXISTS(SELECT 1 FROM memo_participants p WHERE p.company_id=m.company_id AND p.memo_id=m.id AND p.user_id=$2 AND (p.employee_id IS NULL OR p.employee_id=$3::integer))";
          }
          values.push(searchPattern(query.q));
          const search = `$${values.length}`;
          // Detail text belongs to the detail page, whose view can be denied separately.
          const where = `m.company_id=$1 AND (${filter}) AND (m.title ILIKE ${search} OR m.sender_name ILIKE ${search} OR m.recipient_name ILIKE ${search} OR m.current_name ILIKE ${search})`;
          const total = Number(
            (
              await client.query(
                `SELECT count(*) FROM memos m ${readJoins} WHERE ${where}`,
                values,
              )
            ).rows[0].count,
          );
          const rows = (
            await client.query(
              `SELECT m.id,m.company_id,m.title,m.type,m.sender_user_id,m.sender_name,m.recipient_employee_id,m.recipient_user_id,m.recipient_name,m.created_at,m.revision,m.current_user_id,m.current_employee_id,m.current_name,m.current_assigned_at,m.current_assignment_revision,
         own_read.read_at,recipient_read.read_at AS recipient_read_at,current_read.read_at AS current_read_at FROM memos m ${readJoins} WHERE ${where}
         ORDER BY ${query.order} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
              [...values, query.pageSize, query.offset],
            )
          ).rows;
          return {
            items: rows.map(summary),
            total,
            page: query.page,
            pageSize: query.pageSize,
            canViewAll: current.context.general,
          };
        },
      );
      res.json(result);
    }),
  );
  router.get(
    base + "/recipients",
    handler(async (req, res) => {
      const query = listQuery(
        req.query,
        { id: "e.id", code: "e.id", name: "e.name", userId: "e.user_id" },
        "name:asc",
      );
      const result = await transaction(pool, async (client) => {
        await client.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        const current = await scope(client, req);
        await access(client, req, current, "view");
        const from =
          "FROM employees e JOIN users u ON u.id=e.user_id AND NOT u.archived WHERE e.company_id=$1 AND e.active AND e.name ILIKE $2";
        const values = [current.companyId, searchPattern(query.q)];
        const total = Number(
          (await client.query(`SELECT count(*) ${from}`, values)).rows[0].count,
        );
        const rows = (
          await client.query(
            `SELECT e.id,e.user_id,e.name ${from} ORDER BY ${query.order} LIMIT $3 OFFSET $4`,
            [...values, query.pageSize, query.offset],
          )
        ).rows;
        return {
          items: rows.map((row) => ({
            id: row.id,
            userId: row.user_id,
            name: row.name,
          })),
          total,
          page: query.page,
          pageSize: query.pageSize,
        };
      });
      res.json(result);
    }),
  );
  router.post(
    base,
    handler(async (req, res) => {
      const input = parse(memoCreateSchema, req.body);
      const payload = {
        title: input.title,
        body: input.body,
        recipientEmployeeId: input.recipientEmployeeId,
        type: input.type,
      };
      const result = await transaction(pool, async (client) => {
        const current = await scope(client, req, true);
        const existing = (
          await client.query(
            "SELECT id,sender_user_id,request_payload=$3::jsonb AS payload_matches FROM memos WHERE company_id=$1 AND idempotency_key=$2",
            [current.companyId, input.idempotencyKey, JSON.stringify(payload)],
          )
        ).rows[0];
        if (existing) {
          if (
            existing.sender_user_id !== current.user.id ||
            !existing.payload_matches
          )
            throw new HttpError(
              409,
              "conflict",
              "مفتاح الطلب مستخدم لمذكرة أو مرسل آخر",
            );
          return {
            memo: await detail(client, current, existing.id),
            created: false,
          };
        }
        await access(client, req, current, "create", false, true);
        const recipient = (
          await client.query(
            `SELECT e.id,e.user_id,e.name FROM employees e JOIN users u ON u.id=e.user_id AND NOT u.archived
         WHERE e.company_id=$1 AND e.id=$2 AND e.active FOR SHARE OF e`,
            [current.companyId, input.recipientEmployeeId],
          )
        ).rows[0];
        if (!recipient)
          throw new HttpError(
            400,
            "invalid_employee",
            "اختر موظفًا فعالًا مرتبطًا بحساب من الشركة نفسها",
          );
        const memo = (
          await client.query(
            `INSERT INTO memos(company_id,title,body,type,sender_user_id,sender_name,recipient_employee_id,recipient_user_id,recipient_name,idempotency_key,request_payload,current_user_id,current_employee_id,current_name)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$8,$7,$9) RETURNING id,created_at`,
            [
              current.companyId,
              input.title,
              input.body,
              input.type,
              current.user.id,
              current.user.displayName,
              recipient.id,
              recipient.user_id,
              recipient.name,
              input.idempotencyKey,
              JSON.stringify(payload),
            ],
          )
        ).rows[0];
        await client.query(
          "INSERT INTO memo_participants(company_id,memo_id,user_id,employee_id,name) VALUES($1,$2,$3,$4,$5),($1,$2,$6,$7,$8) ON CONFLICT DO NOTHING",
          [
            current.companyId,
            memo.id,
            current.user.id,
            current.ownId,
            current.user.displayName,
            recipient.user_id,
            recipient.id,
            recipient.name,
          ],
        );
        await client.query(
          "INSERT INTO memo_events(company_id,memo_id,kind,actor_user_id,actor_name,created_at) VALUES($1,$2,'created',$3,$4,$5)",
          [
            current.companyId,
            memo.id,
            current.user.id,
            current.user.displayName,
            memo.created_at,
          ],
        );
        const saved = await detail(client, current, memo.id);
        const {
          events: _events,
          canReply: _reply,
          canTransfer: _transfer,
          ...snapshot
        } = saved;
        await audit(
          client,
          current.user,
          "memo.create",
          "memo",
          memo.id,
          null,
          snapshot,
          current.companyId,
        );
        await emitNotification(client, {
          code: "MEMO_RECEIVED",
          companyId: current.companyId,
          subjectEmployeeId: recipient.id,
          recipientUserId: recipient.user_id,
          subjectKey: `memo:${memo.id}`,
          eventKey: `memo:${memo.id}:created`,
          explicitSubjectOnly: true,
          title: `${current.user.displayName}: ${input.title}`,
          message: `مذكرة جديدة من ${current.user.displayName}: ${input.title}`,
          href: `/companies/${current.companyId}/memos/${memo.id}`,
        });
        return { memo: saved, created: true };
      });
      res.status(result.created ? 201 : 200).json({ memo: result.memo });
    }),
  );
  router.get(
    base + "/:memoId",
    handler(async (req, res) => {
      const memoId = id(req.params.memoId);
      const memo = await transaction(pool, async (client) => {
        await client.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        const current = await scope(client, req);
        await access(client, req, current, "view", true);
        return detail(client, current, memoId);
      });
      res.json({ memo });
    }),
  );
  router.post(
    base + "/:memoId/read",
    handler(async (req, res) => {
      const memoId = id(req.params.memoId);
      parse(z.object({}).strict(), req.body);
      const memo = await transaction(pool, async (client) => {
        const current = await scope(client, req, true);
        await access(client, req, current, "view", true, true);
        const before = await detail(client, current, memoId);
        const read = (
          await client.query(
            "INSERT INTO memo_reads(company_id,memo_id,user_id,read_at) VALUES($1,$2,$3,clock_timestamp()) ON CONFLICT DO NOTHING RETURNING read_at",
            [current.companyId, memoId, current.user.id],
          )
        ).rows[0];
        const isAssignee =
          before.currentUserId === current.user.id &&
          (before.currentEmployeeId === null ||
            before.currentEmployeeId === current.ownId);
        const assignmentRead = isAssignee
          ? (
              await client.query(
                "INSERT INTO memo_assignment_reads(company_id,memo_id,assignment_revision,user_id,read_at) VALUES($1,$2,$3,$4,clock_timestamp()) ON CONFLICT DO NOTHING RETURNING read_at",
                [
                  current.companyId,
                  memoId,
                  before.currentAssignmentRevision,
                  current.user.id,
                ],
              )
            ).rows[0]
          : null;
        const readAt = assignmentRead?.read_at ?? read?.read_at;
        if (readAt) {
          await client.query(
            "INSERT INTO memo_events(company_id,memo_id,kind,actor_user_id,actor_name,created_at,assignment_revision) VALUES($1,$2,'read',$3,$4,$5,$6)",
            [
              current.companyId,
              memoId,
              current.user.id,
              current.user.displayName,
              readAt,
              assignmentRead ? before.currentAssignmentRevision : null,
            ],
          );
          await audit(
            client,
            current.user,
            "memo.read",
            "memo",
            memoId,
            { readAt: null },
            {
              readAt: readAt.toISOString(),
              readerUserId: current.user.id,
              assignmentRevision: assignmentRead
                ? before.currentAssignmentRevision
                : null,
            },
            current.companyId,
          );
        }
        const alerts = (
          await client.query(
            `UPDATE notifications SET read_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp()
           WHERE company_id=$1 AND code IN ('MEMO_RECEIVED','MEMO_REPLY') AND subject_key=$2 AND recipient_user_id=$3
           AND subject_employee_id IS NOT DISTINCT FROM $4::integer AND read_at IS NULL AND completed_at IS NULL RETURNING id,read_at,revision`,
            [
              current.companyId,
              `memo:${memoId}`,
              current.user.id,
              current.ownId,
            ],
          )
        ).rows;
        for (const alert of alerts)
          await audit(
            client,
            current.user,
            "notification.follow",
            "notification",
            alert.id,
            { readAt: null },
            {
              action: "read",
              readAt: alert.read_at.toISOString(),
              revision: alert.revision,
            },
            current.companyId,
          );
        return detail(client, current, memoId);
      });
      res.json({ memo });
    }),
  );
  router.post(
    base + "/:memoId/actions",
    handler(async (req, res) => {
      const memoId = id(req.params.memoId),
        input = parse(memoActionSchema, req.body);
      const { idempotencyKey, ...payload } = input;
      const result = await transaction(pool, async (client) => {
        const current = await scope(client, req, true);
        const existing = (
          await client.query(
            "SELECT memo_id,actor_user_id,request_payload=$3::jsonb AS payload_matches FROM memo_actions WHERE company_id=$1 AND idempotency_key=$2",
            [current.companyId, idempotencyKey, JSON.stringify(payload)],
          )
        ).rows[0];
        if (existing) {
          if (
            existing.memo_id !== memoId ||
            existing.actor_user_id !== current.user.id ||
            !existing.payload_matches
          )
            throw new HttpError(
              409,
              "conflict",
              "مفتاح الطلب مستخدم لإجراء أو مستخدم آخر",
            );
          return {
            memo: await detail(client, current, memoId),
            created: false,
          };
        }
        await access(client, req, current, "edit", true, true);
        const before = await detail(client, current, memoId);
        if (!before.canReply)
          deny("المشاركة في هذه المذكرة للمشاركين فيها فقط");
        if (input.revision !== before.revision)
          throw new HttpError(
            409,
            "revision_conflict",
            "تغيرت المذكرة؛ حدثها قبل إرسال الإجراء",
          );
        let target: {
          userId: number;
          employeeId: number | null;
          name: string;
        } | null = null;
        if (input.action !== "reply") {
          if (!before.canTransfer)
            deny("التحويل والإعادة للمسؤول الحالي عن المذكرة فقط");
          if (input.action === "forward") {
            const employee = (
              await client.query(
                `SELECT e.id,e.user_id,e.name FROM employees e JOIN users u ON u.id=e.user_id AND NOT u.archived
               WHERE e.company_id=$1 AND e.id=$2 AND e.active FOR SHARE OF e`,
                [current.companyId, input.recipientEmployeeId],
              )
            ).rows[0];
            if (!employee)
              throw new HttpError(
                400,
                "invalid_employee",
                "اختر موظفًا فعالًا من الشركة نفسها",
              );
            target = {
              userId: employee.user_id,
              employeeId: employee.id,
              name: employee.name,
            };
          } else {
            const sender = (
              await client.query(
                `SELECT u.id,e.id AS employee_id FROM users u LEFT JOIN employees e ON e.company_id=$1 AND e.user_id=u.id AND e.active
               WHERE u.id=$2 AND NOT u.archived AND (u.owner OR e.id IS NOT NULL)`,
                [current.companyId, before.senderUserId],
              )
            ).rows[0];
            if (!sender)
              throw new HttpError(
                400,
                "invalid_employee",
                "المرسل الأصلي لم يعد فعالًا في الشركة",
              );
            target = {
              userId: sender.id,
              employeeId: sender.employee_id ?? null,
              name: before.senderName,
            };
          }
          if (target.userId === current.user.id)
            throw new HttpError(
              400,
              "invalid_recipient",
              "المذكرة لديك بالفعل؛ اختر موظفًا آخر",
            );
        }
        const now = (await client.query("SELECT clock_timestamp() AS now"))
          .rows[0].now as Date;
        const nextRevision = before.revision + 1;
        const action = (
          await client.query(
            `INSERT INTO memo_actions(company_id,memo_id,actor_user_id,idempotency_key,request_payload,result_revision,created_at)
           VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
            [
              current.companyId,
              memoId,
              current.user.id,
              idempotencyKey,
              JSON.stringify(payload),
              nextRevision,
              now,
            ],
          )
        ).rows[0];
        if (target) {
          await client.query(
            "INSERT INTO memo_participants(company_id,memo_id,user_id,employee_id,name,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
            [
              current.companyId,
              memoId,
              target.userId,
              target.employeeId,
              target.name,
              now,
            ],
          );
          await client.query(
            "UPDATE memos SET revision=revision+1,current_user_id=$3,current_employee_id=$4,current_name=$5,current_assigned_at=$6,current_assignment_revision=current_assignment_revision+1 WHERE company_id=$1 AND id=$2",
            [
              current.companyId,
              memoId,
              target.userId,
              target.employeeId,
              target.name,
              now,
            ],
          );
        } else
          await client.query(
            "UPDATE memos SET revision=revision+1 WHERE company_id=$1 AND id=$2",
            [current.companyId, memoId],
          );
        await client.query(
          `INSERT INTO memo_events(company_id,memo_id,kind,actor_user_id,actor_name,created_at,body,target_user_id,target_employee_id,target_name,assignment_revision,action_id)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            current.companyId,
            memoId,
            input.action === "return"
              ? "returned"
              : input.action === "forward"
                ? "forwarded"
                : "reply",
            current.user.id,
            current.user.displayName,
            now,
            input.body,
            target?.userId ?? null,
            target?.employeeId ?? null,
            target?.name ?? null,
            target ? before.currentAssignmentRevision + 1 : null,
            action.id,
          ],
        );
        const saved = await detail(client, current, memoId);
        await audit(
          client,
          current.user,
          `memo.${input.action}`,
          "memo",
          memoId,
          {
            revision: before.revision,
            currentUserId: before.currentUserId,
            currentEmployeeId: before.currentEmployeeId,
            currentAssignmentRevision: before.currentAssignmentRevision,
          },
          {
            revision: saved.revision,
            currentUserId: saved.currentUserId,
            currentEmployeeId: saved.currentEmployeeId,
            currentName: saved.currentName,
            currentAssignmentRevision: saved.currentAssignmentRevision,
            actionId: action.id,
            body: input.body,
          },
          current.companyId,
        );
        const notifyTarget =
          target ??
          (current.user.id === before.senderUserId
            ? {
                userId: before.currentUserId,
                employeeId: before.currentEmployeeId,
                name: before.currentName,
              }
            : {
                userId: before.senderUserId,
                employeeId:
                  (
                    await client.query(
                      "SELECT id FROM employees WHERE company_id=$1 AND user_id=$2 AND active",
                      [current.companyId, before.senderUserId],
                    )
                  ).rows[0]?.id ?? null,
                name: before.senderName,
              });
        if (target)
          await supersedeMemoAlerts(
            client,
            current,
            memoId,
            "MEMO_RECEIVED",
            null,
            "memo-transferred",
          );
        if (notifyTarget.userId !== current.user.id) {
          if (!target)
            await supersedeMemoAlerts(
              client,
              current,
              memoId,
              "MEMO_REPLY",
              notifyTarget.userId,
              "new-memo-reply",
            );
          await emitNotification(client, {
            code: target ? "MEMO_RECEIVED" : "MEMO_REPLY",
            companyId: current.companyId,
            recipientUserId: notifyTarget.userId,
            subjectEmployeeId: notifyTarget.employeeId,
            explicitSubjectOnly: true,
            subjectKey: `memo:${memoId}`,
            eventKey: `memo:${memoId}:action:${idempotencyKey}`,
            title: `${current.user.displayName}: ${before.title}`,
            message: `${target ? (input.action === "return" ? "مذكرة أعيدت إليك" : "مذكرة محولة إليك") : "رد جديد على المذكرة"} من ${current.user.displayName}: ${before.title}`,
            href: `/companies/${current.companyId}/memos/${memoId}`,
          });
        }
        return { memo: saved, created: true };
      });
      res.status(result.created ? 201 : 200).json({ memo: result.memo });
    }),
  );
  return router;
}
