import { randomUUID, createHash } from "node:crypto";
import { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { actor, handler, parse } from "../http.ts";
import { ownerOnly } from "../policies/access.ts";
import { HttpError } from "../errors.ts";
import { audit } from "../services/audit.ts";
import { inspect, limitedTransaction, visible } from "../routes-owner-sql.ts";

const sqlInput=z.object({sql:z.string().trim().min(1).max(12000)}).strict();
const MAX_ROWS=200,MAX_CHANGED_ROWS=500;
const hash=(text:string)=>createHash("sha256").update(text).digest("hex");

export function ownerMarketSqlRoutes(pool:Pool):Router {
  const router=Router();
  const verify=(req:Parameters<typeof actor>[0])=>{
    // The market service globally verifies the signed private gateway context
    // BEFORE this router. Browser sessions/cookies cannot authenticate here.
    const user=actor(req);
    ownerOnly(user);
    if(user.suspended||user.archived)throw new HttpError(403,"forbidden","هذه الصفحة لمالك الموقع فقط");
    return user;
  };
  router.post("/preview",handler(async(req,res)=>{
    verify(req);
    const {sql}=parse(sqlInput,req.body);
    const statement=inspect(sql,"market");
    if(statement.kind==="select"){
      const result=await limitedTransaction(pool,true,async(client)=>{
        const answer=await client.query({
          name:"market_owner_sql_select_"+randomUUID().replaceAll("-",""),
          text:"SELECT * FROM ("+statement.sql+") AS market_owner_result LIMIT "+(MAX_ROWS+1)
        });
        const columns=answer.fields.slice(0,80).map(c=>c.name);
        return {mode:"read" as const,database:"market" as const,columns,
          rows:answer.rows.slice(0,MAX_ROWS).map(row=>columns.map(c=>visible(row[c]))),
          rowCount:Math.min(answer.rows.length,MAX_ROWS),
          truncated:answer.rows.length>MAX_ROWS||answer.fields.length>80};
      });
      res.json(result);return;
    }
    const estimatedRows=await limitedTransaction(pool,true,async(client)=>{
      const result=await client.query({
        name:"market_owner_sql_explain_"+randomUUID().replaceAll("-",""),
        text:"EXPLAIN (FORMAT JSON) "+statement.sql
      });
      const plan=result.rows[0]?.["QUERY PLAN"]?.[0]?.Plan;
      const estimate=plan?.Plans?.[0]?.["Plan Rows"]??plan?.["Plan Rows"];
      return typeof estimate==="number"?estimate:null;
    });
    res.json({mode:"write",database:"market",kind:statement.kind,
      table:statement.table,estimatedRows,maxChangedRows:MAX_CHANGED_ROWS});
  }));
  router.post("/execute",handler(async(req,res)=>{
    const user=verify(req);
    const {sql}=parse(sqlInput,req.body);
    const statement=inspect(sql,"market");
    if(statement.kind==="select")throw new HttpError(400,"sql_read_only","استخدم المعاينة لطلبات SELECT");
    const affectedRows=await limitedTransaction(pool,false,async(client)=>{
      const result=await client.query({
        name:"market_owner_sql_write_"+randomUUID().replaceAll("-",""),
        text:statement.sql
      });
      const count=result.rowCount??0;
      if(count>MAX_CHANGED_ROWS)
        throw new HttpError(409,"sql_too_many_rows","تجاوز الأمر حد 500 صف؛ أُلغيت جميع التغييرات");
      // The market database is isolated. Its own audit_events table receives
      // a committed audit in the SAME transaction as the data modification.
      await client.query(
        "INSERT INTO users(id,display_name) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET display_name=EXCLUDED.display_name WHERE users.display_name IS DISTINCT FROM EXCLUDED.display_name",
        [user.id,user.displayName]
      );
      await audit(client,user,"owner.sql.execute","medicine-market",null,null,{
        kind:statement.kind,table:statement.table,affectedRows:count,statementHash:hash(statement.sql)
      },null);
      return count;
    });
    res.json({ok:true,database:"market",kind:statement.kind,table:statement.table,affectedRows});
  }));
  return router;
}
