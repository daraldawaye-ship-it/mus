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
import { insertDraft, postDraft, readAccountLedger } from "./routes-finance.ts";
import { checkDocumentReferences, findIdempotent, loadDocument, moneyUnits } from "./services/finance.ts";
import { assertEditableDocumentDate, assertYerWhenCurrencyHidden } from "./services/control-values.ts";
import { financialDocumentSchema } from "../../../packages/contracts/src/index.ts";

const pledgeSchema = z.object({
  idempotencyKey: z.uuid(),
  customerName: z.string().trim().min(1).max(120),
  phone: z.string().trim().transform(normalizeDigits).pipe(z.string().regex(/^\+?[0-9]{3,20}$/)),
  collateral: z.string().trim().min(1).max(160),
  durationDays: z.number().int().min(1).max(36500),
  limit: z.string().trim().transform(normalizeDigits)
    .pipe(z.string().regex(/^\d{1,22}(?:\.\d{1,6})?$/)),
}).strict();

/** Narrow, atomic cashier-only pledge movement.
 * Does not grant finance.manage or unrestricted voucher creation. */
export const pledgeCashTransferSchema = z.object({
  idempotencyKey: z.uuid(),
  mode: z.enum(["pay", "receive"]),
  amount: z.string().trim().transform(normalizeDigits)
    .pipe(z.string().regex(/^\d{1,22}(?:\.\d{1,6})?$/,"المبلغ يجب أن يكون رقمًا موجبًا حتى 22 رقمًا و6 خانات كسرية")),
  notes: z.string().trim().max(400).default(""),
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
         p.customer_name,p.phone,p.collateral,p.duration_days,p.received_by_name,p.created_at,
         COALESCE(ledger.balance,0)::text AS balance
         FROM account_pledges p
         JOIN accounts a ON a.company_id=p.company_id AND a.id=p.account_id
         LEFT JOIN LATERAL (
           SELECT sum(l.base_debit-l.base_credit) AS balance
           FROM financial_document_lines l
           JOIN financial_documents d ON d.company_id=l.company_id AND d.id=l.document_id
           WHERE l.company_id=p.company_id AND l.account_id=p.account_id AND d.status<>'draft'
         ) ledger ON true
         WHERE p.company_id=$1 AND
         (p.customer_name ILIKE $2 OR p.phone ILIKE $2 OR p.collateral ILIKE $2 OR a.name ILIKE $2 OR a.code ILIKE $2)
         ORDER BY p.created_at DESC,p.account_id DESC LIMIT 100`,
        [companyId,q]
      );
      return list.rows.map(row => ({
        accountId: row.account_id, code: row.code, name: row.name,
        limit: row.account_limit, balance: row.balance, customerName: row.customer_name,
        phone: row.phone, collateral: row.collateral,
        durationDays: row.duration_days, receivedBy: row.received_by_name,
        createdAt: row.created_at,
      }));
    });
    res.json({items:result});
  }));

  // A pledge holder may inspect ONLY this pledged account, not the general ledger.
  router.get(base + "/:accountId/ledger", handler(async (req, res) => {
    const companyId = id(req.params.companyId), accountId = id(req.params.accountId);
    const result = await transaction(pool, async (client) => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const user = await currentActor(client, actor(req), false);
      await companyAccess(client, user, companyId, "commerce.view");
      const owned = await client.query(
        "SELECT 1 FROM account_pledges WHERE company_id=$1 AND account_id=$2",
        [companyId, accountId]
      );
      if (!owned.rowCount) missing("حساب الرهن غير موجود");
      return readAccountLedger(client, companyId, accountId, req);
    });
    res.json(result);
  }));

  // For a salesperson, finance.post + commerce.manage authorizes ONLY a
  // movement between their own linked sales cashbox and an existing pledge.
  // Never expose the general financial-documents:create endpoint via this grant.
  router.post(base + "/:accountId/transfer", handler(async (req, res) => {
    const companyId=id(req.params.companyId),pledgeAccountId=id(req.params.accountId);
    const input=parse(pledgeCashTransferSchema,req.body);
    if(moneyUnits(input.amount)<=0n)
      throw new HttpError(400,"invalid_amount","مبلغ حركة الرهن يجب أن يكون موجبًا");
    const result=await transaction(pool,async(client)=>{
      const user=await currentActor(client,actor(req));
      const context=await companyAccess(client,user,companyId,"commerce.manage",true);
      await companyAccess(client,user,companyId,"finance.post",true);
      if(!context.general && !context.employee?.positions.includes("sales"))
        throw new HttpError(403,"forbidden","هذه العملية مخصصة لموظفي المبيعات المخولين");
      if(!context.employee)
        throw new HttpError(403,"missing_employee","يلزم وجود موظف نشط وصندوق مبيعات مرتبط به");

      // The request payload is stable across retries, even after midnight.
      // The entire draft+post happens atomically: no orphan drafts on failure.
      const payload={operation:"sales-pledge-transfer",
        pledgeAccountId,mode:input.mode,amount:input.amount,notes:input.notes};
      const previous=await findIdempotent(client,companyId,input.idempotencyKey,payload);
      if(previous){
        if(previous.status!=="posted")
          throw new HttpError(409,"not_posted","السند السابق لم يكتمل ترحيله");
        return {document:await loadDocument(client,companyId,previous.id),replayed:true};
      }

      const pledge=await client.query(
        `SELECT p.customer_name,a.code FROM account_pledges p
         JOIN accounts a ON a.company_id=p.company_id AND a.id=p.account_id
         WHERE p.company_id=$1 AND p.account_id=$2 AND a.active=true AND a.kind='posting'
           AND a.account_choice='pledges' FOR SHARE OF p,a`,
        [companyId,pledgeAccountId],
      );
      if(!pledge.rows[0])
        throw new HttpError(404,"pledge_missing","الرهن غير موجود أو غير فعال");

      const cash=await client.query(
        `SELECT a.id FROM employee_account_links l
         JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id
         WHERE l.company_id=$1 AND l.employee_id=$2 AND l.account_kind='sales_cash'
           AND a.active=true AND a.kind='posting' AND a.cash_or_bank=true
           AND a.category='asset' ORDER BY a.id LIMIT 1`,
        [companyId,context.employee.id],
      );
      const cashId=cash.rows[0]?.id as number|undefined;
      if(!cashId)
        throw new HttpError(409,"missing_cashbox","صندوق مبيعات الموظف غير محدد");
      if(cashId===pledgeAccountId)
        throw new HttpError(400,"same_account","لا يمكن تحويل الرهن إلى صندوقه نفسه");

      const currency=await client.query(
        "SELECT id FROM company_currencies WHERE company_id=$1 AND code='YER' AND active=true ORDER BY id LIMIT 1",
        [companyId],
      );
      if(!currency.rows[0])
        throw new HttpError(409,"missing_yer","عملة الريال اليمني غير متاحة");
      const day=await client.query<{today:string}>(
        "SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Aden')::date::text AS today",
      );
      const kind=input.mode==="pay"?"payment":"receipt";
      const memo=(input.mode==="pay"?"صرف مبلغ لرهن: ":"استلام مبلغ من رهن: ")+
        pledge.rows[0].customer_name+(input.notes?" — "+input.notes:"");
      const description=memo.slice(0,1000);
      const lineDescription=memo.slice(0,500);
      const document=parse(financialDocumentSchema,{
        idempotencyKey:input.idempotencyKey,
        kind,documentDate:day.rows[0].today,currencyId:currency.rows[0].id,
        branchId:null,cashAccountId:cashId,supplierReceiptNumber:"",description,
        lines:[
          {accountId:cashId,debit:kind==="receipt"?input.amount:"0",
            credit:kind==="payment"?input.amount:"0",description:lineDescription},
          {accountId:pledgeAccountId,debit:kind==="payment"?input.amount:"0",
            credit:kind==="receipt"?input.amount:"0",description:lineDescription},
        ],
      });
      await assertEditableDocumentDate(client,companyId,
        kind==="receipt"?"edit_receipts_date":"edit_payments_date",document.documentDate);
      await assertYerWhenCurrencyHidden(client,companyId,document.currencyId);
      await checkDocumentReferences(client,companyId,document);
      const documentId=await insertDraft(client,companyId,user,document,input.idempotencyKey,payload);
      const draft=await loadDocument(client,companyId,documentId);
      await audit(client,user,"financialDocument.create","financialDocument",
        documentId,null,draft,companyId);
      await postDraft(client,companyId,documentId,user);
      const posted=await loadDocument(client,companyId,documentId);
      await audit(client,user,"financialDocument.post","financialDocument",
        documentId,draft,posted,companyId);
      return {document:posted,replayed:false};
    });
    res.status(result.replayed?200:201).json({document:result.document});
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
        if (Object.entries(payload).some(([key,value]) => String(existing.rows[0].request_payload[key]) !== String(value)))
          throw new HttpError(409,"idempotency_conflict","مفتاح الطلب مستخدم لبيانات مختلفة");
        const account = await client.query(`${accountSelect} WHERE a.company_id=$1 AND a.id=$2`,
          [companyId,existing.rows[0].account_id]);
        const reward = await client.query(
          "SELECT 1 FROM employee_wallet_entries WHERE company_id=$1 AND pledge_account_id=$2 LIMIT 1",
          [companyId,existing.rows[0].account_id]
        );
        return {account:accountDTO(account.rows[0]),awardedPoints:reward.rowCount?50:0,replayed:true};
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
      await audit(client,user,"account.create","pledge-account",accountId,null,
        {account:accountDTO(account.rows[0]),pledge:payload,awardedPoints},companyId);
      return {account:accountDTO(account.rows[0]),awardedPoints,replayed:false};
    });
    res.status(result.replayed?200:201).json(result);
  }));
  return router;
}
