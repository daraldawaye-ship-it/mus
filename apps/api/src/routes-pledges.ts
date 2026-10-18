import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { accountDTO, accountSelect } from "./repositories/masters.ts";
import { transaction } from "./db.ts";
import { actor, handler, id, parse } from "./http.ts";
import { currentActor, companyAccess } from "./policies/access.ts";
import { HttpError, missing } from "./errors.ts";
import { audit } from "./services/audit.ts";
import { normalizeDigits } from "../../../packages/contracts/src/masters.ts";
import { searchPattern } from "./services/lists.ts";

const pledgeSchema = z.object({
  idempotencyKey: z.uuid(),
  customerName: z.string().trim().min(1).max(120),
  phone: z.string().trim().transform(normalizeDigits).pipe(z.string().regex(/^\+?[0-9]{3,20}$/)),
  collateral: z.string().trim().min(1).max(160),
  durationDays: z.number().int().min(1).max(36500),
  limit: z.string().trim().transform(normalizeDigits)
    .pipe(z.string().regex(/^\d{1,22}(?:\.\d{1,6})?$/)),
}).strict();

export function pledgeRoutes(pool: Pool): Router {
  const router = Router();
  const base = "/companies/:companyId/pledges";

  router.get(base, handler(async (req, res) => {
    const companyId = id(req.params.companyId);
    const result = await transaction(pool, async (client) => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const user = await currentActor(client, actor(req), false);
      await companyAccess(client, user, companyId, "commerce.view");
      const q = searchPattern(typeof req.query.q === "string" ? req.query.q.slice(0,120) : "");
      const list = await client.query(
        `SELECT p.account_id,a.code,a.name,a.account_limit::text AS account_limit,
         p.customer_name,p.phone,p.collateral,p.duration_days,p.received_by_name,p.created_at
         FROM account_pledges p
         JOIN accounts a ON a.company_id=p.company_id AND a.id=p.account_id
         WHERE p.company_id=$1 AND
         (p.customer_name ILIKE $2 OR p.phone ILIKE $2 OR p.collateral ILIKE $2 OR a.name ILIKE $2 OR a.code ILIKE $2)
         ORDER BY p.created_at DESC,p.account_id DESC LIMIT 100`,
        [companyId,q]
      );
      return list.rows.map(row => ({
        accountId: row.account_id, code: row.code, name: row.name,
        limit: row.account_limit, customerName: row.customer_name,
        phone: row.phone, collateral: row.collateral,
        durationDays: row.duration_days, receivedBy: row.received_by_name,
        createdAt: row.created_at,
      }));
    });
    res.json({items:result});
  }));

  router.post(base, handler(async (req, res) => {
    const input = parse(pledgeSchema,req.body);
    const companyId = id(req.params.companyId);
    const result = await transaction(pool, async (client) => {
      const user = await currentActor(client, actor(req));
      await companyAccess(client,user,companyId,"commerce.manage",true);
      // Locking the company serializes account-code allocation and wallet posting.
      const payload = {
        customerName:input.customerName,phone:input.phone,collateral:input.collateral,
        durationDays:input.durationDays,limit:input.limit,
      };
      const existing = await client.query(
        "SELECT account_id,request_payload FROM account_pledges WHERE company_id=$1 AND idempotency_key=$2",
        [companyId,input.idempotencyKey]
      );
      if (existing.rows[0]) {
        if (JSON.stringify(existing.rows[0].request_payload) !== JSON.stringify(payload))
          throw new HttpError(409,"idempotency_conflict","مفتاح الطلب مستخدم لبيانات مختلفة");
        const account = await client.query(`${accountSelect} WHERE a.company_id=$1 AND a.id=$2`,
          [companyId,existing.rows[0].account_id]);
        return {account:accountDTO(account.rows[0]),awardedPoints:50,replayed:true};
      }
      const parent = await client.query(
        "SELECT id FROM accounts WHERE company_id=$1 AND code='1120000000' AND kind='group' AND category='asset' AND active=true",
        [companyId]
      );
      if (!parent.rows[0])
        throw new HttpError(409,"missing_parent","يرجى إنشاء مجموعة العملاء 1120 في الدليل أولًا");
      const max = await client.query(
        "SELECT max(code) AS code FROM accounts WHERE company_id=$1 AND code BETWEEN '1120000001' AND '1120999999'",
        [companyId]
      );
      const next = max.rows[0].code === null ? 1120000001n : BigInt(max.rows[0].code)+1n;
      if (next > 1120999999n)
        throw new HttpError(409,"code_exhausted","نفد نطاق ترقيم الرهونات 1120");
      const code = next.toString();
      const name = `الرهونات - ${input.customerName}_ت/${input.phone}_الرهن/${input.collateral}_المدة/${input.durationDays}_بواسطة/${user.displayName}_(معدل)`;
      if (name.length > 500)
        throw new HttpError(400,"label_too_long","وصف الرهن طويل جدًا");
      const created = await client.query(
        `INSERT INTO accounts(company_id,code,name,parent_id,kind,category,normal_side,active,
           created_by,cash_or_bank,account_choice,account_limit,owner_phone)
         VALUES($1,$2,$3,$4,'posting','asset','debit',true,$5,false,'pledges',$6,$7)
         RETURNING id`,
        [companyId,code,name,parent.rows[0].id,user.id,input.limit,input.phone]
      );
      const accountId = created.rows[0].id as number;
      await client.query(
        `INSERT INTO account_pledges(company_id,account_id,idempotency_key,request_payload,customer_name,
           phone,collateral,duration_days,received_by,received_by_name)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [companyId,accountId,input.idempotencyKey,JSON.stringify(payload),
         input.customerName,input.phone,input.collateral,input.durationDays,user.id,user.displayName]
      );
      await client.query(
        `INSERT INTO option_values(company_id,definition_id,record_kind,account_id,value,created_by,updated_by)
         SELECT company_id,id,'account',$2,default_value,$3,$3 FROM option_definitions
         WHERE company_id=$1 AND record_kind='account' AND active=true AND native_binding IS NULL
           AND default_value <> 'null'::jsonb`,
        [companyId,accountId,user.id]
      );
      const employee = await client.query(
        "SELECT id,name FROM employees WHERE company_id=$1 AND user_id=$2 AND active=true",
        [companyId,user.id]
      );
      let awardedPoints=0;
      if(employee.rows[0]) {
        await client.query(
          `INSERT INTO employee_wallet_entries(company_id,employee_id,employee_name,kind,points,reason,
            pledge_account_id,task_code,task_revision,logical_line_count,idempotency_key,
            request_payload,created_by,created_by_name)
          VALUES($1,$2,$3,'automatic',50,$4,$5,'PLEDGE_CREATED',1,1,$6,$7,$8,$9)`,
          [companyId,employee.rows[0].id,employee.rows[0].name,
           `مكافأة إضافة رهن للحساب ${code}`,accountId,randomUUID(),
           JSON.stringify({source:"pledge-created",accountId}),user.id,user.displayName]
        );
        awardedPoints=50;
      }
      const account = await client.query(
        `${accountSelect} WHERE a.company_id=$1 AND a.id=$2`,[companyId,accountId]
      );
      await audit(client,user,"pledge.create","account",accountId,null,
        {account:accountDTO(account.rows[0]),pledge:payload,awardedPoints},companyId);
      return {account:accountDTO(account.rows[0]),awardedPoints,replayed:false};
    });
    res.status(result.replayed?200:201).json(result);
  }));
  return router;
}
