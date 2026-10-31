import { createHash, randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";
import { Router } from "express";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { transaction } from "./db.ts";
import { actor, handler, id, parse } from "./http.ts";
import { HttpError } from "./errors.ts";
import { companyAccess, currentActor, ownerOnly } from "./policies/access.ts";
import { assertRequestPagesEnabled } from "./services/pages.ts";
import { batchSchema } from "./routes-transaction-import-schemas.ts";

// The source is the owner's unchanged q.zip archive, SHA256
// 637b10170ee98eb59b37c1f5b3a67491075ae1477c3032b09cf759eb0171d6f2.
// Only its verified, normalized 172-invoice remainder can be prepared here.
// The original archive is not checked into Git or stored by this endpoint.
const EXPECTED_SHA = "c6f0a7ae681bd73a611d06bfbb3354c8b41c9ad7fd5bfd64b772bdbb0367419a";
const SOURCE = "dar-aldawa-legacy-2026-10";
const creatorNames = {
  R: "روان", H: "حمزة", A: "اية", O: "اسامة زيد",
  M: "مامون", W: "الواصلي", D: "عبدالله عثمان", L: "علي ابوطالب",
} as const;
const cashboxIds: Record<string, number> = {
  R: 2420, H: 2414, A: 2402, O: 2417, M: 2360, W: 2408, D: 2405,
};
type Creator = keyof typeof creatorNames;
type SourceLine = [string,string,string,string,string,string,string,string,string,string];
type SourceGroup = [string, Creator, "S" | "P", SourceLine[]];
const sourceLineSchema = z.tuple([
  z.string().regex(/^\d{7,12}$/),
  z.string().regex(/^\d{1,10}$/),
  z.string().regex(/^-?\d+(?:\.\d{1,6})?$/),
  z.string().regex(/^\d+(?:\.\d{1,6})?$/),
  z.string().regex(/^-?\d+(?:\.\d+)?$/),
  z.string().regex(/^\d*$/),
  z.string().max(100),
  z.string().max(100),
  z.string().max(60),
  z.string().max(60),
]);
const groupsSchema = z.array(z.tuple([
  z.string().regex(/^\d{15}$/), z.enum(["R","H","A","O","M","W","D","L"]),
  z.enum(["S","P"]), z.array(sourceLineSchema).min(1).max(200),
])).length(172);
const inputSchema = z.object({
  compressed: z.string().min(100).max(20000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  start: z.number().int().min(0).max(171),
  limit: z.number().int().min(1).max(25).default(20),
}).strict();

function conflict(message: string): never {
  throw new HttpError(409,"qzip_source_mismatch",message);
}
function uuidForSource(source: string) {
  const h = createHash("sha256").update("alraesy:qzip:2026-10:final:"+source).digest("hex");
  return h.slice(0,8)+"-"+h.slice(8,12)+"-4"+h.slice(13,16)+"-a"+h.slice(17,20)+"-"+h.slice(20,32);
}
function excelLocalTime(serial: string): string {
  const n=Number(serial);
  if(!Number.isFinite(n) || n<46323 || n>46327) conflict("تاريخ حركة مصدر غير صالح");
  const millis=Math.round(n*86400000);
  return new Date(Date.UTC(1899,11,30)+millis).toISOString().replace("Z","+03:00");
}
function readPinnedGroups(compressed: string): SourceGroup[] {
  let source: Buffer;
  try {
    source=inflateSync(Buffer.from(compressed,"base64"),{maxOutputLength:100_000});
  } catch {
    throw new HttpError(400,"invalid_qzip_payload","تعذر قراءة بيانات المصدر المضغوطة");
  }
  if(createHash("sha256").update(source).digest("hex")!==EXPECTED_SHA)
    conflict("الملف لا يطابق قائمة الفواتير الأصلية الـ172");
  const groups=groupsSchema.parse(JSON.parse(source.toString("utf8"))) as SourceGroup[];
  if(groups.length!==172 ||
    groups[0]![0]!=="261029105709020" ||
    groups[171]![0]!=="261030013159202" ||
    groups.filter(g=>g[2]==="S").length!==162 ||
    groups.filter(g=>g[2]==="P").length!==10 ||
    groups.reduce((n,g)=>n+g[3].length,0)!==523)
    conflict("عدد الفواتير أو الحركات لا يطابق أرشيف q.zip");
  const seen=new Set<string>(),movementIds=new Set<string>();
  for (const [sourceId,creator,kind,lines] of groups) {
    if(seen.has(sourceId)) conflict("رقم فاتورة مكرر داخل المصدر");
    seen.add(sourceId);
    if(!creatorNames[creator]) conflict("منشئ غير معروف في الملف");
    if(sourceId < "261029105709020" || sourceId > "261030013159202")
      conflict("فاتورة خارج النطاق المخول");
    if(!["261029","261030"].includes(sourceId.slice(0,6)))
      conflict("تاريخ غير مخول");
    for(const line of lines) {
      if(movementIds.has(line[0])) conflict("حركة صنف مكررة");
      movementIds.add(line[0]);
      if(line[2].startsWith("-")!==line[4].startsWith("-"))
        conflict("إشارة الكمية المحسوبة لا تطابق المصدر");
      if(Number(line[2])===0 || Number(line[4])===0 || Number(line[3])<0)
        conflict("كمية أو سعر غير صالح");
    }
    if(kind==="P" && lines.some(line=>!line[5]))
      conflict("مشتريات بلا معرف حساب المصدر");
  }
  return groups;
}

async function sourceMappings(client: PoolClient, groups: SourceGroup[]) {
  const itemLegacyIds=[...new Set(groups.flatMap(g=>g[3].map(l=>l[1])))];
  const items=await client.query<{id:number;legacy_id:string}>(
    "SELECT id,legacy_id FROM items WHERE company_id=2 AND legacy_id=ANY($1::text[])",
    [itemLegacyIds],
  );
  const itemMap=new Map(items.rows.map(x=>[x.legacy_id,x.id]));
  if(itemMap.size!==172 || itemLegacyIds.some(x=>!itemMap.has(x)))
    conflict("لم تُطابق جميع معرفات الأصناف الأصلية");
  const accountLegacyIds=[...new Set(groups.flatMap(g=>g[3].map(l=>l[5])).filter(Boolean))].map(Number);
  const accounts=await client.query<{legacy_id:number;account_id:number}>(
    "SELECT legacy_id,account_id FROM legacy_account_imports WHERE company_id=2 AND legacy_id=ANY($1::integer[])",
    [accountLegacyIds],
  );
  const accountMap=new Map(accounts.rows.map(x=>[String(x.legacy_id),x.account_id]));
  // Imported new account from the same q.zip file (not part of older mappings).
  if(accountMap.has("7949")) {
    if(accountMap.get("7949")!==2428) conflict("خريطة حساب المصدر 7949 غير متوقعة");
  } else {
    const extra=await client.query(
      "SELECT id FROM accounts WHERE company_id=2 AND id=2428 AND name='مصعب / مشتريات جديد' AND active AND kind='posting'"
    );
    if(extra.rowCount!==1) conflict("حساب مشتريات المصدر 7949 لم يعد مطابقًا");
    accountMap.set("7949",2428);
  }
  if(accountLegacyIds.some(x=>!accountMap.has(String(x))))
    conflict("تعذر تعيين أحد الحسابات من معرف النظام السابق");
  const cash=await client.query<{id:number;name:string;active:boolean;cash_or_bank:boolean}>(
    "SELECT id,name,active,cash_or_bank FROM accounts WHERE company_id=2 AND id=ANY($1::integer[])",
    [Object.values(cashboxIds).concat([338])],
  );
  const byId=new Map(cash.rows.map(x=>[x.id,x]));
  for (const [key,accountId] of Object.entries(cashboxIds)) {
    const row=byId.get(accountId);
    if(!row?.active || !row.cash_or_bank || !row.name.includes(creatorNames[key as Creator]) ||
       !row.name.includes("صندوق مبيعات")) conflict("صندوق مبيعات منشئ المصدر غير مطابق");
  }
  if(!byId.get(338)?.active || !byId.get(338)?.cash_or_bank)
    conflict("صندوق مشتريات السوق غير فعال");
  return {itemMap,accountMap};
}

export function qzipRemainingRoutes(pool: Pool): Router {
  const router=Router();
  router.post("/companies/:companyId/transaction-import/prepare-qzip-172",
    handler(async (req,res) => {
      const companyId=id(req.params.companyId);
      if(companyId!==2) throw new HttpError(404,"not_found","هذا المسار خاص بدفعة دار الدواء");
      const input=parse(inputSchema,req.body);
      // Decode and verify only a pinned source; no database writes.
      const groups=readPinnedGroups(input.compressed);
      const result=await transaction(pool,async client=>{
        await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const user=await currentActor(client,actor(req),false);
        ownerOnly(user);
        if(user.suspended)throw new HttpError(403,"forbidden","الحساب موقوف");
        await companyAccess(client,user,2);
        await assertRequestPagesEnabled(client,req);
        const {itemMap,accountMap}=await sourceMappings(client,groups);
        const page=groups.slice(input.start,input.start+input.limit);
        const ids=page.map(g=>g[0]);
        const previous=await client.query<{source_id:string;invoice_id:number}>(
          "SELECT source_id,invoice_id FROM transaction_source_imports WHERE company_id=2 AND source_system=$1 AND source_kind='invoice' AND source_id=ANY($2::text[])",
          [SOURCE,ids],
        );
        const staged=await client.query<{source_id:string}>(
          "SELECT source_id FROM legacy_import_staging WHERE company_id=2 AND source_system=$1 AND source_kind='invoice' AND source_id=ANY($2::text[])",
          [SOURCE,ids],
        );
        const imported=new Set(previous.rows.map(x=>x.source_id));
        const initial=new Set(staged.rows.map(x=>x.source_id));
        const documents=[];
        for(const [sourceId,creator,kind,lines] of page) {
          if(imported.has(sourceId) || initial.has(sourceId))continue;
          const type=kind==="S"?"sale":"purchase";
          const legacyAccounts=[...new Set(lines.map(l=>l[5]).filter(Boolean))];
          if(legacyAccounts.length>1) conflict("فاتورة لها أكثر من معرف حساب");
          const account=legacyAccounts[0] ? accountMap.get(legacyAccounts[0]) : null;
          if(type==="purchase" && !account) conflict("لا يوجد المورد الأصلي للمشتريات");
          const date="2026-"+sourceId.slice(2,4)+"-"+sourceId.slice(4,6);
          const creatorName=creatorNames[creator];
          const document={
            type:"invoice" as const,
            sourceId,
            sourceDocumentNumber:sourceId,
            sourceCreatedAt:excelLocalTime(lines[0]![8]),
            sourceCreators:[creatorName],
            sourceMovementIds:lines.map(l=>l[0]),
            sourceRows:lines.map(l=>({
              "__source_file":"ح.xlsx","__source_timezone":"Asia/Aden",
              "معرف_حركة_الاصناف_م":l[0],
              "معرف_الصنف":l[1],
              "الكمية_المحسوبة_اخيرا":l[4],
              "تكلفة_الوحده_المحسوبه":l[3],
              "نوع_العمليه":type==="sale"?"فاتورة مبيعات":"فاتورة مشتريات",
              "معرف_الحساب":l[5],"رقم_الحساب":l[6],
              "صندوق_الحساب_معرف":l[7],
              "الانشاء_بدون_تعديل":l[8],
              "المنشى_بدون_تعديل":creatorName,
              "رقم_السند":sourceId,"رقم_الوصل":l[9],
              "ملاحظات_الخصم":"",
            })),
            payload:{
              idempotencyKey:uuidForSource(sourceId),
              kind:type,documentDate:date,currencyId:7,branchId:2,locationId:2,
              counterpartyAccountId:type==="sale"?(account??cashboxIds[creator]!):338,
              supplierAccountId:type==="purchase"?account:null,
              supplierReceiptNumber:"",
              description:"ترحيل تاريخي نهائي من q.zip | المصدر "+SOURCE+
                " | رقم المصدر "+sourceId+" | المنشئ "+creatorName,
              discount:"0",doctorId:null,doctorName:"",
              saleCustomerNumber:"",saleCustomerName:"",
              lines:lines.map(l=>({
                itemId:itemMap.get(l[1])!,unit:1 as const,
                quantity:l[2],unitPrice:l[3],expiryDate:null,originalLineId:null,
              })),
            },
          };
          documents.push(document);
        }
        if(!documents.length)return {
          start:input.start,requested:page.length,alreadyPosted:imported.size,
          alreadyStaged:initial.size,batch:null,
        };
        const batch=batchSchema.parse({
          idempotencyKey:randomUUID(),sourceSystem:SOURCE,
          postingDate:documents[0]!.payload.documentDate,
          preserveDocumentDates:true,documents,
        });
        return { start:input.start,requested:page.length,
          alreadyPosted:imported.size,alreadyStaged:initial.size,batch };
      });
      res.setHeader("Cache-Control","private, no-store");
      res.json(result);
    }));
  return router;
}
