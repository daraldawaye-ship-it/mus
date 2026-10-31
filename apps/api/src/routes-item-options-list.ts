import { Router } from "express";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { actor, handler, parse } from "./http.ts";
import { HttpError } from "./errors.ts";
import { readItems } from "./services/items.ts";
import { directoryEntries } from "./services/pages.ts";
import { canReadItemCoverage, addItemCoverageToPage, itemCoverageJoin } from "./services/item-coverage.ts";
import { stagedDailyActivitySql, activityColumns } from "./services/staged-activity-sql.ts";

const optionalNumber = z.preprocess(
  value => value === "" ? undefined : value,
  z.string().regex(/^-?\d{1,15}(?:\.\d{1,6})?$/, "أدخل عددًا صالحًا حتى 6 منازل عشرية").optional(),
);
const querySchema = z.object({
  q: z.string().trim().max(120).default(""),
  active: z.enum(["active", "archived", "all"]).default("active"),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(20).max(100).default(50),
  stockMin: optionalNumber, stockMax: optionalNumber,
  monthMin: optionalNumber, monthMax: optionalNumber,
  fourMonthsMin: optionalNumber, fourMonthsMax: optionalNumber,
  allTimeMin: optionalNumber, allTimeMax: optionalNumber,
  coverageMin: optionalNumber, coverageMax: optionalNumber,
  excludeZero: z.enum(["true", "false"]).default("false").transform(v => v === "true"),
  useReserve: z.enum(["true", "false"]).default("true").transform(v => v === "true"),
  sortBy: z.enum(["code", "name", "stock", "month", "fourMonths", "allTime", "coverage"]).default("code"),
  sortDir: z.enum(["asc", "desc"]).default("asc"),
}).strict();
type Options = z.infer<typeof querySchema>;

async function filteredItems(client: PoolClient, user: ReturnType<typeof actor>, companyId: number, options: Options) {
  const entries = await directoryEntries(client, user, companyId);
  const visible = (key: string) => {
    const entry = entries.find(page => page.key === key);
    return !!entry?.enabled && !!entry.actionAccess.view;
  };
  if (!["company.item-options-list", "company.items", "company.sales",
        "company.purchases", "company.invoice", "company.stock-balances",
        "company.stock-movements"].every(visible)
      || !await canReadItemCoverage(client, user, companyId))
    throw new HttpError(403, "item_filter_denied",
      "تتطلب قائمة الأصناف صلاحيات الأصناف والمبيعات والمشتريات والمخزون والكفاية");

  const asOf = (await client.query(
    "SELECT (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date::text AS today",
  )).rows[0].today as string;
  const values: Array<string | number> = [companyId, asOf, options.q, options.active];
  const predicates: string[] = [];
  const range = (value: string | undefined, column: string, op: ">=" | "<=") => {
    if (value === undefined) return;
    values.push(value);
    predicates.push(`${column} ${op} $${values.length}::numeric`);
  };
  range(options.stockMin, "m.available_unit1", ">=");
  range(options.stockMax, "m.available_unit1", "<=");
  range(options.monthMin, "m.sale_times_month", ">=");
  range(options.monthMax, "m.sale_times_month", "<=");
  range(options.fourMonthsMin, "m.sale_times_four_months", ">=");
  range(options.fourMonthsMax, "m.sale_times_four_months", "<=");
  range(options.allTimeMin, "m.sale_times_all_time", ">=");
  range(options.allTimeMax, "m.sale_times_all_time", "<=");
  if (options.excludeZero) predicates.push("m.available_smallest <> 0");

  // The existing item coverage calculation is only joined before pagination
  // when the user filters on coverage; otherwise enrich the 20-100 rows returned.
  const needsCoverageJoin = options.coverageMin !== undefined
    || options.coverageMax !== undefined || options.sortBy === "coverage";
  const coverageColumn = options.useReserve ? "m.coverage_after_reserve" : "m.coverage_before";
  range(options.coverageMin, coverageColumn, ">=");
  range(options.coverageMax, coverageColumn, "<=");
  const orders: Record<Options["sortBy"], string> = {
    code: "f.code", name: "f.name", stock: "f.available_unit1",
    month: "f.sale_times_month", fourMonths: "f.sale_times_four_months",
    allTime: "f.sale_times_all_time",
    coverage: options.useReserve ? "f.coverage_after_reserve" : "f.coverage_before",
  };
  const order = `${orders[options.sortBy]} ${options.sortDir === "asc" ? "ASC" : "DESC"}, f.code ASC, f.id ASC`;
  values.push(options.pageSize, (options.page - 1) * options.pageSize);
  const limit = `$${values.length - 1}`, offset = `$${values.length}`;
  const sql = `
    WITH candidate AS (
      SELECT i.id, i.company_id, i.code, i.name, i.active,
             i.unit1_name,i.unit2_name,i.unit3_name,i.factor2,i.factor3,i.reserve_quantity,
             (COALESCE(stock.stock_showroom,0)+COALESCE(stock.stock_warehouse,0)) AS available_smallest
      FROM items i
      LEFT JOIN item_statistics stock ON stock.company_id=i.company_id AND stock.item_id=i.id
      WHERE i.company_id=$1
        AND ($3::text='' OR i.code ILIKE '%'||$3||'%' OR i.name ILIKE '%'||$3||'%'
             OR EXISTS (SELECT 1 FROM items source_item WHERE source_item.id=i.id
                        AND source_item.company_id=i.company_id
                        AND (source_item.english_name ILIKE '%'||$3||'%'
                             OR source_item.barcode ILIKE '%'||$3||'%')))
        AND ($4::text='all' OR ($4='active' AND i.active) OR ($4='archived' AND NOT i.active))
    ),
    staged AS (${stagedDailyActivitySql("$2::date")}),
    activity AS (
      SELECT ${activityColumns.join(",")} FROM item_daily_activity
        WHERE company_id=$1 AND document_date<=$2::date
      UNION ALL
      SELECT ${activityColumns.join(",")} FROM staged
    ),
    sales AS (
      SELECT d.item_id,
         COALESCE(SUM(d.sale_invoices-d.sale_return_invoices) FILTER(
           WHERE d.document_date>=($2::date-interval '1 month'+interval '1 day')::date),0) AS month,
         COALESCE(SUM(d.sale_invoices-d.sale_return_invoices) FILTER(
           WHERE d.document_date>=($2::date-interval '4 months'+interval '1 day')::date),0) AS four_months,
         COALESCE(SUM(d.sale_invoices-d.sale_return_invoices),0) AS all_time
      FROM activity d JOIN candidate i ON i.id=d.item_id
      WHERE d.company_id=$1 GROUP BY d.item_id
    ),
    metrics AS (
      SELECT i.*, i.available_smallest/(i.factor2::numeric*i.factor3) AS available_unit1,
             COALESCE(s.month,0) AS sale_times_month,
             COALESCE(s.four_months,0) AS sale_times_four_months,
             COALESCE(s.all_time,0) AS sale_times_all_time,
             ${needsCoverageJoin
               ? "coverage.approximate_coverage_days AS coverage_before, coverage.coverage_after_reserve_days AS coverage_after_reserve"
               : "NULL::numeric AS coverage_before, NULL::numeric AS coverage_after_reserve"}
      FROM candidate i LEFT JOIN sales s ON s.item_id=i.id
      ${needsCoverageJoin ? itemCoverageJoin : ""}
    ),
    filtered AS (SELECT * FROM metrics m ${predicates.length ? `WHERE ${predicates.join(" AND ")}` : ""})
    SELECT counts.total, f.*
    FROM (SELECT COUNT(*)::integer AS total FROM filtered) counts
    LEFT JOIN LATERAL (SELECT * FROM filtered f ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}) f ON TRUE`;
  const rows = (await client.query(sql, values)).rows;
  const selected = rows.filter(row => row.id !== null).map(row => ({
    id: Number(row.id), code: String(row.code), name: String(row.name),
    active: Boolean(row.active),
    factor2: Number(row.factor2), factor3: Number(row.factor3),
    availableSmallest: String(row.available_smallest),
    availableUnit1: String(row.available_unit1),
    saleTimesMonth: String(row.sale_times_month),
    saleTimesFourMonths: String(row.sale_times_four_months),
    saleTimesAllTime: String(row.sale_times_all_time),
    approximateCoverageDays: needsCoverageJoin ? String(row.coverage_before) : null,
    coverageAfterReserveDays: needsCoverageJoin ? String(row.coverage_after_reserve) : null,
  }));
  const enriched = needsCoverageJoin ? selected
    : await addItemCoverageToPage(client, companyId, selected);
  return {
    rows: enriched.map(row => ({
      itemId: row.id, code: row.code, name: row.name, active: row.active,
      factor2: row.factor2, factor3: row.factor3,
      availableSmallest: row.availableSmallest, availableUnit1: row.availableUnit1,
      saleTimesMonth: row.saleTimesMonth,
      saleTimesFourMonths: row.saleTimesFourMonths,
      saleTimesAllTime: row.saleTimesAllTime,
      approximateCoverageDays: row.approximateCoverageDays,
      coverageAfterReserveDays: row.coverageAfterReserveDays,
    })),
    total: Number(rows[0]?.total ?? 0), page: options.page,
    pageSize: options.pageSize, asOf,
  };
}

/** Read-only, company-scoped, server-paginated stock and sales filters. */
export function itemOptionsListRoutes(pool: Pool): Router {
  const router = Router();
  router.get("/companies/:companyId/item-options-list", handler(async (req, res) => {
    const options = parse(querySchema, req.query);
    const result = await readItems(pool, req,
      (client, companyId) => filteredItems(client, actor(req), companyId, options));
    res.json({ result });
  }));
  return router;
}
