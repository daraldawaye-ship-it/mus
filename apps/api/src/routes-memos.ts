import { Router, type Request } from "express";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { z } from "zod";
import {
  memoCreateSchema,
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
  action: "view" | "create",
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
  if (action === "create") assertDirectoryAccess(entry, "create");
  if (detail)
    assertDirectoryAccess(
      entries.find((entry) => entry.key === "company.memo-detail")!,
    );
}
const readJoins = `LEFT JOIN memo_reads own_read ON own_read.company_id=m.company_id AND own_read.memo_id=m.id AND own_read.user_id=$2
 LEFT JOIN memo_reads recipient_read ON recipient_read.company_id=m.company_id AND recipient_read.memo_id=m.id AND recipient_read.user_id=m.recipient_user_id`;
const time = (value: Date | null | undefined) => value?.toISOString() ?? null;
function summary(row: QueryResultRow): MemoSummary {
  return {
    id: row.id,
    companyId: row.company_id,
    title: row.title,
    type: row.type,
    status: "pending",
    revision: 1,
    senderUserId: row.sender_user_id,
    senderName: row.sender_name,
    recipientEmployeeId: row.recipient_employee_id,
    recipientUserId: row.recipient_user_id,
    recipientName: row.recipient_name,
    createdAt: row.created_at.toISOString(),
    readAt: time(row.read_at),
    recipientReadAt: time(row.recipient_read_at),
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
      `SELECT m.*,own_read.read_at,recipient_read.read_at AS recipient_read_at FROM memos m ${readJoins}
     WHERE m.company_id=$1 AND m.id=$3 AND ($4::boolean OR m.sender_user_id=$2 OR (m.recipient_user_id=$2 AND m.recipient_employee_id=$5::integer))`,
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
      "SELECT id,kind,actor_user_id,actor_name,created_at FROM memo_events WHERE company_id=$1 AND memo_id=$2 ORDER BY created_at,id",
      [current.companyId, memoId],
    )
  ).rows.map((event) => ({
    id: event.id,
    kind: event.kind,
    actorUserId: event.actor_user_id,
    actorName: event.actor_name,
    createdAt: event.created_at.toISOString(),
  }));
  return { ...record(row), events };
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
      if (typeof box !== "string" || !["required", "sent", "all"].includes(box))
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
              "m.recipient_user_id=$2 AND m.recipient_employee_id=$3::integer";
          } else if (box === "sent") filter = "m.sender_user_id=$2";
          values.push(searchPattern(query.q));
          const search = `$${values.length}`;
          // Detail text belongs to the detail page, whose view can be denied separately.
          const where = `m.company_id=$1 AND (${filter}) AND (m.title ILIKE ${search} OR m.sender_name ILIKE ${search} OR m.recipient_name ILIKE ${search})`;
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
              `SELECT m.id,m.company_id,m.title,m.type,m.sender_user_id,m.sender_name,m.recipient_employee_id,m.recipient_user_id,m.recipient_name,m.created_at,
         own_read.read_at,recipient_read.read_at AS recipient_read_at FROM memos m ${readJoins} WHERE ${where}
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
        await access(client, req, current, "create");
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
            `INSERT INTO memos(company_id,title,body,type,sender_user_id,sender_name,recipient_employee_id,recipient_user_id,recipient_name,idempotency_key,request_payload)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id,created_at`,
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
        const { events: _events, ...snapshot } = saved;
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
        await detail(client, current, memoId);
        const read = (
          await client.query(
            "INSERT INTO memo_reads(company_id,memo_id,user_id,read_at) VALUES($1,$2,$3,clock_timestamp()) ON CONFLICT DO NOTHING RETURNING read_at",
            [current.companyId, memoId, current.user.id],
          )
        ).rows[0];
        if (read) {
          await client.query(
            "INSERT INTO memo_events(company_id,memo_id,kind,actor_user_id,actor_name,created_at) VALUES($1,$2,'read',$3,$4,$5)",
            [
              current.companyId,
              memoId,
              current.user.id,
              current.user.displayName,
              read.read_at,
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
              readAt: read.read_at.toISOString(),
              readerUserId: current.user.id,
            },
            current.companyId,
          );
        }
        // Opening a memo clears its matching alert's unread indicator only.
        const alerts = (
          await client.query(
            `UPDATE notifications SET read_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp()
         WHERE company_id=$1 AND code='MEMO_RECEIVED' AND subject_key=$2 AND recipient_user_id=$3 AND subject_employee_id=$4
         AND read_at IS NULL AND completed_at IS NULL RETURNING id,read_at,revision`,
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
  return router;
}
