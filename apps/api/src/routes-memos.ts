import { Router, type Request } from "express";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { z } from "zod";
import {
  memoCreateSchema,
  memoActionSchema,
  memoFollowersUpdateSchema,
  memoFollowerCommentSchema,
  memoLinksUpdateSchema,
  memoLinksSchema,
  memoOptionsUpdateSchema,
  type MemoFollower,
  type MemoFollowerChange,
  type MemoFollowerInput,
  type MemoDetail,
  type MemoRecord,
  type MemoList,
  type MemoSummary,
  type MemoEvent,
} from "../../../packages/contracts/src/index.ts";
import { actor, handler, id, parse } from "./http.ts";
import { transaction } from "./db.ts";
import { companyAccess, currentActor } from "./policies/access.ts";
import { HttpError, missing, deny } from "./errors.ts";
import { audit } from "./services/audit.ts";
import { emitNotification } from "./services/notifications.ts";
import { listQuery, searchPattern } from "./services/lists.ts";
import { memoFollowerSql } from "./services/memo-followers.ts";
import {validateMemoLinks,memoLinkView,memoLinksSnapshot} from "./services/memo-links.ts";
import {definitionsForMemo,validateMemoOptionEntries,saveMemoOptionValues,memoOptionDetails} from "./services/memo-options.ts";
import { userDTO } from "./repositories/models.ts";
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
  action: "view" | "create" | "edit" | "post",
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
    status: row.status,
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
    completionRequestedByUserId: row.completion_requested_by_user_id,
    completionRequestedByEmployeeId: row.completion_requested_by_employee_id,
    completionRequestedByName: row.completion_requested_by_name,
    completionRequestedAt: time(row.completion_requested_at),
    completedAt: time(row.completed_at),
    completedByUserId: row.completed_by_user_id,
    completedByName: row.completed_by_name,
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
     WHERE m.company_id=$1 AND m.id=$3 AND ($4::boolean OR m.sender_user_id=$2 OR (m.current_user_id=$2 AND (m.current_employee_id IS NULL OR m.current_employee_id=$5::integer)) OR EXISTS(SELECT 1 FROM memo_participants p WHERE p.company_id=m.company_id AND p.memo_id=m.id AND p.user_id=$2 AND (p.employee_id IS NULL OR p.employee_id=$5::integer)) OR ${memoFollowerSql("m", "$5")})`,
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
  const followerRows = (await client.query(
    `SELECT f.id,f.employee_id,f.role_id,f.access_level,f.added_by,f.added_at,
       COALESCE(e.name,r.name) AS name
       FROM memo_followers f
       LEFT JOIN employees e ON e.company_id=f.company_id AND e.id=f.employee_id
       LEFT JOIN company_roles r ON r.company_id=f.company_id AND r.id=f.role_id
       WHERE f.company_id=$1 AND f.memo_id=$2 ORDER BY f.id`,
    [current.companyId,memoId],
  )).rows;
  const followers: MemoFollower[] = followerRows.map((f) => ({
    id: f.id,
    kind: f.employee_id === null ? "role" : "employee",
    employeeId: f.employee_id,
    roleId: f.role_id,
    name: f.name,
    accessLevel: f.access_level,
    addedBy: f.added_by,
    addedAt: f.added_at.toISOString(),
  }));
  const followerChanges: MemoFollowerChange[] = (await client.query(
    "SELECT id,revision,actor_name,created_at,before_value,after_value FROM memo_follow_changes WHERE company_id=$1 AND memo_id=$2 ORDER BY revision,id",
    [current.companyId,memoId],
  )).rows.map(row => ({
    id:row.id, revision:row.revision, actorName:row.actor_name,
    createdAt:row.created_at.toISOString(),
    beforeFollowers:row.before_value,
    afterFollowers:row.after_value,
  }));
    const followRevision = (await client.query(
    "SELECT revision FROM memo_follow_versions WHERE company_id=$1 AND memo_id=$2",
    [current.companyId,memoId],
  )).rows[0]?.revision ?? 1;
  const followerComment = !!(await client.query(
    `SELECT 1 FROM memos m WHERE m.company_id=$1 AND m.id=$2 AND ${memoFollowerSql("m", "$3", "comment")}`,
    [current.companyId,memoId,current.ownId],
  )).rowCount;
  const comments=(await client.query(
    "SELECT id,actor_user_id,actor_name,created_at,body FROM memo_follow_comments WHERE company_id=$1 AND memo_id=$2 ORDER BY created_at,id",
    [current.companyId,memoId],
  )).rows;
  for (const note of comments)
    events.push({
      id: -note.id, kind:"follower_comment",
      actorUserId:note.actor_user_id,actorName:note.actor_name,
      createdAt:note.created_at.toISOString(),body:note.body,
      targetUserId:null,targetEmployeeId:null,targetName:null,assignmentRevision:null,
    });
  events.sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id-b.id);
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
  const senderAssignee =
    row.sender_user_id === current.user.id &&
    row.current_user_id === current.user.id;
  const links = await memoLinkView(client,current.user,current.companyId,memoId);
  const optionDetails = await memoOptionDetails(client,current.companyId,memoId);
  const canManageLinks = row.status !== "completed" &&
    (row.sender_user_id === current.user.id || current.context.general) &&
    entry.enabled && entry.actionAccess.edit &&
    !links.hiddenFollowPage && !links.hiddenReferencePage && !links.hiddenItem && !links.hiddenAccount;
  const canReply =
    row.status !== "completed" &&
    (participant ||
      currentAssignee ||
      row.sender_user_id === current.user.id) &&
    entry.enabled &&
    entry.actionAccess.edit;
  return {
    ...record(row),
    events,
    followers,
    followerRevision: followRevision,
    followerChanges,
    links,
    ...optionDetails,
    canManageOptions:row.status!=="completed" &&
      (row.sender_user_id===current.user.id || current.context.general) &&
      entry.enabled && entry.actionAccess.edit,
    canManageLinks,
    canManageFollowers: row.status !== "completed" &&
      (row.sender_user_id === current.user.id || current.context.general) &&
      entry.enabled && entry.actionAccess.edit,
    canComment: row.status !== "completed" && followerComment &&
      entry.enabled && entry.actionAccess.edit,
    canReply,
    canTransfer: row.status === "pending" && canReply && currentAssignee,
    canRequestCompletion:
      row.status === "pending" &&
      currentAssignee &&
      row.sender_user_id !== current.user.id &&
      entry.enabled &&
      entry.actionAccess.post,
    canApproveCompletion:
      row.status === "awaiting_approval" &&
      senderAssignee &&
      entry.enabled &&
      entry.actionAccess.post,
    canReopenCompletion:
      row.status === "awaiting_approval" &&
      senderAssignee &&
      entry.enabled &&
      entry.actionAccess.post,
    canComplete:
      row.status === "pending" &&
      senderAssignee &&
      entry.enabled &&
      entry.actionAccess.post,
  };
}
async function storeFollowers(
  client: PoolClient, current: Scope, memoId: number,
  followers: MemoFollowerInput[], revision: number, before: unknown[] = [],
) {
  const keys = new Set<string>();
  for (const follower of followers) {
    const key = follower.kind === "employee" ? `e:${follower.employeeId}` : `r:${follower.roleId}`;
    if (keys.has(key)) throw new HttpError(400, "duplicate_follower", "لا يمكن تكرار المتابع نفسه");
    keys.add(key);
    const found = follower.kind === "employee"
      ? await client.query(
          "SELECT 1 FROM employees e JOIN users u ON u.id=e.user_id AND NOT u.archived WHERE e.company_id=$1 AND e.id=$2 AND e.active FOR SHARE OF e",
          [current.companyId,follower.employeeId],
        )
      : await client.query(
          "SELECT 1 FROM company_roles WHERE company_id=$1 AND id=$2 AND active FOR SHARE",
          [current.companyId,follower.roleId],
        );
    if (!found.rowCount) throw new HttpError(400, "invalid_follower", "الموظف أو الدور غير فعّال في هذه الشركة");
  }
  await client.query("DELETE FROM memo_followers WHERE company_id=$1 AND memo_id=$2",
    [current.companyId,memoId]);
  for (const follower of followers)
    await client.query(
      "INSERT INTO memo_followers(company_id,memo_id,employee_id,role_id,access_level,added_by) VALUES($1,$2,$3,$4,$5,$6)",
      [current.companyId,memoId,follower.kind==="employee"?follower.employeeId:null,
        follower.kind==="role"?follower.roleId:null,follower.accessLevel,current.user.id],
    );
  const after = followers.map((f) => ({...f}));
  await client.query(
    "INSERT INTO memo_follow_changes(company_id,memo_id,revision,actor_user_id,actor_name,before_value,after_value) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)",
    [current.companyId,memoId,revision,current.user.id,current.user.displayName,JSON.stringify(before),JSON.stringify(after)],
  );
  await audit(client,current.user,"memo.followers","memo",memoId,{revision:revision-1,followers:before},
    {revision,followers:after},current.companyId);
  if (followers.length) {
    const title = (await client.query("SELECT title FROM memos WHERE company_id=$1 AND id=$2",
      [current.companyId,memoId])).rows[0].title as string;
    await notifyMemoFollowers(client,current,memoId,title,
      "تحديث صلاحيات متابعة مذكرة",`revision:${revision}`);
  }
}
async function notifyMemoFollowers(
  client: PoolClient, current: Scope, memoId: number,
  title: string, reason: string, eventKey: string,
) {
  // The currently authorized employee/role grants are resolved afresh.
  const recipients = (await client.query(
    `SELECT DISTINCT e.id AS employee_id,e.user_id FROM employees e
     JOIN users u ON u.id=e.user_id AND NOT u.archived
     WHERE e.company_id=$1 AND e.active AND e.user_id<>$3
       AND EXISTS (
         SELECT 1 FROM memo_followers f
         WHERE f.company_id=e.company_id AND f.memo_id=$2
           AND (f.employee_id=e.id OR EXISTS(
             SELECT 1 FROM company_roles r
             WHERE r.company_id=f.company_id AND r.id=f.role_id AND r.active
               AND (e.role=r.key OR EXISTS(
                 SELECT 1 FROM employee_role_assignments a
                 WHERE a.company_id=e.company_id AND a.employee_id=e.id
                   AND a.role_id=r.id AND a.active
               ))
           ))
       ) ORDER BY e.user_id,e.id`,
    [current.companyId,memoId,current.user.id],
  )).rows;
  for(const recipient of recipients) {
    const account=(await client.query("SELECT * FROM users WHERE id=$1",[recipient.user_id])).rows[0];
    const entries=await directoryEntries(client,userDTO(account),current.companyId);
    if(!entries.find(e=>e.key==="company.memos")?.actionAccess.view ||
       !entries.find(e=>e.key==="company.memo-detail")?.actionAccess.view) continue;
    await supersedeMemoAlerts(client,current,memoId,"MEMO_FOLLOW",recipient.user_id,"new-memo-follow-update");
    await emitNotification(client,{
      code:"MEMO_FOLLOW",
      companyId:current.companyId,
      subjectEmployeeId:recipient.employee_id,
      recipientUserId:recipient.user_id,
      explicitSubjectOnly:true,
      subjectKey:`memo:${memoId}`,
      eventKey:`memo:${memoId}:follow:${eventKey}`,
      title:`${current.user.displayName}: ${title}`,
      message:`${reason} — ${title}`,
      href:`/companies/${current.companyId}/memos/${memoId}`,
    });
  }
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
interface MemoTarget {
  userId: number;
  employeeId: number | null;
  name: string;
}
async function activeMemoTarget(
  client: PoolClient,
  companyId: number,
  userId: number,
  employeeId: number | null | undefined,
  name: string,
): Promise<MemoTarget> {
  const row = (
    await client.query(
      employeeId === undefined
        ? `SELECT u.id,e.id AS employee_id FROM users u LEFT JOIN employees e ON e.company_id=$1 AND e.user_id=u.id AND e.active
         WHERE u.id=$2 AND NOT u.archived AND (u.owner OR e.id IS NOT NULL)`
        : employeeId === null
          ? "SELECT id,NULL::integer AS employee_id FROM users WHERE id=$2 AND NOT archived AND owner AND $1::integer IS NOT NULL"
          : `SELECT u.id,e.id AS employee_id FROM users u JOIN employees e ON e.company_id=$1 AND e.id=$3 AND e.user_id=u.id AND e.active
           WHERE u.id=$2 AND NOT u.archived FOR SHARE OF e`,
      employeeId === undefined || employeeId === null
        ? [companyId, userId]
        : [companyId, userId, employeeId],
    )
  ).rows[0];
  if (!row)
    throw new HttpError(
      400,
      "invalid_employee",
      "المستلم لم يعد فعالًا أو لم يعد مرتبطًا بالحساب نفسه في الشركة",
    );
  return { userId: row.id, employeeId: row.employee_id ?? null, name };
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
        ![
          "required",
          "sent",
          "following",
          "approval",
          "completed",
          "all",
          "watching",
        ].includes(box)
      )
        throw new HttpError(400, "invalid_query", "قائمة المذكرات غير صالحة");
      const status = req.query.status;
      if (
        status !== undefined &&
        (typeof status !== "string" ||
          !["pending", "awaiting_approval", "completed"].includes(status))
      )
        throw new HttpError(400, "invalid_query", "حالة المذكرة غير صالحة");
      const result = await transaction(
        pool,
        async (client): Promise<MemoList> => {
          await client.query(
            "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
          );
          const current = await scope(client, req);
          await access(client, req, current, "view");
          if (box === "all" && !current.context.general) deny();
          const optionDefs=await definitionsForMemo(client,current.companyId);
          const values: unknown[] = [current.companyId, current.user.id];
          let filter = "TRUE";
          if (box === "required") {
            values.push(current.ownId);
            filter =
              "m.status='pending' AND m.current_user_id=$2 AND (m.current_employee_id IS NULL OR m.current_employee_id=$3::integer)";
          } else if (box === "approval")
            filter = "m.status='awaiting_approval' AND m.sender_user_id=$2";
          else if (box === "sent") filter = "m.sender_user_id=$2";
          else if (box === "watching") { values.push(current.ownId); filter = memoFollowerSql("m","$3"); }
          else if (box === "completed" && current.context.general)
            filter = "m.status='completed'";
          else if (box === "following" || box === "completed") {
            values.push(current.ownId);
            filter =
              "m.sender_user_id=$2 OR (m.current_user_id=$2 AND (m.current_employee_id IS NULL OR m.current_employee_id=$3::integer)) OR EXISTS(SELECT 1 FROM memo_participants p WHERE p.company_id=m.company_id AND p.memo_id=m.id AND p.user_id=$2 AND (p.employee_id IS NULL OR p.employee_id=$3::integer)) OR " + memoFollowerSql("m","$3");
          }
          if (box === "completed")
            filter = `m.status='completed' AND (${current.context.general ? "TRUE" : filter})`;
          if (status !== undefined) {
            values.push(status);
            filter = `(${filter}) AND m.status=$${values.length}`;
          }
          const optionKey=req.query.optionKey, optionValue=req.query.optionValue;
          if(optionKey !== undefined || optionValue !== undefined) {
            if(typeof optionKey!=="string" || typeof optionValue!=="string")
              throw new HttpError(400,"invalid_query","حدد الخاصية والقيمة معًا");
            const definition=optionDefs.find(d=>d.key===optionKey && d.active && d.searchable);
            if(!definition) throw new HttpError(400,"invalid_option","الخيار غير متاح للبحث");
            const candidate: boolean|string|null = definition.valueType==="boolean"
              ? optionValue==="true"?true:optionValue==="false"?false:null
              : optionValue==="null"?null:optionValue;
            const valid=(await client.query(
              "SELECT option_value_valid($1::text,$2::jsonb,$3::jsonb) AS valid",
              [definition.valueType,JSON.stringify(candidate),JSON.stringify(definition.choices)],
            )).rows[0].valid;
            if(!valid) throw new HttpError(400,"invalid_option_value","قيمة البحث لا تطابق نوع الخاصية");
            values.push(definition.id,JSON.stringify(candidate));
            filter=`(${filter}) AND EXISTS(
              SELECT 1 FROM option_values opt WHERE opt.company_id=m.company_id AND opt.memo_id=m.id
              AND opt.definition_id=${values.length-1} AND opt.value=${values.length}::jsonb)`;
          }
          values.push(searchPattern(query.q));
          const search = `${values.length}`;
          // Detail text belongs to the detail page, whose view can be denied separately.
          const where = `m.company_id=$1 AND (${filter}) AND (
            m.title ILIKE ${search} OR m.sender_name ILIKE ${search}
            OR m.recipient_name ILIKE ${search} OR m.current_name ILIKE ${search}
            OR EXISTS(
              SELECT 1 FROM option_values ov
              JOIN option_definitions od ON od.company_id=ov.company_id AND od.id=ov.definition_id
              WHERE ov.company_id=m.company_id AND ov.memo_id=m.id AND od.record_kind='memo'
                AND od.searchable AND od.active AND (
                  (ov.value #>> '{}') ILIKE ${search} OR EXISTS(
                    SELECT 1 FROM jsonb_array_elements(od.choices) choice
                    WHERE choice->>'key'=ov.value #>> '{}' AND choice->>'label' ILIKE ${search}
                  )
                )
            ))`;
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
              `SELECT m.id,m.company_id,m.title,m.type,m.sender_user_id,m.sender_name,m.recipient_employee_id,m.recipient_user_id,m.recipient_name,m.created_at,m.revision,m.current_user_id,m.current_employee_id,m.current_name,m.current_assigned_at,m.current_assignment_revision,m.status,m.completion_requested_by_user_id,m.completion_requested_by_employee_id,m.completion_requested_by_name,m.completion_requested_at,m.completed_at,m.completed_by_user_id,m.completed_by_name,
         own_read.read_at,recipient_read.read_at AS recipient_read_at,current_read.read_at AS current_read_at FROM memos m ${readJoins} WHERE ${where}
         ORDER BY ${query.order} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
              [...values, query.pageSize, query.offset],
            )
          ).rows;
          const listDefinitions=optionDefs.filter(d=>d.active && d.showInList);
          const ids=rows.map(r=>r.id);
          const optionRows=ids.length && listDefinitions.length
            ? (await client.query(
              `SELECT v.memo_id,d.key,v.value FROM option_values v
               JOIN option_definitions d ON d.company_id=v.company_id AND d.id=v.definition_id
               WHERE v.company_id=$1 AND v.memo_id=ANY($2::integer[])
                 AND v.definition_id=ANY($3::integer[])`,
              [current.companyId,ids,listDefinitions.map(d=>d.id)],
            )).rows : [];
          return {
            items: rows.map(r=>({
              ...summary(r),
              optionValues:Object.fromEntries(optionRows.filter(o=>o.memo_id===r.id)
                .map(o=>[o.key,o.value])),
            })),
            optionDefinitions:listDefinitions,
            searchOptions:optionDefs.filter(d=>d.active && d.searchable),
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
        followers: input.followers ?? [],
        ...(input.links ? {links:input.links} : {}),
        ...(input.options ? {options:input.options} : {}),
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
        if(input.links) await validateMemoLinks(client,current.user,current.companyId,input.links);
        const preparedOptions=await validateMemoOptionEntries(client,current.companyId,input.options??[],true);
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
        await client.query(
          `INSERT INTO memo_links(company_id,memo_id,follow_page_key,follow_record_id,reference_page_key,reference_record_id,item_id,account_id,updated_by)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [current.companyId,memo.id,input.links?.followPage?.pageKey??null,
           input.links?.followPage?.recordId??null,input.links?.referencePage?.pageKey??null,
           input.links?.referencePage?.recordId??null,input.links?.itemId??null,
           input.links?.accountId??null,current.user.id],
        );
        await client.query(
          "INSERT INTO memo_option_versions(company_id,memo_id,changed_by) VALUES($1,$2,$3)",
          [current.companyId,memo.id,current.user.id],
        );
        await saveMemoOptionValues(client,current.user,current.companyId,memo.id,preparedOptions);
        await client.query(
          "INSERT INTO memo_follow_versions(company_id,memo_id,changed_by) VALUES($1,$2,$3)",
          [current.companyId,memo.id,current.user.id],
        );
        if (payload.followers.length)
          await storeFollowers(client,current,memo.id,payload.followers,1);
        const saved = await detail(client, current, memo.id);
        const {
          events: _events,
          canReply: _reply,
          canTransfer: _transfer,
          canRequestCompletion: _request,
          canApproveCompletion: _approve,
          canReopenCompletion: _reopen,
          canComplete: _complete,
          canManageFollowers: _manageFollowers,
          canComment: _comment,
          followers: _followers,
          followerRevision: _followerRevision,
          followerChanges: _followerChanges,
          links: _links,
          canManageLinks: _manageLinks,
          optionDefinitions: _optionDefinitions,
          optionValues: _optionValues,
          optionRevision: _optionRevision,
          optionChanges: _optionChanges,
          canManageOptions: _manageOptions,
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
    base + "/options",
    handler(async (req,res) => {
      const result=await transaction(pool,async client=>{
        await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const current=await scope(client,req);
        await access(client,req,current,"view");
        return {definitions:(await definitionsForMemo(client,current.companyId)).filter(d=>d.active)};
      });
      res.json(result);
    }),
  );
  router.put(
    base + "/:memoId/options",
    handler(async (req,res) => {
      const memoId=id(req.params.memoId),input=parse(memoOptionsUpdateSchema,req.body);
      const memo=await transaction(pool,async client=>{
        const current=await scope(client,req,true);
        await access(client,req,current,"edit",true,true);
        const before=await detail(client,current,memoId);
        if(!before.canManageOptions) deny("تعديل خصائص المذكرة للمرسل والإدارة المصرح لها فقط");
        const version=(await client.query(
          "SELECT revision FROM memo_option_versions WHERE company_id=$1 AND memo_id=$2 FOR UPDATE",
          [current.companyId,memoId]
        )).rows[0];
        if(!version || version.revision!==input.revision)
          throw new HttpError(409,"revision_conflict","تغيرت خصائص المذكرة؛ أعد التحميل");
        const values=await validateMemoOptionEntries(client,current.companyId,input.values,false);
        await saveMemoOptionValues(client,current.user,current.companyId,memoId,values);
        const after=await memoOptionDetails(client,current.companyId,memoId);
        await client.query(
          "UPDATE memo_option_versions SET revision=revision+1,changed_by=$3,changed_at=clock_timestamp() WHERE company_id=$1 AND memo_id=$2",
          [current.companyId,memoId,current.user.id],
        );
        await client.query(
          `INSERT INTO memo_option_changes(company_id,memo_id,revision,actor_user_id,actor_name,previous_value,next_value)
            VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
          [current.companyId,memoId,version.revision+1,current.user.id,current.user.displayName,
           JSON.stringify(before.optionValues),JSON.stringify(after.optionValues)],
        );
        await audit(client,current.user,"memo.options","memo",memoId,
          {revision:version.revision,values:before.optionValues},
          {revision:version.revision+1,values:after.optionValues},current.companyId);
        return detail(client,current,memoId);
      });
      res.json({memo});
    }),
  );
  router.get(
    base + "/link-records",
    handler(async (req,res) => {
      const pageKey=String(req.query.pageKey??"");
      const resource:Record<string,{table:string;parent:string;title:string}>={
        "company.invoice":{table:"invoices",parent:"",title:"فاتورة"},
        "company.financial-document":{table:"financial_documents",parent:"company.financial-documents",title:"مستند"},
        "company.item-card":{table:"items",parent:"company.items",title:"صنف"},
      };
      const target=resource[pageKey];
      if(!target) throw new HttpError(400,"invalid_page","اختر صفحة سجل مدعومة");
      const query=listQuery(req.query,{id:"r.id",code:"r.id",name:"r.id"},"id:desc");
      const result=await transaction(pool,async client=>{
        await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const current=await scope(client,req);
        await access(client,req,current,"view");
        const entries=await directoryEntries(client,current.user,current.companyId);
        assertDirectoryAccess(entries.find(e=>e.key===pageKey)!);
        if(target.parent) assertDirectoryAccess(entries.find(e=>e.key===target.parent)!);
        const kindFilter=target.table==="invoices"
          ? (!entries.find(e=>e.key==="company.sales")?.actionAccess.view
              ? (entries.find(e=>e.key==="company.purchases")?.actionAccess.view ? "AND r.kind='purchase'" : "AND FALSE") : !entries.find(e=>e.key==="company.purchases")?.actionAccess.view
                ? "AND r.kind='sale'" : "")
          : target.table==="financial_documents"
          ? "AND r.kind IN ("+["journal","receipt","payment"].filter(kind=>
              entries.find(e=>e.key==="company."+
                ({journal:"journals",receipt:"receipts",payment:"payments"} as const)[kind as "journal"|"receipt"|"payment"])?.actionAccess.view)
              .map(kind=>"'"+kind+"'").join(",") + ")"
          : "";
        const condition=`FROM ${target.table} r WHERE r.company_id=$1 AND r.id::text ILIKE $2 ${kindFilter}`;
        const values=[current.companyId,searchPattern(query.q)];
        const total=Number((await client.query(`SELECT count(*) ${condition}`,values)).rows[0].count);
        const rows=(await client.query(
          `SELECT r.id ${condition} ORDER BY r.id DESC LIMIT $3 OFFSET $4`,
          [...values,query.pageSize,query.offset],
        )).rows;
        return {items:rows.map(r=>({id:r.id,name:`${target.title} #${r.id}`})),
          total,page:query.page,pageSize:query.pageSize};
      });
      res.json(result);
    }),
  );
  router.get(
    base + "/link-items",
    handler(async (req,res) => {
      const query=listQuery(req.query,{id:"i.id",code:"i.code",name:"i.name"},"name:asc");
      const result=await transaction(pool,async client=>{
        await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const current=await scope(client,req);
        await access(client,req,current,"view");
        const entries=await directoryEntries(client,current.user,current.companyId);
        assertDirectoryAccess(entries.find(e=>e.key==="company.items")!);
        assertDirectoryAccess(entries.find(e=>e.key==="company.item-card")!);
        const values=[current.companyId,searchPattern(query.q)];
        const from="FROM items i WHERE i.company_id=$1 AND (i.name ILIKE $2 OR i.code ILIKE $2)";
        const total=Number((await client.query(`SELECT count(*) ${from}`,values)).rows[0].count);
        const rows=(await client.query(`SELECT i.id,i.code,i.name ${from} ORDER BY ${query.order} LIMIT $3 OFFSET $4`,
          [...values,query.pageSize,query.offset])).rows;
        return {items:rows.map(r=>({id:r.id,name:`${r.code} — ${r.name}`})),
          total,page:query.page,pageSize:query.pageSize};
      });
      res.json(result);
    }),
  );
  router.get(
    base + "/link-accounts",
    handler(async (req,res) => {
      const query=listQuery(req.query,{id:"a.id",code:"a.code",name:"a.name"},"name:asc");
      const result=await transaction(pool,async client=>{
        await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const current=await scope(client,req);
        await access(client,req,current,"view");
        const entries=await directoryEntries(client,current.user,current.companyId);
        assertDirectoryAccess(entries.find(e=>e.key==="company.accounts")!);
        const values=[current.companyId,searchPattern(query.q)];
        const from="FROM accounts a WHERE a.company_id=$1 AND (a.name ILIKE $2 OR a.code ILIKE $2)";
        const total=Number((await client.query(`SELECT count(*) ${from}`,values)).rows[0].count);
        const rows=(await client.query(`SELECT a.id,a.code,a.name ${from} ORDER BY ${query.order} LIMIT $3 OFFSET $4`,
          [...values,query.pageSize,query.offset])).rows;
        return {items:rows.map(r=>({id:r.id,name:`${r.code} — ${r.name}`})),
          total,page:query.page,pageSize:query.pageSize};
      });
      res.json(result);
    }),
  );
  router.put(
    base + "/:memoId/links",
    handler(async (req,res) => {
      const memoId=id(req.params.memoId),input=parse(memoLinksUpdateSchema,req.body);
      const memo=await transaction(pool,async client=>{
        const current=await scope(client,req,true);
        await access(client,req,current,"edit",true,true);
        const before=await detail(client,current,memoId);
        if(!before.canManageLinks) deny("تعديل مراجع المذكرة للمرسل والإدارة المصرح لها فقط");
        const found=(await client.query(
          "SELECT * FROM memo_links WHERE company_id=$1 AND memo_id=$2 FOR UPDATE",
          [current.companyId,memoId]
        )).rows[0];
        if(!found || found.revision!==input.revision)
          throw new HttpError(409,"revision_conflict","تغيرت المراجع، أعد تحميل المذكرة");
        const {revision:_linkRevision,...values}=input;
        await validateMemoLinks(client,current.user,current.companyId,values);
        const previous=memoLinksSnapshot(found);
        await client.query(
          `UPDATE memo_links SET revision=revision+1,follow_page_key=$3,follow_record_id=$4,
            reference_page_key=$5,reference_record_id=$6,item_id=$7,account_id=$8,
            updated_by=$9,updated_at=clock_timestamp()
            WHERE company_id=$1 AND memo_id=$2`,
          [current.companyId,memoId,values.followPage?.pageKey??null,
           values.followPage?.recordId??null,values.referencePage?.pageKey??null,
           values.referencePage?.recordId??null,values.itemId,values.accountId,current.user.id]
        );
        await client.query(
          "INSERT INTO memo_link_changes(company_id,memo_id,revision,actor_user_id,actor_name,previous_value,next_value) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)",
          [current.companyId,memoId,found.revision+1,current.user.id,current.user.displayName,
           JSON.stringify(previous),JSON.stringify(values)]
        );
        await audit(client,current.user,"memo.links","memo",memoId,
          {revision:found.revision,...previous},{revision:found.revision+1,...values},current.companyId);
        return detail(client,current,memoId);
      });
      res.json({memo});
    }),
  );
  router.get(
    base + "/roles",
    handler(async (req,res) => {
      const roles = await transaction(pool,async client => {
        await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const current=await scope(client,req);
        await access(client,req,current,"view");
        return (await client.query(
          "SELECT id,name FROM company_roles WHERE company_id=$1 AND active ORDER BY name,id",
          [current.companyId],
        )).rows;
      });
      res.json({roles});
    }),
  );
  router.put(
    base + "/:memoId/followers",
    handler(async (req,res) => {
      const memoId=id(req.params.memoId), input=parse(memoFollowersUpdateSchema,req.body);
      const memo=await transaction(pool,async client => {
        const current=await scope(client,req,true);
        await access(client,req,current,"edit",true,true);
        const before=await detail(client,current,memoId);
        if(!before.canManageFollowers) deny("تعديل المتابعين للمرسل أو الإدارة المصرح لها فقط");
        await client.query("SELECT id FROM memos WHERE company_id=$1 AND id=$2 FOR SHARE",[current.companyId,memoId]);
        const version=(await client.query(
          "SELECT revision FROM memo_follow_versions WHERE company_id=$1 AND memo_id=$2 FOR UPDATE",
          [current.companyId,memoId],
        )).rows[0];
        if(!version || input.revision!==version.revision)
          throw new HttpError(409,"revision_conflict","تغير المتابعون؛ حدث المذكرة قبل الحفظ");
        const beforeFollowers=before.followers.map(f => ({
          kind:f.kind,
          ...(f.kind==="employee"?{employeeId:f.employeeId}:{roleId:f.roleId}),
          accessLevel:f.accessLevel,
        }));
        await storeFollowers(client,current,memoId,input.followers,version.revision+1,beforeFollowers);
        await client.query(
          "UPDATE memo_follow_versions SET revision=revision+1,changed_by=$3,changed_at=clock_timestamp() WHERE company_id=$1 AND memo_id=$2",
          [current.companyId,memoId,current.user.id],
        );
        return detail(client,current,memoId);
      });
      res.json({memo});
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
          (before.senderUserId === current.user.id ||
            before.currentEmployeeId === null ||
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
           WHERE company_id=$1 AND code IN ('MEMO_RECEIVED','MEMO_REPLY','MEMO_APPROVAL','MEMO_COMPLETED','MEMO_FOLLOW') AND subject_key=$2 AND recipient_user_id=$3
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
    base + "/:memoId/comments",
    handler(async (req,res) => {
      const memoId=id(req.params.memoId),input=parse(memoFollowerCommentSchema,req.body);
      const memo=await transaction(pool,async client => {
        const current=await scope(client,req,true);
        const previous=(await client.query(
          "SELECT actor_user_id,memo_id,request_payload=$3::jsonb AS matches FROM memo_follow_comments WHERE company_id=$1 AND idempotency_key=$2",
          [current.companyId,input.idempotencyKey,JSON.stringify({body:input.body})],
        )).rows[0];
        if(previous && (previous.actor_user_id!==current.user.id || previous.memo_id!==memoId || !previous.matches))
          throw new HttpError(409,"conflict","مفتاح التعليق مستخدم لتعليق مختلف");
        // A previously accepted request can be confirmed without reposting.
        await access(client,req,current,previous?"view":"edit",true,!previous);
        const before=await detail(client,current,memoId);
        if(previous) return before;
        if(!before.canComment) deny("التعليق متاح للمتابع المصرح له فقط");
        const row=(await client.query(
          "INSERT INTO memo_follow_comments(company_id,memo_id,actor_user_id,actor_name,body,idempotency_key,request_payload) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING id",
          [current.companyId,memoId,current.user.id,current.user.displayName,input.body,input.idempotencyKey,
           JSON.stringify({body:input.body})],
        )).rows[0];
        await audit(client,current.user,"memo.follower-comment","memo",memoId,null,
          {commentId:row.id,body:input.body},current.companyId);
        await notifyMemoFollowers(client,current,memoId,before.title,
          `تعليق متابعة جديد من ${current.user.displayName}`,`comment:${row.id}`);
        return detail(client,current,memoId);
      });
      res.status(201).json({memo});
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
        const completionAction = [
          "request-completion",
          "approve-completion",
          "reopen-completion",
          "complete",
        ].includes(input.action);
        await access(
          client,
          req,
          current,
          completionAction ? "post" : "edit",
          true,
          true,
        );
        const before = await detail(client, current, memoId);
        if (before.status === "completed")
          throw new HttpError(
            409,
            "invalid_state",
            "المذكرة منجزة؛ سجلها متاح للاطلاع فقط",
          );
        if (input.revision !== before.revision)
          throw new HttpError(
            409,
            "revision_conflict",
            "تغيرت المذكرة؛ حدثها قبل إرسال الإجراء",
          );
        let target: MemoTarget | null = null;
        const eventKind: MemoEvent["kind"] = {
          reply: "reply",
          return: "returned",
          forward: "forwarded",
          "request-completion": "completion_requested",
          "approve-completion": "completed",
          "reopen-completion": "reopened",
          complete: "completed",
        }[input.action] as MemoEvent["kind"];
        if (input.action === "reply") {
          if (!before.canReply)
            deny("المشاركة في هذه المذكرة للمشاركين فيها فقط");
        } else if (input.action === "return" || input.action === "forward") {
          if (!before.canTransfer)
            deny("التحويل والإعادة للمسؤول الحالي عن المذكرة المعلقة فقط");
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
          } else
            target = await activeMemoTarget(
              client,
              current.companyId,
              before.senderUserId,
              undefined,
              before.senderName,
            );
        } else if (input.action === "request-completion") {
          if (!before.canRequestCompletion)
            deny(
              "طلب اعتماد الإنجاز للمسؤول الحالي فقط؛ المرسل يعتمد مباشرة عندما تكون المذكرة لديه",
            );
          target = await activeMemoTarget(
            client,
            current.companyId,
            before.senderUserId,
            undefined,
            before.senderName,
          );
        } else if (input.action === "reopen-completion") {
          if (!before.canReopenCompletion)
            deny("إعادة طلب الإنجاز للاستكمال للمرسل الأصلي فقط");
          if (
            before.completionRequestedByUserId === null ||
            before.completionRequestedByName === null
          )
            throw new HttpError(
              409,
              "invalid_state",
              "لا يوجد طلب إنجاز ينتظر الإعادة",
            );
          target = await activeMemoTarget(
            client,
            current.companyId,
            before.completionRequestedByUserId,
            before.completionRequestedByEmployeeId,
            before.completionRequestedByName,
          );
        } else if (input.action === "approve-completion") {
          if (!before.canApproveCompletion)
            deny("اعتماد طلب الإنجاز للمرسل الأصلي فقط");
        } else if (!before.canComplete)
          deny("الإنجاز المباشر للمرسل الأصلي عندما تكون المذكرة لديه فقط");
        if (target?.userId === current.user.id)
          throw new HttpError(
            400,
            "invalid_recipient",
            "المذكرة لديك بالفعل؛ اختر إجراءً مناسبًا",
          );
        const now = (await client.query("SELECT clock_timestamp() AS now"))
          .rows[0].now as Date;
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
              before.revision + 1,
              now,
            ],
          )
        ).rows[0];
        if (target)
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
        const request = input.action === "request-completion",
          reopen = input.action === "reopen-completion",
          close =
            input.action === "approve-completion" ||
            input.action === "complete";
        const nextStatus = request
          ? "awaiting_approval"
          : reopen
            ? "pending"
            : close
              ? "completed"
              : before.status;
        await client.query(
          `UPDATE memos SET revision=revision+1,status=$3,current_user_id=$4,current_employee_id=$5,current_name=$6,current_assigned_at=CASE WHEN $16::boolean THEN $7::timestamptz ELSE current_assigned_at END,current_assignment_revision=$8,
           completion_requested_by_user_id=$9,completion_requested_by_employee_id=$10,completion_requested_by_name=$11,completion_requested_at=$12,
           completed_at=$13,completed_by_user_id=$14,completed_by_name=$15 WHERE company_id=$1 AND id=$2`,
          [
            current.companyId,
            memoId,
            nextStatus,
            target?.userId ?? before.currentUserId,
            target ? target.employeeId : before.currentEmployeeId,
            target?.name ?? before.currentName,
            target ? now : before.currentAssignedAt,
            before.currentAssignmentRevision + (target ? 1 : 0),
            request
              ? current.user.id
              : reopen
                ? null
                : before.completionRequestedByUserId,
            request
              ? before.currentEmployeeId
              : reopen
                ? null
                : before.completionRequestedByEmployeeId,
            request
              ? current.user.displayName
              : reopen
                ? null
                : before.completionRequestedByName,
            request ? now : reopen ? null : before.completionRequestedAt,
            close ? now : null,
            close ? current.user.id : null,
            close ? current.user.displayName : null,
            target !== null,
          ],
        );
        await client.query(
          `INSERT INTO memo_events(company_id,memo_id,kind,actor_user_id,actor_name,created_at,body,target_user_id,target_employee_id,target_name,assignment_revision,action_id)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            current.companyId,
            memoId,
            eventKind,
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
            status: before.status,
            currentUserId: before.currentUserId,
            currentEmployeeId: before.currentEmployeeId,
            currentAssignmentRevision: before.currentAssignmentRevision,
          },
          {
            revision: saved.revision,
            status: saved.status,
            currentUserId: saved.currentUserId,
            currentEmployeeId: saved.currentEmployeeId,
            currentName: saved.currentName,
            currentAssignmentRevision: saved.currentAssignmentRevision,
            completionRequestedByUserId: saved.completionRequestedByUserId,
            completionRequestedByEmployeeId:
              saved.completionRequestedByEmployeeId,
            completionRequestedByName: saved.completionRequestedByName,
            completionRequestedAt: saved.completionRequestedAt,
            completedAt: saved.completedAt,
            completedByUserId: saved.completedByUserId,
            completedByName: saved.completedByName,
            actionId: action.id,
            body: input.body,
          },
          current.companyId,
        );
        let notifyTarget: MemoTarget | null = target;
        let code = target
          ? request
            ? "MEMO_APPROVAL"
            : "MEMO_RECEIVED"
          : "MEMO_REPLY";
        if (close) {
          code = "MEMO_COMPLETED";
          notifyTarget =
            input.action === "approve-completion" &&
            before.completionRequestedByUserId !== null
              ? {
                  userId: before.completionRequestedByUserId,
                  employeeId: before.completionRequestedByEmployeeId,
                  name: before.completionRequestedByName!,
                }
              : {
                  userId: before.recipientUserId,
                  employeeId: before.recipientEmployeeId,
                  name: before.recipientName,
                };
        } else if (!target) {
          notifyTarget =
            current.user.id === before.senderUserId
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
                };
        }
        if (completionAction)
          for (const memoCode of [
            "MEMO_RECEIVED",
            "MEMO_REPLY",
            "MEMO_APPROVAL",
            "MEMO_COMPLETED",
          ])
            await supersedeMemoAlerts(
              client,
              current,
              memoId,
              memoCode,
              null,
              "memo-workflow-transition",
            );
        else if (target)
          await supersedeMemoAlerts(
            client,
            current,
            memoId,
            "MEMO_RECEIVED",
            null,
            "memo-transferred",
          );
        if (notifyTarget && notifyTarget.userId !== current.user.id) {
          if (!target && !close)
            await supersedeMemoAlerts(
              client,
              current,
              memoId,
              "MEMO_REPLY",
              notifyTarget.userId,
              "new-memo-reply",
            );
          const descriptions = {
            reply: "رد جديد على المذكرة",
            return: "مذكرة أعيدت إليك",
            forward: "مذكرة محولة إليك",
            "request-completion": "طلب اعتماد إنجاز مذكرة",
            "approve-completion": "اعتماد إنجاز المذكرة",
            "reopen-completion": "مذكرة أعيدت إليك للاستكمال",
            complete: "إنجاز المذكرة",
          };
          await emitNotification(client, {
            code,
            companyId: current.companyId,
            recipientUserId: notifyTarget.userId,
            subjectEmployeeId: notifyTarget.employeeId,
            explicitSubjectOnly: true,
            subjectKey: `memo:${memoId}`,
            eventKey: `memo:${memoId}:action:${idempotencyKey}`,
            title: `${current.user.displayName}: ${before.title}`,
            message: `${descriptions[input.action]} من ${current.user.displayName}: ${before.title}`,
            href: `/companies/${current.companyId}/memos/${memoId}`,
          });
        }
        if (target || close || request)
          await notifyMemoFollowers(client,current,memoId,saved.title,
            `تحديث سير عمل المذكرة بواسطة ${current.user.displayName}`,`action:${idempotencyKey}`);
        return { memo: saved, created: true };
      });
      res.status(result.created ? 201 : 200).json({ memo: result.memo });
    }),
  );
  return router;
}
