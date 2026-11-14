import { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { transaction } from "./db.ts";
import { actor, handler, parse } from "./http.ts";
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
const batchSchema = z.object({
  visitorId: z.string().uuid(),
  events: z.array(eventSchema).min(1).max(24),
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
      for (const item of input.events) {
        const pathname = item.path.split(/[?#]/,1)[0].slice(0,200);
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

  router.get("/interest-events/report",handler(async(req,res)=>{
    const user = await currentActor(pool,actor(req));
    ownerOnly(user);
    const requested = Number(req.query.days ?? 30);
    const days = [0,7,30,100].includes(requested) ? requested : 30;
    const source = days === 0 ? "interest_totals" : "interest_events";
    const measure = days === 0 ? "SUM(t.total)" : "COUNT(*)";
    const period = days === 0 ? "" : "AND t.occurred_at >= now() - ($1::integer * interval '1 day')";
    const args = days === 0 ? [] : [days];
    const [actions,users,cards,searches,recent,firstCount] = await Promise.all([
      pool.query(`SELECT t.action,${measure}::text AS total,
        COUNT(DISTINCT t.subject_key)::integer AS visitors
        FROM ${source} t WHERE true ${period}
        GROUP BY t.action ORDER BY total::bigint DESC`,args),
      pool.query(`SELECT t.subject_key,coalesce(NULLIF(u.display_name,''),u.name,
        CASE WHEN left(t.subject_key,2)='v:' THEN 'زائر غير مسجل' ELSE 'مستخدم' END) AS name,
        ${measure}::text AS total
        FROM ${source} t LEFT JOIN users u ON t.subject_key=('u:'||u.id::text)
        WHERE true ${period}
        GROUP BY t.subject_key,u.display_name,u.name ORDER BY total::bigint DESC LIMIT 80`,args),
      pool.query(`SELECT t.target_type,t.target_id,MAX(t.label) AS label,
        ${measure}::text AS total,
        COUNT(DISTINCT t.subject_key)::integer AS visitors
        FROM ${source} t WHERE t.action='card_open' ${period}
        GROUP BY t.target_type,t.target_id ORDER BY total::bigint DESC LIMIT 80`,args),
      pool.query(`SELECT t.dimension_text AS term,${measure}::text AS total,
        COUNT(DISTINCT t.subject_key)::integer AS visitors
        FROM ${source} t WHERE t.action='search' AND t.dimension_text<>'' ${period}
        GROUP BY t.dimension_text ORDER BY total::bigint DESC LIMIT 80`,args),
      pool.query(`SELECT e.occurred_at,e.action,e.target_type,e.target_id,e.pathname,
        e.label,e.dimension_text,e.subject_key,
        coalesce(NULLIF(u.display_name,''),u.name,'زائر غير مسجل') AS name
        FROM interest_events e LEFT JOIN users u ON e.actor_id=u.id
        ORDER BY e.occurred_at DESC LIMIT 100`),
      pool.query("SELECT count(*)::text AS total FROM interest_first_events"),
    ]);
    res.json({
      days, actions:actions.rows, users:users.rows, cards:cards.rows,
      searches:searches.rows, recent:recent.rows,
      firstEventsRetained:Number(firstCount.rows[0]?.total ?? 0),
      retentionDays:100,
    });
  }));
  return router;
}
