import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { itemSchema } from "../../../packages/contracts/src/index.ts";
import { handler, parse } from "./http.ts";
import { HttpError } from "./errors.ts";
import { itemFieldColumns } from "./services/items.ts";
import { mutateMaster } from "./services/masters.ts";

/** The source file remains in the browser; batches go directly to the authorized
 * company over same-origin authenticated HTTPS. No private item catalog in Git. */
const bodySchema=z.object({
  format:z.literal("tijara-items-v1"),
  companyHint:z.string().min(3).max(200),
  currency:z.literal("YER"),
  items:z.array(z.unknown()).min(1).max(100),
}).strict();
const simplified=(s:string)=>s.normalize("NFKC")
  .replace(/[\s\u0640]/g,"").replace(/[أإآ]/g,"ا").toLowerCase();

export function itemImportRoutes(pool:Pool):Router{
  const router=Router();
  router.post("/companies/:companyId/items/import-batch",handler(async(req,res)=>{
    const body=parse(bodySchema,req.body);
    const result=await mutateMaster(pool,req,"items.manage",async(client,user,companyId)=>{
      const company=await client.query("SELECT name FROM companies WHERE id=$1",[companyId]);
      const expected=simplified(body.companyHint),actual=simplified(String(company.rows[0]?.name??""));
      const samePharmacy=expected.includes("دارالدواء")&&actual.includes("دارالدواء");
      if(!samePharmacy && expected!==actual)
        throw new HttpError(409,"wrong_company","اسم الشركة المحددة لا يطابق الشركة المذكورة في الملف. أوقف الاستيراد واختر الشركة الصحيحة.");
      const currency=(await client.query(
        "SELECT id FROM company_currencies WHERE company_id=$1 AND code='YER' AND active=true",
        [companyId],
      )).rows[0];
      if(!currency)throw new HttpError(409,"currency_missing","يجب أن يكون الريال اليمني فعالًا في هذه الشركة قبل استيراد الأصناف.");
      const parsedRows: z.output<typeof itemSchema>[]=[];
      const seen=new Set<string>();
      for(let i=0;i<body.items.length;i++){
        const row=body.items[i];
        if(!row || typeof row!=="object" || Array.isArray(row))
          throw new HttpError(400,"import_invalid",`بيانات الصنف ${i+1} غير صحيحة.`);
        const data=itemSchema.safeParse({
          ...row,currencyId:currency.id,agentId:null,idempotencyKey:randomUUID(),
        });
        if(!data.success)
          throw new HttpError(400,"import_invalid",
            `الصنف ${i+1}: ${data.error.issues[0]?.message??"بيانات غير صحيحة"}`);
        const old=data.data.legacyId;
        if(!/^\d{1,100}$/.test(old))
          throw new HttpError(400,"import_invalid",`الصنف ${i+1}: المعرف في النظام السابق مطلوب ويجب أن يكون رقميًا.`);
        if(seen.has(old))throw new HttpError(400,"import_duplicate",`المعرف القديم ${old} مكرر في الدفعة.`);
        seen.add(old);
        parsedRows.push(data.data);
      }
      const existing=await client.query(
        "SELECT legacy_id FROM items WHERE company_id=$1 AND legacy_id=ANY($2::text[])",
        [companyId,[...seen]],
      );
      const occupied=new Set<string>(existing.rows.map(row=>String(row.legacy_id)));
      const fresh=parsedRows.filter(row=>!occupied.has(row.legacyId));
      if(!fresh.length)return {created:0,skipped:parsedRows.length};
      await client.query("INSERT INTO item_counters(company_id) VALUES($1) ON CONFLICT(company_id) DO NOTHING",[companyId]);
      const reserved=await client.query(
        "UPDATE item_counters SET next_number=next_number+$2 WHERE company_id=$1 AND next_number+$2<=100000000 RETURNING next_number-$2 AS first",
        [companyId,fresh.length],
      );
      if(!reserved.rows[0])throw new HttpError(409,"item_code_exhausted","نفدت رموز الأصناف المتاحة.");
      const first=BigInt(reserved.rows[0].first);
      const columns=["company_id","code",...itemFieldColumns.map(([,column])=>column),
        "created_by","idempotency_key","creation_payload"];
      const args:unknown[]=[],placeholders:string[]=[];
      for(let i=0;i<fresh.length;i++){
        const row=fresh[i]!;
        const values:unknown[]=[
          companyId,(first+BigInt(i)).toString().padStart(8,"0"),
          ...itemFieldColumns.map(([field])=>row[field]),
          user.id,row.idempotencyKey,JSON.stringify(row),
        ];
        const start=args.length;args.push(...values);
        placeholders.push("("+values.map((_,j)=>"$"+(start+j+1)).join(",")+")");
      }
      const created=await client.query(
        `INSERT INTO items(${columns.join(",")}) VALUES ${placeholders.join(",")} RETURNING id`,args,
      );
      const ids=created.rows.map(row=>row.id as number);
      await client.query(
        `INSERT INTO option_values(company_id,definition_id,record_kind,item_id,value,created_by,updated_by)
         SELECT opt.company_id,opt.id,'item',new_items.id,opt.default_value,$3,$3
         FROM option_definitions opt CROSS JOIN items new_items
         WHERE opt.company_id=$1 AND new_items.company_id=$1 AND new_items.id=ANY($2::integer[])
           AND opt.record_kind='item' AND opt.active=true AND opt.native_binding IS NULL
           AND opt.default_value <> 'null'::jsonb`,
        [companyId,ids,user.id],
      );
      await client.query(
        `INSERT INTO audit_events(actor_id,actor_name,scope,company_id,action,target_type,target_id,before_value,after_value)
         SELECT $2,$3,'company',$1,'item.create','item',i.id,NULL,to_jsonb(i)
         FROM items i WHERE i.company_id=$1 AND i.id=ANY($4::integer[])`,
        [companyId,user.id,user.displayName,ids],
      );
      return {created:ids.length,skipped:parsedRows.length-ids.length};
    });
    res.status(200).json(result);
  }));
  return router;
}
