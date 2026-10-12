import { Router, type Request } from "express";
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
          const params = [
            companyId,
            searchPattern(query.q),
            kind,
            from,
            to,
            returning,
            branchId,
            locationId,
          ];
          const filter =
            "i.company_id=$1 AND (i.number ILIKE $2 OR i.description ILIKE $2 OR i.counterparty_account_name ILIKE $2) AND ($3::text IS NULL OR i.kind=$3) AND ($4::date IS NULL OR i.document_date >= $4::date) AND ($5::date IS NULL OR i.document_date <= $5::date) AND ($6::boolean IS NULL OR (i.total<0)=$6) AND ($7::integer IS NULL OR i.branch_id=$7) AND ($8::integer IS NULL OR i.location_id=$8)";
          const count = await client.query(
            `SELECT count(*)::integer AS total ${invoiceFrom} WHERE ${filter}`,
            params,
          );
          const rows = await client.query(
            `${invoiceSelect} WHERE ${filter} ORDER BY ${query.order} LIMIT $9 OFFSET $10`,
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
  return router;
}
