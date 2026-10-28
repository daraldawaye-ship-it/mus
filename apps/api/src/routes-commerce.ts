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
import { audit } from "./services/audit.ts";

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
            "i.company_id=$1 AND (i.number ILIKE $2 OR i.description ILIKE $2 OR i.counterparty_account_name ILIKE $2 OR i.supplier_account_name ILIKE $2) AND ($3::text IS NULL OR i.kind=$3) AND ($4::date IS NULL OR i.document_date >= $4::date) AND ($5::date IS NULL OR i.document_date <= $5::date) AND ($6::boolean IS NULL OR i.is_return=$6) AND ($7::integer IS NULL OR i.branch_id=$7) AND ($8::integer IS NULL OR i.location_id=$8) AND (COALESCE(i.supplier_account_name,'') ILIKE $9 OR COALESCE(i.supplier_account_code,'') ILIKE $9) AND (i.counterparty_account_name ILIKE $10 OR i.counterparty_account_code ILIKE $10)";
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
          return createInvoice(client, companyId, user, input);
        },
      );
      res.status(201).json({ invoice });
    }),
  );

  const referralEdit = z.object({
    revision: z.number().int().positive(),
    category: z.string().trim().max(100).nullable(),
    phone: z.string().trim().max(50).nullable(),
    details: z.string().trim().max(2000),
    archived: z.boolean(),
  }).strict();
  const selectReferral = 'SELECT id,company_id AS "companyId",kind,name,category,phone,details,archived,revision,created_at AS "createdAt",updated_at AS "updatedAt" FROM invoice_referrals';
  router.get(
    `${base}/sales-referrals`,
    handler(async (req,res) => {
      const kind = req.query.kind;
      const status = req.query.status ?? "pending";
      const q = req.query.q ?? "";
      const page = req.query.page === undefined ? 1 : Number(req.query.page);
      if ((kind !== undefined && kind !== "doctor" && kind !== "entity") ||
          !["pending","all","archived"].includes(String(status)) ||
          typeof q !== "string" || q.length > 120 ||
          !Number.isSafeInteger(page) || page < 1 || page > 100000)
        throw new HttpError(400,"invalid_query","بحث كروت الأطباء والجهات غير صالح");
      res.json(await readCommerce(pool,req,async (client,companyId) => {
        const params = [companyId,kind ?? null,status,searchPattern(q)];
        const where = "company_id=$1 AND ($2::text IS NULL OR kind=$2) AND ($3::text='all' OR ($3='pending' AND archived=false AND category IS NULL) OR ($3='archived' AND archived=true)) AND name ILIKE $4";
        const total = await client.query(`SELECT count(*)::integer AS total FROM invoice_referrals WHERE ${where}`,params);
        const items = await client.query(`${selectReferral} WHERE ${where} ORDER BY id DESC LIMIT 100 OFFSET $5`,[...params,(page-1)*100]);
        return {items:items.rows,total:total.rows[0].total,page,pageSize:100};
      }));
    })
  );
  router.get(
    `${base}/sales-referrals/:referralId`,
    handler(async(req,res) => {
      const referral = await readCommerce(pool,req,async(client,companyId) => (
        await client.query(`${selectReferral} WHERE company_id=$1 AND id=$2`,[companyId,id(req.params.referralId)])
      ).rows[0]);
      if (!referral) throw new HttpError(404,"not_found","الكرت غير موجود");
      res.json({referral});
    })
  );
  router.patch(
    `${base}/sales-referrals/:referralId`,
    handler(async(req,res) => {
      const input = parse(referralEdit,req.body);
      const referralId = id(req.params.referralId);
      const referral = await mutateMaster(pool,req,"commerce.manage",async(client,user,companyId)=>{
        const previous = (await client.query(
          "SELECT * FROM invoice_referrals WHERE company_id=$1 AND id=$2 FOR UPDATE",[companyId,referralId],
        )).rows[0];
        if (!previous) throw new HttpError(404,"not_found","الكرت غير موجود");
        if (Number(previous.revision) !== input.revision)
          throw new HttpError(409,"conflict","تم تعديل الكرت من مستخدم آخر؛ حدث الصفحة أولًا");
        const updated = (await client.query(
          `UPDATE invoice_referrals SET category=$3,phone=$4,details=$5,archived=$6,revision=revision+1,updated_at=clock_timestamp()
           WHERE company_id=$1 AND id=$2 RETURNING id`,
          [companyId,referralId,input.category || null,input.phone || null,input.details,input.archived],
        )).rows[0];
        if (input.archived || !!input.category) {
          await client.query(
            `UPDATE notifications SET completed_at=clock_timestamp(),read_at=COALESCE(read_at,clock_timestamp()),next_reminder_at=NULL,snoozed_until=NULL,revision=revision+1,updated_at=clock_timestamp()
             WHERE company_id=$1 AND code='SALES_REFERRAL_NEEDS_REVIEW' AND subject_key=$2 AND completed_at IS NULL`,
            [companyId,`${previous.kind}:${referralId}`],
          );
        }
        await audit(client,user,"sales-referral.update","invoice-referral",referralId,previous,{...input},companyId);
        return (await client.query(`${selectReferral} WHERE company_id=$1 AND id=$2`,[companyId,updated.id])).rows[0];
      });
      res.json({referral});
    })
  );
  return router;
}
