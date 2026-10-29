import type { Pool } from "pg";
import { transaction } from "../db.ts";

export const OCTOBER_2026_SALES_RUN_ID = "e8669ff1-74a4-4b86-97d4-f9932e7e0807";
const SOURCE = "dar-aldawa-legacy-2026-10";
const COMPANY_ID = 2;

/**
 * One-time, owner-authorized recovery for exactly the 807 October 2026
 * staged sales that failed before the signed-fraction parser was deployed.
 * Explicit opt-in from Render environment. Atomic, strictly scoped and
 * restart-idempotent. The normal import worker posts and audits each invoice.
 */
export async function prepareOctober2026SalesRecovery(pool: Pool): Promise<boolean> {
  if (process.env.ALRAESY_RETRY_OCT2026_SALES_807 !== "1") return false;
  return transaction(pool, async client => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('alraesy:oct2026:807-sales'),$1)",
      [COMPANY_ID],
    );
    const existing = await client.query(
      "SELECT status FROM legacy_import_runs WHERE company_id=$1 AND idempotency_key=$2",
      [COMPANY_ID, OCTOBER_2026_SALES_RUN_ID],
    );
    if (existing.rowCount) return true;

    const owner = await client.query(
      "SELECT id FROM users WHERE id=1 AND owner AND NOT suspended AND NOT archived FOR UPDATE",
    );
    if (owner.rowCount !== 1) throw new Error("October sales recovery: owner unavailable");

    const scope = `s.company_id=$1 AND s.source_system=$2 AND s.source_kind='invoice'
      AND s.status='failed' AND s.posting_date >= DATE '2026-10-01'
      AND s.posting_date < DATE '2026-11-01'
      AND s.source_document->'payload'->>'kind'='sale'`;
    const check = await client.query(
      `SELECT count(*)::integer AS total,
        count(DISTINCT s.source_id)::integer AS distinct_ids,
        count(*) FILTER (WHERE m.source_id IS NOT NULL)::integer AS already_posted
       FROM legacy_import_staging s LEFT JOIN transaction_source_imports m
         ON m.company_id=s.company_id AND m.source_system=s.source_system
         AND m.source_kind=s.source_kind AND m.source_id=s.source_id
       WHERE ${scope}`,
      [COMPANY_ID, SOURCE],
    );
    const { total, distinct_ids, already_posted } = check.rows[0];
    if (total !== 807 || distinct_ids !== 807 || already_posted !== 0)
      throw new Error(`October sales recovery scope changed: ${total}/${distinct_ids}/${already_posted}`);
    const running = await client.query(
      "SELECT 1 FROM legacy_import_runs WHERE company_id=$1 AND status IN ('running','rebuilding')",
      [COMPANY_ID],
    );
    if (running.rowCount) throw new Error("October sales recovery: another import is active");

    const changed = await client.query(
      `UPDATE legacy_import_staging s SET status='pending',error_message=NULL,updated_at=clock_timestamp()
       WHERE ${scope} RETURNING s.source_id`,
      [COMPANY_ID, SOURCE],
    );
    if (changed.rowCount !== 807) throw new Error("October sales recovery changed row count");

    await client.query(
      `INSERT INTO legacy_import_runs
        (company_id,idempotency_key,source_system,created_by,request_payload,
         round_unit_prices,status,phase,initial_pending,defer_projections,sales_from_date)
       VALUES ($1,$2,$3,1,$4::jsonb,true,'running','importing',807,false,DATE '2026-10-01')`,
      [COMPANY_ID,OCTOBER_2026_SALES_RUN_ID,SOURCE,
       JSON.stringify({reason:"Owner-authorized recovery for exactly 807 failed October 2026 sales",
         inventoryReconciliation:"Opening balances later", excludesPurchases:true})],
    );
    console.info("OCT2026_SALES_RECOVERY_PREPARED",changed.rowCount);
    return true;
  });
}
