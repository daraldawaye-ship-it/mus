import { Router, type Request } from "express";
import { z } from "zod";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { employeePositionSchema } from "../../../packages/contracts/src/employee-positions.ts";
import { transaction } from "./db.ts";
import { actor, handler, id, parse } from "./http.ts";
import { companyAccess, currentActor } from "./policies/access.ts";
import { HttpError, missing } from "./errors.ts";
import { audit } from "./services/audit.ts";
import { directoryEntries, assertDirectoryAccess } from "./services/pages.ts";

const requestSchema = z.object({
  requestType:z.enum(["question","clarification","information","confirmation","execution"]).default("question"),
  requestText:z.string().trim().min(1).max(4000),
  answerType:z.enum(["number","number_note","date","yesno","choice","text"]),
  answerOptions:z.array(z.string().trim().min(1).max(300)).max(4).default([]),
  responseMode:z.enum(["first","all"]),
  userIds:z.array(z.number().int().positive()).max(300).default([]),
  positionKeys:z.array(employeePositionSchema).max(30).default([]),
  priority:z.enum(["normal","important","urgent"]).default("normal"),
  dueAt:z.string().datetime({offset:true}).nullable().default(null),
  linkedTable:z.string().trim().min(1).max(120).nullable().default(null),
  linkedRecordId:z.number().int().positive().nullable().default(null),
  followUpAction:z.string().trim().max(4000).default(""),
  idempotencyKey:z.string().uuid(),
}).strict();
const answerSchema = z.object({
  answerValue:z.string().trim().max(2000).default(""),
  optionNumber:z.number().int().min(1).max(4).nullable().default(null),
  explanation:z.string().trim().max(2000).default(""),
  idempotencyKey:z.string().uuid(),
}).strict();
const statusSchema = z.object({
  status:z.enum(["in_progress","done","closed"]),
  actionResult:z.string().trim().max(4000).default(""),
}).strict();

async function scope(db:Pool|PoolClient,req:Request,write=false) {
  const user=await currentActor(db,actor(req),write);
  const companyId=req.params.companyId ? id(req.params.companyId) : null;
  const context=companyId===null ? null : await companyAccess(db,user,companyId,undefined,write);
  const key=companyId===null?"public.inquiries":"company.inquiries";
  const page=(await directoryEntries(db,user,companyId)).find(entry=>entry.key===key);
  if(!page)missing("صفحة الاستفسارات غير مسجلة");
  assertDirectoryAccess(page,"view");
  return {user,companyId,manager:user.owner || !!context?.general,page};
}
function managerOnly(manager:boolean) {
  if(!manager)throw new HttpError(403,"forbidden","إنشاء الطلبات ومتابعتها لمالك المنصة أو إدارة الشركة");
}
function formatRow(r:QueryResultRow) {
  return {
    id:Number(r.id),companyId:r.company_id,requestType:r.request_type,
    requestText:r.request_text,answerType:r.answer_type,answerOptions:r.answer_options,
    responseMode:r.response_mode,recipientSelection:r.recipient_selection,
    priority:r.priority,dueAt:r.due_at,linkedTable:r.linked_table,
    linkedRecordId:r.linked_record_id===null?null:Number(r.linked_record_id),
    followUpAction:r.follow_up_action,actionResult:r.action_result,
    status:r.status,createdBy:r.created_by,creatorName:r.creator_name,companyName:r.company_name??null,
    createdAt:r.created_at,updatedAt:r.updated_at,answeredAt:r.answered_at
  };
}
async function hydrate(db:Pool|PoolClient,rows:QueryResultRow[],viewer:number,manager:boolean) {
  if(!rows.length)return [];
  const ids=rows.map(r=>Number(r.id));
  const targets=await db.query(
    "SELECT t.inquiry_id,t.user_id,t.status,t.answered_at,u.name FROM inquiry_targets t JOIN users u ON u.id=t.user_id WHERE t.inquiry_id=ANY($1::int[]) ORDER BY t.id",
    [ids]);
  const replies=await db.query(
    "SELECT a.id,a.inquiry_id,a.user_id,a.answer_value,a.option_number,a.explanation,a.answered_at,u.name FROM inquiry_answers a JOIN users u ON u.id=a.user_id WHERE a.inquiry_id=ANY($1::int[]) AND ($2::boolean OR a.user_id=$3) ORDER BY a.id",
    [ids,manager,viewer]);
  return rows.map(row=>{
    const all=targets.rows.filter(t=>t.inquiry_id===row.id);
    const my=all.find(t=>t.user_id===viewer);
    const answerRows=replies.rows.filter(a=>a.inquiry_id===row.id);
    return {...formatRow(row),
      assignedCount:all.length,
      answeredCount:all.filter(t=>t.status==="answered").length,
      myStatus:my?.status??null,
      targets:manager?all.map(t=>({userId:t.user_id,name:t.name,status:t.status,answeredAt:t.answered_at})):[],
      answers:answerRows.map(a=>({id:Number(a.id),userId:a.user_id,userName:a.name,
        answerValue:a.answer_value,optionNumber:a.option_number,
        explanation:a.explanation,answeredAt:a.answered_at}))
    };
  });
}
async function visibleRow(db:Pool|PoolClient,requestId:number,companyId:number|null,userId:number,manager:boolean,lock=false) {
  const row=(await db.query(
    "SELECT q.*,u.name AS creator_name,c.name AS company_name FROM inquiry_requests q JOIN users u ON u.id=q.created_by LEFT JOIN companies c ON c.id=q.company_id "+
    "WHERE q.id=$1 AND q.company_id IS NOT DISTINCT FROM $2 "+
    "AND ($3::boolean OR q.created_by=$4 OR EXISTS (SELECT 1 FROM inquiry_targets t WHERE t.inquiry_id=q.id AND t.user_id=$4))"+
    (lock?" FOR UPDATE OF q":""),
    [requestId,companyId,manager,userId]
  )).rows[0];
  if(!row)missing("الاستفسار غير موجود أو لا تملك صلاحية عرضه");
  return row;
}

export function inquiryRoutes(pool:Pool):Router {
  const router=Router();
  const roots=["/inquiries","/companies/:companyId/inquiries"];
  router.get(roots.map(root=>root+"/recipients"),handler(async(req,res)=>{
    const {manager,companyId}=await scope(pool,req);
    managerOnly(manager);
    const q=typeof req.query.q==="string"?req.query.q.trim().slice(0,100):"";
    const pattern="%"+q.replace(/[\\%_]/g,"\\$&")+"%";
    const r=await pool.query(
      "SELECT u.id,u.name FROM users u WHERE NOT u.archived AND NOT u.suspended "+
      "AND u.name ILIKE $2 ESCAPE '\\' AND ($1::integer IS NULL OR u.owner OR "+
      "EXISTS(SELECT 1 FROM employees e WHERE e.user_id=u.id AND e.company_id=$1 AND e.active)) "+
      "ORDER BY u.name,u.id LIMIT 300",
      [companyId,pattern]);
    res.json({items:r.rows});
  }));
  router.get(roots,handler(async(req,res)=>{
    const {user,companyId,manager}=await scope(pool,req);
    const q=typeof req.query.q==="string"?req.query.q.trim().slice(0,100):"";
    const filter=typeof req.query.status==="string"?req.query.status:"";
    if(filter && !["open","answered","in_progress","done","closed","mine"].includes(filter))
      throw new HttpError(400,"invalid_filter","حالة الفلتر غير صالحة");
    const page=req.query.page===undefined?1:Number(req.query.page);
    if(!Number.isSafeInteger(page)||page<1||page>100000)throw new HttpError(400,"invalid_page","صفحة غير صالحة");
    const rows=await pool.query(
      "SELECT q.*,u.name AS creator_name,c.name AS company_name FROM inquiry_requests q JOIN users u ON u.id=q.created_by LEFT JOIN companies c ON c.id=q.company_id "+
      "WHERE q.company_id IS NOT DISTINCT FROM $1 AND "+
      "($2::boolean OR q.created_by=$3 OR EXISTS(SELECT 1 FROM inquiry_targets t WHERE t.inquiry_id=q.id AND t.user_id=$3)) "+
      "AND ($4='' OR q.request_text ILIKE '%'||$4||'%' OR q.linked_table ILIKE '%'||$4||'%') "+
      "AND ($5='' OR ($5='mine' AND EXISTS(SELECT 1 FROM inquiry_targets t WHERE t.inquiry_id=q.id AND t.user_id=$3 AND t.status='pending')) OR q.status=$5) "+
      "ORDER BY q.id DESC LIMIT 60 OFFSET $6",
      [companyId,manager,user.id,q,filter,(page-1)*60]);
    res.json({items:await hydrate(pool,rows.rows,user.id,manager),page,pageSize:60});
  }));
  router.get(roots.map(root=>root+"/:inquiryId"),handler(async(req,res)=>{
    const {user,companyId,manager}=await scope(pool,req);
    const row=await visibleRow(pool,id(req.params.inquiryId),companyId,user.id,manager);
    res.json({item:(await hydrate(pool,[row],user.id,manager))[0]});
  }));
  router.post(roots,handler(async(req,res)=>{
    const input=parse(requestSchema,req.body);
    if(input.answerType==="choice" && (input.answerOptions.length<2||input.answerOptions.length>4))
      throw new HttpError(400,"invalid_options","اختر خيارين إلى أربعة خيارات");
    if(input.answerType!=="choice" && input.answerOptions.length)
      throw new HttpError(400,"invalid_options","الخيارات مخصصة لنوع إجابة الخيارات");
    if(input.linkedRecordId!==null && !input.linkedTable)
      throw new HttpError(400,"invalid_link","حدد الجدول المرتبط مع معرف السجل");
    if(input.dueAt && Number.isNaN(Date.parse(input.dueAt)))
      throw new HttpError(400,"invalid_date","موعد الإجابة غير صالح");
    const item=await transaction(pool,async db=>{
      const {user,companyId,manager,page}=await scope(db,req,true);
      managerOnly(manager);
      assertDirectoryAccess(page,"create");
      const existing=(await db.query(
        "SELECT id FROM inquiry_requests WHERE created_by=$1 AND idempotency_key=$2",
        [user.id,input.idempotencyKey])).rows[0];
      if(existing)return {id:existing.id,reused:true};
      if(companyId===null && input.positionKeys.length)
        throw new HttpError(400,"position_scope","الصفات لا تُستخدم إلا داخل الشركة");
      if(companyId!==null && input.positionKeys.length){
        // zod guarantees only known employee position keys.
      }
      const selectedUsers=[...new Set(input.userIds)];
      const candidates=await db.query(
        "SELECT u.id FROM users u WHERE u.id=ANY($1::int[]) AND NOT u.archived AND NOT u.suspended "+
        "AND ($2::integer IS NULL OR u.owner OR EXISTS(SELECT 1 FROM employees e "+
        "WHERE e.company_id=$2 AND e.user_id=u.id AND e.active))",
        [selectedUsers,companyId]);
      if(candidates.rowCount!==selectedUsers.length)
        throw new HttpError(400,"invalid_recipients","بعض المستخدمين ليسوا ضمن نطاق الشركة أو حساباتهم غير نشطة");
      const assigned=new Set<number>(selectedUsers);
      if(companyId!==null && input.positionKeys.length){
        const found=await db.query(
          "SELECT DISTINCT e.user_id FROM employees e JOIN users u ON u.id=e.user_id "+
          "WHERE e.company_id=$1 AND e.active AND NOT u.archived AND NOT u.suspended "+
          "AND e.position_keys && $2::text[]",
          [companyId,input.positionKeys]);
        for(const r of found.rows)assigned.add(Number(r.user_id));
      }
      if(!assigned.size)throw new HttpError(400,"no_recipients","اختر مستخدمًا واحدًا أو صفة تضم موظفين نشطين");
      if(assigned.size>300)throw new HttpError(400,"too_many_recipients","الحد الأقصى 300 مستخدم في الطلب");
      if(input.linkedTable&&input.linkedRecordId!==null){
        const duplicate=await db.query(
          "SELECT id FROM inquiry_requests WHERE company_id IS NOT DISTINCT FROM $1 "+
          "AND linked_table=$2 AND linked_record_id=$3 AND request_text=$4 AND status='open' LIMIT 1",
          [companyId,input.linkedTable,input.linkedRecordId,input.requestText]);
        if(duplicate.rowCount)throw new HttpError(409,"duplicate_inquiry","يوجد استفسار مفتوح مطابق لهذا السجل");
      }
      const inserted=await db.query(
        "INSERT INTO inquiry_requests(company_id,request_type,request_text,answer_type,answer_options,"+
        "response_mode,recipient_selection,priority,due_at,linked_table,linked_record_id,follow_up_action,created_by,idempotency_key) "+
        "VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14) RETURNING id",
        [companyId,input.requestType,input.requestText,input.answerType,JSON.stringify(input.answerOptions),
        input.responseMode,JSON.stringify({userIds:selectedUsers,positionKeys:input.positionKeys}),
        input.priority,input.dueAt,input.linkedTable,input.linkedRecordId,input.followUpAction,user.id,input.idempotencyKey]);
      const requestId=Number(inserted.rows[0].id);
      for(const target of assigned)
        await db.query("INSERT INTO inquiry_targets(inquiry_id,user_id) VALUES($1,$2)",[requestId,target]);
      await audit(db,user,"inquiry.create","inquiry",requestId,null,
        {requestText:input.requestText,responseMode:input.responseMode,recipientCount:assigned.size},companyId);
      return {id:requestId,recipientCount:assigned.size,reused:false};
    });
    res.status(201).json(item);
  }));
  router.post(roots.map(root=>root+"/:inquiryId/answers"),handler(async(req,res)=>{
    const input=parse(answerSchema,req.body);
    const requestId=id(req.params.inquiryId);
    const result=await transaction(pool,async db=>{
      const {user,companyId,manager}=await scope(db,req,true);
      const request=await visibleRow(db,requestId,companyId,user.id,manager,true);
      const prior=(await db.query(
        "SELECT id FROM inquiry_answers WHERE inquiry_id=$1 AND user_id=$2 AND idempotency_key=$3",
        [requestId,user.id,input.idempotencyKey])).rows[0];
      if(prior)return {id:Number(prior.id),reused:true};
      if(request.status!=="open")throw new HttpError(409,"already_closed","الاستفسار لم يعد مفتوحًا للإجابة");
      const target=(await db.query(
        "SELECT * FROM inquiry_targets WHERE inquiry_id=$1 AND user_id=$2 FOR UPDATE",
        [requestId,user.id])).rows[0];
      if(!target||target.status!=="pending")
        throw new HttpError(403,"not_assigned","لا يوجد طلب إجابة مفتوح موجه إليك");
      let value=input.answerValue;
      let ordinal:number|null=null;
      if(request.answer_type==="number"||request.answer_type==="number_note"){
        if(!/^-?\d{1,24}(?:\.\d{1,8})?$/.test(value))
          throw new HttpError(400,"invalid_number","اكتب رقمًا صحيحًا أو عشريًا حتى ثماني خانات");
      }else if(request.answer_type==="date"){
        if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||Number.isNaN(Date.parse(value))||
          new Date(value+"T00:00:00.000Z").toISOString().slice(0,10)!==value)
          throw new HttpError(400,"invalid_date","أدخل تاريخًا صحيحًا");
      }else if(request.answer_type==="yesno"){
        if(!["yes","no"].includes(value))throw new HttpError(400,"invalid_answer","اختر نعم أو لا");
        ordinal=value==="yes"?1:2;
      }else if(request.answer_type==="choice"){
        const choices=request.answer_options as string[];
        if(!input.optionNumber||input.optionNumber>choices.length)
          throw new HttpError(400,"invalid_answer","اختر إجابة من الخيارات المتاحة");
        ordinal=input.optionNumber;
        value=choices[ordinal-1]!;
      }else if(!value){
        throw new HttpError(400,"empty_answer","اكتب الإجابة");
      }
      if(request.answer_type==="number_note"&&!input.explanation)
        throw new HttpError(400,"missing_explanation","التوضيح مطلوب بجوار الرقم");
      if(!value)throw new HttpError(400,"empty_answer","الإجابة مطلوبة");
      const inserted=await db.query(
        "INSERT INTO inquiry_answers(inquiry_id,target_id,user_id,answer_value,option_number,explanation,idempotency_key) "+
        "VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
        [requestId,target.id,user.id,value,ordinal,input.explanation,input.idempotencyKey]);
      await db.query("UPDATE inquiry_targets SET status='answered',answered_at=now() WHERE id=$1",[target.id]);
      if(request.response_mode==="first"){
        await db.query("UPDATE inquiry_targets SET status='waived' WHERE inquiry_id=$1 AND status='pending'",[requestId]);
        await db.query("UPDATE inquiry_requests SET status='answered',answered_at=now(),updated_at=now() WHERE id=$1",[requestId]);
      }else{
        const pending=await db.query("SELECT 1 FROM inquiry_targets WHERE inquiry_id=$1 AND status='pending' LIMIT 1",[requestId]);
        if(!pending.rowCount)
          await db.query("UPDATE inquiry_requests SET status='answered',answered_at=now(),updated_at=now() WHERE id=$1",[requestId]);
        else
          await db.query("UPDATE inquiry_requests SET updated_at=now() WHERE id=$1",[requestId]);
      }
      await audit(db,user,"inquiry.answer","inquiry",requestId,null,
        {answerId:Number(inserted.rows[0].id),replyType:request.answer_type},companyId);
      return {id:Number(inserted.rows[0].id),reused:false};
    });
    res.status(201).json(result);
  }));
  router.patch(roots.map(root=>root+"/:inquiryId/status"),handler(async(req,res)=>{
    const input=parse(statusSchema,req.body);
    const requestId=id(req.params.inquiryId);
    const result=await transaction(pool,async db=>{
      const {user,companyId,manager,page}=await scope(db,req,true);
      managerOnly(manager);
      assertDirectoryAccess(page,"edit");
      const old=await visibleRow(db,requestId,companyId,user.id,manager,true);
      if(old.status==="closed"||old.status==="done")
        throw new HttpError(409,"status_final","الطلب مغلق أو منجز بالفعل");
      if(old.status==="open"&&input.status!=="closed")
        throw new HttpError(409,"pending_answers","لا يمكن تأكيد الإنجاز قبل الإجابة");
      const updated=await db.query(
        "UPDATE inquiry_requests SET status=$1,action_result=$2,updated_by=$3,updated_at=now() WHERE id=$4 RETURNING id,status",
        [input.status,input.actionResult,user.id,requestId]);
      if(input.status==="closed")
        await db.query("UPDATE inquiry_targets SET status='waived' WHERE inquiry_id=$1 AND status='pending'",[requestId]);
      await audit(db,user,"inquiry.status","inquiry",requestId,{status:old.status,actionResult:old.action_result},
        {status:input.status,actionResult:input.actionResult},companyId);
      return updated.rows[0];
    });
    res.json(result);
  }));
  return router;
}