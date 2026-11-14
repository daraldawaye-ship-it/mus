import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { actor, handler, parse } from "./http.ts";
import { currentActor, ownerOnly } from "./policies/access.ts";
import { HttpError } from "./errors.ts";
import { audit } from "./services/audit.ts";

const unlockSchema=z.object({password:z.string().min(1).max(200)}).strict();
const querySchema=z.object({
  token:z.string().uuid(),
  sql:z.string().trim().min(1).max(12000),
}).strict();
const executeSchema=querySchema.extend({confirmationId:z.string().uuid()});
const MAX_ROWS=200, MAX_CHANGED_ROWS=500, UNLOCK_MS=10*60*1000, CONFIRM_MS=2*60*1000;
type SQLKind="select"|"insert"|"update"|"delete";
type Ticket={ownerId:number;session:string;expiresAt:number};
type Preview=Ticket & {token:string;hash:string;kind:SQLKind};
const unlocked=new Map<string,Ticket>();
const pending=new Map<string,Preview>();
const attempts=new Map<string,{count:number;until:number}>();

const sha=(value:string)=>createHash("sha256").update(value).digest("hex");
function sqlError(message:string,code="sql_not_allowed"):never {
  throw new HttpError(400,code,message);
}
function inspect(sql:string):{sql:string;kind:SQLKind;table:string|null} {
  let text=sql.trim();
  if(text.endsWith(";"))text=text.slice(0,-1).trim();
  // A single plain statement is deliberate: no commands, comments or stacked SQL.
  if(!text || /;|--|\/\*|\*\//.test(text))
    sqlError("يُسمح باستعلام واحد فقط دون تعليقات SQL أو فواصل أوامر");
  const match=/^(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i.exec(text);
  if(!match)sqlError("المسموح: SELECT أو INSERT INTO أو UPDATE أو DELETE FROM فقط");
  const kind=match[1].split(/\s+/)[0].toLowerCase() as SQLKind;
  if(kind==="select")return {sql:text,kind,table:null};
  if(/\breturning\b/i.test(text))
    sqlError("استخدم استعلام SELECT مستقلًا لعرض الصفوف؛ RETURNING غير متاح في أوامر الكتابة");
  if((kind==="update"||kind==="delete")&&!/\bwhere\b/i.test(text))
    sqlError("يجب تحديد WHERE عند التعديل أو الحذف لمنع التأثير على جدول كامل");
  const rest=text.slice(match[0].length);
  const tableMatch=/^\s*((?:"?[a-z_][a-z0-9_]*"?\.)?"?[a-z_][a-z0-9_]*"?)(?=\s|\()/i.exec(rest);
  if(!tableMatch)sqlError("استخدم اسم جدول مباشرًا في استعلام التعديل");
  const parts=tableMatch[1].replaceAll('"',"").toLowerCase().split(".");
  if(parts.length>1 && parts[0]!=="public")
    sqlError("الكتابة المباشرة مسموحة لجداول public فقط");
  const table=parts.at(-1)!;
  if(/^(users|sessions|audit_events|schema_migrations|page_access_grants|oauth_.*|chatgpt_.*|user_oauth_.*)$/.test(table))
    sqlError("هذا جدول محمي؛ تعديله يتم من واجهات إدارة النظام المعتمدة");
  return {sql:text,kind,table};
}
function visible(value:unknown):string|number|boolean|null {
  if(value===undefined||value===null)return null;
  if(typeof value==="string")return value.slice(0,10000);
  if(typeof value==="number"||typeof value==="boolean")return value;
  if(typeof value==="bigint")return value.toString();
  if(value instanceof Date)return value.toISOString();
  try{return JSON.stringify(value).slice(0,10000);}catch{return "[قيمة غير قابلة للعرض]";}
}
function unlockRequired():never {
  throw new HttpError(403,"sql_unlock_required","أدخل كلمة مرور صفحة الاستعلامات مجددًا");
}
function ticketFor(req:Parameters<typeof actor>[0],token:string):Ticket {
  const t=unlocked.get(token);
  if(!t||t.ownerId!==actor(req).id||t.session!==req.auth?.tokenHash||t.expiresAt<Date.now())
    unlockRequired();
  return t;
}
function tidy() {
  const now=Date.now();
  for(const [k,v] of unlocked)if(v.expiresAt<now)unlocked.delete(k);
  for(const [k,v] of pending)if(v.expiresAt<now)pending.delete(k);
  for(const [k,v] of attempts)if(v.until<now)attempts.delete(k);
}
async function owner(pool:Pool,req:Parameters<typeof actor>[0]) {
  const user=await currentActor(pool,actor(req),false);
  ownerOnly(user);
  if(user.suspended)throw new HttpError(403,"suspended","الحساب موقوف");
  return user;
}
async function limitedTransaction<T>(pool:Pool,readOnly:boolean,task:(client:import("pg").PoolClient)=>Promise<T>):Promise<T> {
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    if(readOnly)await client.query("SET TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout = '4000ms'");
    await client.query("SET LOCAL lock_timeout = '750ms'");
    const value=await task(client);
    await client.query("COMMIT");
    return value;
  }catch(error){
    await client.query("ROLLBACK").catch(()=>{});
    throw error;
  }finally{client.release();}
}
export function ownerSqlConsoleRoutes(pool:Pool):Router {
  const router=Router();
  router.post("/owner-sql/unlock",handler(async(req,res)=>{
    const user=await owner(pool,req);
    tidy();
    const {password}=parse(unlockSchema,req.body);
    const key=req.auth!.tokenHash;
    const fail=attempts.get(key);
    if(fail&&fail.count>=5&&fail.until>Date.now())
      throw new HttpError(429,"sql_unlock_limited","محاولات كثيرة؛ أعد المحاولة بعد 15 دقيقة");
    const expected=process.env.OWNER_SQL_CONSOLE_PASSWORD;
    if(!expected)throw new HttpError(503,"sql_password_unconfigured","لم تُضبط كلمة مرور لوحة SQL على الخادم");
    const good=timingSafeEqual(Buffer.from(sha(password),"hex"),Buffer.from(sha(expected),"hex"));
    if(!good){
      const next={count:(fail?.count??0)+1,until:Date.now()+15*60*1000};
      attempts.set(key,next);
      throw new HttpError(403,"sql_password_invalid","كلمة مرور الصفحة غير صحيحة");
    }
    attempts.delete(key);
    const token=randomUUID();
    unlocked.set(token,{ownerId:user.id,session:key,expiresAt:Date.now()+UNLOCK_MS});
    res.json({token,expiresInSeconds:UNLOCK_MS/1000});
  }));
  router.post("/owner-sql/preview",handler(async(req,res)=>{
    const user=await owner(pool,req);
    const input=parse(querySchema,req.body);
    ticketFor(req,input.token);
    tidy();
    const statement=inspect(input.sql);
    if(statement.kind==="select"){
      const response=await limitedTransaction(pool,true,async client=>{
        // The outer LIMIT bounds data transfer even when the owner omits LIMIT.
        const result=await client.query({
          name:"owner_sql_read_"+randomUUID().replaceAll("-",""),
          text:"SELECT * FROM ("+statement.sql+") AS owner_sql_preview LIMIT "+(MAX_ROWS+1),
        });
        const columns=result.fields.slice(0,80).map(f=>f.name);
        return {mode:"read" as const,columns,
          rows:result.rows.slice(0,MAX_ROWS).map(row=>columns.map(c=>visible(row[c]))),
          rowCount:Math.min(result.rows.length,MAX_ROWS),
          truncated:result.rows.length>MAX_ROWS||result.fields.length>80};
      });
      res.json(response);return;
    }
    const estimatedRows=await limitedTransaction(pool,true,async client=>{
      // EXPLAIN without ANALYZE does not execute the INSERT, UPDATE or DELETE.
      const result=await client.query({
        name:"owner_sql_explain_"+randomUUID().replaceAll("-",""),
        text:"EXPLAIN (FORMAT JSON) "+statement.sql,
      });
      const plan=result.rows[0]?.["QUERY PLAN"]?.[0]?.Plan;
      const estimate=plan?.Plans?.[0]?.["Plan Rows"]??plan?.["Plan Rows"];
      return typeof estimate==="number"?estimate:null;
    });
    const confirmationId=randomUUID();
    pending.set(confirmationId,{ownerId:user.id,session:req.auth!.tokenHash,
      expiresAt:Date.now()+CONFIRM_MS,token:input.token,hash:sha(statement.sql),kind:statement.kind});
    res.json({mode:"write",kind:statement.kind,table:statement.table,estimatedRows,
      confirmationId,expiresInSeconds:CONFIRM_MS/1000,maxChangedRows:MAX_CHANGED_ROWS});
  }));
  router.post("/owner-sql/execute",handler(async(req,res)=>{
    const user=await owner(pool,req);
    const input=parse(executeSchema,req.body);
    ticketFor(req,input.token);
    const statement=inspect(input.sql);
    if(statement.kind==="select")sqlError("استعلام SELECT يُنفذ من زر المعاينة");
    const preview=pending.get(input.confirmationId);
    if(!preview||preview.ownerId!==user.id||preview.session!==req.auth!.tokenHash||
      preview.token!==input.token||preview.kind!==statement.kind||
      preview.hash!==sha(statement.sql)||preview.expiresAt<Date.now())
      throw new HttpError(409,"sql_preview_expired","انتهت المعاينة أو تغيّر الاستعلام؛ عاينه مجددًا");
    // Consume before executing: a retry cannot accidentally apply a write twice.
    pending.delete(input.confirmationId);
    const affectedRows=await limitedTransaction(pool,false,async client=>{
      const result=await client.query({
        name:"owner_sql_write_"+randomUUID().replaceAll("-",""),
        text:statement.sql,
      });
      const count=result.rowCount??0;
      if(count>MAX_CHANGED_ROWS)
        throw new HttpError(409,"sql_too_many_rows","تجاوز الأمر حد 500 صف؛ أُلغيت المعاملة دون حفظ التغيير");
      // This audit is in the same transaction, and never includes SQL values.
      await audit(client,user,"owner.sql.execute","sqlConsole",null,null,{
        kind:statement.kind,table:statement.table,affectedRows:count,statementHash:sha(statement.sql)
      },null);
      return count;
    });
    res.json({ok:true,kind:statement.kind,table:statement.table,affectedRows});
  }));
  return router;
}
