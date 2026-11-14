import {createHash,randomUUID} from "node:crypto";
import type {Pool} from "pg";
import {z} from "zod";
import type {User} from "../../../../packages/contracts/src/index.ts";
import type {MarketGatewayOptions} from "../market/gateway.ts";
import {askMarket,inspect,limitedTransaction,type SqlDatabase} from "../routes-owner-sql.ts";
import {HttpError} from "../errors.ts";
import {audit} from "./audit.ts";

const previewInput=z.object({database:z.enum(["main","market"]),sql:z.string().trim().min(1).max(12000)}).strict();
const executeInput=previewInput.extend({
  previewId:z.string().uuid(),
  confirmation:z.literal("تنفيذ"),
}).strict();
const LIMIT=500,EXPIRES_MS=120000;
const hash=(sql:string)=>createHash("sha256").update(sql).digest("hex");
type Pending={
  userId:number;sessionHash:string;expiresAt:number;database:SqlDatabase;
  sqlHash:string;kind:"insert"|"update"|"delete";table:string|null;
};
const pending=new Map<string,Pending>();
function prune(){
  const now=Date.now();
  for(const [key,val] of pending)if(val.expiresAt<now)pending.delete(key);
}
export const ownerSqlMcpTools=[
  {
    name:"preview_bulk_sql",
    description:"للمالك فقط عبر OAuth: عاين استعلام PostgreSQL واحدًا من INSERT أو UPDATE أو DELETE على قاعدة الرئيسي أو السوق المستقلة، دون تنفيذه. يتطلب tijara.read وtijara.write. أعد معرف المعاينة قبل أي تنفيذ.",
    inputSchema:{
      type:"object",
      properties:{
        database:{type:"string",enum:["main","market"]},
        sql:{type:"string",minLength:1,maxLength:12000},
      },
      required:["database","sql"],additionalProperties:false,
    },
    securitySchemes:[{type:"oauth2",scopes:["tijara.read","tijara.write"]}],
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  },
  {
    name:"execute_bulk_sql",
    description:"للمالك فقط عبر OAuth: نفذ استعلام INSERT أو UPDATE أو DELETE بعد معاينته بنفس النص وقاعدة البيانات، وبمعرف المعاينة والتأكيد الصريح. لا تكرر التنفيذ إن كانت النتيجة غير معروفة. 500 صف كحد أقصى، والتغيير يسجل في تدقيق القاعدة المختارة.",
    inputSchema:{
      type:"object",
      properties:{
        database:{type:"string",enum:["main","market"]},
        sql:{type:"string",minLength:1,maxLength:12000},
        previewId:{type:"string",format:"uuid"},
        confirmation:{type:"string",enum:["تنفيذ"]},
      },
      required:["database","sql","previewId","confirmation"],additionalProperties:false,
    },
    securitySchemes:[{type:"oauth2",scopes:["tijara.read","tijara.write"]}],
    annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:false},
  },
] as const;

export async function callOwnerSqlMcp(
  pool:Pool,marketOptions:MarketGatewayOptions|undefined,
  name:string,args:unknown,user:User,sessionHash:string
){
  if(!user.owner||user.archived||user.suspended)
    throw new HttpError(403,"owner_only","تنفيذ SQL عبر ChatGPT للمالك المسجل وحده");
  prune();
  if(name==="preview_bulk_sql"){
    const input=previewInput.parse(args);
    const statement=inspect(input.sql,input.database);
    if(statement.kind==="select")throw new HttpError(400,"write_only","SELECT متاح للمالك من صفحة الاستعراض");
    let estimatedRows:number|null=null;
    if(input.database==="market"){
      const result=await askMarket(marketOptions,"preview",user,statement.sql);
      estimatedRows=result.estimatedRows??null;
    }else{
      estimatedRows=await limitedTransaction(pool,true,async client=>{
        const result=await client.query({
          name:"owner_mcp_explain_"+randomUUID().replaceAll("-",""),
          text:"EXPLAIN (FORMAT JSON) "+statement.sql,
        });
        const plan=result.rows[0]?.["QUERY PLAN"]?.[0]?.Plan;
        const estimate=plan?.Plans?.[0]?.["Plan Rows"]??plan?.["Plan Rows"];
        return typeof estimate==="number"?estimate:null;
      });
    }
    const previewId=randomUUID();
    pending.set(previewId,{
      userId:user.id,sessionHash,expiresAt:Date.now()+EXPIRES_MS,
      database:input.database,sqlHash:hash(statement.sql),kind:statement.kind,table:statement.table,
    });
    return {
      mode:"preview",database:input.database,kind:statement.kind,table:statement.table,
      estimatedRows,previewId,expiresInSeconds:EXPIRES_MS/1000,
      maxChangedRows:LIMIT,requiresExplicitConfirmation:true,
      warning:"EXPLAIN is an estimate, not a row-level diff. Verify SELECT scope and business rules before authorizing.",
    };
  }
  if(name!=="execute_bulk_sql")throw new HttpError(400,"unknown_tool","عملية غير معروفة");
  const input=executeInput.parse(args);
  const statement=inspect(input.sql,input.database);
  if(statement.kind==="select")throw new HttpError(400,"write_only","استخدم SELECT من الصفحة");
  const ticket=pending.get(input.previewId);
  if(!ticket||ticket.userId!==user.id||ticket.sessionHash!==sessionHash||
    ticket.database!==input.database||ticket.sqlHash!==hash(statement.sql)||
    ticket.kind!==statement.kind||ticket.expiresAt<Date.now())
    throw new HttpError(409,"preview_expired","معاينة غير صالحة أو منتهية؛ أعد المعاينة قبل التنفيذ");
  // Consume first: a retry with the same preview ID cannot double-apply a write.
  pending.delete(input.previewId);
  if(input.database==="market"){
    const result=await askMarket(marketOptions,"execute",user,statement.sql);
    return {ok:true,database:"market",kind:statement.kind,table:statement.table,
      affectedRows:result.affectedRows??0,previewId:input.previewId};
  }
  const affectedRows=await limitedTransaction(pool,false,async client=>{
    const result=await client.query({
      name:"owner_mcp_write_"+randomUUID().replaceAll("-",""),
      text:statement.sql,
    });
    const count=result.rowCount??0;
    if(count>LIMIT)throw new HttpError(409,"sql_too_many_rows","تجاوز الاستعلام 500 صف؛ أُلغيت العملية كاملة");
    await audit(client,user,"owner.sql.execute","sqlConsole",null,null,{
      source:"chatgpt-mcp",database:"main",kind:statement.kind,table:statement.table,
      affectedRows:count,statementHash:hash(statement.sql),
    },null);
    return count;
  });
  return {ok:true,database:"main",kind:statement.kind,table:statement.table,
    affectedRows,previewId:input.previewId};
}
