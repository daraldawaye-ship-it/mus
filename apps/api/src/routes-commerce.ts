import { Router, type Request } from "express";
import { z } from "zod";
import type { Pool, PoolClient } from "pg";
import {
  documentDateSchema,
  invoiceKinds,
  invoiceSchema,
} from "../../../packages/contracts/src/index.ts";
import { transaction } from "./db.ts";
import { HttpError } from "./errors.ts";
import { actor, handler, id, parse } from "./http.ts";
import { companyAccess, currentActor } from "./policies/access.ts";
import {
  createInvoice,
  invoiceDTOs,
  invoiceFrom,
  invoiceSelect,
  loadInvoice,
} from "./services/commerce.ts";
import { listQuery, searchPattern } from "./services/lists.ts";
import { mutateMaster } from "./services/masters.ts";
import {matchingMemoFeatureRules} from "./services/memo-feature-rules.ts";
import {audit} from "./services/audit.ts";
import { cashboxOperationSchema, postEmployeeCashboxOperation } from "./services/cashbox-operations.ts";
import { pouchReceiptSchema, receivePouchMovement, listPouchReceipts } from "./services/pouch-receipts.ts";
import { electronicReceiptSchema, receiveElectronicMovement, listElectronicReceipts } from "./services/electronic-receipts.ts";
import { assertEditableDocumentDate, assertMobileInvoiceCreation, assertYerWhenCurrencyHidden, controlValue } from "./services/control-values.ts";

async function readCommerce<T>(
  pool: Pool,
  req: Request,
  action: (client: PoolClient, companyId: number) => Promise<T>,
): Promise<T> {
  return transaction(pool, async (client) => {
    await client.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    const companyId = id(req.params.companyId),
      user = await currentActor(client, actor(req), false);
    await companyAccess(client, user, companyId, "commerce.view");
    return action(client, companyId);
  });
}
export function commerceRoutes(pool: Pool): Router {
  const router = Router(),
    base = "/companies/:companyId";
  // Small, read-only and indexed lookup, only when the cashier selects
  // a sale item. No synchronous work in invoice line typing/focus transitions.
  router.get(
    `${base}/sales-item-alerts/:itemId`,
    handler(async(req,res)=>{
      const itemId=id(req.params.itemId);
      const result=await readCommerce(pool,req,async(client,companyId)=>{
        const item=(await client.query(
          `SELECT i.id,i.sale_notes AS "saleNotes",i.composition_id AS "compositionId",
             COALESCE(c.sale_notes,'') AS "compositionSaleNotes",
             COALESCE(c.arabic_name,'') AS "compositionName",
             (COALESCE(c.identical_alternative,false) AND NOT COALESCE(c.non_interchangeable,false)) AS "identicalAlternative"
           FROM items i LEFT JOIN item_compositions c
             ON c.company_id=i.company_id AND c.id=i.composition_id
           WHERE i.company_id=$1 AND i.id=$2`,
          [companyId,itemId],
        )).rows[0];
        if(!item)throw new HttpError(404,"not_found","الصنف غير موجود في هذه الشركة");
        if(!item.compositionId)return {saleNotes:item.saleNotes,
          compositionSaleNotes:"",compositionName:"",identicalAlternative:false,alternatives:[]};
        const threshold=await controlValue(client,companyId,"sales_near_expiry_months");
        const limit=typeof threshold==="number"?threshold:3;
        const rows=await client.query(
          `SELECT i.id,i.name,
             i.commission_rate::text AS "clearanceRate",
             i.nearest_expiry_date::text AS "nearestExpiryDate",
             (i.commission_rate>0 AND i.clearance_from<=
               (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date
               AND i.clearance_to>=
               (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date)
               AS clearance,
             (i.has_expiry AND $4::integer>0 AND
               i.nearest_expiry_date IS NOT NULL AND
               i.nearest_expiry_date <=
               ((clock_timestamp() AT TIME ZONE 'Asia/Aden')::date +
                 make_interval(months=>$4::integer))::date)
               AS "nearExpiry"
           FROM items i
           WHERE i.company_id=$1 AND i.composition_id=$2
             AND i.id<>$3 AND i.active=true AND
             ((i.commission_rate>0 AND i.clearance_from<=
                 (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date
                 AND i.clearance_to>=
                 (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date)
              OR ($4::integer>0 AND i.has_expiry AND
                  i.nearest_expiry_date IS NOT NULL AND
                  i.nearest_expiry_date<=
                   ((clock_timestamp() AT TIME ZONE 'Asia/Aden')::date+
                    make_interval(months=>$4::integer))::date))
           ORDER BY i.nearest_expiry_date ASC NULLS LAST,i.id
           LIMIT 15`,
          [companyId,item.compositionId,itemId,limit],
        );
        return {saleNotes:item.saleNotes,
          compositionSaleNotes:item.compositionSaleNotes,
          compositionName:item.compositionName,
          identicalAlternative:item.identicalAlternative,
          alternatives:rows.rows};
      });
      res.json(result);
    }),
  );
  router.get(
    `${base}/purchase-history/:itemId`,
    handler(async (req, res) => {
      const itemId = id(req.params.itemId);
      const items = await readCommerce(pool, req, async (client, companyId) => {
        const found = await client.query(
          "SELECT 1 FROM items WHERE company_id=$1 AND id=$2",
          [companyId, itemId],
        );
        if (!found.rowCount)
          throw new HttpError(404, "not_found", "الصنف غير موجود لهذه الشركة.");
        const result = await client.query(
          `SELECT il.id AS "lineId", i.id AS "invoiceId",
             i.document_date::text AS "documentDate",
             COALESCE(NULLIF(i.supplier_account_name,''),'غير محدد') AS "supplierName",
             round(il.smallest_quantity::numeric /
               (il.factor2::numeric * il.factor3::numeric), 3)::text AS "quantityFirstUnit"
           FROM invoice_lines il
           JOIN invoices i ON i.company_id=il.company_id AND i.id=il.invoice_id
           WHERE il.company_id=$1 AND il.item_id=$2
             AND i.kind='purchase' AND il.smallest_quantity>0
           ORDER BY i.document_date DESC,i.id DESC,il.line_number DESC
           LIMIT 5`,
          [companyId, itemId],
        );
        return result.rows;
      });
      res.json({ items });
    }),
  );
  // Compact read-only history for the invoice item sidebar. The type is allowlisted
  // and inventory operations additionally require permission to view inventory.
  router.get(
    `${base}/item-history/:itemId`,
    handler(async (req, res) => {
      const itemId = id(req.params.itemId);
      const type = req.query.type;
      const pageRaw = req.query.page;
      const pageSizeRaw = req.query.pageSize;
      const page = pageRaw === undefined ? 1 :
        typeof pageRaw === "string" && /^[1-9][0-9]{0,5}$/.test(pageRaw) ? Number(pageRaw) : 0;
      const pageSize = pageSizeRaw === undefined ? 5 :
        pageSizeRaw === "10" ? 10 : pageSizeRaw === "5" ? 5 : 0;
      if (page < 1 || pageSize === 0)
        throw new HttpError(400, "invalid_query", "صفحة حركات الصنف غير صالحة.");
      if (type !== "purchase" && type !== "sale" &&
          type !== "adjustment" && type !== "transfer")
        throw new HttpError(400, "invalid_query", "نوع تاريخ الصنف غير صالح.");
      const items = await readCommerce(pool, req, async (client, companyId) => {
        const found = await client.query(
          "SELECT 1 FROM items WHERE company_id=$1 AND id=$2",
          [companyId, itemId],
        );
        if (!found.rowCount)
          throw new HttpError(404, "not_found", "الصنف غير موجود لهذه الشركة.");
        if (type === "purchase" || type === "sale") {
          // Each side of the history is independently bounded BEFORE unioning.
          // Posted dates come from the incrementally maintained daily activity;
          // staged lines use their own indexed, incrementally maintained source cache.
          const result = await client.query(
            `SELECT "lineId","documentId","documentDate","partyName",
                 "quantityFirstUnit","unitPriceFirstUnit","currencyCode","isStaged"
             FROM (
               SELECT il.id::text AS "lineId",i.id::text AS "documentId",
                 i.document_date::text AS "documentDate",
                 CASE WHEN i.kind='purchase'
                   THEN COALESCE(NULLIF(i.supplier_account_name,''),'غير محدد')
                   ELSE COALESCE(NULLIF(i.counterparty_account_name,''),'غير محدد')
                 END AS "partyName",
                 round(il.smallest_quantity::numeric /
                   (il.factor2::numeric * il.factor3::numeric),3)::text AS "quantityFirstUnit",
                 round(il.unit_price::numeric * CASE il.unit
                   WHEN 1 THEN 1 WHEN 2 THEN il.factor2
                   ELSE il.factor2 * il.factor3 END,2)::text AS "unitPriceFirstUnit",
                 i.currency_code AS "currencyCode",false AS "isStaged",
                 i.id AS "sortId",NULL::text AS "sourceId",il.line_number AS "sortLine"
               FROM (
                 SELECT document_date FROM item_daily_activity
                 WHERE company_id=$1 AND item_id=$2
                   AND CASE WHEN $3='sale' THEN sale_invoices>0 ELSE purchase_invoices>0 END
                 ORDER BY document_date DESC LIMIT ($4::bigint+$5::bigint)
               ) days
               JOIN invoices i ON i.company_id=$1 AND i.document_date=days.document_date
                 AND i.kind=$3
               JOIN invoice_lines il ON il.company_id=$1 AND il.invoice_id=i.id
                 AND il.item_id=$2 AND il.smallest_quantity>0
               UNION ALL
               SELECT ('staged:'||l.source_system||':'||l.source_id||':'||
                   l.line_number::text) AS "lineId",
                 l.source_id AS "documentId",l.document_date::text AS "documentDate",
                 COALESCE(NULLIF(CASE WHEN $3='purchase' THEN supplier.name
                   ELSE payer.name END,''),'غير محدد') AS "partyName",
                 round(l.quantity * CASE l.unit WHEN 1 THEN 1::numeric
                   WHEN 2 THEN 1::numeric/item.factor2::numeric
                   ELSE 1::numeric/(item.factor2::numeric*item.factor3::numeric)
                 END,6)::text AS "quantityFirstUnit",
                 round(l.unit_price * CASE l.unit WHEN 1 THEN 1::numeric
                   WHEN 2 THEN item.factor2::numeric
                   ELSE item.factor2::numeric*item.factor3::numeric
                 END,2)::text AS "unitPriceFirstUnit",
                 cur.code AS "currencyCode",true AS "isStaged",
                 NULL::integer AS "sortId",l.source_id AS "sourceId",
                 l.line_number AS "sortLine"
               FROM (
                 SELECT * FROM staged_invoice_item_lines_cache
                 WHERE company_id=$1 AND item_id=$2 AND kind=$3 AND quantity>0
                 ORDER BY document_date DESC,source_id DESC,line_number DESC
                 LIMIT ($4::bigint+$5::bigint)
               ) l
               JOIN items item ON item.company_id=l.company_id AND item.id=l.item_id
               LEFT JOIN accounts payer ON payer.company_id=l.company_id
                 AND payer.id=l.counterparty_account_id
               LEFT JOIN accounts supplier ON supplier.company_id=l.company_id
                 AND supplier.id=l.supplier_account_id
               LEFT JOIN company_currencies cur ON cur.company_id=l.company_id
                 AND cur.id=l.currency_id
             ) history
             ORDER BY "documentDate" DESC,"isStaged" ASC,
               "sortId" DESC NULLS LAST,"sourceId" DESC NULLS LAST,"sortLine" DESC
             LIMIT $4 OFFSET $5`,
            [companyId, itemId, type, pageSize + 1, (page - 1) * pageSize],
          );
          return result.rows;
        }
        const user = await currentActor(client, actor(req), false);
        await companyAccess(client, user, companyId, "inventory.view");
        const result = await client.query(
          `SELECT o.id AS "lineId", o.id AS "documentId",
             o.document_date::text AS "documentDate",
             COALESCE(NULLIF(o.description,''),'—') AS "description",
             round(sum(CASE WHEN o.kind='transfer'
               THEN CASE WHEN m.kind='transfer_out' THEN -m.quantity_smallest ELSE 0 END
               ELSE m.quantity_smallest END)::numeric /
               (it.factor2::numeric * it.factor3::numeric),3)::text AS "quantityFirstUnit"
           FROM stock_operations o
           JOIN stock_movements m ON m.company_id=o.company_id AND m.operation_id=o.id
           JOIN items it ON it.company_id=m.company_id AND it.id=m.item_id
           WHERE o.company_id=$1 AND m.item_id=$2 AND o.kind=$3
           GROUP BY o.id,o.document_date,o.description,it.factor2,it.factor3
           ORDER BY o.document_date DESC,o.id DESC
           LIMIT $4 OFFSET $5`,
          [companyId, itemId, type, pageSize + 1, (page - 1) * pageSize],
        );
        return result.rows;
      });
      res.json({ items: items.slice(0, pageSize), hasMore: items.length > pageSize });
    }),
  );
  router.get(
    `${base}/invoice-stock-preview`,
    handler(async (req, res) => {
      const locationId = id(typeof req.query.locationId === "string" ? req.query.locationId : undefined);
      const raw = req.query.itemIds;
      if (typeof raw !== "string" || !raw || raw.length > 1100)
        throw new HttpError(400, "invalid_query", "حدد أصنافًا صالحة");
      const tokens = raw.split(",");
      if (tokens.length > 100 || tokens.some((value) => !/^[1-9][0-9]{0,9}$/.test(value) || !Number.isSafeInteger(Number(value))))
        throw new HttpError(400, "invalid_query", "قائمة الأصناف غير صالحة");
      const itemIds = [...new Set(tokens.map(Number))];
      const items = await readCommerce(pool, req, async (client, companyId) => {
        const location = await client.query("SELECT 1 FROM locations WHERE company_id=$1 AND id=$2", [companyId, locationId]);
        if (!location.rowCount)
          throw new HttpError(404, "not_found", "الموقع غير موجود لهذه الشركة");
        const result = await client.query(
          `SELECT i.id AS item_id, i.shelf, COALESCE(sum(s.quantity_smallest),0)::text AS quantity_smallest
           FROM items i
           LEFT JOIN stock_balances s
             ON s.company_id=i.company_id AND s.item_id=i.id AND s.location_id=$2
           WHERE i.company_id=$1 AND i.id=ANY($3::integer[])
           GROUP BY i.id, i.shelf`,
          [companyId, locationId, itemIds],
        );
        return result.rows.map((row) => ({
          itemId: Number(row.item_id),
          quantitySmallest: String(row.quantity_smallest),
          shelf: String(row.shelf),
        }));
      });
      res.json({ items });
    }),
  );
  router.get(
    `${base}/invoices`,
    handler(async (req, res) => {
      res.json(
        await readCommerce(pool, req, async (client, companyId) => {
          const query = listQuery(
            req.query,
            {
              id: "i.id",
              number: "i.number",
              kind: "i.kind",
              documentDate: "i.document_date",
              total: "i.total",
              currencyCode: "i.currency_code",
              counterpartyAccountName: "i.counterparty_account_name",
              supplierAccountName: "i.supplier_account_name",
              createdAt: "i.created_at",
            },
            "documentDate:desc,id:desc",
          );
          const from =
              req.query.dateFrom === undefined
                ? null
                : parse(documentDateSchema, req.query.dateFrom),
            to =
              req.query.dateTo === undefined
                ? null
                : parse(documentDateSchema, req.query.dateTo);
          if (from && to && from > to)
            throw new HttpError(
              400,
              "invalid_query",
              "بداية الفترة تتجاوز نهايتها",
            );
          let kind: string | null = null;
          if (req.query.kind !== undefined) {
            if (
              typeof req.query.kind !== "string" ||
              !invoiceKinds.includes(
                req.query.kind as (typeof invoiceKinds)[number],
              )
            )
              throw new HttpError(
                400,
                "invalid_query",
                "نوع الفاتورة غير صالح",
              );
            kind = req.query.kind;
          }
          let returning: boolean | null = null;
          if (req.query.returning !== undefined) {
            if (
              typeof req.query.returning !== "string" ||
              !["true", "false"].includes(req.query.returning)
            )
              throw new HttpError(
                400,
                "invalid_query",
                "فلتر المردود غير صالح",
              );
            returning = req.query.returning === "true";
          }
          const branchId =
            req.query.branchId === undefined
              ? null
              : id(
                  typeof req.query.branchId === "string"
                    ? req.query.branchId
                    : undefined,
                );
          const locationId =
            req.query.locationId === undefined
              ? null
              : id(
                  typeof req.query.locationId === "string"
                    ? req.query.locationId
                    : undefined,
                );
          const supplierQ = req.query.supplierQ;
          const payerQ = req.query.payerQ;
          if ([supplierQ, payerQ].some((term) =>
            term !== undefined && (typeof term !== "string" || term.length > 120)))
            throw new HttpError(400, "invalid_query", "بحث المورد أو حساب السداد غير صالح");
          const params = [
            companyId,
            searchPattern(query.q),
            kind,
            from,
            to,
            returning,
            branchId,
            locationId,
            searchPattern((supplierQ as string | undefined) ?? ""),
            searchPattern((payerQ as string | undefined) ?? ""),
          ];
          const filter =
            "i.company_id=$1 AND (i.number ILIKE $2 OR i.supplier_receipt_number ILIKE $2 OR i.description ILIKE $2 OR i.counterparty_account_name ILIKE $2 OR i.supplier_account_name ILIKE $2) AND ($3::text IS NULL OR i.kind=$3) AND ($4::date IS NULL OR i.document_date >= $4::date) AND ($5::date IS NULL OR i.document_date <= $5::date) AND ($6::boolean IS NULL OR i.is_return=$6) AND ($7::integer IS NULL OR i.branch_id=$7) AND ($8::integer IS NULL OR i.location_id=$8) AND (COALESCE(i.supplier_account_name,'') ILIKE $9 OR COALESCE(i.supplier_account_code,'') ILIKE $9) AND (i.counterparty_account_name ILIKE $10 OR i.counterparty_account_code ILIKE $10)";
          const count = await client.query(
            `SELECT count(*)::integer AS total ${invoiceFrom} WHERE ${filter}`,
            params,
          );
          const rows = await client.query(
            `${invoiceSelect} WHERE ${filter} ORDER BY ${query.order} LIMIT $11 OFFSET $12`,
            [...params, query.pageSize, query.offset],
          );
          return {
            items: await invoiceDTOs(client, rows.rows),
            total: count.rows[0].total,
            page: query.page,
            pageSize: query.pageSize,
          };
        }),
      );
    }),
  );
  router.get(
    `${base}/invoices/:id`,
    handler(async (req, res) =>
      res.json({
        invoice: await readCommerce(pool, req, (client, companyId) =>
          loadInvoice(client, companyId, id(req.params.id)),
        ),
      }),
    ),
  );
  router.get(`${base}/memo-feature-impact`,handler(async(req,res)=>{
    const kind=req.query.kind;
    if(kind!=="sale"&&kind!=="purchase")
      throw new HttpError(400,"invalid_kind","اختر نوع فاتورة صالحًا");
    const matches=await transaction(pool,async client=>{
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const user=await currentActor(client,actor(req),false);
      const companyId=id(req.params.companyId);
      await companyAccess(client,user,companyId,"commerce.view");
      return matchingMemoFeatureRules(client,companyId,user.id,
        kind==="sale"?"invoice.sale.create":"invoice.purchase.create");
    });
    res.json({matches});
  }));
  // Cashier-only counterparty lookup for the optional receipt companion voucher.
  // It does not allow selecting a cashbox, amount, date, or currency.
  router.get(`${base}/receipt-counterpart-accounts`,handler(async(req,res)=>{
    const companyId=id(req.params.companyId);
    const q=typeof req.query.q==="string"?req.query.q.trim():"";
    if(q.length>100)throw new HttpError(400,"invalid_query","عبارة البحث طويلة");
    const result=await transaction(pool,async(client)=>{
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const user=await currentActor(client,actor(req),false);
      await companyAccess(client,user,companyId,"finance.view");
      const rows=await client.query(
        `SELECT id,code,name FROM accounts
         WHERE company_id=$1 AND active AND kind='posting'
           AND ($2='' OR code ILIKE '%'||$2||'%' OR name ILIKE '%'||$2||'%')
         ORDER BY name,id LIMIT 50`,[companyId,q],
      );
      return {items:rows.rows};
    });
    res.json(result);
  }));
  router.get(
    `${base}/pouch-receipts`,
    handler(async (req,res) => {
      const companyId=id(req.params.companyId);
      const status=parse(
        z.enum(["all","pending","received"]),
        typeof req.query.status==="string"?req.query.status:"pending",
      );
      const page=parse(z.coerce.number().int().min(1).max(1000000),
        typeof req.query.page==="string"?req.query.page:"1");
      const pageSize=parse(z.coerce.number().int().min(1).max(100),
        typeof req.query.pageSize==="string"?req.query.pageSize:"50");
      const result=await transaction(pool,async client=>{
        await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const user=await currentActor(client,actor(req),false);
        await companyAccess(client,user,companyId,"finance.view");
        return listPouchReceipts(client,companyId,status,pageSize,(page-1)*pageSize);
      });
      res.json(result);
    }),
  );
  router.post(
    `${base}/pouch-receipts`,
    handler(async (req,res)=>{
      const input=parse(pouchReceiptSchema,req.body);
      const result=await mutateMaster(pool,req,"finance.post",
        async (client,user,companyId)=>
          receivePouchMovement(client,companyId,user,input),
      );
      res.status(201).json({receipt:result});
    }),
  );
  // Receipt source is resolved from the original electronic-wallet transfer,
  // whose destination was selected via the company's account links.
  router.get(
    `${base}/electronic-receipts`,
    handler(async (req,res) => {
      const companyId=id(req.params.companyId);
      const status=parse(
        z.enum(["all","pending","received"]),
        typeof req.query.status==="string"?req.query.status:"pending",
      );
      const page=parse(z.coerce.number().int().min(1).max(1000000),
        typeof req.query.page==="string"?req.query.page:"1");
      const pageSize=parse(z.coerce.number().int().min(1).max(100),
        typeof req.query.pageSize==="string"?req.query.pageSize:"50");
      const result=await transaction(pool,async client=>{
        await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const user=await currentActor(client,actor(req),false);
        await companyAccess(client,user,companyId,"finance.view");
        return listElectronicReceipts(client,companyId,status,pageSize,(page-1)*pageSize);
      });
      res.json(result);
    }),
  );
  router.post(
    `${base}/electronic-receipts`,
    handler(async (req,res)=>{
      const input=parse(electronicReceiptSchema,req.body);
      const result=await mutateMaster(pool,req,"finance.post",
        async (client,user,companyId)=>
          receiveElectronicMovement(client,companyId,user,input),
      );
      res.status(201).json({receipt:result});
    }),
  );
  // Sales-only quick till actions. No account identifiers are accepted from
  // the browser: the destination is resolved from the employee's links or
  // the administrator's company electronic-wallet configuration.
  router.post(
    `${base}/sales/cashbox-operations`,
    handler(async (req, res) => {
      const input=parse(cashboxOperationSchema,req.body);
      const result=await mutateMaster(pool,req,"commerce.manage",
        async (client,user,companyId)=>{
          await companyAccess(client,user,companyId,"finance.post",true);
          return postEmployeeCashboxOperation(client,companyId,user,input);
        });
      res.status(201).json(result);
    }),
  );
  router.post(
    `${base}/invoices`,
    handler(async (req, res) => {
      const input = parse(invoiceSchema, req.body);
      const invoice = await mutateMaster(
        pool,
        req,
        "commerce.manage",
        async (client, user, companyId) => {
          await companyAccess(client, user, companyId, "finance.post", true);
          // Accepted UUID retries remain verifiable even if a control changes.
          const existing = await client.query(
            "SELECT 1 FROM invoices WHERE company_id=$1 AND idempotency_key=$2",
            [companyId, input.idempotencyKey],
          );
          if (!existing.rowCount) {
            await assertMobileInvoiceCreation(client, companyId, input.kind, req.headers["user-agent"]);
            await assertEditableDocumentDate(client, companyId,
              input.kind === "sale" ? "edit_sales_date" : "edit_purchases_date", input.documentDate);
            await assertYerWhenCurrencyHidden(client, companyId, input.currencyId);
          }
          return createInvoice(client, companyId, user, input);
        },
      ).catch(async (error:unknown)=>{
        if(error instanceof HttpError && error.code==="memo_feature_block"){
          try{
            await transaction(pool,async client=>{
              const companyId=id(req.params.companyId),user=await currentActor(client,actor(req));
              await companyAccess(client,user,companyId,"commerce.manage");
              const matches=await matchingMemoFeatureRules(client,companyId,user.id,
                input.kind==="sale"?"invoice.sale.create":"invoice.purchase.create");
              for(const rule of matches.filter(rule=>rule.effect==="block"))
                await audit(client,user,"memo.feature-trigger","memo-feature-rule",rule.ruleId,
                  null,{effect:"block",outcome:"rejected",rule:rule.ruleName,
                    pendingCount:rule.count,action:input.kind},companyId);
            });
          }catch(logFailure){console.error("Memo feature rejection audit failed",logFailure);}
        }
        throw error;
      });
      res.status(201).json({ invoice });
    }),
  );
  return router;
}
