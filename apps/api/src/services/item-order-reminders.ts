import type { PoolClient } from "pg";
import { scanGroupedStockAlert } from "./grouped-stock-alerts.ts";

/** Legacy export retained for the hourly company notification worker.
 * All configured special-item order limits now produce ONE aggregate
 * notification per company, not independent item alerts.
 * The interval is configured on the ITEM_ORDER_LEVEL notification card.
 */
export async function scanDailyItemOrderReminders(
  client: PoolClient, companyId: number,
): Promise<number> {
  return scanGroupedStockAlert(client,companyId,"ITEM_ORDER_LEVEL");
}
