import type { PoolClient } from "pg";
import type {
  AccountAssignedStockValue,
  AccountStatisticsComponentMetadata,
  User,
} from "../../../../packages/contracts/src/index.ts";
import { directoryEntries } from "./pages.ts";
import { conflict } from "./masters.ts";

const decimal = (value: string): string => {
  const normalized = value.includes(".")
    ? value.replace(/0+$/, "").replace(/\.$/, "")
    : value;
  return normalized === "-0" ? "0" : normalized;
};

/** Caller holds the current actor/company locks and the base account read grant. */
export async function readAccountStockValue(
  client: PoolClient,
  user: User,
  companyId: number,
  accountId: number,
): Promise<{
  availability: "available" | "restricted";
  stock: AccountAssignedStockValue | null;
  metadata: AccountStatisticsComponentMetadata | null;
}> {
  const pages = await directoryEntries(client, user, companyId);
  const canRead = [
    "company.items",
    "company.stock-balances",
    "company.stock-movements",
  ].every((key) =>
    pages.some((page) => page.key === key && page.actionAccess.view),
  );
  if (!canRead)
    return { availability: "restricted", stock: null, metadata: null };

  const refreshed = await client.query(
    "SELECT refresh_account_stock_statistics($1,$2) AS ready",
    [companyId, accountId],
  );
  if (!refreshed.rows[0].ready)
    conflict("تعذر احتساب قيمة الأصناف بالعملة الأساسية الحالية");
  const row = (
    await client.query(
      `SELECT stock_value_base,stock_confirmed_value_base,
      stock_inferred_value_base,stock_assigned_items_count,stock_inferred_items_count,
      stock_negative_items_count,stock_negative_value_base,stock_currency_id,
      stock_currency_code,stock_currency_decimal_places,stock_state,
      stock_computed_revision,stock_as_of_date::text AS stock_date,stock_computed_at
    FROM account_statistics WHERE company_id=$1 AND account_id=$2`,
      [companyId, accountId],
    )
  ).rows[0]!;
  const computedAt = (row.stock_computed_at as Date).toISOString();
  return {
    availability: "available",
    stock: {
      basis: "current_item_card_supplier",
      scope: "current_transaction_state",
      valuationMethod: "weighted_average",
      asOfDate: row.stock_date,
      snapshotAt: computedAt,
      currency: {
        id: row.stock_currency_id,
        code: row.stock_currency_code,
        decimalPlaces: row.stock_currency_decimal_places,
      },
      valueBase: decimal(row.stock_value_base),
      confirmedValueBase: decimal(row.stock_confirmed_value_base),
      inferredValueBase: decimal(row.stock_inferred_value_base),
      assignedItemCount: row.stock_assigned_items_count,
      inferredItemCount: row.stock_inferred_items_count,
      negativeStockItemCount: row.stock_negative_items_count,
      negativeStockValueBase: decimal(row.stock_negative_value_base),
    },
    metadata: {
      state: row.stock_state,
      computedRevision: row.stock_computed_revision,
      asOfDate: row.stock_date,
      computedAt,
    },
  };
}
