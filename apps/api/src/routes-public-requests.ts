import { randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { actor, handler, id, parse } from "./http.ts";
import { transaction } from "./db.ts";
import { companyAccess, currentActor } from "./policies/access.ts";
import { directoryEntries, assertDirectoryAccess } from "./services/pages.ts";
import { HttpError } from "./errors.ts";
import { audit } from "./services/audit.ts";
import type { User } from "../../../packages/contracts/src/index.ts";

const addSchema = z.object({ itemId: z.number().int().positive() }).strict();

async function publicRequestAccess(client: PoolClient, req: Request, companyId: number, action: "view" | "create") {
  const user = await currentActor(client, actor(req), action === "create");
  await companyAccess(client, user, companyId, undefined, action === "create");
  const page = (await directoryEntries(client, user, companyId))
    .find(entry => entry.key === "company.public-requests");
  if (!page) throw new HttpError(403, "forbidden", "صفحة طلب الجمهور غير متاحة");
  assertDirectoryAccess(page, action);
  return user;
}

async function awardPublicRequest(
  client: PoolClient, companyId: number, requestId: number, itemId: number,
  itemName: string, user: User,
): Promise<string> {
  const employee = (await client.query(
    `SELECT e.id,e.name FROM employees e JOIN users u ON u.id=e.user_id
     WHERE e.company_id=$1 AND e.user_id=$2 AND e.active AND NOT u.archived
     FOR SHARE OF e`, [companyId,user.id],
  )).rows[0] as { id: number; name: string } | undefined;
  if (!employee) return "0";
  const task = (await client.query(
    `SELECT s.points::text AS points,s.revision
     FROM reward_task_settings s
     JOIN reward_task_definitions d ON d.code=s.code
     WHERE s.company_id=$1 AND s.code='PUBLIC_REQUEST'
       AND s.enabled AND d.implemented AND s.repeat_rule='per-document'
       AND (NOT EXISTS (SELECT 1 FROM reward_task_roles r
            WHERE r.company_id=s.company_id AND r.code=s.code)
         OR EXISTS (SELECT 1 FROM reward_task_roles r
           JOIN employee_role_assignments a ON a.company_id=r.company_id AND a.role_id=r.role_id
           JOIN company_roles cr ON cr.company_id=r.company_id AND cr.id=r.role_id
           WHERE r.company_id=s.company_id AND r.code=s.code AND a.employee_id=$2
             AND a.active AND cr.active))
     FOR SHARE OF s`, [companyId,employee.id],
  )).rows[0] as { points: string; revision: number } | undefined;
  if (!task || BigInt(task.points) <= 0n) return "0";
  const snapshot = {source:"public-request",requestId,itemId,taskCode:"PUBLIC_REQUEST",
    taskRevision:task.revision,pointsPerUnit:task.points,units:1,totalPoints:task.points};
  const result = await client.query(
    `INSERT INTO employee_wallet_entries
      (company_id,employee_id,employee_name,kind,points,reason,
       public_request_id,task_code,task_revision,logical_line_count,
       idempotency_key,request_payload,created_by,created_by_name)
     VALUES ($1,$2,$3,'automatic',$4,$5,$6,'PUBLIC_REQUEST',$7,1,$8,$9,$10,$11)
     ON CONFLICT DO NOTHING RETURNING id`,
    [companyId,employee.id,employee.name,task.points,
     (`مكافأة طلب الجمهور — ${itemName}`).slice(0,490),
     requestId,task.revision,randomUUID(),JSON.stringify(snapshot),
     user.id,user.displayName],
  );
  if (!result.rows[0]) return "0";
  await audit(client,user,"wallet.auto-award","wallet-entry",
    result.rows[0].id,null,snapshot,companyId);
  return task.points;
}

export function publicRequestRoutes(pool: Pool): Router {
  const router = Router();
  const base = "/companies/:companyId/public-requests";

  router.post(base, handler(async (req, res) => {
    const companyId = id(req.params.companyId);
    const { itemId } = parse(addSchema, req.body);
    const result = await transaction(pool, async client => {
      const user = await publicRequestAccess(client, req, companyId, "create");
      const item = (await client.query(
        "SELECT id,name FROM items WHERE company_id=$1 AND id=$2",
        [companyId,itemId],
      )).rows[0] as {id:number;name:string}|undefined;
      if (!item) throw new HttpError(404,"item_not_found","الصنف غير موجود في الشركة");
      const employee = (await client.query(
        "SELECT name FROM employees WHERE company_id=$1 AND user_id=$2 AND active",
        [companyId,user.id],
      )).rows[0] as {name:string}|undefined;
      const inserted = (await client.query(
        `INSERT INTO company_public_requests
         (company_id,item_id,item_name,request_date,created_by,created_by_name)
         VALUES ($1,$2,$3,(clock_timestamp() AT TIME ZONE 'Asia/Aden')::date,$4,$5)
         ON CONFLICT(company_id,item_id,request_date,created_by) DO NOTHING
         RETURNING id,request_date::text AS "requestDate"`,
        [companyId,itemId,item.name,user.id,employee?.name ?? user.displayName],
      )).rows[0] as {id:number;requestDate:string}|undefined;
      if (!inserted) return {added:false,pointsAwarded:"0"};
      const pointsAwarded = await awardPublicRequest(
        client,companyId,inserted.id,itemId,item.name,user);
      await audit(client,user,"public-request.create","public-request",inserted.id,
        null,{itemId,itemName:item.name,date:inserted.requestDate,pointsAwarded},companyId);
      return {added:true,requestId:inserted.id,pointsAwarded};
    });
    res.status(result.added?201:200).json(result);
  }));

  router.get(base, handler(async (req,res) => {
    const companyId = id(req.params.companyId);
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const page = req.query.page === undefined ? 1 : Number(req.query.page);
    if (q.length > 120 || !Number.isInteger(page) || page < 1 || page > 100000)
      throw new HttpError(400,"invalid_query","قيمة البحث أو الصفحة غير صحيحة");
    const result = await transaction(pool, async client => {
      await publicRequestAccess(client,req,companyId,"view");
      const pattern = "%"+q.replace(/[\\%_]/g,"\\$&")+"%";
      const params = [companyId,q,pattern];
      const where = `company_id=$1 AND ($2::text='' OR item_name ILIKE $3 OR created_by_name ILIKE $3)`;
      const total = (await client.query(
        `SELECT count(*)::integer AS total FROM company_public_requests WHERE ${where}`,params,
      )).rows[0].total as number;
      const rows = await client.query(
        `SELECT id,item_id AS "itemId",item_name AS "itemName",
          request_date::text AS "requestDate",created_by_name AS "createdByName",
          created_at AS "createdAt"
         FROM company_public_requests WHERE ${where}
         ORDER BY created_at DESC,id DESC LIMIT 100 OFFSET $4`,
        [...params,(page-1)*100],
      );
      return {items:rows.rows,total,page,pageSize:100};
    });
    res.setHeader("Cache-Control","private, no-store");
    res.json(result);
  }));
  return router;
}
