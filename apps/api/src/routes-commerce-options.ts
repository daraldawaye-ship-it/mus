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
  // Read-only, permission-protected *stored* monthly ranking. Never aggregate
  // invoice lines during typing. Paging allows devices to cache the snapshot
  // once per Aden calendar day without downloading the full item cards again.
  router.get("/companies/:companyId/item-sale-ranks", handler(async (req,res)=>{
    const companyId=id(req.params.companyId);
    const afterId=req.query.afterId??"0";
    if (typeof afterId!=="string" || !/^(0|[1-9]\d{0,9})$/.test(afterId) ||
        Number(afterId)>2147483647)
      throw new HttpError(400,"invalid_cursor","مؤشر ترتيب الأصناف غير صالح");
    const result=await transaction(pool,async client=>{
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const user=await currentActor(client,actor(req),false);
      await companyAccess(client,user,companyId,"commerce.view");
      if (!(await canOrderItemsBySales(client,user,companyId)))
        throw new HttpError(403,"forbidden","لا تملك صلاحية عرض إحصاءات المبيعات");
      await assertItemSaleRankingsReady(client);
      const today=await client.query<{day:string}>(
        "SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Aden')::date::text AS day",
      );
      const day=today.rows[0]!.day;
      const canShowStock = await canReadItemStock(client,user,companyId);
      const stockJoin = canShowStock
        ? " LEFT JOIN item_statistics stock ON stock.company_id=i.company_id AND stock.item_id=i.id"
        : "";
      const saleable = canShowStock
        ? "COALESCE(stock.stock_showroom,0)+COALESCE(stock.stock_warehouse,0)"
        : "0::numeric";
      const rows=await client.query<{item_id:number;total:string;priority_scaled:string;stock_available:string|null}>(`
        SELECT i.id AS item_id,
          (COALESCE(sale_rank.net_sale_invoices,0)+COALESCE(staged_rank.net_sale_invoices,0))::text AS total,
          ROUND(((COALESCE(sale_rank.net_sale_quantity,0)+COALESCE(staged_rank.net_sale_quantity,0))
            + (${saleable}))*1000000)::text AS priority_scaled,
          ${canShowStock ? `(${saleable})::text` : "NULL::text"} AS stock_available
        FROM items i
        ${itemSaleTimesJoinSql} ${stockJoin}
        WHERE i.company_id=$1 AND i.id>$2::integer
        ORDER BY i.id ASC LIMIT 1001
      `,[companyId,Number(afterId)]);
      const more=rows.rows.length>1000;
      const page=rows.rows.slice(0,1000);
      return {asOfDate:day,items:page.map(row=>({
        itemId:row.item_id,saleTimes:row.total,priorityScaled:row.priority_scaled,
        stockAvailable:row.stock_available,
      })),hasMore:more,afterId:more?page[page.length-1]!.item_id:0};
    });
    res.json(result);
  }));
  // Small incremental feed: no private caching, no client-provided SQL, no full catalog reload.
  // The cursor uses PostgreSQL microsecond precision to avoid skipping updates in one millisecond.
  router.get("/companies/:companyId/item-changes", handler(async (req, res) => {
    const companyId = id(req.params.companyId);
    const since = req.query.since;
    const afterId = req.query.afterId;
    if (since !== undefined && (typeof since !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/.test(since) ||
        !Number.isFinite(Date.parse(since))))
      throw new HttpError(400, "invalid_cursor", "مؤشر تحديث الأصناف غير صالح");
    if (afterId !== undefined && (typeof afterId !== "string" ||
        !/^(0|[1-9]\d{0,9})$/.test(afterId) || Number(afterId) > 2147483647))
      throw new HttpError(400, "invalid_cursor", "مؤشر تحديث الأصناف غير صالح");
    const result = await transaction(pool, async (client) => {
      await client.query("SET TRANSACTION READ ONLY");
      const user = await currentActor(client, actor(req), false);
      let permitted = false;
      for (const permission of ["commerce.view", "inventory.view", "items.view"] as const) {
        try {
          await companyAccess(client, user, companyId, permission);
          permitted = true;
          break;
        } catch (error) {
          if (!(error instanceof HttpError) || error.status !== 403) throw error;
        }
      }
      if (!permitted) throw new HttpError(403, "forbidden", "لا تملك صلاحية عرض الأصناف");
      const now = await client.query<{ timestamp: string }>(
        `SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS timestamp`,
      );
      const timestamp = now.rows[0].timestamp;
      if (since === undefined) return {
        items: [], cursor: { since: timestamp, afterId: 0 }, hasMore: false,
      };
      const rows = await client.query(
        `${itemSelect.replace("SELECT i.*,", `SELECT i.*,to_char(i.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sync_time,`)}
         WHERE i.company_id=$1 AND (i.updated_at,i.id)>($2::timestamptz,$3::integer)
           AND i.updated_at<=$4::timestamptz
         ORDER BY i.updated_at ASC,i.id ASC LIMIT 101`,
        [companyId, since, Number(afterId ?? 0), timestamp],
      );
      const hasMore = rows.rows.length > 100;
      const page = rows.rows.slice(0, 100);
      const last = page[page.length - 1];
      return {
        items: page.map(itemDTO),
        cursor: hasMore ? { since: last.sync_time as string, afterId: last.id as number }
          : { since: timestamp, afterId: 0 },
        hasMore,
      };
    });
    res.json(result);
  }));
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
          if (!/^[^\s\p{C}]{1,2}$/u.test(normalized) || normalized === "0")
            throw new HttpError(400, "invalid_shortcut", "الاختصار خانة أو خانتان من حروف أو أرقام أو رموز؛ 0 وحده مخصص لإنهاء المبيعات");
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
            items: [], total: 0, page: 1, pageSize: 20, hasMore: false,
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
          const soldQuantity = canRank
            ? "COALESCE(sale_rank.net_sale_quantity,0)+COALESCE(staged_rank.net_sale_quantity,0)"
            : "0::numeric";
          const saleableStock = canShowStock
            ? "COALESCE(lookup_stock.stock_showroom,0)+COALESCE(lookup_stock.stock_warehouse,0)"
            : "0::numeric";
          return masterPage(
            client,
            request,
            companyId,
            itemSelect.replace(itemFrom, stockSelect + stockFrom),
            stockFrom,
            "i",
            { id: "i.id", code: "i.code", name: "i.name", active: "i.active", saleTimes: canRank ? itemSaleTimesOrderSql : "0::bigint",
              saleQuantityPlusStock: `(${soldQuantity})+(${saleableStock})` },
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
