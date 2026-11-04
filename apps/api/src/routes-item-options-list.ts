import { Router, type Request } from "express";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { actor, handler, id, parse } from "./http.ts";
import { itemFactorSchema, itemWholeQuantitySchema } from "../../../packages/contracts/src/items.ts";
import { itemOptionsPresetCreateSchema, itemOptionsPresetFiltersSchema } from "../../../packages/contracts/src/item-options-presets.ts";
import { transaction } from "./db.ts";
import { companyAccess, currentActor } from "./policies/access.ts";
import { audit } from "./services/audit.ts";
import { HttpError } from "./errors.ts";
import { readItems } from "./services/items.ts";
import { directoryEntries, assertDirectoryAccess } from "./services/pages.ts";
import { canReadItemCoverage, addItemCoverageToPage, itemCoverageJoin } from "./services/item-coverage.ts";
import { stagedDailyActivitySql, activityColumns } from "./services/staged-activity-sql.ts";
import { searchPattern } from "./services/lists.ts";

const optionalNumber = z.preprocess(
  value => value === "" ? undefined : value,
  z.string().regex(/^-?\d{1,15}(?:\.\d{1,6})?$/, "أدخل عددًا صالحًا حتى 6 منازل عشرية").optional(),
);
// Ignore unrelated URL parameters in this read-only report rather than
// returning a generic validation error. Known filter values remain validated.
const querySchema = z.object({
  q: z.string().trim().max(120).default(""),
  active: z.enum(["active", "archived", "all"]).default("active"),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(20).max(100).default(50),
  stockMin: optionalNumber, stockMax: optionalNumber,
  reserveMin: optionalNumber, reserveMax: optionalNumber,
  purchaseFactorMin: optionalNumber, purchaseFactorMax: optionalNumber,
  monthMin: optionalNumber, monthMax: optionalNumber,
  fourMonthsMin: optionalNumber, fourMonthsMax: optionalNumber,
  allTimeMin: optionalNumber, allTimeMax: optionalNumber,
  previousYearMin: optionalNumber, previousYearMax: optionalNumber,
  coverageMin: optionalNumber, coverageMax: optionalNumber,
  reserveCoverageMin: optionalNumber, reserveCoverageMax: optionalNumber,
  purchaseFactorCoverageMin: optionalNumber, purchaseFactorCoverageMax: optionalNumber,
  excludeZero: z.enum(["true", "false"]).default("false").transform(v => v === "true"),
  useReserve: z.enum(["true", "false"]).default("true").transform(v => v === "true"),
  sortBy: z.enum(["code", "name", "stock", "reserve", "purchaseFactor", "month", "fourMonths", "allTime", "previousYear", "coverage", "reserveCoverage", "purchaseFactorCoverage"]).default("code"),
  sortDir: z.enum(["asc", "desc"]).default("asc"),
}).strip();
type Options = z.infer<typeof querySchema>;

async function filteredItems(
  client: PoolClient, user: ReturnType<typeof actor>, companyId: number,
  options: Options, unselectedForDraft = false,
) {
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
  const values: Array<string | number> = [companyId, asOf,
    options.q ? searchPattern(options.q, true) : "", options.active];
  const predicates: string[] = [];
  const range = (value: string | undefined, column: string, op: ">=" | "<=") => {
    if (value === undefined) return;
    values.push(value);
    predicates.push(`${column} ${op} $${values.length}::numeric`);
  };
  range(options.stockMin, "m.available_unit1", ">=");
  range(options.stockMax, "m.available_unit1", "<=");
  range(options.reserveMin, "m.reserve_quantity", ">=");
  range(options.reserveMax, "m.reserve_quantity", "<=");
  range(options.purchaseFactorMin, "m.purchase_factor", ">=");
  range(options.purchaseFactorMax, "m.purchase_factor", "<=");
  range(options.monthMin, "m.sale_times_month", ">=");
  range(options.monthMax, "m.sale_times_month", "<=");
  range(options.fourMonthsMin, "m.sale_times_four_months", ">=");
  range(options.fourMonthsMax, "m.sale_times_four_months", "<=");
  range(options.allTimeMin, "m.sale_times_all_time", ">=");
  range(options.allTimeMax, "m.sale_times_all_time", "<=");
  range(options.previousYearMin, "m.sale_times_previous_year", ">=");
  range(options.previousYearMax, "m.sale_times_previous_year", "<=");
  if (options.excludeZero) predicates.push("m.available_smallest <> 0");

  // The existing item coverage calculation is only joined before pagination
  // when the user filters on coverage; otherwise enrich the 20-100 rows returned.
  const needsCoverageJoin = [
    options.coverageMin, options.coverageMax,
    options.reserveCoverageMin, options.reserveCoverageMax,
    options.purchaseFactorCoverageMin, options.purchaseFactorCoverageMax,
  ].some(value => value !== undefined)
    || ["coverage", "reserveCoverage", "purchaseFactorCoverage"].includes(options.sortBy);
  const coverageColumn = options.useReserve ? "m.coverage_after_reserve" : "m.coverage_before";
  range(options.coverageMin, coverageColumn, ">=");
  range(options.coverageMax, coverageColumn, "<=");
  range(options.reserveCoverageMin, "m.reserve_coverage_days", ">=");
  range(options.reserveCoverageMax, "m.reserve_coverage_days", "<=");
  range(options.purchaseFactorCoverageMin, "m.purchase_factor_coverage_days", ">=");
  range(options.purchaseFactorCoverageMax, "m.purchase_factor_coverage_days", "<=");
  const orders: Record<Options["sortBy"], string> = {
    code: "f.code", name: "f.name", stock: "f.available_unit1",
    reserve: "f.reserve_quantity", purchaseFactor: "f.purchase_factor", previousYear: "f.sale_times_previous_year",
    month: "f.sale_times_month", fourMonths: "f.sale_times_four_months",
    allTime: "f.sale_times_all_time",
    coverage: options.useReserve ? "f.coverage_after_reserve" : "f.coverage_before",
    reserveCoverage: "f.reserve_coverage_days", purchaseFactorCoverage: "f.purchase_factor_coverage_days",
  };
  const order = `${orders[options.sortBy]} ${options.sortDir === "asc" ? "ASC" : "DESC"}${options.sortBy === "previousYear" ? " NULLS LAST" : ""}, f.code ASC, f.id ASC`;
  // Draft export deliberately ignores list pagination; its entire filtered
  // company-wide complement is fetched in ONE authorized query. Never quietly
  // return only the first 50/100 or truncate a large result.
  if (!unselectedForDraft)
    values.push(options.pageSize, (options.page - 1) * options.pageSize);
  const limit = `$${values.length - 1}`, offset = `$${values.length}`;
  const sql = `
    WITH candidate AS (
      SELECT i.id, i.company_id, i.code, i.name, i.active, i.revision,
             i.unit1_name,i.unit2_name,i.unit3_name,i.factor2,i.factor3,i.reserve_quantity,i.purchase_factor,
             COALESCE(previous.sale_times,0) AS sale_times_previous_year,
             (COALESCE(stock.stock_showroom,0)+COALESCE(stock.stock_warehouse,0)) AS available_smallest
      FROM items i
      LEFT JOIN item_statistics stock ON stock.company_id=i.company_id AND stock.item_id=i.id
      LEFT JOIN company_item_previous_year_sale_times previous
        ON previous.company_id=i.company_id AND previous.legacy_id=i.legacy_id
      WHERE i.company_id=$1
        AND ($3::text='' OR i.code ILIKE $3 OR i.name ILIKE $3
             OR EXISTS (SELECT 1 FROM items source_item WHERE source_item.id=i.id
                        AND source_item.company_id=i.company_id
                        AND (source_item.english_name ILIKE $3
                             OR source_item.barcode ILIKE $3)))
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
               ? "coverage.approximate_coverage_days AS coverage_before, coverage.coverage_after_reserve_days AS coverage_after_reserve, coverage.reserve_coverage_days, coverage.purchase_factor_coverage_days"
               : "NULL::numeric AS coverage_before, NULL::numeric AS coverage_after_reserve, NULL::numeric AS reserve_coverage_days, NULL::numeric AS purchase_factor_coverage_days"}
      FROM candidate i LEFT JOIN sales s ON s.item_id=i.id
      ${needsCoverageJoin ? itemCoverageJoin : ""}
    ),
    filtered AS (SELECT * FROM metrics m ${predicates.length ? `WHERE ${predicates.join(" AND ")}` : ""})
    ${unselectedForDraft ? `
    SELECT f.id, f.code, f.name
    FROM filtered f
    WHERE NOT EXISTS (
      SELECT 1 FROM company_item_temporary_selections chosen
      WHERE chosen.company_id=$1 AND chosen.item_id=f.id
    )
    ORDER BY ${order} LIMIT 50001
    ` : `
    SELECT counts.total, f.*
    FROM (SELECT COUNT(*)::integer AS total FROM filtered) counts
    LEFT JOIN LATERAL (SELECT * FROM filtered f ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}) f ON TRUE
    `}`;
  const rows = (await client.query(sql, values)).rows;
  if (unselectedForDraft) {
    if (rows.length > 50000) throw new HttpError(413, "too_many_draft_items",
      "تتجاوز القائمة 50000 صنف غير مختار؛ ضيّق خيارات التصفية ثم أعد المحاولة. لم تُضف مسودة جزئية.");
    return {
      items: rows.map(row => ({
        id: Number(row.id), code: String(row.code), name: String(row.name),
      })),
      total: rows.length,
      asOf,
    };
  }
  const selected = rows.filter(row => row.id !== null).map(row => ({
    id: Number(row.id), code: String(row.code), name: String(row.name),
    active: Boolean(row.active), revision: Number(row.revision),
    reserveQuantity: String(row.reserve_quantity), purchaseFactor: Number(row.purchase_factor),
    factor2: Number(row.factor2), factor3: Number(row.factor3),
    availableSmallest: String(row.available_smallest),
    availableUnit1: String(row.available_unit1),
    saleTimesMonth: String(row.sale_times_month),
    saleTimesFourMonths: String(row.sale_times_four_months),
    saleTimesAllTime: String(row.sale_times_all_time),
    saleTimesPreviousYear: String(row.sale_times_previous_year),
    approximateCoverageDays: needsCoverageJoin ? String(row.coverage_before) : null,
    coverageAfterReserveDays: needsCoverageJoin ? String(row.coverage_after_reserve) : null,
    reserveCoverageDays: needsCoverageJoin ? String(row.reserve_coverage_days) : null,
    purchaseFactorCoverageDays: needsCoverageJoin ? String(row.purchase_factor_coverage_days) : null,
  }));
  const enriched = needsCoverageJoin ? selected
    : await addItemCoverageToPage(client, companyId, selected);
  return {
    rows: enriched.map(row => ({
      itemId: row.id, code: row.code, name: row.name, active: row.active,
      revision: row.revision, reserveQuantity: row.reserveQuantity,
      purchaseFactor: row.purchaseFactor,
      factor2: row.factor2, factor3: row.factor3,
      availableSmallest: row.availableSmallest, availableUnit1: row.availableUnit1,
      saleTimesMonth: row.saleTimesMonth,
      saleTimesFourMonths: row.saleTimesFourMonths,
      saleTimesAllTime: row.saleTimesAllTime, saleTimesPreviousYear: row.saleTimesPreviousYear,
      approximateCoverageDays: row.approximateCoverageDays,
      coverageAfterReserveDays: row.coverageAfterReserveDays,
      reserveCoverageDays: row.reserveCoverageDays,
      purchaseFactorCoverageDays: row.purchaseFactorCoverageDays,
    })),
    total: Number(rows[0]?.total ?? 0), page: options.page,
    pageSize: options.pageSize, asOf,
  };
}

/** Read-only, company-scoped, server-paginated stock and sales filters. */
export function itemOptionsListRoutes(pool: Pool): Router {
  const router = Router();
  const presetsPath = "/companies/:companyId/item-options-list/presets";
  // Presets are shared across every user/device of this company, never attached
  // to a user's local storage or used as a substitute for item access rights.
  const checkPresetsAccess = async (
    client: PoolClient, req: Request, companyId: number,
    edit = false,
  ) => {
    const user = await currentActor(client, actor(req));
    await companyAccess(client, user, companyId, "items.view");
    const entries = await directoryEntries(client, user, companyId);
    const listPage = entries.find(page => page.key === "company.item-options-list");
    if (!listPage) throw new HttpError(403, "forbidden", "قائمة الأصناف غير متاحة");
    assertDirectoryAccess(listPage, edit && !user.owner ? "edit" : "view");
    return user;
  };
  router.get(presetsPath, handler(async (req, res) => {
    const companyId = id(req.params.companyId);
    const items = await transaction(pool, async client => {
      await checkPresetsAccess(client, req, companyId);
      const rows = await client.query(
        `SELECT p.id,p.name,p.filters,p.created_by,p.created_at,
                COALESCE(NULLIF(u.display_name,''),u.name) AS created_by_name
           FROM company_item_options_presets p
           JOIN users u ON u.id=p.created_by
          WHERE p.company_id=$1 ORDER BY lower(p.name),p.id`,
        [companyId],
      );
      return rows.rows.map(row => ({
        id: Number(row.id), name: String(row.name),
        filters: itemOptionsPresetFiltersSchema.parse(row.filters),
        createdBy: Number(row.created_by),
        createdByName: String(row.created_by_name),
        createdAt: (row.created_at as Date).toISOString(),
      }));
    });
    res.json({ items });
  }));
  router.post(presetsPath, handler(async (req, res) => {
    const companyId = id(req.params.companyId);
    const input = parse(itemOptionsPresetCreateSchema, req.body);
    const saved = await transaction(pool, async client => {
      const user = await checkPresetsAccess(client, req, companyId);
      // A case-insensitive unique index also resolves simultaneous submissions.
      const inserted = await client.query(
        `INSERT INTO company_item_options_presets(company_id,name,filters,created_by)
         VALUES($1,$2,$3::jsonb,$4)
         ON CONFLICT DO NOTHING RETURNING id,name,created_at`,
        [companyId,input.name,JSON.stringify(input.filters),user.id],
      );
      if (!inserted.rowCount) throw new HttpError(409, "preset_exists",
        "يوجد فلتر محفوظ بنفس الاسم في هذه الشركة؛ اختر اسمًا مختلفًا.");
      const row = inserted.rows[0];
      await audit(client,user,"item.options-preset.create","itemOptionsPreset",
        Number(row.id),null,{name:input.name,filters:input.filters},companyId);
      return {id:Number(row.id),name:String(row.name),filters:input.filters,
        createdBy:user.id,createdByName:user.displayName,
        createdAt:(row.created_at as Date).toISOString()};
    });
    res.status(201).json({ item:saved });
  }));
  router.delete(`${presetsPath}/:presetId`, handler(async (req, res) => {
    const companyId = id(req.params.companyId);
    const presetId = id(req.params.presetId);
    await transaction(pool, async client => {
      const user = await checkPresetsAccess(client, req, companyId, true);
      const deleted = await client.query(
        "DELETE FROM company_item_options_presets WHERE id=$1 AND company_id=$2 RETURNING id,name,filters",
        [presetId,companyId],
      );
      if (!deleted.rowCount) throw new HttpError(404,"preset_not_found","الفلتر المحفوظ غير موجود");
      await audit(client,user,"item.options-preset.delete","itemOptionsPreset",presetId,
        {name:deleted.rows[0].name,filters:deleted.rows[0].filters},null,companyId);
    });
    res.json({ok:true});
  }));
  // Update only reserve quantity; respect card revision and audit every edit.
  // Never send the full card on a row-level edit.
  router.patch("/companies/:companyId/items/:itemId/reserve-quantity", handler(async (req, res) => {
    const companyId = id(req.params.companyId);
    const itemId = id(req.params.itemId);
    const input = parse(z.object({
      revision: z.number().int().positive(),
      reserveQuantity: itemWholeQuantitySchema,
    }).strict(), req.body);
    const result = await transaction(pool, async client => {
      const user = await currentActor(client, actor(req));
      // This report has a separately configurable "edit" permission:
      // the company can grant stock-reserve editing to a sales position
      // without having to grant broader item-master management permissions.
      await companyAccess(client, user, companyId, "items.view");
      const entries = await directoryEntries(client, user, companyId);
      const listPage = entries.find(page => page.key === "company.item-options-list");
      if (!listPage) throw new HttpError(403, "forbidden", "قائمة الأصناف غير متاحة");
      assertDirectoryAccess(listPage, "edit");
      const row = (await client.query(
        "SELECT revision, reserve_quantity FROM items WHERE company_id=$1 AND id=$2 FOR UPDATE",
        [companyId, itemId],
      )).rows[0];
      if (!row) throw new HttpError(404, "item_not_found", "الصنف غير موجود");
      if (Number(row.revision) !== input.revision)
        throw new HttpError(409, "stale_item", "عُدّل كرت الصنف من مستخدم آخر؛ حدّث القائمة ثم حاول مجددًا.");
      if (String(row.reserve_quantity) === input.reserveQuantity)
        return { itemId, revision: Number(row.revision), reserveQuantity: input.reserveQuantity };
      const updated = (await client.query(
        `UPDATE items SET reserve_quantity=$3::numeric,
             revision=revision+1, updated_at=clock_timestamp()
         WHERE company_id=$1 AND id=$2 AND revision=$4
         RETURNING revision,reserve_quantity`,
        [companyId, itemId, input.reserveQuantity, input.revision],
      )).rows[0];
      if (!updated) throw new HttpError(409, "stale_item", "تغيرت نسخة الصنف؛ حدّث القائمة.");
      await audit(client, user, "item.field.update", "item", itemId,
        { field: "reserveQuantity", value: String(row.reserve_quantity) },
        { field: "reserveQuantity", value: String(updated.reserve_quantity) }, companyId);
      return { itemId, revision: Number(updated.revision), reserveQuantity: String(updated.reserve_quantity) };
    });
    res.json({ result });
  }));

  // Planning/reference value only: never touch inventory or invoice pricing.
  router.patch("/companies/:companyId/items/:itemId/purchase-factor", handler(async (req, res) => {
    const companyId = id(req.params.companyId);
    const itemId = id(req.params.itemId);
    const input = parse(z.object({
      revision: z.number().int().positive(),
      purchaseFactor: itemFactorSchema,
    }).strict(), req.body);
    const result = await transaction(pool, async client => {
      const user = await currentActor(client, actor(req));
      await companyAccess(client, user, companyId, "items.view");
      const entries = await directoryEntries(client, user, companyId);
      const listPage = entries.find(page => page.key === "company.item-options-list");
      if (!listPage) throw new HttpError(403, "forbidden", "قائمة الأصناف غير متاحة");
      assertDirectoryAccess(listPage, "edit");
      const row = (await client.query(
        "SELECT revision, purchase_factor FROM items WHERE company_id=$1 AND id=$2 FOR UPDATE",
        [companyId, itemId],
      )).rows[0];
      if (!row) throw new HttpError(404, "item_not_found", "الصنف غير موجود");
      if (Number(row.revision) !== input.revision)
        throw new HttpError(409, "stale_item", "عُدّل كرت الصنف من مستخدم آخر؛ حدّث القائمة ثم حاول مجددًا.");
      if (Number(row.purchase_factor) === input.purchaseFactor)
        return { itemId, revision: Number(row.revision), purchaseFactor: input.purchaseFactor };
      const updated = (await client.query(
        `UPDATE items SET purchase_factor=$3::integer,
              revision=revision+1, updated_at=clock_timestamp()
          WHERE company_id=$1 AND id=$2 AND revision=$4
          RETURNING revision,purchase_factor`,
        [companyId, itemId, input.purchaseFactor, input.revision],
      )).rows[0];
      if (!updated) throw new HttpError(409, "stale_item", "تغيرت نسخة الصنف؛ حدّث القائمة.");
      await audit(client, user, "item.field.update", "item", itemId,
        { field: "purchaseFactor", value: Number(row.purchase_factor) },
        { field: "purchaseFactor", value: Number(updated.purchase_factor) }, companyId);
      return { itemId, revision: Number(updated.revision), purchaseFactor: Number(updated.purchase_factor) };
    });
    res.json({ result });
  }));
  // This read-only endpoint uses exactly the same applied filters/sort as the
  // table, but excludes the shared selection at SQL level on EVERY page.
  // It never creates a purchase order or changes shared checkmarks.
  router.get("/companies/:companyId/item-options-list/unselected", handler(async (req, res) => {
    const options = parse(querySchema, req.query);
    const result = await readItems(pool, req,
      (client, companyId) => filteredItems(client, actor(req), companyId, options, true));
    res.json({ result });
  }));
  router.get("/companies/:companyId/item-options-list", handler(async (req, res) => {
    const options = parse(querySchema, req.query);
    const result = await readItems(pool, req,
      (client, companyId) => filteredItems(client, actor(req), companyId, options));
    res.json({ result });
  }));
  return router;
}
