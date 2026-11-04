import type { PoolClient } from "pg";
import type { ItemCoverage, User } from "../../../../packages/contracts/src/index.ts";
import { normalizeRate } from "../../../../packages/contracts/src/index.ts";
import { directoryEntries } from "./pages.ts";
import { missing } from "../errors.ts";

/** Current directory flags and explicit denies apply to every derived value. */
export async function canReadItemStock(
  client: PoolClient,
  user: User,
  companyId: number,
): Promise<boolean> {
  const pages = await directoryEntries(client, user, companyId);
  return ["company.stock-balances", "company.stock-movements"]
    .every(key => !!pages.find(page => page.key === key)?.actionAccess.view);
}

export async function canReadItemCoverage(
  client: PoolClient,
  user: User,
  companyId: number,
): Promise<boolean> {
  const pages = await directoryEntries(client, user, companyId);
  return [
    "company.stock-balances", "company.stock-movements",
    "company.sales", "company.purchases", "company.invoice",
  ].every(key => !!pages.find(page => page.key === key)?.actionAccess.view);
}

// The same expressions serve the primary list (including numeric sorting) and
// item card. Daily facts use exact smallest-unit quantities and positive returns.
// Calendar windows match the existing activity card; 30/120 are the requested
// daily-rate divisors. No invoices are scanned by these reads.
export const itemCoverageJoin = `
 LEFT JOIN item_statistics coverage_stock
   ON coverage_stock.company_id=i.company_id AND coverage_stock.item_id=i.id
 CROSS JOIN LATERAL (
   SELECT coalesce(sum(d.sale_quantity-d.sale_return_quantity) FILTER (
       WHERE d.document_date >= ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Aden')::date
         - interval '1 month' + interval '1 day')::date
     ),0) AS month_sales,
     coalesce(sum(d.sale_quantity-d.sale_return_quantity),0) AS four_month_sales
   FROM item_daily_activity d
   WHERE d.company_id=i.company_id AND d.item_id=i.id
     AND d.document_date <= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Aden')::date
     AND d.document_date >= ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Aden')::date
       - interval '4 months' + interval '1 day')::date
 ) coverage_sales
 CROSS JOIN LATERAL (
   SELECT CASE WHEN coverage_sales.month_sales < 2
       THEN coverage_sales.four_month_sales ELSE coverage_sales.month_sales END AS sales,
     CASE WHEN coverage_sales.month_sales < 2 THEN 120 ELSE 30 END AS days,
     -- Returns locations remain included in physical stock but are not
     -- available for sufficiency. Both coverage fields use the same scope.
     (coalesce(coverage_stock.stock_showroom,0)+
      coalesce(coverage_stock.stock_warehouse,0)) AS quantity,
     greatest(coalesce(coverage_stock.stock_showroom,0)+
       coalesce(coverage_stock.stock_warehouse,0)-i.reserve_quantity,0) AS after_reserve
 ) coverage_rate
 CROSS JOIN LATERAL (
   SELECT CASE WHEN coverage_rate.sales <= 0 THEN 9999::numeric
       ELSE round(coverage_rate.quantity * coverage_rate.days / coverage_rate.sales,2)
     END AS approximate_coverage_days,
     CASE WHEN coverage_rate.after_reserve = 0 THEN 0::numeric
       WHEN coverage_rate.sales <= 0 THEN 9999::numeric
       ELSE round(coverage_rate.after_reserve * coverage_rate.days / coverage_rate.sales,2)
     END AS coverage_after_reserve_days,
     CASE WHEN i.reserve_quantity <= 0 THEN 0::numeric
       WHEN coverage_rate.sales <= 0 THEN 9999::numeric
       ELSE round(i.reserve_quantity * coverage_rate.days / coverage_rate.sales,2)
     END AS reserve_coverage_days,
     CASE WHEN i.purchase_factor <= 0 THEN 0::numeric
       WHEN coverage_rate.sales <= 0 THEN 9999::numeric
       ELSE round(i.purchase_factor * coverage_rate.days / coverage_rate.sales,2)
     END AS purchase_factor_coverage_days
 ) coverage`;

export const itemCoverageSelect =
  ",coverage.approximate_coverage_days::text AS approximate_coverage_days,coverage.coverage_after_reserve_days::text AS coverage_after_reserve_days";
export const itemCoverageRedactedSelect =
  ",NULL::text AS approximate_coverage_days,NULL::text AS coverage_after_reserve_days";

/** Enrich only the selected page when coverage is not part of SQL ordering.
 * The caller must first establish the current joint inventory/commerce access.
 * The surrounding repeatable-read transaction keeps list and coverage aligned.
 */
export async function addItemCoverageToPage<T extends { id: number }>(
  client: PoolClient,
  companyId: number,
  items: T[],
  itemIdOf: (item: T) => number = item => item.id,
): Promise<Array<T & Pick<ItemCoverage, "approximateCoverageDays" | "coverageAfterReserveDays"> & {
  reserveCoverageDays: string | null;
  purchaseFactorCoverageDays: string | null;
}>> {
  if (!items.length) return [];
  const rows = (await client.query(
    `SELECT i.id ${itemCoverageSelect},
       coverage.reserve_coverage_days::text AS reserve_coverage_days,
       coverage.purchase_factor_coverage_days::text AS purchase_factor_coverage_days
     FROM items i ${itemCoverageJoin}
     WHERE i.company_id=$1 AND i.id=ANY($2::integer[])`,
    [companyId, items.map(itemIdOf)],
  )).rows;
  const values = new Map(rows.map(row => [row.id as number, {
    approximateCoverageDays: normalizeRate(row.approximate_coverage_days),
    coverageAfterReserveDays: normalizeRate(row.coverage_after_reserve_days),
    reserveCoverageDays: normalizeRate(row.reserve_coverage_days),
    purchaseFactorCoverageDays: normalizeRate(row.purchase_factor_coverage_days),
  }]));
  return items.map(item => ({
    ...item,
    ...(values.get(itemIdOf(item)) ?? {
      approximateCoverageDays: null, coverageAfterReserveDays: null,
      reserveCoverageDays: null, purchaseFactorCoverageDays: null,
    }),
  }));
}


/**
 * Read-only replenishment estimate for the selected item-options page.
 * Required quantity is DISPLAYED in the first purchase unit as a WHOLE
 * number. The suggested quantity in smallest units is rounded up to the
 * least common multiple of factor2*factor3 and purchaseFactor, preserving
 * whole first units and the existing minimum purchase lot simultaneously.
 * Item purchase_price is per first purchase unit, not per smallest unit.
 * No stock or financial postings result from these figures.
 */
export async function requiredPurchaseQuantitiesToPage(
  client: PoolClient,
  companyId: number,
  itemIds: number[],
  targetDays: string,
  useReserve: boolean,
): Promise<Map<number, {
  requiredPurchaseQuantity: string;
  requiredPurchaseValue: string;
  coverageWithRequiredDays: string;
}>> {
  if (!itemIds.length) return new Map();
  const rows = (await client.query(
    `SELECT i.id,
       (requested.quantity_smallest / purchase_lot.first_unit_smallest)::text
         AS required_purchase_quantity,
       round(i.purchase_price::numeric
         * (requested.quantity_smallest / purchase_lot.first_unit_smallest),4)::text
         AS required_purchase_value,
       CASE
         WHEN coverage_rate.sales <= 0 THEN
           CASE WHEN greatest(coverage_rate.quantity + requested.quantity_smallest
             - CASE WHEN $4::boolean THEN i.reserve_quantity ELSE 0::numeric END,0) = 0
             THEN 0::numeric ELSE 9999::numeric END
         ELSE round(greatest(coverage_rate.quantity + requested.quantity_smallest
             - CASE WHEN $4::boolean THEN i.reserve_quantity ELSE 0::numeric END,0)
             * coverage_rate.days / coverage_rate.sales,2)
       END::text AS coverage_with_required_days
     FROM items i ${itemCoverageJoin}
     CROSS JOIN LATERAL (
       SELECT greatest((i.factor2::bigint * i.factor3::bigint),1)::numeric
                AS first_unit_smallest,
         lcm(greatest(i.purchase_factor::bigint,1),
           greatest(i.factor2::bigint * i.factor3::bigint,1))::numeric
                AS minimum_lot_smallest
     ) purchase_lot
     CROSS JOIN LATERAL (
       SELECT greatest(1::numeric, ceil(greatest(0::numeric,
         coverage_rate.sales * greatest($3::numeric,0) / coverage_rate.days
         + CASE WHEN $4::boolean THEN i.reserve_quantity ELSE 0::numeric END
         - coverage_rate.quantity
       ) / purchase_lot.minimum_lot_smallest)) * purchase_lot.minimum_lot_smallest
         AS quantity_smallest
     ) requested
     WHERE i.company_id=$1 AND i.id=ANY($2::integer[])`,
    [companyId, itemIds, targetDays, useReserve],
  )).rows;
  const trimZeros = (value: unknown) => String(value).includes(".")
    ? String(value).replace(/0+$/, "").replace(/\.$/, "") : String(value);
  return new Map(rows.map(row => [
    Number(row.id), {
      requiredPurchaseQuantity: trimZeros(row.required_purchase_quantity),
      requiredPurchaseValue: trimZeros(row.required_purchase_value),
      coverageWithRequiredDays: trimZeros(row.coverage_with_required_days),
    },
  ]));
}

export async function readItemCoverage(
  client: PoolClient,
  user: User,
  companyId: number,
  itemId: number,
): Promise<ItemCoverage> {
  const canViewCoverage = await canReadItemCoverage(client, user, companyId);
  const row = (await client.query(
    `SELECT i.id,i.unit1_name,i.unit2_name,i.unit3_name,i.factor2,i.factor3,
      (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Aden')::date::text AS as_of
      ${canViewCoverage ? itemCoverageSelect : itemCoverageRedactedSelect}
     FROM items i ${canViewCoverage ? itemCoverageJoin : ""}
     WHERE i.company_id=$1 AND i.id=$2`,
    [companyId, itemId],
  )).rows[0];
  if (!row) missing();
  return {
    companyId,
    itemId,
    asOf: row.as_of,
    unitName: row.factor3 > 1 ? row.unit3_name : row.factor2 > 1 ? row.unit2_name : row.unit1_name,
    canViewCoverage,
    approximateCoverageDays: row.approximate_coverage_days === null
      ? null : normalizeRate(row.approximate_coverage_days),
    coverageAfterReserveDays: row.coverage_after_reserve_days === null
      ? null : normalizeRate(row.coverage_after_reserve_days),
  };
}
