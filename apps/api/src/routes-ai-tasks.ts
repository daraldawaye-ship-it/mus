import { Router } from "express";
import type { Pool, QueryResultRow } from "pg";
import { z } from "zod";
import { transaction } from "./db.ts";
import { HttpError, missing } from "./errors.ts";
import { actor, handler, id, parse } from "./http.ts";
import { currentActor } from "./policies/access.ts";
import { audit } from "./services/audit.ts";

const tasksTable = "مهام الذكاء الاصطناعي";
const journalTable = "سجل إنجاز مهام الذكاء الاصطناعي";
const archivedCategory = "مهامك — مؤرشفة";
const companySection = "الشركة";
const personalSection = "مهمة خاصة بمصطفى";
const personalLinkTable = "معرفات المهام الشخصية";
export const aiTaskInput = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(12000),
  section: z.string().trim().min(1).max(120),
  companyId: z.number().int().positive().nullable(),
  cadenceHours: z.number().int().min(1).max(8760).default(8),
}).strict().refine(input => (input.section === companySection) === (input.companyId !== null), {
  message: "حدد الشركة للمهام التي تتبع قسم الشركة",
});
export const aiTaskArchiveInput = z.object({ archived: z.boolean() }).strict();
const taskQuery = `SELECT t.*, g.*, c.name AS company_name
  FROM ai_tasks t JOIN general_table g ON g.general_table_id=t.task_id
  LEFT JOIN companies c ON c.id=t.company_id
  WHERE (g.general_table_table_name=$1 OR t.private_title IS NOT NULL)`;

type Run = {
  id: number;
  title: string;
  detail: string;
  startedAt: string | null;
  finishedAt: string | null;
  recordedAt: string;
  resumeFrom: string | null;
};

const endStates = /^(?:finished|completed|stopped|aborted|failed|partial|verified|done|closed)/i;
const dateValue = (value: unknown) =>
  typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) &&
    /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString() : null;

function runMetadata(texts: string[]) {
  const entries: Record<string, unknown>[] = [];
  for (const source of texts) {
    for (const line of source.split("\n")) {
      if (!line.trimStart().startsWith("{")) continue;
      try {
        const entry = JSON.parse(line);
        if (entry && typeof entry === "object" && !Array.isArray(entry)) entries.push(entry);
      } catch {
        // Some legacy notes contain prose or truncated JSON.
      }
    }
  }
  return entries;
}

function auditRuns(rows: QueryResultRow[], taskIds: Set<number>) {
  const byTask = new Map<number, Run[]>();
  for (const row of rows) {
    const metadata = runMetadata([row.general_table_text1, row.general_table_text2, row.general_table_text8, row.general_table_text9]);
    const title = String(row.general_table_title);
    const byTitle = title.match(/^(?:المهمة\s*#?\s*(\d+)|#?(\d+)\s*[|—–:-])/);
    const entry = metadata.reverse().find(item => taskIds.has(Number(item.taskId)));
    const taskId = Number(entry?.taskId ?? byTitle?.[1] ?? byTitle?.[2]);
    if (!taskIds.has(taskId)) continue;
    const recordedAt = new Date(row.created_at).toISOString();
    const startedAt = dateValue(entry?.startedAt);
    const terminal = !entry?.status || endStates.test(String(entry.status));
    const finishedAt = dateValue(entry?.endedAt ?? entry?.finishedAt ?? entry?.completedAt)
      ?? (terminal ? recordedAt : null);
    const run = {
      id: Number(row.general_table_id),
      title,
      detail: row.general_table_description,
      recordedAt,
      startedAt,
      finishedAt,
      resumeFrom: typeof entry?.resumeFrom === "string" ? entry.resumeFrom : null,
    };
    const existing = byTask.get(taskId);
    if (existing) existing.push(run);
    else byTask.set(taskId, [run]);
  }
  return byTask;
}

async function readJournal(pool: Pool) {
  const result = await pool.query(
    `SELECT general_table_id,general_table_title,general_table_description,created_at,
       general_table_text1,general_table_text2,general_table_text8,general_table_text9
       FROM general_table WHERE general_table_table_name=$1 ORDER BY created_at DESC,general_table_id DESC`,
    [journalTable],
  );
  return result.rows;
}

function taskDTO(row: QueryResultRow, history: Run[]) {
  const lastRun = history.filter(run => run.finishedAt)
    .sort((a, b) => b.finishedAt!.localeCompare(a.finishedAt!))[0];
  const knownStarts = history.map(run => run.startedAt);
  const notes = [row.general_table_text7, row.general_table_text8, row.general_table_text9] as string[];
  for (const entry of runMetadata(notes)) {
    if (entry.taskId === row.task_id || entry.taskId === undefined)
      knownStarts.push(dateValue(entry.startedAt));
  }
  for (const note of notes) {
    for (const match of note.matchAll(/(?:بدء فعلي|وقت البدء الفعلي|startedAt)\s*[:=]\s*(\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d))/gi))
      knownStarts.push(dateValue(match[1]));
  }
  const lastStartedAt = knownStarts.filter((value): value is string => value !== null).sort().at(-1);
  const cadenceHours = row.cadence_hours as number | null;
  const archived = Boolean(row.archived_at) || row.general_table_category === archivedCategory;
  return {
    id: Number(row.task_id),
    title: String(row.private_title ?? row.general_table_title),
    description: String(row.private_description ?? row.general_table_description),
    section: String(row.section),
    companyId: row.company_id as number | null,
    companyName: row.company_name as string | null,
    cadenceHours,
    cadenceLabel: row.cadence_label as string | null,
    archived,
    lastFinishedAt: lastRun?.finishedAt ?? null,
    lastResult: lastRun?.detail || lastRun?.title || String(row.general_table_text9 || ""),
    resumeFrom: lastRun?.resumeFrom ?? null,
    nextEligibleAt: !archived && lastStartedAt && cadenceHours
      ? new Date(Date.parse(lastStartedAt) + cadenceHours * 3600000).toISOString() : null,
  };
}

export function aiTaskRoutes(pool: Pool) {
  const router = Router();
  router.use("/ai-tasks", (req, res, next) => {
    if (!actor(req).owner) throw new HttpError(403, "owner_only", "للمالك فقط");
    res.set("Cache-Control", "private, no-store");
    next();
  });

  router.get("/ai-tasks", handler(async (_req, res) => {
    const [tasks, companies, journal] = await Promise.all([
      pool.query(taskQuery + " ORDER BY t.task_id DESC", [tasksTable]),
      pool.query<{ id: number; name: string }>("SELECT id,name FROM companies ORDER BY name,id"),
      readJournal(pool),
    ]);
    const byTask = auditRuns(journal, new Set(tasks.rows.map(row => Number(row.task_id))));
    res.json({
      tasks: tasks.rows.map(row => taskDTO(row, byTask.get(Number(row.task_id)) ?? [])),
      companies: companies.rows,
    });
  }));

  router.get("/ai-tasks/:id/history", handler(async (req, res) => {
    const taskId = id(req.params.id);
    const task = await pool.query(taskQuery + " AND t.task_id=$2", [tasksTable, taskId]);
    if (!task.rowCount) missing();
    const byTask = auditRuns(await readJournal(pool), new Set([taskId]));
    res.json({ history: byTask.get(taskId) ?? [] });
  }));

  router.post("/ai-tasks", handler(async (req, res) => {
    const input = parse(aiTaskInput, req.body);
    const taskId = await transaction(pool, async db => {
      const user = await currentActor(db, actor(req));
      if (!user.owner) throw new HttpError(403, "owner_only", "للمالك فقط");
      if (input.companyId !== null && !(await db.query("SELECT id FROM companies WHERE id=$1", [input.companyId])).rowCount)
        missing();
      const personal = input.section === personalSection;
      const inserted = await db.query<{ general_table_id: number }>(
        `INSERT INTO general_table(general_table_table_name,general_table_category,general_table_title,
           general_table_description,general_table_number2,general_table_text6,created_by)
           VALUES($1,$2,$3,$4,0,$5,$6) RETURNING general_table_id`,
        [personal ? personalLinkTable : tasksTable, personal ? "" : input.section,
          personal ? "معرّف مهمة خاصة" : input.title, personal ? "" : input.description,
          `الدورية المعتمدة: كل ${input.cadenceHours} ساعات من آخر بدء فعلي.` +
            (input.companyId === null ? "" : ` الشركة رقم ${input.companyId}.`), user.id],
      );
      const taskId = inserted.rows[0].general_table_id;
      await db.query(`INSERT INTO ai_tasks(task_id,section,company_id,cadence_hours,private_title,private_description)
        VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(task_id) DO UPDATE SET section=EXCLUDED.section,company_id=EXCLUDED.company_id,
          cadence_hours=EXCLUDED.cadence_hours`,
        [taskId, input.section, input.companyId, input.cadenceHours,
          personal ? input.title : null, personal ? input.description : null]);
      await audit(db, user, "generalTable.create", "aiTask", taskId, null,
        { taskId, section: input.section, companyId: input.companyId, cadenceHours: input.cadenceHours });
      return taskId;
    });
    res.status(201).json({ id: taskId });
  }));

  router.patch("/ai-tasks/:id/archive", handler(async (req, res) => {
    const taskId = id(req.params.id);
    const { archived } = parse(aiTaskArchiveInput, req.body);
    await transaction(pool, async db => {
      const user = await currentActor(db, actor(req));
      if (!user.owner) throw new HttpError(403, "owner_only", "للمالك فقط");
      const found = await db.query(taskQuery + " AND t.task_id=$2 FOR UPDATE OF g,t", [tasksTable, taskId]);
      const row = found.rows[0];
      if (!row) missing();
      const before = Boolean(row.archived_at) || row.general_table_category === archivedCategory;
      if (before === archived) return;
      if (archived) {
        await db.query("UPDATE ai_tasks SET archived_at=now(),previous_category=$2,previous_number2=$3 WHERE task_id=$1",
          [taskId, row.general_table_category, row.general_table_number2]);
      } else {
        await db.query("UPDATE ai_tasks SET archived_at=NULL,previous_category=NULL,previous_number2=NULL WHERE task_id=$1", [taskId]);
      }
      if (!row.private_title) await db.query(`UPDATE general_table SET general_table_category=$2,general_table_number2=$3,updated_at=now()
        WHERE general_table_id=$1`, [taskId, archived ? archivedCategory : row.previous_category ?? row.section,
        archived ? 1 : row.previous_number2]);
      await audit(db, user, "generalTable.update", "aiTask", taskId, { archived: before }, { archived });
    });
    res.json({ id: taskId, archived });
  }));
  return router;
}
