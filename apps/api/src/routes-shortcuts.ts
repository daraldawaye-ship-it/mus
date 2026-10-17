import { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { transaction } from "./db.ts";
import { actor, handler, parse } from "./http.ts";
import { optionalId } from "./services/lists.ts";
import { currentActor } from "./policies/access.ts";
import { directoryEntries } from "./services/pages.ts";
import { HttpError } from "./errors.ts";

const shortcutInput = z.object({
  pageKeys: z.array(z.string().max(120)).max(40).refine(
    keys => new Set(keys).size === keys.length, "لا يمكن تكرار الصفحة",
  ),
}).strict();

export function shortcutRoutes(pool: Pool): Router {
  const router = Router();
  router.get("/my-shortcuts",handler(async(req,res) => {
    const companyId=optionalId(req.query.companyId);
    const result=await transaction(pool,async client=>{
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const user=await currentActor(client,actor(req),false);
      const entries=await directoryEntries(client,user,companyId);
      const allowed=new Set(entries.filter(entry=>
        entry.enabled && entry.actionAccess.view && entry.href &&
        !entry.record && (entry.scope==="public" || companyId !== null)
      ).map(entry=>entry.key));
      const row=await client.query(
        "SELECT page_keys FROM user_page_shortcuts WHERE user_id=$1 AND scope_company_id=$2",
        [user.id,companyId??0],
      );
      return {
        pageKeys:(row.rows[0]?.page_keys as string[] | undefined ?? [])
          .filter(key=>allowed.has(key)),
      };
    });
    res.json(result);
  }));
  router.put("/my-shortcuts",handler(async(req,res)=>{
    const companyId=optionalId(req.query.companyId);
    const input=parse(shortcutInput,req.body);
    const result=await transaction(pool,async client=>{
      const user=await currentActor(client,actor(req));
      const entries=await directoryEntries(client,user,companyId);
      const allowed=new Set(entries.filter(entry=>
        entry.enabled && entry.actionAccess.view && entry.href &&
        !entry.record && (entry.scope==="public" || companyId !== null)
      ).map(entry=>entry.key));
      if(input.pageKeys.some(key=>!allowed.has(key)))
        throw new HttpError(403,"shortcut_not_allowed",
          "لا يمكن حفظ صفحة غير متاحة ضمن صلاحياتك؛ حدث دليل الصفحات.");
      const row=await client.query(
        `INSERT INTO user_page_shortcuts(user_id,scope_company_id,page_keys)
         VALUES($1,$2,$3::text[]) ON CONFLICT(user_id,scope_company_id)
         DO UPDATE SET page_keys=EXCLUDED.page_keys,updated_at=now()
         RETURNING page_keys`,
        [user.id,companyId??0,input.pageKeys],
      );
      return {pageKeys:row.rows[0].page_keys as string[]};
    });
    res.json(result);
  }));
  return router;
}
