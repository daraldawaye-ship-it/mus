import type { PoolClient } from "pg";

export type MyCashboxTransferKind = "pouch" | "electronic";
type TransferRow = {
  id: number;
  kind: MyCashboxTransferKind;
  amount: string;
  notes: string;
  createdAt: string;
};
type TransferSummary = { total: string; count: number; items: TransferRow[] };
type CloseRow = {
  id: number;
  countedCash: string;
  bookBalance: string;
  difference: string;
  shortage: string;
  surplus: string;
  notes: string;
  createdAt: string;
};
type ClosingSummary = {
  count: number;
  shortageTotal: string;
  surplusTotal: string;
  items: CloseRow[];
};

const millisecondsPerHour = 60 * 60 * 1000;
const iso = (date: Date | string) => new Date(date).toISOString();

/**
 * Cashier-only reporting: pouch/electronic transfers in the rolling previous
 * 24 hours; shortage/overage from closings during the previous 14 hours.
 * Last closing no longer resets transfer history. Everything is read-only,
 * scoped to the authenticated employee, and uses a single database timestamp
 * so totals and paginated previews refer to identical periods.
 */
export async function listMyCashboxTransfers(
  client: PoolClient, companyId: number, userId: number,
) {
  const employee = (await client.query(
    "SELECT id FROM employees WHERE company_id=$1 AND user_id=$2 AND active LIMIT 1",
    [companyId, userId],
  )).rows[0];
  const empty = (): TransferSummary => ({ total: "0", count: 0, items: [] });
  const emptyClosings = (): ClosingSummary => ({
    count: 0, shortageTotal: "0", surplusTotal: "0", items: [],
  });
  if (!employee) return {
    hasEmployee: false,
    transferWindowStartAt: null as string | null,
    closingWindowStartAt: null as string | null,
    pouch: empty(), electronic: empty(), closings: emptyClosings(),
  };

  const asOf: Date = (await client.query(
    "SELECT clock_timestamp() AS as_of",
  )).rows[0].as_of;
  const windowEndAt = iso(asOf);
  const transferWindowStartAt = new Date(asOf.getTime() - 24 * millisecondsPerHour).toISOString();
  const closingWindowStartAt = new Date(asOf.getTime() - 14 * millisecondsPerHour).toISOString();
  const params = [companyId, employee.id, transferWindowStartAt, windowEndAt];
  const predicate = `company_id=$1 AND employee_id=$2
    AND created_at >= $3::timestamptz AND created_at <= $4::timestamptz
    AND kind IN ('pouch','electronic')`;
  const totals = await client.query(
    `SELECT kind,count(*)::int AS count,COALESCE(sum(amount),0)::text AS total
     FROM employee_cashbox_operations WHERE ${predicate} GROUP BY kind`,params,
  );
  // Totals/counts are complete; the preview shows the latest 50 transfers
  // per kind and never silently truncates aggregate amounts.
  const movements = await client.query(
    `SELECT id,kind,amount::text AS amount,notes,created_at AS "createdAt" FROM (
       SELECT id,kind,amount,notes,created_at,
         row_number() OVER(PARTITION BY kind ORDER BY created_at DESC,id DESC) AS rank
       FROM employee_cashbox_operations WHERE ${predicate}
     ) recent WHERE rank<=50 ORDER BY kind,"createdAt" DESC,id DESC`,params,
  );
  const closingParams = [companyId, employee.id, closingWindowStartAt, windowEndAt];
  const closingPredicate = `company_id=$1 AND employee_id=$2
    AND created_at >= $3::timestamptz AND created_at <= $4::timestamptz
    AND kind='close'`;
  // Persisted variance_amount = book balance - actual counted cash.
  // Positive is a shortage, negative an overage; no client-side float math.
  const closeTotals = await client.query(
    `SELECT count(*)::int AS count,
      COALESCE(sum(GREATEST(variance_amount,0)),0)::text AS "shortageTotal",
      COALESCE(sum(GREATEST(-variance_amount,0)),0)::text AS "surplusTotal"
     FROM employee_cashbox_operations WHERE ${closingPredicate}`,closingParams,
  );
  const closeItems = await client.query(
    `SELECT id,amount::text AS "countedCash",
      book_balance::text AS "bookBalance",
      variance_amount::text AS difference,
      GREATEST(variance_amount,0)::text AS shortage,
      GREATEST(-variance_amount,0)::text AS surplus,
      notes,created_at AS "createdAt"
     FROM employee_cashbox_operations WHERE ${closingPredicate}
     ORDER BY created_at DESC,id DESC LIMIT 50`,closingParams,
  );
  const pouch = empty(), electronic = empty(), closings = emptyClosings();
  for (const row of totals.rows) {
    const target = row.kind === "pouch" ? pouch : electronic;
    target.count = row.count;
    target.total = row.total;
  }
  for (const row of movements.rows) {
    const target = row.kind === "pouch" ? pouch : electronic;
    target.items.push({
      id: row.id, kind: row.kind, amount: row.amount, notes: row.notes,
      createdAt: iso(row.createdAt),
    });
  }
  const closeSummary = closeTotals.rows[0];
  if (closeSummary) {
    closings.count = closeSummary.count;
    closings.shortageTotal = closeSummary.shortageTotal;
    closings.surplusTotal = closeSummary.surplusTotal;
  }
  for (const row of closeItems.rows) {
    closings.items.push({
      id: row.id, countedCash: row.countedCash, bookBalance: row.bookBalance,
      difference: row.difference, shortage: row.shortage, surplus: row.surplus,
      notes: row.notes, createdAt: iso(row.createdAt),
    });
  }
  return {
    hasEmployee: true,
    transferWindowStartAt, closingWindowStartAt,
    pouch, electronic, closings,
  };
}
