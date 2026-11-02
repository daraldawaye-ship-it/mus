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

/** Read only this logged-in employee's transfers since their most recent
 * completed till closure. Zero-closing operations still reset this timeline.
 * Querying on demand keeps the invoice's normal item search responsive.
 */
export async function listMyCashboxTransfers(
  client: PoolClient, companyId: number, userId: number,
) {
  const employee = (await client.query(
    "SELECT id FROM employees WHERE company_id=$1 AND user_id=$2 AND active LIMIT 1",
    [companyId, userId],
  )).rows[0];
  const empty = (): TransferSummary => ({ total: "0", count: 0, items: [] });
  if (!employee) return {
    hasEmployee: false, lastClosedAt: null as string | null,
    pouch: empty(), electronic: empty(),
  };

  const employeeId: number = employee.id;
  const closed = (await client.query(
    `SELECT id,created_at FROM employee_cashbox_operations
     WHERE company_id=$1 AND employee_id=$2 AND kind='close'
     ORDER BY created_at DESC,id DESC LIMIT 1`,
    [companyId, employeeId],
  )).rows[0];
  const closeTime: Date | null = closed?.created_at ?? null;
  const closeId: number | null = closed?.id ?? null;
  const params = [companyId, employeeId, closeTime, closeId];
  const predicate = `company_id=$1 AND employee_id=$2 AND kind IN ('pouch','electronic')
    AND ($3::timestamptz IS NULL OR (created_at,id)>($3::timestamptz,$4::integer))`;
  const totals = await client.query(
    `SELECT kind,count(*)::int AS count,COALESCE(sum(amount),0)::text AS total
     FROM employee_cashbox_operations WHERE ${predicate} GROUP BY kind`, params,
  );
  // Compact lists: return the latest 50 entries per category, while the total
  // and count above represent EVERY matching entry since the last close.
  const movements = await client.query(
    `SELECT id,kind,amount::text AS amount,notes,created_at AS "createdAt" FROM (
       SELECT id,kind,amount,notes,created_at,
         row_number() OVER(PARTITION BY kind ORDER BY created_at DESC,id DESC) AS rank
       FROM employee_cashbox_operations WHERE ${predicate}
     ) recent WHERE rank<=50 ORDER BY kind,"createdAt" DESC,id DESC`,params,
  );
  const pouch = empty(), electronic = empty();
  for (const row of totals.rows) {
    const target = row.kind === "pouch" ? pouch : electronic;
    target.count = row.count;
    target.total = row.total;
  }
  for (const row of movements.rows) {
    const target = row.kind === "pouch" ? pouch : electronic;
    target.items.push({
      id: row.id, kind: row.kind, amount: row.amount, notes: row.notes,
      createdAt: new Date(row.createdAt).toISOString(),
    });
  }
  return {
    hasEmployee: true,
    lastClosedAt: closeTime?.toISOString() ?? null,
    pouch, electronic,
  };
}
