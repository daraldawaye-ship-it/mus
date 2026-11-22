import { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { transaction } from "./db.ts";
import { actor, handler, parse } from "./http.ts";
import {
  avatarActivityActionKeys, operatorSearchActionKeys, operatorActivityPageKeys,
  isOperatorSearchAllowed, normalizeOperatorSearchText, operatorActivityDetailLabels,
} from "../../../packages/contracts/src/operator-activity.ts";
import { pageByKey } from "../../../packages/contracts/src/pages.ts";
import { deny } from "./errors.ts";
import { currentActor, ownerOnly } from "./policies/access.ts";

const interestAction = z.enum(["page_view", "click", "card_open", "search"]);
const eventSchema = z.object({
  id: z.string().uuid(),
  action: interestAction,
  targetType: z.string().min(1).max(48).regex(/^[a-z0-9:_-]+$/),
  targetId: z.number().int().min(0).max(2147483647).default(0),
  path: z.string().startsWith("/").max(220),
  label: z.string().max(120).default(""),
  text: z.string().max(150).default(""),
}).strict();
const operatorIdSchema = z.number().int().min(1).max(2147483647);
const operatorActivityBase = {
  id: z.string().uuid(),
  actorId: operatorIdSchema,
  companyId: operatorIdSchema.nullable(),
  pageKey: z.enum(operatorActivityPageKeys),
};
const operatorActivitySchema = z.discriminatedUnion("surface", [
  z.object({ ...operatorActivityBase, surface: z.literal("avatar_menu"),
    actionKey: z.enum(avatarActivityActionKeys),
    detailKey: z.string().max(96).refine(key => !!pageByKey(key) ||
      (avatarActivityActionKeys as readonly string[]).includes(key) || Object.hasOwn(operatorActivityDetailLabels,key)).optional()
  }).strict(),
  z.object({ ...operatorActivityBase, surface: z.literal("operator_search"),
    actionKey: z.enum(operatorSearchActionKeys), searchText: z.string().max(128) }).strict(),
]);
const batchSchema = z.object({
  visitorId: z.string().uuid(),
  events: z.array(z.union([eventSchema, operatorActivitySchema])).min(1).max(24),
}).strict();

function publicText(value: string, max: number): string {
  const normalized = value.normalize("NFKC").replace(/[\r\n\t]+/g," ").replace(/\s+/g," ").trim().slice(0,max);
  // Search terms and button labels are not a place to retain phone numbers,
  // credentials, patient details or email addresses.
  if (/@|(?:\+?\d[\d\s\-]{7,})|(?:password|كلمة المرور|رمز التحقق|otp|bearer|token|secret)/i.test(normalized))
    return "[محجوب للخصوصية]";
  return normalized;
}

let nextPruneAt = 0;
/** Opportunistic hourly cleanup: every aggregate and first-event snapshot has
 * already been committed before its corresponding raw event can be deleted.
 * Deletes never touch the permanent operational/security audit table. */
async function pruneOldEvents(pool: Pool): Promise<void> {
  if (Date.now() < nextPruneAt) return;
  nextPruneAt = Date.now() + 60 * 60 * 1000;
  try {
    await transaction(pool, async db => {
      const lock = await db.query("SELECT pg_try_advisory_xact_lock(81912026) AS acquired");
      if (!lock.rows[0]?.acquired) return;
      await db.query(`
        DELETE FROM interest_events WHERE id IN (
          SELECT id FROM interest_events
          WHERE occurred_at < now() - interval '100 days'
          ORDER BY occurred_at, id LIMIT 25000
        )`);
    });
  } catch (error) {
    console.error("INTEREST_EVENT_RETENTION_ERROR", error instanceof Error ? error.name : "unknown");
  }
}

const activityQuerySchema=z.object({
  employee:z.string().trim().max(100).default(""),
  user:z.string().trim().max(100).default(""),
  event:z.string().trim().max(120).default(""),
  from:z.iso.date().refine(s=>s>="1900-01-01"&&s<="9998-12-31").optional(),
  to:z.iso.date().refine(s=>s>="1900-01-01"&&s<="9998-12-31").optional(),
  cursorAt:z.iso.datetime().optional(),
  cursorId:z.string().regex(/^[1-9][0-9]{0,18}$/)
    .refine(s=>BigInt(s)<=9223372036854775807n).optional(),
}).strict().refine(q=>!q.from||!q.to||q.from<=q.to,"تاريخ البداية يجب ألا يكون بعد النهاية")
  .refine(q=>Boolean(q.cursorAt)===Boolean(q.cursorId),"مؤشر الصفحة غير مكتمل");

const activityLabels={
  page_view:"فتح صفحة",click:"نقر",card_open:"فتح كرت",search:"بحث",
  operator_activity:"نشاط المشغل",
};
const activityPageSize=30;
export const interestActivitySql=`
  WITH evidence AS (
    SELECT e.id,e.occurred_at,e.actor_id,e.action,e.target_type,e.target_id,
           e.dimension_text,e.label,e.pathname,
           CASE WHEN e.action='operator_activity' THEN e.label::jsonb ELSE NULL END AS context
      FROM interest_events e
     WHERE ($1::date IS NULL OR e.occurred_at >= ($1::timestamp AT TIME ZONE 'Asia/Aden'))
       AND ($2::date IS NULL OR e.occurred_at < (($2::date+1)::timestamp AT TIME ZONE 'Asia/Aden'))
       AND ($6::timestamptz IS NULL OR (e.occurred_at,e.id)<($6::timestamptz,$7::bigint))
  ), identified AS (
    SELECT i.*,employee.name AS employee_name,
           COALESCE(NULLIF(u.display_name,''),u.name) AS actor_name,
           CASE WHEN i.action='operator_activity' THEN
                  COALESCE($9::jsonb->>(i.context->>'detailKey'),
                           CASE WHEN i.target_type='operator_search' THEN 'بحث المشغل' ELSE 'نشاط المشغل' END)
                ELSE COALESCE($8::jsonb->>i.action,i.action) END AS action_label
      FROM evidence i
      LEFT JOIN users u ON u.id=i.actor_id
      LEFT JOIN employees employee ON i.action='operator_activity' AND employee.company_id=i.target_id
        AND employee.id=(i.context->>'employeeId')::integer
  )
  SELECT id::text,
         to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt",
         actor_name AS "actorName",actor_id IS NULL AS anonymous,
         employee_name AS "employeeName",context->>'employeeId' AS "employeeId",
         action_label AS "actionLabel",pathname,
         CASE WHEN action='operator_activity' THEN COALESCE(context->>'searchText',context->>'detailKey',dimension_text)
              ELSE COALESCE(NULLIF(label,''),NULLIF(dimension_text,''),NULLIF(target_type,'')) END AS "eventDetail",
         CASE WHEN action='operator_activity' THEN 'operator' ELSE 'general' END AS source
    FROM identified
   WHERE ($3::text='' OR strpos(lower(COALESCE(employee_name,'')),lower($3::text))>0)
     AND ($4::text='' OR strpos(lower(COALESCE(actor_name,'')),lower($4::text))>0)
     AND ($5::text='' OR strpos(lower(concat_ws(' ',action_label,action,target_type,
        dimension_text,CASE WHEN action<>'operator_activity' THEN label END,
        context->>'detailKey',context->>'searchText')),lower($5::text))>0)
   ORDER BY identified.occurred_at DESC,identified.id DESC
   LIMIT $10`;

/** Public visitor/event ingestion plus a strictly owner-only analytics report.
 * The only accepted identity of a logged-in user is the server session. */
export function interestEventRoutes(pool: Pool): Router {
  const router = Router();
  router.post("/interest-events", handler(async (req, res) => {
    const input = parse(batchSchema,req.body);
    const actorId = req.auth?.user.id ?? null;
    const visitorId = actorId === null ? input.visitorId : null;
    const subject = actorId === null ? `v:${input.visitorId}` : `u:${actorId}`;
    let saved = 0;
    await transaction(pool,async db => {
      const memberships = new Map<number, { employee_id: number | null } | undefined>();
      for (const item of input.events) {
        if ("surface" in item) {
          // The expected client actor only prevents cross-account queue replay;
          // the persisted actor and employee are derived on the server.
          if (actorId === null || item.actorId !== actorId) continue;
          if (item.pageKey.startsWith("company.") !== (item.companyId !== null)) continue;
          const searchText = item.surface === "operator_search"
            && isOperatorSearchAllowed(item.actionKey,item.pageKey) ? normalizeOperatorSearchText(item.searchText) : null;
          if (item.surface === "operator_search" && !searchText) continue;
          const detailKey = item.surface === "avatar_menu" ? item.detailKey ?? null : null;
          let employeeId: number | null = null;
          if (item.companyId !== null) {
            if (!memberships.has(item.companyId)) {
              const access = await db.query<{ employee_id: number | null }>(`
                SELECT e.id AS employee_id FROM companies c
                JOIN users u ON u.id=$2 AND NOT u.archived
                LEFT JOIN employees e ON e.company_id=c.id AND e.user_id=u.id AND e.active
                WHERE c.id=$1 AND (u.owner OR e.id IS NOT NULL)
                ORDER BY e.id LIMIT 1`,[item.companyId,actorId]);
              memberships.set(item.companyId,access.rows[0]);
            }
            const membership = memberships.get(item.companyId);
            if (!membership) continue;
            employeeId = membership.employee_id;
          }
          // Tagged activity is raw-only; employee ID is an event-time
          // snapshot. No tagged row goes into indefinite aggregate storage.
          const inserted = await db.query(`
            INSERT INTO interest_events(event_uuid,subject_key,actor_id,action,
              target_type,target_id,dimension_text,label,pathname)
            VALUES($1,$2,$3,'operator_activity',$4,$5,$6,$7,$8)
            ON CONFLICT(event_uuid) DO NOTHING`,[
            item.id,subject,actorId,item.surface,item.companyId ?? 0,
            item.actionKey,JSON.stringify({employeeId,detailKey,searchText}),item.pageKey,
          ]);
          saved += inserted.rowCount ?? 0;
          continue;
        }
        const pathname = item.path.split(/[?#]/,1)[0].slice(0,200);
        // Legacy builds could classify almost any text field as a search.
        // Only keep anonymous catalog searches here; named searches are explicit above.
        if (item.action === "search" && (!(pathname === "/" || pathname === "/medicine-market") ||
          !normalizeOperatorSearchText(item.text))) continue;
        const dimension = item.action === "search" ? publicText(item.text,120) :
          item.action === "click" ? publicText(item.label,100) : "";
        const label = item.action === "card_open" ? publicText(item.label,120) : "";
        if (item.action === "search" && !dimension) continue;
        const inserted = await db.query(`
          INSERT INTO interest_events(
            event_uuid,subject_key,actor_id,visitor_id,action,target_type,
            target_id,dimension_text,label,pathname)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT(event_uuid) DO NOTHING
          RETURNING occurred_at`,[
          item.id,subject,actorId,visitorId,item.action,item.targetType,
          item.targetId,dimension,label,pathname,
        ]);
        if (!inserted.rowCount) continue;
        saved++;
        const at = inserted.rows[0].occurred_at;
        await db.query(`
          INSERT INTO interest_totals(
            subject_key,action,target_type,target_id,dimension_text,pathname,
            label,total,first_at,last_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,$8)
          ON CONFLICT(subject_key,action,target_type,target_id,dimension_text,pathname)
          DO UPDATE SET total=interest_totals.total+1,
            last_at=EXCLUDED.last_at,
            label=CASE WHEN EXCLUDED.label<>'' THEN EXCLUDED.label ELSE interest_totals.label END`,[
          subject,item.action,item.targetType,item.targetId,dimension,pathname,label,at,
        ]);
        await db.query(`
          INSERT INTO interest_first_events(
            subject_key,action,target_type,target_id,pathname,
            event_uuid,actor_id,visitor_id,dimension_text,label,occurred_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          ON CONFLICT DO NOTHING`,[
          subject,item.action,item.targetType,item.targetId,pathname,
          item.id,actorId,visitorId,dimension,label,at,
        ]);
      }
    });
    res.status(202).json({ saved });
    void pruneOldEvents(pool);
  }));

  router.get("/interest-events/activity",handler(async(req,res)=>{
    if(req.get("X-Alraesy-Employee-Preview")!==undefined)deny();
    const user=await currentActor(pool,actor(req));
    ownerOnly(user);
    const q=parse(activityQuerySchema,req.query);
    const rows=(await pool.query(interestActivitySql,[
      q.from??null,q.to??null,q.employee,q.user,q.event,q.cursorAt??null,q.cursorId??null,
      JSON.stringify(activityLabels),JSON.stringify(operatorActivityDetailLabels),activityPageSize+1,
    ])).rows;
    const items=rows.slice(0,activityPageSize);
    const last=items.at(-1);
    res.set("Cache-Control","private, no-store").json({
      items,nextCursor:rows.length>activityPageSize&&last?{at:last.occurredAt,id:last.id}:null,
    });
  }));

  router.get("/interest-events/report",handler(async(req,res)=>{
    const user = await currentActor(pool,actor(req));
    ownerOnly(user);
    const requested = Number(req.query.days ?? 30);
    const days = [0,7,30,100].includes(requested) ? requested : 30;
    const source = days === 0 ? "interest_totals" : "interest_events";
    const measure = days === 0 ? "SUM(t.total)" : "COUNT(*)";
    const period = days === 0 ? "" : "AND t.occurred_at >= now() - ($1::integer * interval '1 day')";
    const args = days === 0 ? [] : [days];
    const [actions,users,cards,searches,recent,firstCount,operatorActivity] = await Promise.all([
      pool.query(`SELECT t.action,${measure}::text AS total,
        COUNT(DISTINCT t.subject_key)::integer AS visitors
        FROM ${source} t WHERE t.action<>'operator_activity' ${period}
        GROUP BY t.action ORDER BY ${measure} DESC`,args),
      pool.query(`SELECT t.subject_key,coalesce(NULLIF(u.display_name,''),u.name,
        CASE WHEN left(t.subject_key,2)='v:' THEN 'زائر غير مسجل' ELSE 'مستخدم' END) AS name,
        ${measure}::text AS total
        FROM ${source} t LEFT JOIN users u ON t.subject_key=('u:'||u.id::text)
        WHERE true ${period}
        GROUP BY t.subject_key,u.display_name,u.name ORDER BY ${measure} DESC LIMIT 80`,args),
      pool.query(`SELECT t.target_type,t.target_id,MAX(t.label) AS label,
        ${measure}::text AS total,
        COUNT(DISTINCT t.subject_key)::integer AS visitors
        FROM ${source} t WHERE t.action='card_open' ${period}
        GROUP BY t.target_type,t.target_id ORDER BY ${measure} DESC LIMIT 80`,args),
      pool.query(`SELECT t.dimension_text AS term,${measure}::text AS total,
        COUNT(DISTINCT t.subject_key)::integer AS visitors
        FROM ${source} t WHERE t.action='search' AND t.dimension_text<>'' ${period}
        GROUP BY t.dimension_text ORDER BY ${measure} DESC LIMIT 80`,args),
      pool.query(`SELECT e.occurred_at,e.action,e.target_type,e.target_id,e.pathname,
        e.label,e.dimension_text,e.subject_key,
        coalesce(NULLIF(u.display_name,''),u.name,'زائر غير مسجل') AS name
        FROM interest_events e LEFT JOIN users u ON e.actor_id=u.id
        WHERE e.action<>'operator_activity'
        ORDER BY e.occurred_at DESC LIMIT 100`),
      pool.query("SELECT count(*)::text AS total FROM interest_first_events"),
      pool.query(`SELECT e.occurred_at AS "occurredAt",e.target_type AS surface,
        e.dimension_text AS "actionKey",e.pathname AS "pageKey",e.actor_id AS "actorId",
        NULLIF(e.target_id,0) AS "companyId",
        (e.label::jsonb->>'employeeId')::integer AS "employeeId",
        e.label::jsonb->>'detailKey' AS "detailKey",e.label::jsonb->>'searchText' AS "searchText",
        coalesce(NULLIF(u.display_name,''),u.name) AS "actorName",
        employee.name AS "employeeName"
        FROM interest_events e LEFT JOIN users u ON e.actor_id=u.id
        LEFT JOIN employees employee ON employee.company_id=e.target_id
          AND employee.id=CASE WHEN e.action='operator_activity' THEN (e.label::jsonb->>'employeeId')::integer END
        WHERE e.action='operator_activity'
          AND e.occurred_at >= now() - ($1::integer * interval '1 day')
        ORDER BY e.occurred_at DESC,e.id DESC LIMIT 100`,[days || 100]),
    ]);
    res.json({
      days, actions:actions.rows, users:users.rows, cards:cards.rows,
      searches:searches.rows, recent:recent.rows, operatorActivity:operatorActivity.rows,
      firstEventsRetained:Number(firstCount.rows[0]?.total ?? 0),
      retentionDays:100,
    });
  }));
  return router;
}
