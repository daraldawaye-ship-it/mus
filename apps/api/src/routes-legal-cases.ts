import { Router } from "express";
import { z } from "zod";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { transaction, type Database } from "./db.ts";
import { actor, handler, id, parse } from "./http.ts";
import { currentActor, ownerOnly } from "./policies/access.ts";
import { HttpError, missing } from "./errors.ts";
import { audit } from "./services/audit.ts";
import type { User } from "../../../packages/contracts/src/index.ts";
import { calculateLegalTaskPriority, compareLegalTasks, type TaskPriorityInput } from "./legal-task-priority.ts";

type LegalTaskRow = QueryResultRow & TaskPriorityInput & {
  id:number;kind:string;sort_order:number;
};

const positive = z.number().int().positive().max(2147483647);
const legalTaskPrioritySchema=z.object({
  priority:z.number().int().min(1).max(10).nullable(),
  revision:positive,
  reason:z.string().trim().max(2000).default(""),
}).strict();
const date = z.iso.date().nullable();
const httpsUrl = z.union([z.literal(""), z.url().refine(value => /^https:\/\//i.test(value), "الرابط يجب أن يكون HTTPS")]);
const caseSchema = z.object({
  title: z.string().trim().min(1).max(250),
  caseNumber: z.string().trim().max(120).default(""),
  agency: z.string().trim().max(250).default(""),
  driveFolderId: z.string().max(200).default(""),
  driveFolderUrl: httpsUrl.default(""),
  stage: z.string().trim().max(120).default(""),
  status: z.enum(["active","closed","unknown"]).default("active"),
  fileCopyStatus: z.enum(["unknown","yes","no","partial"]).default("unknown"),
  startDate: date.default(null),
  nextHearing: date.default(null),
  priority: z.number().int().min(0).max(10).default(0),
  summary: z.string().max(100000).default(""),
}).strict();
const kindSchema = z.enum(["fact","document","event","explanation","task","report","hearing"]);
const recordSchema = z.object({
  kind: kindSchema,
  title: z.string().trim().min(1).max(300),
  body: z.string().max(250000).default(""),
  contentText: z.string().max(1000000).default(""),
  imageUrls: z.array(httpsUrl).max(50).default([]),
  pdfUrl: httpsUrl.default(""),
  driveFileId: z.string().max(200).default(""),
  driveFolderId: z.string().max(200).default(""),
  driveFolderUrl: httpsUrl.default(""),
  sourceIssuer: z.string().max(500).default(""),
  documentNumber: z.string().max(150).default(""),
  recordDate: date.default(null),
  dueAt: z.iso.datetime({offset:true}).nullable().default(null),
  sortOrder: z.number().int().min(0).max(1000000).default(0),
  status: z.string().trim().max(40).default(""),
  assignedTo: positive.nullable().default(null),
  caseIds: z.array(positive).max(100).default([]),
}).strict();
const legalCaseUpdateSchema = caseSchema.extend({revision:positive});
const legalCaseAccessSchema = z.object({
  userId:positive,
  role:z.enum(["viewer","reporter","editor"]).nullable(),
}).strict();
const legalRecordUpdateSchema = recordSchema.omit({caseIds:true}).extend({revision:positive});
const legalRecordCaseSchema = z.object({caseId:positive,linked:z.boolean()}).strict();
const legalRecordLinkSchema = z.object({otherId:positive,linked:z.boolean()}).strict();
const legalRecordTaskStatusSchema = z.object({
  status:z.enum(["pending","working","submitted","verified","blocked"]),
}).strict();
const legalRecordImageSchema = z.object({
  filename:z.string().max(250).default(""),
  dataUrl:z.string().min(30).max(3000000),
}).strict();
export const mcpBodySchemas = {
  caseSchema,
  legalCaseUpdateSchema,
  legalCaseAccessSchema,
  recordSchema,
  legalRecordUpdateSchema,
  legalRecordCaseSchema,
  legalRecordLinkSchema,
  legalRecordTaskStatusSchema,
  legalRecordImageSchema,
  legalTaskPrioritySchema,
};
// This action intentionally reads no body; keep that explicit in the catalog
// without adding a different validator or workflow to the existing API route.
export const mcpBodylessOperations = ["POST /legal/records/:id/review"];
const caseColumns = [
  "title","case_number","agency","drive_folder_id","drive_folder_url","stage","status","file_copy_status",
  "start_date","next_hearing","priority","summary",
] as const;
const caseValues = (v:z.infer<typeof caseSchema>)=>[
  v.title,v.caseNumber,v.agency,v.driveFolderId,v.driveFolderUrl,v.stage,v.status,v.fileCopyStatus,
  v.startDate,v.nextHearing,v.priority,v.summary,
];
const recordColumns = [
  "kind","title","body","content_text","image_urls","pdf_url",
  "drive_file_id","drive_folder_id","drive_folder_url","source_issuer",
  "document_number","record_date","due_at","sort_order","status","assigned_to",
] as const;
const recordValues = (v:z.infer<typeof recordSchema>)=>[
  v.kind,v.title,v.body,v.contentText,JSON.stringify(v.imageUrls),v.pdfUrl,
  v.driveFileId,v.driveFolderId,v.driveFolderUrl,v.sourceIssuer,
  v.documentNumber,v.recordDate,v.dueAt,v.sortOrder,v.status,v.assignedTo,
];
const number = (value:unknown)=>id(typeof value==="string"?value:"");
const userRoleRank:Record<string,number>={viewer:1,reporter:2,editor:3,owner:4};
async function level(db:Database,user:User,caseId:number) {
  if(user.owner) return "owner";
  if(user.suspended) return "";
  const row=await db.query("SELECT role FROM legal_case_access WHERE case_id=$1 AND user_id=$2",[caseId,user.id]);
  return (row.rows[0]?.role ?? "") as string;
}
async function canCase(db:Database,user:User,caseId:number,min:"viewer"|"reporter"|"editor"="viewer") {
  const exists=await db.query("SELECT id FROM legal_cases WHERE id=$1",[caseId]);
  if(!exists.rows.length) missing();
  const role=await level(db,user,caseId);
  if((userRoleRank[role]??0)<userRoleRank[min]) throw new HttpError(403,"legal_forbidden","لا تملك صلاحية هذه القضية");
}
async function recordCases(db:Database,recordId:number) {
  const rows=await db.query("SELECT case_id FROM legal_record_cases WHERE record_id=$1 ORDER BY case_id",[recordId]);
  return rows.rows.map(r=>r.case_id as number);
}
async function canRecord(db:Database,user:User,recordId:number,min:"viewer"|"reporter"|"editor"="viewer") {
  const exists=await db.query("SELECT id FROM legal_records WHERE id=$1",[recordId]);
  if(!exists.rows.length) missing();
  if(user.owner) return;
  const cases=await recordCases(db,recordId);
  if(!cases.length) throw new HttpError(403,"legal_forbidden","السجلات غير المرتبطة خاصة بالمالك");
  for(const caseId of cases) await canCase(db,user,caseId,min);
}
async function requireCases(db:Database,user:User,ids:number[],role:"reporter"|"editor") {
  if(new Set(ids).size!==ids.length) throw new HttpError(400,"duplicate","لا تكرر القضية");
  if(!ids.length && !user.owner) throw new HttpError(403,"legal_forbidden","حدد قضية مصرحًا لك بها");
  for(const caseId of ids) await canCase(db,user,caseId,role);
}
const forbidIfDisabled=async(db:Database)=>{
  const disabled=await db.query("SELECT 1 FROM page_settings WHERE page_key='public.legal-cases' AND company_id IS NULL AND enabled=false");
  if(disabled.rowCount) throw new HttpError(403,"page_disabled","نظام القضايا معطل");
};
const getRecord=async(db:Database,recordId:number)=>{
  const row=(await db.query("SELECT * FROM legal_records WHERE id=$1",[recordId])).rows[0];
  if(!row) missing();
  return row;
};
export function legalCaseRoutes(pool:Pool):Router {
  const router=Router();
  router.get("/legal/overview",handler(async(req,res)=>{
    const user=actor(req);
    const [cases,records]=await Promise.all([
      pool.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE status='active')::int AS active,count(*) FILTER(WHERE needs_review)::int AS needs_review FROM legal_cases c WHERE $1 OR EXISTS(SELECT 1 FROM legal_case_access a WHERE a.case_id=c.id AND a.user_id=$2)",[user.owner,user.id]),
      pool.query("SELECT kind,count(*)::int AS total FROM legal_records r WHERE $1 OR EXISTS(SELECT 1 FROM legal_record_cases rc JOIN legal_case_access a ON a.case_id=rc.case_id AND a.user_id=$2 WHERE rc.record_id=r.id) GROUP BY kind",[user.owner,user.id]),
    ]);
    res.json({cases:cases.rows[0],records:records.rows});
  }));
  router.get("/legal/people",handler(async(req,res)=>{
    ownerOnly(actor(req));
    const rows=await pool.query("SELECT id,display_name AS name FROM users WHERE NOT archived ORDER BY display_name LIMIT 300");
    res.json({items:rows.rows});
  }));
  router.get("/legal/cases",handler(async(req,res)=>{
    const user=actor(req),q=String(req.query.q??"").trim().slice(0,150);
    const status=req.query.status;
    if(status!==undefined && !["active","closed","unknown"].includes(String(status))) throw new HttpError(400,"invalid_query","حالة غير صالحة");
    const page=Math.max(1,Math.min(100000,Number(req.query.page)||1));
    const limit=30;
    const where="($1::boolean OR EXISTS(SELECT 1 FROM legal_case_access a WHERE a.case_id=c.id AND a.user_id=$2)) AND (c.title ILIKE $3 OR c.case_number ILIKE $3 OR c.agency ILIKE $3 OR c.summary ILIKE $3) AND ($4::text IS NULL OR c.status=$4)";
    const args=[user.owner,user.id,"%"+q.replace(/[%_\\]/g,"\\$&")+"%",status??null];
    const [rows,count]=await Promise.all([
      pool.query("SELECT c.* FROM legal_cases c WHERE "+where+" ORDER BY c.priority DESC,c.id DESC LIMIT $5 OFFSET $6",[...args,limit,(page-1)*limit]),
      pool.query("SELECT count(*)::int AS total FROM legal_cases c WHERE "+where,args),
    ]);
    res.json({items:rows.rows,total:count.rows[0].total,page,pageSize:limit});
  }));
  router.post("/legal/cases",handler(async(req,res)=>{
    const input=parse(caseSchema,req.body),requested=actor(req);
    ownerOnly(requested);
    const record=await transaction(pool,async db=>{
      const user=await currentActor(db,requested);
      await forbidIfDisabled(db);
      const columns=[...caseColumns,"created_by","updated_by"];
      const values=[...caseValues(input),user.id,user.id];
      const sql="INSERT INTO legal_cases("+columns.join(",")+") VALUES("+values.map((_,i)=>"$"+(i+1)).join(",")+") RETURNING *";
      const next=(await db.query(sql,values)).rows[0];
      await audit(db,user,"legal.create","legalCase",next.id,null,next);
      return next;
    });
    res.status(201).json({record});
  }));
  router.get("/legal/cases/:id",handler(async(req,res)=>{
    const user=actor(req),caseId=number(req.params.id);
    await canCase(pool,user,caseId);
    const record=(await pool.query("SELECT * FROM legal_cases WHERE id=$1",[caseId])).rows[0];
    res.json({record,role:await level(pool,user,caseId)});
  }));
  router.put("/legal/cases/:id",handler(async(req,res)=>{
    const caseId=number(req.params.id);
    const payload=parse(legalCaseUpdateSchema,req.body);
    const record=await transaction(pool,async db=>{
      const user=await currentActor(db,actor(req));
      await canCase(db,user,caseId,"editor");
      await forbidIfDisabled(db);
      const previous=(await db.query("SELECT * FROM legal_cases WHERE id=$1 FOR UPDATE",[caseId])).rows[0];
      if(previous.revision!==payload.revision) throw new HttpError(409,"conflict","عُدلت القضية من جهاز آخر؛ أعد تحميلها");
      if(!user.owner && previous.status!==payload.status) throw new HttpError(403,"legal_forbidden","تغيير حالة القضية من اختصاص المالك");
      const values=caseValues(payload);
      const sql="UPDATE legal_cases SET "+caseColumns.map((col,i)=>col+"=$"+(i+1)).join(",")+",revision=revision+1,needs_review=false,updated_at=now(),updated_by=$13 WHERE id=$14 RETURNING *";
      const next=(await db.query(sql,[...values,user.id,caseId])).rows[0];
      await audit(db,user,"legal.update","legalCase",caseId,previous,next);
      return next;
    });
    res.json({record});
  }));
  router.get("/legal/cases/:id/records",handler(async(req,res)=>{
    const caseId=number(req.params.id),user=actor(req);
    await canCase(pool,user,caseId);
    const rows=await pool.query<LegalTaskRow>(
      `SELECT r.*,u.display_name AS creator_name,
        (SELECT count(*)::int FROM legal_document_images i WHERE i.record_id=r.id) AS image_count,
        linked.case_title,linked.next_hearing
       FROM legal_records r JOIN legal_record_cases rc ON rc.record_id=r.id
       LEFT JOIN users u ON u.id=r.created_by
       LEFT JOIN LATERAL (
         SELECT string_agg(c.title,' ' ORDER BY c.id) AS case_title,
           MIN(c.next_hearing)::text AS next_hearing
         FROM legal_record_cases all_cases JOIN legal_cases c ON c.id=all_cases.case_id
         WHERE all_cases.record_id=r.id
       ) linked ON true
       WHERE rc.case_id=$1 AND ($2::boolean OR NOT EXISTS(
         SELECT 1 FROM legal_record_cases other WHERE other.record_id=r.id
           AND NOT EXISTS(SELECT 1 FROM legal_case_access granted
             WHERE granted.case_id=other.case_id AND granted.user_id=$3)))
       ORDER BY CASE r.kind WHEN 'explanation' THEN 0 WHEN 'event' THEN 1 WHEN 'hearing' THEN 2 WHEN 'task' THEN 3 WHEN 'report' THEN 4 WHEN 'fact' THEN 5 ELSE 6 END,
         r.sort_order,r.record_date NULLS LAST,r.id DESC`,[caseId,user.owner,user.id]);
    const now=Date.now();
    const tasks=rows.rows.filter(row=>row.kind==="task")
      .map(row=>({...row,...calculateLegalTaskPriority(row,now)})).sort(compareLegalTasks);
    let taskIndex=0;
    // Preserve the existing grouping and order of documents, facts and reports.
    res.json({items:rows.rows.map(row=>row.kind==="task"?tasks[taskIndex++]:row)});
  }));
  router.get("/legal/cases/:id/access",handler(async(req,res)=>{
    ownerOnly(actor(req));
    const caseId=number(req.params.id);
    const rows=await pool.query("SELECT a.*,u.display_name AS user_name FROM legal_case_access a JOIN users u ON u.id=a.user_id WHERE a.case_id=$1 ORDER BY u.display_name",[caseId]);
    res.json({items:rows.rows});
  }));
  router.put("/legal/cases/:id/access",handler(async(req,res)=>{
    const caseId=number(req.params.id),input=parse(legalCaseAccessSchema,req.body);
    const access=await transaction(pool,async db=>{
      const user=await currentActor(db,actor(req));ownerOnly(user);
      await canCase(db,user,caseId);
      await forbidIfDisabled(db);
      const target=(await db.query("SELECT id,owner,archived FROM users WHERE id=$1",[input.userId])).rows[0];
      if(!target||target.archived) missing();
      const old=(await db.query("SELECT * FROM legal_case_access WHERE case_id=$1 AND user_id=$2 FOR UPDATE",[caseId,input.userId])).rows[0]??null;
      if(input.role===null) await db.query("DELETE FROM legal_case_access WHERE case_id=$1 AND user_id=$2",[caseId,input.userId]);
      else await db.query("INSERT INTO legal_case_access(case_id,user_id,role,granted_by) VALUES($1,$2,$3,$4) ON CONFLICT(case_id,user_id) DO UPDATE SET role=EXCLUDED.role,granted_by=EXCLUDED.granted_by,granted_at=now()",[caseId,input.userId,input.role,user.id]);
      await audit(db,user,"legal.access","legalCase",caseId,old,{userId:input.userId,role:input.role});
      return {userId:input.userId,role:input.role};
    });
    res.json({access});
  }));
  router.get("/legal/tasks",handler(async(req,res)=>{
    const user=actor(req);
    const term=String(req.query.q??"").trim().slice(0,120);
    // Visibility is checked for ALL linked cases so a task shared with a
    // confidential case cannot leak to a user with only partial access.
    const rows=await pool.query<LegalTaskRow>(
      `SELECT r.id,r.kind,r.title,r.body,r.status,r.due_at,r.assigned_to,r.sort_order,
        r.revision,r.task_priority,r.task_priority_reason,r.created_at,r.updated_at,
        COALESCE(json_agg(json_build_object('id',c.id,'title',c.title,'next_hearing',c.next_hearing)
          ORDER BY c.id) FILTER(WHERE c.id IS NOT NULL),'[]'::json) AS cases,
        MIN(c.next_hearing)::text AS next_hearing,
        string_agg(c.title,' ' ORDER BY c.id) AS case_title
       FROM legal_records r
       LEFT JOIN legal_record_cases rc ON rc.record_id=r.id
       LEFT JOIN legal_cases c ON c.id=rc.case_id
       WHERE r.kind='task' AND (r.title ILIKE $3 OR r.body ILIKE $3)
         AND ($1::boolean OR (
           EXISTS(SELECT 1 FROM legal_record_cases x
             JOIN legal_case_access a ON a.case_id=x.case_id AND a.user_id=$2
             WHERE x.record_id=r.id)
           AND NOT EXISTS(SELECT 1 FROM legal_record_cases x
             WHERE x.record_id=r.id AND NOT EXISTS(
               SELECT 1 FROM legal_case_access a WHERE a.case_id=x.case_id AND a.user_id=$2
             ))
         ))
       GROUP BY r.id`,
      [user.owner,user.id,"%"+term.replace(/[%_\\]/g,"\\$&")+"%"],
    );
    // Rank every visible task before returning it; a newer normal task must not
    // hide an older urgent one behind a database fetch limit.
    const now=Date.now();
    const items=rows.rows.map(row=>({
      ...row,...calculateLegalTaskPriority(row,now),
    })).sort(compareLegalTasks);
    res.json({items,total:items.length});
  }));
  router.put("/legal/tasks/:id/priority",handler(async(req,res)=>{
    const recordId=number(req.params.id);
    const input=parse(legalTaskPrioritySchema,req.body);
    const record=await transaction(pool,async db=>{
      const user=await currentActor(db,actor(req));ownerOnly(user);
      await forbidIfDisabled(db);
      const old=(await db.query("SELECT * FROM legal_records WHERE id=$1 FOR UPDATE",[recordId])).rows[0];
      if(!old)missing();
      if(old.kind!=="task")throw new HttpError(400,"invalid_kind","السجل ليس مهمة");
      if(old.revision!==input.revision)throw new HttpError(409,"conflict","تغيرت المهمة؛ أعد تحميلها قبل تعديل الأولوية");
      const next=(await db.query(
        "UPDATE legal_records SET task_priority=$2,task_priority_reason=$3,revision=revision+1,updated_by=$4,updated_at=now() WHERE id=$1 RETURNING *",
        [recordId,input.priority,input.priority===null?"":input.reason,user.id],
      )).rows[0];
      await audit(db,user,"legal.update","legalRecord",recordId,old,next);
      return next;
    });
    res.json({record});
  }));
  router.get("/legal/records",handler(async(req,res)=>{
    const user=actor(req),kind=req.query.kind;
    if(kind!==undefined && !kindSchema.safeParse(kind).success) throw new HttpError(400,"invalid_query","نوع سجل غير صالح");
    const page=Number(req.query.page??1);
    if(!Number.isSafeInteger(page)||page<1||page>100000) throw new HttpError(400,"invalid_query","رقم الصفحة غير صالح");
    const unlinkedParam=req.query.unlinked;
    if(unlinkedParam!==undefined && !["true","false"].includes(String(unlinkedParam))) throw new HttpError(400,"invalid_query","مرشح الربط غير صالح");
    const unlinked=unlinkedParam==="true";
    if(unlinked) ownerOnly(user);
    const q=String(req.query.q??"").trim().slice(0,120),limit=unlinked?30:100;
    const where="($1::boolean OR (EXISTS(SELECT 1 FROM legal_record_cases rc JOIN legal_case_access a ON a.case_id=rc.case_id AND a.user_id=$2 WHERE rc.record_id=r.id) AND NOT EXISTS(SELECT 1 FROM legal_record_cases other WHERE other.record_id=r.id AND NOT EXISTS(SELECT 1 FROM legal_case_access granted WHERE granted.case_id=other.case_id AND granted.user_id=$2)))) AND ($3::text IS NULL OR r.kind=$3) AND (r.title ILIKE $4 OR r.body ILIKE $4 OR r.content_text ILIKE $4) AND (NOT $5::boolean OR NOT EXISTS(SELECT 1 FROM legal_record_cases rc_unlinked WHERE rc_unlinked.record_id=r.id))";
    const args=[user.owner,user.id,kind??null,"%"+q.replace(/[%_\\]/g,"\\$&")+"%",unlinked];
    const [rows,count]=await Promise.all([
      pool.query("SELECT r.* FROM legal_records r WHERE "+where+" ORDER BY r.id DESC LIMIT $6 OFFSET $7",[...args,limit,(page-1)*limit]),
      pool.query("SELECT COUNT(*)::int AS total FROM legal_records r WHERE "+where,args),
    ]);
    res.json({items:rows.rows,total:count.rows[0].total,page,pageSize:limit});
  }));
  router.get("/legal/records/:id",handler(async(req,res)=>{
    const recordId=number(req.params.id),user=actor(req);
    await canRecord(pool,user,recordId);
    const record=await getRecord(pool,recordId);
    const [cases,links,images]=await Promise.all([
      pool.query("SELECT case_id FROM legal_record_cases WHERE record_id=$1",[recordId]),
      pool.query("SELECT CASE WHEN first_record_id=$1 THEN second_record_id ELSE first_record_id END AS record_id FROM legal_record_links WHERE first_record_id=$1 OR second_record_id=$1",[recordId]),
      pool.query("SELECT id,filename,created_at FROM legal_document_images WHERE record_id=$1 ORDER BY id",[recordId]),
    ]);
    res.json({record,caseIds:cases.rows.map(x=>x.case_id),linkedIds:links.rows.map(x=>x.record_id),images:images.rows});
  }));
  router.post("/legal/records",handler(async(req,res)=>{
    const input=parse(recordSchema,req.body);
    const record=await transaction(pool,async db=>{
      const user=await currentActor(db,actor(req));
      const role=input.kind==="report"?"reporter":"editor";
      await requireCases(db,user,input.caseIds,role);
      if(user.suspended) throw new HttpError(403,"forbidden","الحساب موقوف");
      await forbidIfDisabled(db);
      const columns=[...recordColumns,"created_by","updated_by"];
      const values=[...recordValues(input),user.id,user.id];
      const next=(await db.query("INSERT INTO legal_records("+columns.join(",")+") VALUES("+values.map((_,i)=>"$"+(i+1)).join(",")+") RETURNING *",values)).rows[0];
      for(const caseId of input.caseIds) await db.query("INSERT INTO legal_record_cases(record_id,case_id) VALUES($1,$2)",[next.id,caseId]);
      await audit(db,user,"legal.create","legalRecord",next.id,null,{...next,caseIds:input.caseIds});
      return next;
    });
    res.status(201).json({record});
  }));
  router.put("/legal/records/:id",handler(async(req,res)=>{
    const recordId=number(req.params.id),input=parse(legalRecordUpdateSchema,req.body);
    const record=await transaction(pool,async db=>{
      const user=await currentActor(db,actor(req));
      await canRecord(db,user,recordId,"editor");
      await forbidIfDisabled(db);
      const old=(await db.query("SELECT * FROM legal_records WHERE id=$1 FOR UPDATE",[recordId])).rows[0];
      if(old.revision!==input.revision) throw new HttpError(409,"conflict","تغير السجل؛ أعد تحميله");
      if(old.kind!==input.kind) throw new HttpError(400,"invalid_kind","لا يمكن تغيير نوع السجل");
      const next=(await db.query("UPDATE legal_records SET "+recordColumns.map((c,i)=>c+"=$"+(i+1)).join(",")+",revision=revision+1,updated_by=$17,updated_at=now() WHERE id=$18 RETURNING *",[...recordValues({...input,caseIds:[]}),user.id,recordId])).rows[0];
      await audit(db,user,"legal.update","legalRecord",recordId,old,next);
      return next;
    });
    res.json({record});
  }));
  router.post("/legal/records/:id/cases",handler(async(req,res)=>{
    const recordId=number(req.params.id),input=parse(legalRecordCaseSchema,req.body);
    await transaction(pool,async db=>{
      const user=await currentActor(db,actor(req));
      await canRecord(db,user,recordId,"editor");
      await canCase(db,user,input.caseId,"editor");
      await forbidIfDisabled(db);
      if(input.linked) await db.query("INSERT INTO legal_record_cases(record_id,case_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[recordId,input.caseId]);
      else await db.query("DELETE FROM legal_record_cases WHERE record_id=$1 AND case_id=$2",[recordId,input.caseId]);
      await audit(db,user,"legal.link","legalRecord",recordId,null,{caseId:input.caseId,linked:input.linked});
    });
    res.json({ok:true});
  }));
  router.post("/legal/records/:id/links",handler(async(req,res)=>{
    const recordId=number(req.params.id),input=parse(legalRecordLinkSchema,req.body);
    if(recordId===input.otherId) throw new HttpError(400,"invalid_link","لا يمكن ربط السجل بنفسه");
    await transaction(pool,async db=>{
      const user=await currentActor(db,actor(req));
      await canRecord(db,user,recordId,"editor");
      await canRecord(db,user,input.otherId,"editor");
      await forbidIfDisabled(db);
      const a=Math.min(recordId,input.otherId),b=Math.max(recordId,input.otherId);
      if(input.linked) await db.query("INSERT INTO legal_record_links(first_record_id,second_record_id,created_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",[a,b,user.id]);
      else await db.query("DELETE FROM legal_record_links WHERE first_record_id=$1 AND second_record_id=$2",[a,b]);
      await audit(db,user,"legal.link","legalRecord",recordId,null,{otherId:input.otherId,linked:input.linked});
    });
    res.json({ok:true});
  }));
  router.post("/legal/records/:id/review",handler(async(req,res)=>{
    const recordId=number(req.params.id);
    const record=await transaction(pool,async db=>{
      const user=await currentActor(db,actor(req));ownerOnly(user);
      await forbidIfDisabled(db);
      const old=await getRecord(db,recordId);
      if(old.kind!=="report") throw new HttpError(400,"invalid_kind","الاعتماد للتقارير فقط");
      const next=(await db.query("UPDATE legal_records SET reviewed_at=now(),revision=revision+1,updated_by=$2,updated_at=now() WHERE id=$1 RETURNING *",[recordId,user.id])).rows[0];
      await audit(db,user,"legal.update","legalRecord",recordId,old,next);
      return next;
    });
    res.json({record});
  }));
  router.post("/legal/records/:id/task-status",handler(async(req,res)=>{
    const recordId=number(req.params.id),input=parse(legalRecordTaskStatusSchema,req.body);
    const record=await transaction(pool,async db=>{
      const user=await currentActor(db,actor(req));
      await canRecord(db,user,recordId,"viewer");
      const old=await getRecord(db,recordId);
      if(old.kind!=="task" || (!user.owner && old.assigned_to!==user.id && !(await Promise.all((await recordCases(db,recordId)).map(caseId=>level(db,user,caseId)))).every(role=>role==="editor"))) throw new HttpError(403,"legal_forbidden","غير مسموح بتغيير هذه المهمة");
      if(input.status==="verified" && !user.owner) throw new HttpError(403,"legal_forbidden","اعتماد الإنجاز للمالك");
      await forbidIfDisabled(db);
      const next=(await db.query("UPDATE legal_records SET status=$2,revision=revision+1,updated_by=$3,updated_at=now() WHERE id=$1 RETURNING *",[recordId,input.status,user.id])).rows[0];
      await audit(db,user,"legal.update","legalRecord",recordId,old,next);
      return next;
    });
    res.json({record});
  }));
  router.post("/legal/records/:id/images",handler(async(req,res)=>{
    const recordId=number(req.params.id);
    const input=parse(legalRecordImageSchema,req.body);
    const match=/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(input.dataUrl);
    if(!match) throw new HttpError(400,"invalid_image","صيغة صورة غير صالحة");
    const image=Buffer.from(match[2],"base64"),mime="image/"+match[1];
    const valid=mime==="image/png"?image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):mime==="image/jpeg"?image[0]===255&&image[1]===216:image.subarray(0,4).toString()==="RIFF"&&image.subarray(8,12).toString()==="WEBP";
    if(!valid||!image.length||image.length>2097152) throw new HttpError(400,"invalid_image","الصورة كبيرة أو غير صالحة؛ الحد 2 ميجابايت");
    const item=await transaction(pool,async db=>{
      const user=await currentActor(db,actor(req));
      await canRecord(db,user,recordId,"editor");
      await forbidIfDisabled(db);
      const record=await getRecord(db,recordId);
      if(record.kind!=="document") throw new HttpError(400,"invalid_kind","الصور لسجلات المستندات");
      const next=(await db.query("INSERT INTO legal_document_images(record_id,mime_type,image_bytes,filename,uploaded_by) VALUES($1,$2,$3,$4,$5) RETURNING id,record_id,filename,created_at",[recordId,mime,image,input.filename,user.id])).rows[0];
      await audit(db,user,"legal.create","legalImage",next.id,null,{recordId,filename:input.filename,bytes:image.length});
      return next;
    });
    res.status(201).json({item});
  }));
  router.get("/legal/images/:id",handler(async(req,res)=>{
    const imageId=number(req.params.id),user=actor(req);
    const row=(await pool.query("SELECT * FROM legal_document_images WHERE id=$1",[imageId])).rows[0];
    if(!row) missing();
    await canRecord(pool,user,row.record_id);
    res.setHeader("Cache-Control","private,no-store");
    res.setHeader("Content-Security-Policy","default-src 'none'; sandbox");
    res.setHeader("X-Content-Type-Options","nosniff");
    res.type(row.mime_type).send(row.image_bytes);
  }));
  router.get("/legal/cases/:id/ai-export",handler(async(req,res)=>{
    const caseId=number(req.params.id),user=actor(req);
    await canCase(pool,user,caseId);
    const [record,records,linked]=await Promise.all([
      pool.query("SELECT * FROM legal_cases WHERE id=$1",[caseId]),
      pool.query("SELECT r.*,u.display_name AS creator_name FROM legal_records r JOIN legal_record_cases rc ON rc.record_id=r.id JOIN users u ON u.id=r.created_by WHERE rc.case_id=$1 AND ($2::boolean OR NOT EXISTS(SELECT 1 FROM legal_record_cases other WHERE other.record_id=r.id AND NOT EXISTS(SELECT 1 FROM legal_case_access granted WHERE granted.case_id=other.case_id AND granted.user_id=$3))) ORDER BY CASE r.kind WHEN 'explanation' THEN 0 WHEN 'event' THEN 1 ELSE 2 END,r.sort_order,r.record_date NULLS LAST,r.id",[caseId,user.owner,user.id]),
      pool.query("SELECT l.first_record_id,l.second_record_id FROM legal_record_links l WHERE l.first_record_id IN(SELECT record_id FROM legal_record_cases WHERE case_id=$1) OR l.second_record_id IN(SELECT record_id FROM legal_record_cases WHERE case_id=$1)",[caseId]),
    ]);
    res.json({version:1,case:record.rows[0],records:records.rows,links:linked.rows,notes:"Original scans and external PDFs require separately authorized retrieval; text is not inferred from links."});
  }));
  return router;
}
