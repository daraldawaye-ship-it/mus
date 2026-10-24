import express, { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { tokenHash } from "./services/auth.ts";
import { transaction } from "./db.ts";
import { generalTableSchema, type GeneralTableInput } from "../../../packages/contracts/src/general-table.ts";
import { audit } from "./services/audit.ts";
import { apiTools, apiCatalog, dispatchApi, oauthScopes, API_READ_SCOPE, API_WRITE_SCOPE } from "./services/mcp-api.ts";
import { userDTO } from "./repositories/models.ts";
import { assertGeneralTableAccess } from "./general-table-access.ts";

const tools=[{
 name:"query_general_table",
 description:"اقرأ من الجدول العام في الرئيسي. صفِّ حسب اسم الجدول والرقم 2 (صفر أو فارغ)، ورتب بحسب الرقم 1 من الأكبر إلى الأصغر. يعيد النص الكامل لحقل الوصف أو الشرح. للقراءة فقط.",
 inputSchema:{type:"object",properties:{
   tableName:{type:"string",description:"اسم الجدول مثل: طلب تعديلات في الموقع"},
   number2EmptyOrZero:{type:"boolean",default:false},
   page:{type:"integer",minimum:1,default:1},
   pageSize:{type:"integer",minimum:1,maximum:50,default:20}
 },required:["tableName"],additionalProperties:false},
 securitySchemes:[{type:"oauth2",scopes:["general_table.read"]}],
 annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
},{
 name:"get_general_table_record",
 description:"قراءة سجل معين من الجدول العام برقم السجل مع الشرح والنص الكامل للحقول. للقراءة فقط.",
 inputSchema:{type:"object",properties:{id:{type:"integer",minimum:1}},required:["id"],additionalProperties:false},
 securitySchemes:[{type:"oauth2",scopes:["general_table.read"]}],
 annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
},{
 name:"create_general_table_record",
 description:"إنشاء سجل جديد في الجدول العام بعد موافقة المستخدم. تتطلب صلاحية كتابة مستقلة، ويسجل النظام العملية للتدقيق. لا ينفذ أوامر SQL حرة.",
 inputSchema:{type:"object",properties:{
   tableName:{type:"string"},title:{type:"string"},category:{type:"string"},description:{type:"string"},
   number1:{type:["string","null"]},number2:{type:["string","null"]},
   date1:{type:["string","null"]},date2:{type:["string","null"]},
   text1:{type:"string"},text2:{type:"string"},text3:{type:"string"},
   text4:{type:"string"},text5:{type:"string"},text6:{type:"string"},
   text7:{type:"string"},text8:{type:"string"},text9:{type:"string"}
 },required:["tableName","title"],additionalProperties:false},
 securitySchemes:[{type:"oauth2",scopes:["general_table.read","general_table.write"]}],
 annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},
},{
 name:"update_general_table_record",
 description:"تعديل الحقول المحددة في سجل موجود من الجدول العام مع رقم السجل وتاريخ updatedAt المتوقع الذي تحصل عليه من القراءة. يمنع الكتابة فوق تعديل أحدث، ويسجل التغيير للتدقيق. لا يسمح بالحذف أو SQL الحر.",
 inputSchema:{type:"object",properties:{
  id:{type:"integer",minimum:1},expectedUpdatedAt:{type:"string",description:"updatedAt من آخر قراءة للسجل"},
  changes:{type:"object",properties:{
   tableName:{type:"string"},title:{type:"string"},category:{type:"string"},description:{type:"string"},
   number1:{type:["string","null"]},number2:{type:["string","null"]},
   date1:{type:["string","null"]},date2:{type:["string","null"]},
   text1:{type:"string"},text2:{type:"string"},text3:{type:"string"},text4:{type:"string"},
   text5:{type:"string"},text6:{type:"string"},text7:{type:"string"},text8:{type:"string"},text9:{type:"string"}
  },additionalProperties:false}
 },required:["id","expectedUpdatedAt","changes"],additionalProperties:false},
 securitySchemes:[{type:"oauth2",scopes:["general_table.read","general_table.write"]}],
 annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},
}];
const argsSchema=z.object({
 tableName:z.string().trim().min(1).max(120),
 number2EmptyOrZero:z.boolean().default(false),
 page:z.number().int().min(1).max(1000).default(1),
 pageSize:z.number().int().min(1).max(50).default(20),
}).strict();
const idSchema=z.object({id:z.number().int().positive().max(2147483647)}).strict();
const createSchema=generalTableSchema.partial().extend({
 tableName:generalTableSchema.shape.tableName,
 title:generalTableSchema.shape.title,
}).strict();
const updateSchema=z.object({
 id:idSchema.shape.id,
 expectedUpdatedAt:z.string().datetime({offset:true}),
 changes:generalTableSchema.partial().refine(v=>Object.keys(v).length>0,"No changes provided"),
}).strict();
const editableColumns:Record<keyof GeneralTableInput,string>={
 tableName:"general_table_table_name",category:"general_table_category",
 title:"general_table_title",description:"general_table_description",
 number1:"general_table_number1",number2:"general_table_number2",
 date1:"general_table_date1",date2:"general_table_date2",
 text1:"general_table_text1",text2:"general_table_text2",
 text3:"general_table_text3",text4:"general_table_text4",text5:"general_table_text5",
 text6:"general_table_text6",text7:"general_table_text7",
 text8:"general_table_text8",text9:"general_table_text9",
};
const emptyRecord:Omit<GeneralTableInput,"tableName"|"title">={
 category:"",description:"",number1:null,number2:null,date1:null,date2:null,
 text1:"",text2:"",text3:"",text4:"",text5:"",text6:"",text7:"",text8:"",text9:"",
};

const selectFields=`general_table_id AS "id",
 general_table_table_name AS "tableName",general_table_category AS "category",
 general_table_title AS "title",general_table_description AS "description",
 general_table_number1::text AS "number1",general_table_number2::text AS "number2",
 general_table_date1 AS "date1",general_table_date2 AS "date2",
 general_table_text1 AS "text1",general_table_text2 AS "text2",
 general_table_text3 AS "text3",general_table_text4 AS "text4",
 general_table_text5 AS "text5",general_table_text6 AS "text6",
 general_table_text7 AS "text7",general_table_text8 AS "text8",
 general_table_text9 AS "text9",created_at AS "createdAt",updated_at AS "updatedAt"`;

export function chatgptMcpRoutes(pool:Pool,origin:string,business:Router):Router{
 const router=Router();
 const unauthorized=(res:import("express").Response,id:string|number)=>{
   const challenge=`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", error="invalid_token", error_description="Authorize Alraesy's general table read access"`;
   res.setHeader("WWW-Authenticate",challenge);
   res.setHeader("Cache-Control","no-store");
   res.json({jsonrpc:"2.0",id,result:{
     content:[{type:"text",text:"Authentication required: connect Alraesy using OAuth."}],
     isError:true,
     _meta:{"mcp/www_authenticate":[challenge]},
   }});
 };
 router.post("/mcp",express.json({limit:"5mb"}),async(req,res,next)=>{
  try{
   res.setHeader("Cache-Control","no-store");
   const body=req.body as {jsonrpc?:unknown;id?:string|number;method?:unknown;params?:unknown};
   if(!body||body.jsonrpc!=="2.0"||typeof body.method!=="string"||
     (body.id!==undefined&&!["string","number"].includes(typeof body.id))){
      res.status(400).json({jsonrpc:"2.0",id:null,error:{code:-32600,message:"Invalid request"}});
      return;
   }
   if(body.id===undefined){res.status(202).end();return;}
   const ok=(result:unknown)=>res.json({jsonrpc:"2.0",id:body.id,result});
   const fail=(code:number,message:string)=>res.json({jsonrpc:"2.0",id:body.id,error:{code,message}});
   if(body.method==="initialize"){
     ok({protocolVersion:"2025-06-18",capabilities:{tools:{listChanged:false}},
       serverInfo:{name:"tijara-general-table",version:"1.3.0"}});return;
   }
   if(body.method==="ping"){ok({});return;}
   if(body.method==="tools/list"){ok({tools:[...tools,...apiTools]});return;}
   if(body.method==="resources/list"){ok({resources:[]});return;}
   if(body.method==="prompts/list"){ok({prompts:[]});return;}
   if(body.method!=="tools/call"){fail(-32601,"Method not found");return;}
   // MCP capabilities are discoverable anonymously, but actual record reads
   // always require an unexpired, unrevoked, scoped and owner/admin token.
   const auth=req.get("authorization")??"";
   if(!/^Bearer [A-Za-z0-9_-]{43}$/.test(auth)){
     unauthorized(res,body.id);return;
   }
   const user=(await pool.query(
     `SELECT u.*,t.scope AS granted_scope FROM chatgpt_oauth_tokens t JOIN users u ON u.id=t.user_id
       WHERE t.access_hash=$1 AND t.access_expires_at>now() AND t.refresh_expires_at>now()
       AND t.revoked_at IS NULL AND t.scope=ANY($3::text[])
       AND t.resource=ANY($2::text[])
       AND NOT u.archived AND NOT u.suspended LIMIT 1`,
     [tokenHash(auth.slice(7)),[origin,origin+"/mcp"],oauthScopes],
   )).rows[0];
   if(!user){unauthorized(res,body.id);return;}
   const params=body.params as {name?:unknown;arguments?:unknown}|undefined;
   if(!params||typeof params.name!=="string"){fail(-32602,"Invalid tool");return;}
   if(apiTools.some(tool=>tool.name===params.name)){
     const granted=String(user.granted_scope).split(" ");
     if(!granted.includes(API_READ_SCOPE)||(params.name==="tijara_api_write"&&!granted.includes(API_WRITE_SCOPE))){
       fail(-32001,"Additional scope required. Reconnect Alraesy and approve the requested site read/write access.");return;
     }
     try {
     if(params.name==="tijara_api_catalog"){
       const catalog=apiCatalog(business,params.arguments??{});
       ok({content:[{type:"text",text:JSON.stringify(catalog)}],structuredContent:catalog});return;
     }
     dispatchApi(business,req,res,next,userDTO(user),params.name,params.arguments??{},body.id);return;
     } catch { fail(-32602,"Invalid API operation or arguments; inspect tijara_api_catalog"); return; }
   }
   // A site-only employee connection never grants access to the
   // owner/admin general table, including its dedicated read tools.
   const generalGrants=String(user.granted_scope).split(" ");
   if ((!user.owner && user.kind!=="admin") || !generalGrants.includes("general_table.read")) {
     fail(-32001,"General table access requires a separately authorized platform administrator.");return;
   }
   const isWrite=["create_general_table_record","update_general_table_record"].includes(params.name);
   if(isWrite&&!generalGrants.includes("general_table.write")){
     fail(-32001,"Write scope required. Reconnect Alraesy and approve read and write permissions.");return;
   }
   let result:unknown;
   if(params.name==="query_general_table"){
     const parsed=argsSchema.safeParse(params.arguments??{});
     if(!parsed.success){fail(-32602,"Invalid table filters");return;}
     const {tableName,number2EmptyOrZero,page,pageSize}=parsed.data;
     await assertGeneralTableAccess(pool,user,tableName);
     const where="general_table_table_name=$1"+
       (number2EmptyOrZero?" AND (general_table_number2 IS NULL OR general_table_number2=0)":"");
     const total=(await pool.query<{total:number}>(
       `SELECT count(*)::integer AS total FROM general_table WHERE ${where}`,[tableName])).rows[0]!.total;
     const rows=(await pool.query(
       `SELECT ${selectFields} FROM general_table WHERE ${where}
        ORDER BY general_table_number1 DESC NULLS LAST,general_table_id DESC
        LIMIT $2 OFFSET $3`,
       [tableName,pageSize,(page-1)*pageSize])).rows;
     result={tableName,total,page,pageSize,records:rows};
   }else if(params.name==="get_general_table_record"){
     const parsed=idSchema.safeParse(params.arguments??{});
     if(!parsed.success){fail(-32602,"Invalid record ID");return;}
     const row=(await pool.query(
       `SELECT ${selectFields} FROM general_table WHERE general_table_id=$1`,
       [parsed.data.id])).rows[0];
     if(!row){fail(-32602,"Record not found");return;}
     await assertGeneralTableAccess(pool,user,String(row.tableName));
     result={record:row};
   }else if(params.name==="create_general_table_record"){
     const parsed=createSchema.safeParse(params.arguments??{});
     if(!parsed.success){fail(-32602,"Invalid record fields");return;}
     const input=generalTableSchema.parse({...emptyRecord,...parsed.data});
     await assertGeneralTableAccess(pool,user,input.tableName,"editor");
     const record=await transaction(pool,async db=>{
       const actorResult=await db.query("SELECT * FROM users WHERE id=$1 FOR SHARE",[user.id]);
       const active=actorResult.rows[0];
       if(!active||active.archived||active.suspended||(!active.owner&&active.kind!=="admin"))
         throw new Error("User no longer has administration rights");
       const disabled=await db.query("SELECT 1 FROM page_settings WHERE page_key='public.general-table' AND company_id IS NULL AND NOT enabled FOR SHARE");
       if(disabled.rowCount)throw new Error("General table page is disabled");
       const keys=Object.keys(editableColumns) as (keyof GeneralTableInput)[];
       const values=keys.map(key=>input[key]);
       const fields=keys.map(key=>editableColumns[key]);
       const placeholders=keys.map((_,i)=>"$"+(i+1));
       const inserted=await db.query(
         `INSERT INTO general_table(${fields.join(",")},created_by) VALUES(${placeholders.join(",")},$${keys.length+1}) RETURNING ${selectFields}`,
         [...values,active.id]);
       const next=inserted.rows[0];
       await audit(db,userDTO(active),"generalTable.create","generalTable",next.id,null,next);
       return next;
     });
     result={record};
   }else if(params.name==="update_general_table_record"){
     const parsed=updateSchema.safeParse(params.arguments??{});
     if(!parsed.success){fail(-32602,"Invalid update; supply id, expectedUpdatedAt and changes");return;}
     const {id,expectedUpdatedAt,changes}=parsed.data;
     const updated=await transaction(pool,async db=>{
       const actorResult=await db.query("SELECT * FROM users WHERE id=$1 FOR SHARE",[user.id]);
       const active=actorResult.rows[0];
       if(!active||active.archived||active.suspended||(!active.owner&&active.kind!=="admin"))
         throw new Error("User no longer has administration rights");
       const disabled=await db.query("SELECT 1 FROM page_settings WHERE page_key='public.general-table' AND company_id IS NULL AND NOT enabled FOR SHARE");
       if(disabled.rowCount)throw new Error("General table page is disabled");
       const old=await db.query(`SELECT ${selectFields} FROM general_table WHERE general_table_id=$1 FOR UPDATE`,[id]);
       if(!old.rows[0])return {error:"Record not found",code:"not_found"};
       const before=old.rows[0];
       await assertGeneralTableAccess(db,userDTO(active),String(before.tableName),"editor");
       if(changes.tableName!==undefined) await assertGeneralTableAccess(db,userDTO(active),changes.tableName,"editor");
       if(new Date(before.updatedAt).toISOString()!==new Date(expectedUpdatedAt).toISOString())
         return {error:"Record changed since last read. Reload before editing.",code:"conflict",current:before};
       const keys=Object.keys(changes) as (keyof GeneralTableInput)[];
       const assignments=keys.map((key,i)=>`${editableColumns[key]}=$${i+1}`).join(",");
       const vals=keys.map(key=>changes[key]);
       const changed=await db.query(
         `UPDATE general_table SET ${assignments},updated_at=now() WHERE general_table_id=$${keys.length+1} RETURNING ${selectFields}`,
         [...vals,id]);
       const next=changed.rows[0];
       await audit(db,userDTO(active),"generalTable.update","generalTable",id,before,next);
       return {record:next};
     });
     if("error" in updated){ok({content:[{type:"text",text:updated.error}],structuredContent:updated,isError:true});return;}
     result=updated;
   }else{fail(-32602,"Unknown tool");return;}
   ok({content:[{type:"text",text:JSON.stringify(result)}],structuredContent:result});
  }catch(error){next(error);}
 });
 router.get("/mcp",(_req,res)=>res.status(405).set("Allow","POST").end());
 router.delete("/mcp",(_req,res)=>res.status(405).set("Allow","POST").end());
 return router;
}
