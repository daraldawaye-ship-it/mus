import express, { Router, type Router as ExpressRouter } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { tokenHash } from "./services/auth.ts";

/**
 * Private ChatGPT connector for the existing Alraesy application. It delegates
 * every operation to /api, so the same company, page, record and role policies
 * used by the website apply here. It never issues SQL.
 */
export interface AlraesyOperation {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
}
const RESOURCE_PATH = "/mcp/alraesy";
const HIDDEN = /^\/(?:auth(?:\/|$)|setup(?:\/|$)|social(?:\/|$)|media(?:\/|$))/;
const supported = new Set(["GET", "POST", "PATCH", "PUT", "DELETE"]);
const querySchema = z.record(z.string(), z.union([
  z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()
])).optional();
const readInput = z.object({
  path: z.string().min(1).max(250),
  query: querySchema,
}).strict();
const writeInput = readInput.extend({
  method: z.enum(["POST", "PATCH", "PUT", "DELETE"]),
  body: z.record(z.string(), z.unknown()).optional(),
}).strict();
const catalogInput = z.object({
  filter: z.string().max(100).optional(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
}).strict();

/** Enumerate the *registered* API actions instead of maintaining a stale hand-written list. */
export function alraesyApiCatalog(routers: ExpressRouter[]): AlraesyOperation[] {
  const operations = new Map<string, AlraesyOperation>();
  for (const router of routers) {
    for (const layer of (router as unknown as {stack?: Array<{
      route?: {path?: unknown; methods?: Record<string, boolean>};
    }>}).stack ?? []) {
      const route = layer.route;
      const paths = Array.isArray(route?.path) ? route.path : [route?.path];
      for (const path of paths) {
        if (typeof path !== "string" || !/^\/[a-zA-Z0-9_./:-]+$/.test(path) || HIDDEN.test(path))
          continue;
        for (const [name, enabled] of Object.entries(route?.methods ?? {})) {
          const method = name.toUpperCase();
          if (!enabled || !supported.has(method)) continue;
          const entry = {method: method as AlraesyOperation["method"], path};
          operations.set(method + " " + path, entry);
        }
      }
    }
  }
  return [...operations.values()].sort((a,b)=>
    a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

function matches(operation: AlraesyOperation, method: string, path: string): boolean {
  if (operation.method !== method) return false;
  // Only named path parameters are substituted. No absolute URL, encoding,
  // dot segments, traversal or arbitrary API endpoints are accepted.
  const template = operation.path.split("/").map(segment =>
    segment.startsWith(":") ? "[a-zA-Z0-9_-]+" :
      segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("/");
  return new RegExp("^" + template + "$").test(path);
}

export function alraesyMcpRoutes(
  pool: Pool, origin: string, operations: AlraesyOperation[]
): ExpressRouter {
  const router = Router();
  const protectedResource = origin + RESOURCE_PATH;
  const oauth2 = (write: boolean) => [{
    type: "oauth2",
    scopes: write ? ["alraesy.read", "alraesy.write"] : ["alraesy.read"],
  }];
  const tools = [
    {
      name: "alraesy_api_catalog",
      description: "Discover registered Alraesy API actions (pages, accounts, companies, users, invoices, items, inventory, reports and more). Permission checks still apply to calls.",
      inputSchema: {
        type: "object", properties: {
          filter: {type:"string"},method:{type:"string",enum:["GET","POST","PATCH","PUT","DELETE"]}
        }, additionalProperties:false
      },
      securitySchemes:oauth2(false),
      annotations:{readOnlyHint:true,openWorldHint:false},
    },
    {
      name: "alraesy_api_read",
      description: "Read via a registered GET /api endpoint, respecting the signed-in user's permissions and company boundaries. Paths come from alraesy_api_catalog.",
      inputSchema: {
        type:"object",properties:{
          path:{type:"string"},query:{type:"object",additionalProperties:true}
        },required:["path"],additionalProperties:false
      },
      securitySchemes:oauth2(false),
      annotations:{readOnlyHint:true,openWorldHint:false},
    },
    {
      name:"alraesy_api_write",
      description:"Perform a registered POST/PUT/PATCH/DELETE site operation as the signed-in user. Server authorization, revision and idempotency protections apply. Never send passwords through chat.",
      inputSchema:{
        type:"object", properties:{
          method:{type:"string",enum:["POST","PUT","PATCH","DELETE"]},
          path:{type:"string"},query:{type:"object",additionalProperties:true},
          body:{type:"object",additionalProperties:true}
        },required:["method","path"],additionalProperties:false
      },
      securitySchemes:oauth2(true),
      annotations:{readOnlyHint:false,openWorldHint:false},
    },
    {
      name:"alraesy_password_settings",
      description:"Open the website's protected password-change form. Passwords must not be disclosed to ChatGPT or placed in tool arguments.",
      inputSchema:{type:"object",properties:{},additionalProperties:false},
      securitySchemes:oauth2(false),
      annotations:{readOnlyHint:true,openWorldHint:false},
    },
  ];
  router.post(RESOURCE_PATH,express.json({limit:"128kb"}),async(req,res,next)=>{
    try {
      res.setHeader("Cache-Control","no-store");
      const body=req.body as {jsonrpc?:unknown;id?:number|string;method?:unknown;params?:unknown};
      if (!body || body.jsonrpc!=="2.0" || typeof body.method!=="string" ||
        (body.id!==undefined&&!["string","number"].includes(typeof body.id))) {
        res.status(400).json({jsonrpc:"2.0",id:null,error:{code:-32600,message:"Invalid request"}});return;
      }
      if (body.id===undefined) {res.status(202).end();return;}
      const ok=(result:unknown)=>res.json({jsonrpc:"2.0",id:body.id,result});
      const fail=(code:number,message:string)=>res.json({jsonrpc:"2.0",id:body.id,error:{code,message}});
      if (body.method==="initialize") {
        ok({protocolVersion:"2025-06-18",capabilities:{tools:{listChanged:false}},
          serverInfo:{name:"alraesy",version:"1.0.0"}});return;
      }
      if (body.method==="ping") {ok({});return;}
      if (body.method==="tools/list") {ok({tools});return;}
      if (body.method==="resources/list") {ok({resources:[]});return;}
      if (body.method==="prompts/list") {ok({prompts:[]});return;}
      if (body.method!=="tools/call") {fail(-32601,"Method not found");return;}
      const auth=req.get("authorization")??"";
      const token=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(auth)?.[1];
      const scope=(token ? (await pool.query<{scope:string}>(
        `SELECT t.scope FROM chatgpt_oauth_tokens t JOIN users u ON u.id=t.user_id
         WHERE t.access_hash=$1 AND t.resource=$2 AND t.access_expires_at>now()
           AND t.refresh_expires_at>now() AND t.revoked_at IS NULL
           AND NOT u.archived AND NOT u.suspended
           AND t.scope IN ('alraesy.read','alraesy.read alraesy.write') LIMIT 1`,
        [tokenHash(token),protectedResource]
      )).rows[0]?.scope : undefined);
      if (!scope) {
        const challenge=`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp/alraesy"`;
        res.setHeader("WWW-Authenticate",challenge);
        ok({content:[{type:"text",text:"Connect Alraesy using your own site account."}],
          isError:true,_meta:{"mcp/www_authenticate":[challenge]}});return;
      }
      const params=body.params as {name?:unknown;arguments?:unknown}|undefined;
      if (!params||typeof params.name!=="string") {fail(-32602,"Tool name required");return;}
      const isWrite=params.name==="alraesy_api_write";
      if (isWrite&&!scope.split(" ").includes("alraesy.write")) {
        fail(-32001,"Reconnect and authorize Alraesy write access.");return;
      }
      if (params.name==="alraesy_api_catalog") {
        const parsed=catalogInput.safeParse(params.arguments??{});
        if (!parsed.success) {fail(-32602,"Invalid catalog filter");return;}
        const filter=parsed.data.filter?.toLowerCase();
        const entries=operations.filter(o=>
          (!parsed.data.method||o.method===parsed.data.method)&&
          (!filter||o.path.toLowerCase().includes(filter)));
        ok({content:[{type:"text",text:JSON.stringify(entries)}],
          structuredContent:{total:entries.length,operations:entries}});return;
      }
      if (params.name==="alraesy_password_settings") {
        const result={url:origin+"/profile",note:"Change your own password on the secured website. Do not send passwords in chat."};
        ok({content:[{type:"text",text:JSON.stringify(result)}],structuredContent:result});return;
      }
      if (!["alraesy_api_read","alraesy_api_write"].includes(params.name)) {
        fail(-32602,"Unknown tool");return;
      }
      const parsed = isWrite ? writeInput.safeParse(params.arguments??{}) :
        readInput.safeParse(params.arguments??{});
      if (!parsed.success) {fail(-32602,"Invalid API operation arguments");return;}
      const input=parsed.data;
      const method=isWrite ? (input as z.infer<typeof writeInput>).method:"GET";
      const path=input.path;
      if (!/^\/[a-zA-Z0-9_/-]+$/.test(path)||HIDDEN.test(path)||
        !operations.some(op=>matches(op,method,path))) {
        fail(-32602,"Unknown or disallowed API operation. Inspect the catalog.");return;
      }
      const query=new URLSearchParams();
      for (const [k,value] of Object.entries(input.query??{})) {
        if (value===null)continue;
        if(Array.isArray(value)) for(const part of value)query.append(k,String(part));
        else query.set(k,String(value));
      }
      const endpoint="http://127.0.0.1:"+String(process.env.PORT??3000)+"/api"+path+
        (query.size ? "?"+query.toString():"");
      const payload=isWrite ? (input as z.infer<typeof writeInput>).body:undefined;
      const downstream=await fetch(endpoint,{
        method,headers:{
          authorization:auth,
          ...(isWrite?{"content-type":"application/json"}:{})
        },
        ...(isWrite?{body:JSON.stringify(payload??{})}:{}),
        signal:AbortSignal.timeout(15000)
      });
      const responseText=await downstream.text();
      let data:unknown;
      try {data=JSON.parse(responseText);} catch {data={message:"Non-JSON response from site API"};}
      const result={status:downstream.status,data};
      ok({content:[{type:"text",text:JSON.stringify(result).slice(0,60000)}],
        structuredContent:result,isError:!downstream.ok});
    } catch (error) {next(error);}
  });
  router.get(RESOURCE_PATH,(_req,res)=>res.status(405).set("Allow","POST").end());
  router.delete(RESOURCE_PATH,(_req,res)=>res.status(405).set("Allow","POST").end());
  return router;
}
