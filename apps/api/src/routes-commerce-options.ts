import { Router, type Request } from "express";
import type { Pool } from "pg";
import { accountCategories } from "../../../packages/contracts/src/index.ts";
import { transaction } from "./db.ts";
import { HttpError } from "./errors.ts";
import { actor, handler, id } from "./http.ts";
import { companyAccess, currentActor } from "./policies/access.ts";
import {
  accountDTO,
  accountSelect,
  branchDTO,
  branchSelect,
  currencyDTO,
  currencySelect,
  locationDTO,
  locationSelect,
} from "./repositories/masters.ts";
import { itemDTO, itemFrom, itemSelect } from "./repositories/items.ts";
import { masterPage } from "./services/masters.ts";
import {
  assertItemSaleRankingsReady,
  canOrderItemsBySales,
  itemSaleTimesJoinSql,
  itemSaleTimesOrderSql,
} from "./services/item-sale-ranking.ts";
import { canReadItemStock } from "./services/item-coverage.ts";
import { itemLookupSearchPlan } from "./services/item-lookup-search.ts";

export function commerceOptionRoutes(pool: Pool): Router {
  const router = Router();
  router.get(
    "/companies/:companyId/commerce-options",
    handler(async (req, res) => {
      const result = await transaction(pool, async (client) => {
        await client.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        const companyId = id(req.params.companyId);
        const user = await currentActor(client, actor(req), false);
        try {
          await companyAccess(client, user, companyId, "commerce.view");
        } catch (error) {
          if (!(error instanceof HttpError) || error.status !== 403)
            throw error;
          await companyAccess(client, user, companyId, "inventory.view");
        }
        // Keep short in-progress terms responsive: use indexed item-code
        // order and bounded suggestions instead of sorting all matches by sales.
        const fastItemLookup = req.query.type === "items" && req.query.fast === "1" &&
          typeof req.query.q === "string" && !!req.query.q.trim();
        const shortItemLookup = fastItemLookup &&
          Array.from((req.query.q as string).trim()).length < 3;
        const query = {
          ...req.query,
          ...(req.query.id === undefined ? { active: "true" } : {}),
          ...(shortItemLookup ? { sort: "code:asc" } : {}),
        };
        const request: Request = Object.create(req) as Request;
        Object.defineProperty(request, "query", { value: query });
        if (req.query.type === "items") {
          const canRank = !shortItemLookup && await canOrderItemsBySales(client,user,companyId);
          if (canRank) await assertItemSaleRankingsReady(client);
          const canShowStock = await canReadItemStock(client,user,companyId);
          const stockFrom = itemFrom + (canRank ? itemSaleTimesJoinSql : "") + (canShowStock
            ? " LEFT JOIN item_statistics lookup_stock ON lookup_stock.company_id=i.company_id AND lookup_stock.item_id=i.id" : "");
          const stockSelect = canShowStock
            ? ",COALESCE(lookup_stock.stock_total,0)::text AS available_smallest "
            : ",NULL::text AS available_smallest ";
          return masterPage(
            client,
            request,
            companyId,
            itemSelect.replace(itemFrom, stockSelect + stockFrom),
            stockFrom,
            "i",
            { id: "i.id", code: "i.code", name: "i.name", active: "i.active", saleTimes: canRank ? itemSaleTimesOrderSql : "0::bigint" },
            [
              "i.name",
              "i.english_name",
              "i.code",
              "i.barcode",
              "i.search_keys",
              "f.arabic_name",
              "f.english_name",
            ],
            itemDTO,
            { id: "id", active: "boolean" },
            "saleTimes:desc,code:asc",
            undefined,
            ["i.code","i.barcode"],
            shortItemLookup ? undefined : itemLookupSearchPlan,
            fastItemLookup,
          );
        }
        if (req.query.type === "accounts") {
          const accountRequest: Request = Object.create(req) as Request;
          Object.defineProperty(accountRequest, "query", {
            value: { ...query, kind: "posting" },
          });
          return masterPage(
            client,
            accountRequest,
            companyId,
            accountSelect,
            "FROM accounts a LEFT JOIN accounts p ON p.company_id=a.company_id AND p.id=a.parent_id",
            "a",
            {
              id: "a.id",
              code: "a.code",
              name: "a.name",
              active: "a.active",
              kind: "a.kind",
              category: "a.category",
            },
            ["a.name", "a.code"],
            accountDTO,
            {
              id: "id",
              active: "boolean",
              kind: ["posting"],
              category: accountCategories,
            },
            "code:asc",
          );
        }
        if (req.query.type === "currencies")
          return masterPage(
            client,
            request,
            companyId,
            currencySelect,
            "FROM company_currencies c",
            "c",
            { id: "c.id", code: "c.code", name: "c.name", active: "c.active" },
            ["c.name", "c.code"],
            currencyDTO,
            { id: "id", active: "boolean" },
            "code:asc",
          );
        if (req.query.type === "branches")
          return masterPage(
            client,
            request,
            companyId,
            branchSelect,
            "FROM branches b",
            "b",
            { id: "b.id", code: "b.code", name: "b.name", active: "b.active" },
            ["b.name", "b.code"],
            branchDTO,
            { id: "id", active: "boolean" },
            "code:asc",
          );
        if (req.query.type === "locations")
          return masterPage(
            client,
            request,
            companyId,
            locationSelect,
            "FROM locations l JOIN branches b ON b.company_id=l.company_id AND b.id=l.branch_id",
            "l",
            {
              id: "l.id",
              code: "l.code",
              name: "l.name",
              active: "l.active",
              branchId: "l.branch_id",
              kind: "l.kind",
            },
            ["l.name", "l.code", "b.name"],
            locationDTO,
            {
              id: "id",
              active: "boolean",
              branchId: "id",
              kind: ["showroom", "warehouse"],
            },
            "code:asc",
          );
        throw new HttpError(400, "invalid_query", "نوع الاختيارات غير صالح");
      });
      res.json(result);
    }),
  );
  return router;
}
