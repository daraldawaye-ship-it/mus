import { Router, type Request } from "express";
import type { Pool } from "pg";
import { accountCategories, normalizeDigits } from "../../../packages/contracts/src/index.ts";
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
import { canSearchInvoiceItem } from "../../../packages/contracts/src/invoice-item-search.ts";

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
          try {
            await companyAccess(client, user, companyId, "inventory.view");
          } catch (inventoryError) {
            // Item-card readers can search items even without commerce/stock access.
            // Other option types retain their existing commerce/inventory policy.
            if (req.query.type !== "items" ||
                !(inventoryError instanceof HttpError) || inventoryError.status !== 403)
              throw inventoryError;
            await companyAccess(client, user, companyId, "items.view");
          }
        }
        // Shortcut lookup is an exact, unique indexed read, not a typeahead
        // search. The item editor also uses includeInactive=1 to prevent
        // assigning a code belonging to an archived card.
        if (req.query.type === "items" && req.query.shortcut !== undefined) {
          const shortcut = req.query.shortcut;
          const normalized = typeof shortcut === "string"
            ? normalizeDigits(shortcut.trim().toUpperCase()) : "";
          if (!/^[\p{L}\p{N}]{2}$/u.test(normalized))
            throw new HttpError(400, "invalid_shortcut", "الاختصار يجب أن يتكون من خانتين، حروف أو أرقام");
          const includeInactive = req.query.includeInactive === "1";
          const canShowStock = await canReadItemStock(client,user,companyId);
          const stockFrom = itemFrom + (canShowStock
            ? " LEFT JOIN item_statistics lookup_stock ON lookup_stock.company_id=i.company_id AND lookup_stock.item_id=i.id" : "");
          const stockSelect = canShowStock
            ? ",COALESCE(lookup_stock.stock_total,0)::text AS available_smallest "
            : ",NULL::text AS available_smallest ";
          const rows = await client.query(
            `${itemSelect.replace(itemFrom, stockSelect + stockFrom)}
             WHERE i.company_id=$1 AND lower(i.shortcut)=lower($2)
               AND i.shortcut<>'' ${includeInactive ? "" : "AND i.active"}
             LIMIT 1`,
            [companyId, normalized],
          );
          return {
            items: rows.rows.map(itemDTO),
            total: rows.rowCount ?? 0,
            hasMore: false, page: 1, pageSize: 1,
          };
        }
        // Keep typeahead responsive with bounded result pages, but preserve
        // the same monthly sales-frequency order for EVERY search length.
        const fastItemLookup = req.query.type === "items" && req.query.fast === "1" &&
          typeof req.query.q === "string" && !!req.query.q.trim();
        // Keep old clients safe too: a fast invoice lookup with fewer than
        // three characters must never trigger broad scans or ranking work.
        if (fastItemLookup && !canSearchInvoiceItem(req.query.q as string)) {
          return {
            items: [], total: 0, page: 1, pageSize: 10, hasMore: false,
          };
        }
        const query = {
          ...req.query,
          ...(req.query.id === undefined ? { active: "true" } : {}),
        };
        const request: Request = Object.create(req) as Request;
        Object.defineProperty(request, "query", { value: query });
        if (req.query.type === "items") {
          const canRank = await canOrderItemsBySales(client,user,companyId);
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
            itemLookupSearchPlan,
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
