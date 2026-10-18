import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { Database } from "../db.ts";
import { HttpError } from "../errors.ts";

export interface TransactionResetSnapshot {
  counts: Record<string, number>;
  fingerprint: string;
  blockers: string[];
  walletAdjustments: { employeeId: number; pointsToRemove: string }[];
}

const linkedRewardsCte = `WITH source_rewards AS (
  SELECT * FROM employee_wallet_entries WHERE company_id=$1 AND kind='automatic'
    AND (invoice_id IS NOT NULL OR financial_document_id IS NOT NULL)
), linked_rewards AS (
  SELECT * FROM source_rewards
  UNION ALL
  SELECT e.* FROM employee_wallet_entries e WHERE e.company_id=$1 AND e.kind='reversal'
    AND e.reference_id IN (SELECT id FROM source_rewards)
)`;

// These append-only operational records reference invoices, invoice lines or
// journals removed by a reset. Their deletion/settlement policies are separate
// from document rewards; never silently remove accruals, credits or receipts.
const protectedOperationalSources = [
  {
    key: "clearanceEarnings",
    table: "employee_clearance_earnings",
    message:
      "توجد استحقاقات تصريف مرتبطة بالفواتير؛ لا يمكن حذف حركتها المحمية.",
  },
  {
    key: "clearanceReturnReviews",
    table: "employee_clearance_return_reviews",
    message:
      "توجد مراجعات مرتجعات تصريف مرتبطة بسطور الفواتير؛ لا يمكن حذف تاريخها.",
  },
  {
    key: "cashboxOperations",
    table: "employee_cashbox_operations",
    message:
      "توجد عمليات ترحيل أو إغلاق صناديق مرتبطة بالقيود؛ لا يمكن حذف تاريخها.",
  },
  {
    key: "pouchReceipts",
    table: "employee_pouch_receipts",
    message:
      "توجد استلامات حوافظ مرتبطة بالقيود والترحيلات؛ لا يمكن حذف تاريخها.",
  },
  {
    key: "electronicReceipts",
    table: "employee_electronic_receipts",
    message:
      "توجد استلامات محافظ إلكترونية مرتبطة بالقيود والترحيلات؛ لا يمكن حذف تاريخها.",
  },
] as const;

function operationalBlockers(present: Record<string, number | boolean>) {
  return protectedOperationalSources
    .filter((source) => present[source.key])
    .map((source) => source.message);
}

async function linkedWalletState(
  db: Database,
  companyId: number,
  lock = false,
) {
  const entries = (
    await db.query<{
      id: number;
      employee_id: number;
      points: string;
      snapshot: string;
    }>(
      `${linkedRewardsCte} SELECT id,employee_id,points::text,to_jsonb(r)::text AS snapshot
     FROM linked_rewards r ORDER BY id`,
      [companyId],
    )
  ).rows;
  const employeeIds = [
    ...new Set(entries.map((entry) => entry.employee_id)),
  ].sort((a, b) => a - b);
  const wallets = (
    await db.query<{
      employee_id: number;
      points: string;
      snapshot: string;
    }>(
      `SELECT employee_id,points::text,to_jsonb(w)::text AS snapshot
     FROM employee_wallets w WHERE company_id=$1 AND employee_id=ANY($2::integer[])
     ORDER BY employee_id${lock ? " FOR UPDATE" : ""}`,
      [companyId, employeeIds],
    )
  ).rows;
  const reservations = (
    await db.query<{
      employee_id: number;
      points: string;
      snapshot: string;
    }>(
      `SELECT employee_id,points::text,to_jsonb(c)::text AS snapshot FROM wallet_conversions c
     WHERE company_id=$1 AND employee_id=ANY($2::integer[]) AND status='pending'
     ORDER BY id`,
      [companyId, employeeIds],
    )
  ).rows;
  const walletAdjustments = employeeIds.map((employeeId) => ({
    employeeId,
    pointsToRemove: entries
      .filter((entry) => entry.employee_id === employeeId)
      .reduce((total, entry) => total + BigInt(entry.points), 0n)
      .toString(),
  }));
  const insufficientPoints = walletAdjustments.some((adjustment) => {
    const wallet = wallets.find(
      (row) => row.employee_id === adjustment.employeeId,
    );
    if (!wallet) return true;
    const remaining = BigInt(wallet.points) - BigInt(adjustment.pointsToRemove);
    const reserved = reservations
      .filter((row) => row.employee_id === adjustment.employeeId)
      .reduce((total, row) => total + BigInt(row.points), 0n);
    return remaining < 0n || remaining < reserved;
  });
  return {
    entries,
    wallets,
    reservations,
    walletAdjustments,
    insufficientPoints,
  };
}

// Keep this list explicit: a transaction reset never includes master data,
// settings, company numbering, users, attendance, memo history, or audit events.
const snapshotSources = [
  {
    key: "sourceImports",
    table: "transaction_source_imports",
    order: "source_system,source_kind,source_id",
  },
  { key: "invoices", table: "invoices", order: "id" },
  { key: "invoiceLines", table: "invoice_lines", order: "id" },
  { key: "financialDocuments", table: "financial_documents", order: "id" },
  {
    key: "financialDocumentLines",
    table: "financial_document_lines",
    order: "id",
  },
  { key: "stockOperations", table: "stock_operations", order: "id" },
  { key: "stockMovements", table: "stock_movements", order: "id" },
  { key: "stockBalances", table: "stock_balances", order: "id" },
  { key: "stockValuations", table: "stock_item_valuations", order: "item_id" },
  { key: "itemStatistics", table: "item_statistics", order: "item_id" },
  {
    key: "documentOptionValues",
    table: "option_values",
    order: "id",
    filter: "(invoice_id IS NOT NULL OR financial_document_id IS NOT NULL)",
  },
  {
    key: "walletConversions",
    table: "wallet_conversions",
    order: "id",
    filter: "financial_document_id IS NOT NULL",
  },
  {
    key: "invoiceWalletRewards",
    table: "employee_wallet_entries",
    order: "id",
    filter: "invoice_id IS NOT NULL",
  },
  {
    key: "voucherWalletRewards",
    table: "employee_wallet_entries",
    order: "id",
    filter: "financial_document_id IS NOT NULL",
  },
  ...protectedOperationalSources.map((source) => ({ ...source, order: "id" })),
] as const;

/** Read under the caller's repeatable-read snapshot or locked company transaction. */
export async function transactionResetSnapshot(
  db: Database,
  companyId: number,
): Promise<TransactionResetSnapshot> {
  const counts: Record<string, number> = {};
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ version: 3, companyId }));
  for (const source of snapshotSources) {
    const filter = "filter" in source ? ` AND ${source.filter}` : "";
    const result = await db.query<{ snapshot: string }>(
      `SELECT to_jsonb(r)::text AS snapshot FROM ${source.table} r
       WHERE company_id=$1${filter} ORDER BY ${source.order}`,
      [companyId],
    );
    counts[source.key] = result.rows.length;
    hash.update(`\n${source.key}:${result.rows.length}\n`);
    for (const row of result.rows) {
      // JSON strings cannot contain unescaped newlines, so row boundaries are
      // unambiguous. Full row values invalidate approval after draft edits too.
      hash.update(row.snapshot);
      hash.update("\n");
    }
  }
  const wallet = await linkedWalletState(db, companyId);
  counts.linkedWalletEntries = wallet.entries.length;
  for (const [key, rows] of [
    ["linkedWalletEntries", wallet.entries],
    ["affectedWallets", wallet.wallets],
    ["pendingWalletConversions", wallet.reservations],
  ] as const) {
    hash.update(`\n${key}:${rows.length}\n`);
    for (const row of rows) hash.update(row.snapshot + "\n");
  }
  const blockers: string[] = operationalBlockers(counts);
  if (counts.walletConversions)
    blockers.push(
      "توجد تحويلات نقاط مالية مرتبطة بالقيود؛ يلزم معالجتها قبل حذف الحركة.",
    );
  if (wallet.insufficientPoints)
    blockers.push(
      "نقاط مكافآت المستندات مستخدمة أو محجوزة؛ حذفها سيستهلك نقاطًا غير متاحة.",
    );
  return {
    counts,
    fingerprint: hash.digest("hex"),
    blockers,
    walletAdjustments: wallet.walletAdjustments,
  };
}

/**
 * Caller must hold the company row lock and current owner authorization, and
 * compare the approved snapshot before invoking this inside its transaction.
 * Deferred constraints are checked before returning and before the narrow
 * transaction-local DELETE capability is cleared.
 */
export async function deleteCompanyTransactions(
  client: PoolClient,
  companyId: number,
): Promise<void> {
  // Recheck under the caller's company lock, independently of the preview and
  // before enabling deletion or changing any ledger/projection/wallet row.
  const protectedHistory = await client.query<Record<string, boolean>>(
    `SELECT ${protectedOperationalSources
      .map(
        (source) =>
          `EXISTS(SELECT 1 FROM ${source.table} WHERE company_id=$1) AS "${source.key}"`,
      )
      .join(",")}`,
    [companyId],
  );
  const operational = operationalBlockers(protectedHistory.rows[0]!);
  if (operational.length)
    throw new HttpError(
      409,
      "transaction_reset_blocked",
      operational.join("؛ "),
    );
  const blockers = await client.query<{ blocked: boolean }>(
    `SELECT (
       EXISTS(SELECT 1 FROM wallet_conversions WHERE company_id=$1 AND financial_document_id IS NOT NULL)
     ) AS blocked`,
    [companyId],
  );
  if (blockers.rows[0]?.blocked)
    throw new HttpError(
      409,
      "transaction_reset_blocked",
      "توجد حركة محفظة مرتبطة بالمستندات؛ لم تُحذف أي حركة.",
    );
  const wallet = await linkedWalletState(client, companyId, true);
  if (wallet.insufficientPoints)
    throw new HttpError(
      409,
      "transaction_reset_blocked",
      "نقاط مكافآت المستندات مستخدمة أو محجوزة؛ لم تُحذف أي حركة.",
    );

  await client.query(
    `SELECT set_config('tijara.transaction_reset_company',$1,true),
       set_config('tijara.transaction_reset_txid',txid_current()::text,true),
       set_config('tijara.transaction_reset_reward_ids',$2,true)`,
    [String(companyId), wallet.entries.map((entry) => entry.id).join(",")],
  );

  // Delete linked originals and their reversals together. The statement trigger
  // subtracts their exact net once per wallet, without transient row-order debits.
  await client.query(
    "DELETE FROM employee_wallet_entries WHERE company_id=$1 AND id=ANY($2::integer[])",
    [companyId, wallet.entries.map((entry) => entry.id)],
  );

  // These projection references have immediate foreign keys. Clear them before
  // removing immutable source rows; rebuilding follows after balances are empty.
  await client.query(
    `UPDATE item_statistics SET last_movement_id=NULL,last_sale_invoice_id=NULL,
       last_purchase_line_id=NULL,last_adjustment_movement_id=NULL,
       last_adjustment_operation_id=NULL
     WHERE company_id=$1`,
    [companyId],
  );
  // Remove rebuildable history before its immediate source FKs. Daily price
  // extrema reference facts, which in turn reference invoice lines/invoices;
  // legacy supplier hints reference movements. Other daily buckets have no
  // document FK, but must not retain transactions that this reset removes.
  for (const table of [
    "item_purchase_price_daily",
    "item_purchase_price_facts",
    "stock_movement_supplier_hints",
    "item_daily_activity",
    "account_daily_activity",
  ])
    await client.query(`DELETE FROM ${table} WHERE company_id=$1`, [companyId]);
  await client.query(
    `DELETE FROM option_values WHERE company_id=$1
       AND (invoice_id IS NOT NULL OR financial_document_id IS NOT NULL)`,
    [companyId],
  );
  // A whole company is deleted in one statement per table, preserving immediate
  // self-reference FKs for return sources and their originals.
  for (const table of [
    "transaction_source_imports",
    "stock_movements",
    "invoice_lines",
    "invoices",
    "stock_operations",
    "financial_document_lines",
    "financial_documents",
    "stock_balances",
  ])
    await client.query(`DELETE FROM ${table} WHERE company_id=$1`, [companyId]);

  // Existing valuation rows must remain, at zero, for stock-integrity checks
  // queued by balance deletion. They contain no operational document history.
  await client.query(
    "UPDATE stock_item_valuations SET quantity_smallest=0,value_base=0 WHERE company_id=$1",
    [companyId],
  );
  await client.query(
    "SELECT refresh_item_statistics(company_id,id) FROM items WHERE company_id=$1 ORDER BY id",
    [companyId],
  );
  await client.query(
    "SELECT refresh_item_adjustment_counts(company_id,id) FROM items WHERE company_id=$1 ORDER BY id",
    [companyId],
  );
  await client.query("SET CONSTRAINTS ALL IMMEDIATE");
  await client.query(
    `SELECT set_config('tijara.transaction_reset_company','',true),
       set_config('tijara.transaction_reset_txid','',true),
       set_config('tijara.transaction_reset_reward_ids','',true)`,
  );
}
