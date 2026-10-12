import express, { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { tokenHash } from "./services/auth.ts";

const tools=[{
 name:"query_general_table",
 description:"اقرأ من الجدول العام في تجارة. صفِّ حسب اسم الجدول والرقم 2 (صفر أو فارغ)، ورتب بحسب الرقم 1 من الأكبر إلى الأصغر. يعيد النص الكامل لحقل الوصف أو الشرح. للقراءة فقط.",
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
}];
const argsSchema=z.object({
 tableName:z.string().trim().min(1).max(120),
 number2EmptyOrZero:z.boolean().default(false),
 page:z.number().int().min(1).max(1000).default(1),
 pageSize:z.number().int().min(1).max(50).default(20),
}).strict();
const idSchema=z.object({id:z.number().int().positive().max(2147483647)}).strict();
const selectFields=`general_table_id AS "id",
 general_table_table_name AS "tableName",general_table_category AS "category",
 general_table_title AS "title",general_table_description AS "description",
 general_table_number1::text AS "number1",general_table_number2::text AS "number2",
 general_table_date1 AS "date1",general_table_date2 AS "date2",
 general_table_text1 AS "text1",general_table_text2 AS "text2",
 general_table_text3 AS "text3",general_table_text4 AS "text4",
 general_table_text5 AS "text5",general_table_text6 AS "text6",
 general_table_text7 AS "text7",general_table_text8 AS "text8",
 general_table_text9 AS "text9"`;

export function chatgptMcpRoutes(pool:Pool,origin:string):Router{
 const router=Router();
 const unauthorized=(res:import("express").Response,id:string|number)=>{
   const challenge=`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", error="invalid_token", error_description="Authorize Tijara's general table read access"`;
   res.setHeader("WWW-Authenticate",challenge);
   res.setHeader("Cache-Control","no-store");
   res.json({jsonrpc:"2.0",id,result:{
     content:[{type:"text",text:"Authentication required: connect Tijara using OAuth."}],
     isError:true,
     _meta:{"mcp/www_authenticate":[challenge]},
   }});
 };
 router.post("/mcp",express.json({limit:"64kb"}),async(req,res,next)=>{
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
       serverInfo:{name:"tijara-readonly",version:"1.0.0"}});return;
   }
   if(body.method==="ping"){ok({});return;}
   if(body.method==="tools/list"){ok({tools});return;}
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
     `SELECT u.id FROM chatgpt_oauth_tokens t JOIN users u ON u.id=t.user_id
       WHERE t.access_hash=$1 AND t.access_expires_at>now() AND t.refresh_expires_at>now()
       AND t.revoked_at IS NULL AND t.scope='general_table.read'
       AND t.resource=ANY($2::text[]) AND (u.owner OR u.kind='admin')
       AND NOT u.archived AND NOT u.suspended LIMIT 1`,
     [tokenHash(auth.slice(7)),[origin,origin+"/mcp"]],
   )).rows[0];
   if(!user){unauthorized(res,body.id);return;}
   const params=body.params as {name?:unknown;arguments?:unknown}|undefined;
   if(!params||typeof params.name!=="string"){fail(-32602,"Invalid tool");return;}
   let result:unknown;
   if(params.name==="query_general_table"){
     const parsed=argsSchema.safeParse(params.arguments??{});
     if(!parsed.success){fail(-32602,"Invalid table filters");return;}
     const {tableName,number2EmptyOrZero,page,pageSize}=parsed.data;
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
     result={record:row};
   }else{fail(-32602,"Unknown tool");return;}
   ok({content:[{type:"text",text:JSON.stringify(result)}],structuredContent:result});
  }catch(error){next(error);}
 });
 router.get("/mcp",(_req,res)=>res.status(405).set("Allow","POST").end());
 router.delete("/mcp",(_req,res)=>res.status(405).set("Allow","POST").end());
 return router;
}
