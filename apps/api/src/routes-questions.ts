import { Router, type Request } from "express";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { z } from "zod";
import { actor, handler, id, parse } from "./http.ts";
import { transaction } from "./db.ts";
import { companyAccess, currentActor } from "./policies/access.ts";
import { HttpError, missing } from "./errors.ts";
import { audit } from "./services/audit.ts";
import { directoryEntries, assertDirectoryAccess, assertRequestPagesEnabled } from "./services/pages.ts";
import { searchPattern } from "./services/lists.ts";

const questionFields = z.object({
  category: z.string().trim().max(120).default(""),
  priority: z.number().int().min(1).max(100).default(1),
  question: z.string().trim().min(1).max(2000),
  options: z.array(z.string().trim().min(1).max(1000)).min(2).max(4),
  correctAnswer: z.number().int().min(1).max(4),
  points: z.number().int().min(0).max(100000).default(1),
  active: z.boolean().default(true),
}).strict().refine(input => input.correctAnswer <= input.options.length, {
  path:["correctAnswer"],message:"اختر الإجابة الصحيحة ضمن الخيارات الموجودة"
});
const editFields = questionFields.safeExtend({ revision: z.number().int().positive() });
const statusFields = z.object({ revision:z.number().int().positive(),active:z.boolean() }).strict();
const answerFields = z.object({
  selectedAnswer: z.number().int().min(1).max(4),
  comment: z.string().trim().max(2000).nullable().optional(),
  idempotencyKey: z.string().uuid(),
}).strict();

function pagination(req: Request) {
  const parseNumber = (value: unknown, fallback: number, max: number) => {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) throw new HttpError(400,"invalid_query","ترقيم الصفحات غير صالح");
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n > max) throw new HttpError(400,"invalid_query","ترقيم الصفحات غير صالح");
    return n;
  };
  const page = parseNumber(req.query.page,1,1000000), pageSize = parseNumber(req.query.pageSize,20,100);
  const q = req.query.q ?? "";
  if (typeof q !== "string" || q.length > 200) throw new HttpError(400,"invalid_query","نص البحث غير صالح");
  return { page,pageSize,offset:(page-1)*pageSize,q:q.trim() };
}
async function access(client: PoolClient, req: Request, section: "questions" | "answers", action: "view" | "create" | "edit" = "view", write = false) {
  const companyId = req.params.companyId ? id(req.params.companyId) : null;
  const user = await currentActor(client, actor(req), write);
  const context = companyId === null ? null : await companyAccess(client,user,companyId,undefined,write);
  const key = `${companyId === null ? "public" : "company"}.${section}`;
  const entry = (await directoryEntries(client,user,companyId)).find(item=>item.key===key);
  if (!entry) missing();
  assertDirectoryAccess(entry,"view");
  if (action !== "view") assertDirectoryAccess(entry,action);
  if (write) await assertRequestPagesEnabled(client,req,true);
  return { companyId,user,manager:companyId === null ? user.owner : !!context?.general };
}
// Count each other user's most recent answer once, even if they answered repeatedly.
// The requesting user's own votes are excluded from every option count.
async function otherOptionCounts(client: PoolClient, questionIds: number[], userId: number): Promise<Map<number,number[]>> {
  const counts=new Map<number,number[]>();
  if (!questionIds.length) return counts;
  const result=await client.query(`
    SELECT question_id,selected_answer,count(*)::int AS total FROM (
      SELECT DISTINCT ON (question_id,user_id) question_id,user_id,selected_answer
      FROM question_answers WHERE question_id=ANY($1::integer[]) AND user_id<>$2
      ORDER BY question_id,user_id,answered_at DESC,id DESC
    ) latest
    GROUP BY question_id,selected_answer
  `,[questionIds,userId]);
  for (const row of result.rows) {
    const values=counts.get(row.question_id)??[0,0,0,0];
    values[row.selected_answer-1]=row.total;
    counts.set(row.question_id,values);
  }
  return counts;
}

const questionOutput = (row: QueryResultRow, manager: boolean) => ({
  id: row.id, companyId: row.company_id, category: row.category,
  priority: row.priority, question: row.question,
  options: [row.answer1,row.answer2,row.answer3,row.answer4].filter((v):v is string=>typeof v==="string"),
  optionCount:row.option_count,correctAnswer: manager || row.my_last_selected_answer !== null ? row.correct_answer : null, points: row.points,
  active: row.active, revision: row.revision, createdBy: row.created_by,
  creatorName: row.creator_name, createdAt: row.created_at.toISOString(),
  answerCount: row.answer_count, respondentCount: row.respondent_count,
  myAnswerCount: row.my_answer_count,
  myLastAnsweredAt: row.my_last_answered_at?.toISOString() ?? null,
  myLastSelectedAnswer: row.my_last_selected_answer ?? null,
  myLastCorrect: row.my_last_correct ?? null,
  myLastPoints: row.my_last_points ?? null,
  myLastComment: row.my_last_comment ?? null,
  otherOptionCounts: row.my_last_selected_answer === null ? null : row.other_option_counts,
});

export function questionRoutes(pool: Pool): Router {
  const router = Router();
  const roots = ["/questions","/companies/:companyId/questions"];
  const answerRoots = ["/answers","/companies/:companyId/answers"];

  // Lightweight category index: fetch only names and counts on first opening
  // the questions page; do not load questions from every category.
  router.get(roots.map(root=>root+"/categories"),handler(async(req,res)=>{
    const result=await transaction(pool,async client=>{
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const {companyId,manager}=await access(client,req,"questions");
      const rows=await client.query(`
        SELECT category,count(*)::int AS count
        FROM questions
        WHERE company_id IS NOT DISTINCT FROM $1 AND (active OR $2)
        GROUP BY category
        ORDER BY CASE category
          WHEN 'أسئلة للأطفال' THEN 0
          WHEN 'معلومات صيدلانية' THEN 1
          ELSE 2 END,
          category COLLATE "C"
      `,[companyId,manager]);
      return {items:rows.rows.map(row=>({category:row.category,count:row.count}))};
    });
    res.json(result);
  }));

  // Per-user history for offline recovery, irrespective of manager role.
  // Never expose other users' responses through this endpoint.
  router.get(roots.map(root=>root+"/my-history"),handler(async(req,res)=>{
    const result=await transaction(pool,async client=>{
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const {companyId,user}=await access(client,req,"questions");
      const p=pagination(req);
      const total=(await client.query(`
        SELECT count(DISTINCT a.question_id)::int AS total
        FROM question_answers a JOIN questions q ON q.id=a.question_id
        WHERE a.user_id=$1 AND q.company_id IS NOT DISTINCT FROM $2
      `,[user.id,companyId])).rows[0].total as number;
      const rows=await client.query(`
        SELECT DISTINCT ON (a.question_id)
          a.question_id,a.selected_answer,a.is_correct,a.awarded_points,
          a.comment,a.answered_at,a.question_snapshot
        FROM question_answers a JOIN questions q ON q.id=a.question_id
        WHERE a.user_id=$1 AND q.company_id IS NOT DISTINCT FROM $2
        ORDER BY a.question_id,a.answered_at DESC,a.id DESC
      `,[user.id,companyId]);
      // This is deliberately user-only and bounded: the existing per-page
      // question endpoint remains the source of live global choice counts.
      const ordered=rows.rows.sort((a,b)=>
        b.answered_at.getTime()-a.answered_at.getTime() ||
          b.question_id-a.question_id);
      return {
        items:ordered.slice(p.offset,p.offset+p.pageSize).map(row=>({
          questionId:row.question_id,selectedAnswer:row.selected_answer,
          correct:row.is_correct,
          correctAnswer:typeof row.question_snapshot?.correctAnswer==="number"
            ?row.question_snapshot.correctAnswer:null,
          points:row.awarded_points,comment:row.comment,otherOptionCounts:[],
          answeredAt:row.answered_at.toISOString(),
        })),
        total,page:p.page,pageSize:p.pageSize,
      };
    });
    res.json(result);
  }));

  router.get(roots,handler(async(req,res)=>{
    const result=await transaction(pool,async client=>{
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const {companyId,user,manager}=await access(client,req,"questions");
      const p=pagination(req);
      const category=req.query.category;
      if(category!==undefined && (typeof category!=="string" || category.length>120))
        throw new HttpError(400,"invalid_query","فئة الأسئلة غير صالحة");
      const categoryFilter=category===undefined?null:category;
      const status=req.query.status??"active";
      if(status!=="active" && status!=="archived")
        throw new HttpError(400,"invalid_query","حالة الأرشيف غير صالحة");
      const args=[companyId,user.id,searchPattern(p.q),categoryFilter];
      const visibility=manager
        ? status==="archived" ? "NOT q.active" : "q.active"
        : status==="archived" ? "FALSE" : "q.active";
      const condition=`q.company_id IS NOT DISTINCT FROM $1 AND ${visibility} AND (q.question ILIKE $3 OR q.category ILIKE $3) AND ($4::text IS NULL OR q.category=$4)`;
      const count=await client.query(
        `SELECT count(*)::int total FROM questions q WHERE q.company_id IS NOT DISTINCT FROM $1 AND ${visibility} AND (q.question ILIKE $2 OR q.category ILIKE $2) AND ($3::text IS NULL OR q.category=$3)`,
        [companyId,searchPattern(p.q),categoryFilter]);
      const rows=await client.query(`
        SELECT q.*,creator.display_name AS creator_name,
        (SELECT count(*)::int FROM question_answers a WHERE a.question_id=q.id) AS answer_count,
        (SELECT count(DISTINCT a.user_id)::int FROM question_answers a WHERE a.question_id=q.id) AS respondent_count,
        (SELECT count(*)::int FROM question_answers a WHERE a.question_id=q.id AND a.user_id=$2) AS my_answer_count,
        mine.answered_at AS my_last_answered_at,
        mine.selected_answer AS my_last_selected_answer,
        mine.is_correct AS my_last_correct,
        mine.awarded_points AS my_last_points,
        mine.comment AS my_last_comment
        FROM questions q JOIN users creator ON creator.id=q.created_by
        LEFT JOIN LATERAL (
          SELECT a.answered_at,a.selected_answer,a.is_correct,a.awarded_points,a.comment
          FROM question_answers a WHERE a.question_id=q.id AND a.user_id=$2
          ORDER BY a.answered_at DESC,a.id DESC LIMIT 1
        ) mine ON TRUE
        WHERE ${condition}
        ORDER BY (SELECT max(a.answered_at) FROM question_answers a WHERE a.question_id=q.id AND a.user_id=$2) IS NOT NULL ASC,
          CASE WHEN NOT EXISTS (SELECT 1 FROM question_answers a WHERE a.question_id=q.id AND a.user_id=$2) THEN q.priority END ASC,
          (SELECT max(a.answered_at) FROM question_answers a WHERE a.question_id=q.id AND a.user_id=$2) ASC,
          q.id ASC LIMIT $5 OFFSET $6
      `, [...args,p.pageSize,p.offset]);
      const counts=await otherOptionCounts(client,
        rows.rows.filter(row=>row.my_last_selected_answer !== null).map(row=>row.id),user.id);
      return { items:rows.rows.map(row=>questionOutput({
        ...row,other_option_counts:(counts.get(row.id)??[0,0,0,0]).slice(0,row.option_count)
      },manager)),total:count.rows[0].total,page:p.page,pageSize:p.pageSize };
    });
    res.json(result);
  }));

  router.post(roots,handler(async(req,res)=>{
    const input=parse(questionFields,req.body);
    const result=await transaction(pool,async client=>{
      const {companyId,user}=await access(client,req,"questions","create",true);
      const found=await client.query(
        "INSERT INTO questions(company_id,category,priority,question,answer1,answer2,answer3,answer4,option_count,correct_answer,points,active,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *",
        [companyId,input.category,input.priority,input.question,input.options[0],input.options[1],input.options[2]??null,input.options[3]??null,input.options.length,input.correctAnswer,input.points,input.active,user.id]);
      const row=found.rows[0];
      await audit(client,user,"question.create","question",row.id,null,{
        question:input.question,category:input.category,priority:input.priority,points:input.points,active:input.active,
      },companyId);
      return {id:row.id};
    });
    res.status(201).json(result);
  }));

  router.put(roots.map(root=>root+"/:questionId"),handler(async(req,res)=>{
    const input=parse(editFields,req.body);
    const result=await transaction(pool,async client=>{
      const {companyId,user}=await access(client,req,"questions","edit",true);
      const questionId=id(req.params.questionId);
      const old=(await client.query("SELECT * FROM questions WHERE id=$1 AND company_id IS NOT DISTINCT FROM $2 FOR UPDATE",[questionId,companyId])).rows[0];
      if(!old) missing();
      if(old.revision !== input.revision) throw new HttpError(409,"conflict","تم تعديل السؤال؛ أعد تحميله");
      const updated=(await client.query(
        "UPDATE questions SET category=$1,priority=$2,question=$3,answer1=$4,answer2=$5,answer3=$6,answer4=$7,option_count=$8,correct_answer=$9,points=$10,active=$11,updated_by=$12,revision=revision+1,updated_at=now() WHERE id=$13 RETURNING *",
        [input.category,input.priority,input.question,input.options[0],input.options[1],input.options[2]??null,input.options[3]??null,input.options.length,input.correctAnswer,input.points,input.active,user.id,questionId],
      )).rows[0];
      await audit(client,user,"question.update","question",questionId,{
        question:old.question,options:[old.answer1,old.answer2,old.answer3,old.answer4],correctAnswer:old.correct_answer,points:old.points,
      },{question:updated.question,options:input.options,correctAnswer:updated.correct_answer,points:updated.points},companyId);
      return {id:updated.id,revision:updated.revision};
    });
    res.json(result);
  }));

  // Archive/restore without deleting prior answers or rewriting correct choices.
  router.patch(roots.map(root=>root+"/:questionId/status"),handler(async(req,res)=>{
    const input=parse(statusFields,req.body);
    const result=await transaction(pool,async client=>{
      const {companyId,user}=await access(client,req,"questions","edit",true);
      const questionId=id(req.params.questionId);
      const old=(await client.query(
        "SELECT id,revision,active FROM questions WHERE id=$1 AND company_id IS NOT DISTINCT FROM $2 FOR UPDATE",
        [questionId,companyId]
      )).rows[0];
      if(!old) missing();
      if(old.revision!==input.revision) throw new HttpError(409,"conflict","تم تعديل السؤال؛ أعد تحميله");
      if(old.active===input.active) return {id:questionId,revision:old.revision,active:old.active};
      const updated=(await client.query(
        "UPDATE questions SET active=$1,updated_by=$2,revision=revision+1,updated_at=now() WHERE id=$3 RETURNING revision,active",
        [input.active,user.id,questionId]
      )).rows[0];
      await audit(client,user,"question.update","question",questionId,
        {active:old.active},{active:updated.active},companyId);
      return {id:questionId,revision:updated.revision,active:updated.active};
    });
    res.json(result);
  }));

  router.post(roots.map(root=>root+"/:questionId/answers"),handler(async(req,res)=>{
    const input=parse(answerFields,req.body);
    const result=await transaction(pool,async client=>{
      const {companyId,user}=await access(client,req,"answers","create",true);
      const questionId=id(req.params.questionId),comment=input.comment?.trim()||null;
      const existing=(await client.query("SELECT * FROM question_answers WHERE user_id=$1 AND idempotency_key=$2",[user.id,input.idempotencyKey])).rows[0];
      if(existing){
        if(existing.question_id!==questionId || existing.selected_answer!==input.selectedAnswer || existing.comment!==comment)
          throw new HttpError(409,"conflict","مفتاح المحاولة مرتبط بإجابة أخرى");
        const original=(await client.query("SELECT correct_answer,option_count FROM questions WHERE id=$1 AND company_id IS NOT DISTINCT FROM $2",[questionId,companyId])).rows[0];
        if (!original) missing();
        const counts=await otherOptionCounts(client,[questionId],user.id);
        return {id:String(existing.id),selectedAnswer:existing.selected_answer,
          correct:existing.is_correct,correctAnswer:existing.question_snapshot.correctAnswer,
          points:existing.awarded_points,firstAttempt:false,
          otherOptionCounts:(counts.get(questionId)??[0,0,0,0]).slice(0,original.option_count),replayed:true};
      }
      const question=(await client.query("SELECT * FROM questions WHERE id=$1 AND company_id IS NOT DISTINCT FROM $2 FOR SHARE",[questionId,companyId])).rows[0];
      if(!question || !question.active) missing("السؤال غير موجود أو غير متاح");
      if (input.selectedAnswer > question.option_count)
        throw new HttpError(400,"validation","اختر إجابة ضمن خيارات هذا السؤال");
      // currentActor(...,true) locks this user for the transaction; two devices
      // answering simultaneously cannot both earn the question's first reward.
      const firstAttempt=(await client.query(
        "SELECT NOT EXISTS (SELECT 1 FROM question_answers WHERE question_id=$1 AND user_id=$2) AS first",
        [questionId,user.id],
      )).rows[0].first as boolean;
      const correct=input.selectedAnswer===question.correct_answer;
      const awardedPoints=correct && firstAttempt ? question.points : 0;
      const snapshot={question:question.question,options:[question.answer1,question.answer2,question.answer3,question.answer4].slice(0,question.option_count),correctAnswer:question.correct_answer,points:question.points,revision:question.revision};
      const inserted=(await client.query(
        "INSERT INTO question_answers(question_id,user_id,selected_answer,is_correct,awarded_points,comment,question_snapshot,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(user_id,idempotency_key) DO NOTHING RETURNING *",
        [questionId,user.id,input.selectedAnswer,correct,awardedPoints,comment,JSON.stringify(snapshot),input.idempotencyKey],
      )).rows[0];
      if(!inserted) throw new HttpError(409,"conflict","المحاولة محفوظة مسبقًا؛ أعد تحديث الصفحة");
      await audit(client,user,"question.answer","question-answer",Number(inserted.id),null,{
        questionId,selectedAnswer:input.selectedAnswer,correct,firstAttempt,points:awardedPoints,comment,
      },companyId);
      const counts=await otherOptionCounts(client,[questionId],user.id);
      return {id:String(inserted.id),selectedAnswer:input.selectedAnswer,correct,
        correctAnswer:question.correct_answer,points:awardedPoints,firstAttempt,
        otherOptionCounts:(counts.get(questionId)??[0,0,0,0]).slice(0,question.option_count),
        replayed:false};
    });
    res.status(result.replayed?200:201).json(result);
  }));

  router.get(answerRoots,handler(async(req,res)=>{
    const result=await transaction(pool,async client=>{
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const {companyId,user,manager}=await access(client,req,"answers");
      const p=pagination(req);
      const questionId=req.query.questionId === undefined ? null : id(req.query.questionId as string);
      const condition="q.company_id IS NOT DISTINCT FROM $1 AND ($2::integer IS NULL OR a.user_id=$2) AND ($3::integer IS NULL OR q.id=$3) AND (u.display_name ILIKE $4 OR q.question ILIKE $4 OR a.comment ILIKE $4)";
      const args=[companyId,manager?null:user.id,questionId,searchPattern(p.q)];
      const total=(await client.query(`SELECT count(*)::int total FROM question_answers a JOIN questions q ON q.id=a.question_id JOIN users u ON u.id=a.user_id WHERE ${condition}`,args)).rows[0].total;
      const rows=await client.query(`
        SELECT a.*,u.display_name AS user_name,q.question AS current_question
        FROM question_answers a JOIN questions q ON q.id=a.question_id JOIN users u ON u.id=a.user_id
        WHERE ${condition} ORDER BY a.answered_at DESC,a.id DESC LIMIT $5 OFFSET $6
      `,[...args,p.pageSize,p.offset]);
      return {items:rows.rows.map(row=>({
        id:String(row.id),questionId:row.question_id,userId:row.user_id,userName:row.user_name,
        question:row.question_snapshot.question,selectedAnswer:row.selected_answer,
        selectedText:row.question_snapshot.options[row.selected_answer-1],
        correct:row.is_correct,points:row.awarded_points,comment:row.comment,
        answeredAt:row.answered_at.toISOString(),
      })),total,page:p.page,pageSize:p.pageSize};
    });
    res.json(result);
  }));
  return router;
}
