import type { PoolClient } from "pg";
import { conflict } from "./masters.ts";

/**
 * Generate codes on the server in the SAME transaction as the new card.
 * An advisory transaction lock serializes creates within each company/branch.
 * Existing user-defined codes and the special SHOWROOM code are preserved.
 *
 * Future numbered cards can use this helper after explicitly registering
 * their table, scope and prefix; never substitute a code for the DB record ID.
 */
type CardCodeScope =
  | { card: "branch"; companyId: number }
  | { card: "warehouse"; companyId: number; branchId: number };

export async function nextCardCode(
  client: PoolClient,
  scope: CardCodeScope,
): Promise<string> {
  const { companyId } = scope;
  const isBranch = scope.card === "branch";
  const branchId = isBranch ? null : scope.branchId;
  const prefix = isBranch ? "BR" : "WH";
  const digits = 8;
  const lockName = isBranch
    ? `card-code:branches:${companyId}`
    : `card-code:locations:${companyId}:${branchId}`;
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockName]);
  // Explicit table selection: no untrusted identifier interpolation.
  const result = await client.query(
    isBranch
      ? `SELECT code FROM branches
         WHERE company_id=$1 AND code ~ $2
         ORDER BY code DESC LIMIT 1`
      : `SELECT code FROM locations
         WHERE company_id=$1 AND branch_id=$3 AND code ~ $2
         ORDER BY code DESC LIMIT 1`,
    isBranch
      ? [companyId, `^${prefix}[0-9]{${digits}}$`]
      : [companyId, `^${prefix}[0-9]{${digits}}$`, branchId],
  );
  const lastCode = result.rows[0]?.code as string | undefined;
  const next = lastCode === undefined
    ? 1
    : Number(lastCode.slice(prefix.length)) + 1;
  if (!Number.isSafeInteger(next) || next >= 10 ** digits)
    conflict("نفد نطاق الأكواد التلقائية؛ يلزم توسيع ترقيم الكروت");
  return `${prefix}${String(next).padStart(digits, "0")}`;
}
