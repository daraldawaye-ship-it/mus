import { createServer } from "node:http";
import { createApp } from "./app.ts";
import { stageNineNewOctoberPurchasesOnce } from "./services/stage-nine-new-oct-purchases.ts";
import { postNonmarketPurchases2026Once } from "./services/post-2026-nonmarket-purchases.ts";
import { post2026NoncashboxSalesOnce } from "./services/post-2026-noncashbox-sales.ts";
import { stagePrivateOctoberSalesFileOnce } from "./services/stage-private-october-sales.ts";
import { importLegacyVouchersOnce } from "./services/import-legacy-vouchers-once.ts";
import { previewAccessGuard } from "./preview-access.ts";
import { startAttendanceNotifications } from "./services/attendance-notifications.ts";
import { startPushNotifications } from "./services/web-push.ts";
import { prepareItemSaleRankings, startItemSaleRankings } from "./services/item-sale-ranking-worker.ts";
import { startLegacyImportWorker } from "./services/legacy-import-worker.ts";
import { startInvoicePostFollowups } from "./services/invoice-post-followups.ts";
import { startItemClearanceNotifications } from "./services/item-clearance-notification-worker.ts";
import { provisionExistingDarAldawaInvoiceShortcuts } from "./services/company2-invoice-shortcut-defaults.ts";
import { OCTOBER_2026_SALES_RUN_ID, prepareOctober2026SalesRecovery } from "./services/october-2026-sales-recovery.ts";
import { AUTOMATIONS_PAUSED } from "./automation-control.ts";

// Private previews fail closed unless public access is explicitly configured.
const previewGate = process.env.NODE_ENV === "production" &&
  process.env.PREVIEW_ACCESS_MODE !== "public"
  ? previewAccessGuard(process.env.PREVIEW_ACCESS_PASSWORD)
  : undefined;

const application = await createApp();
// One-time reconciliation ALSO covers the twelve existing invoice-authorized
// employees of Dar Aldawa, not just staff created after this deployment.
// Page grants are evaluated individually: no new permissions are assigned.
if (!AUTOMATIONS_PAUSED) {
  try {
    await provisionExistingDarAldawaInvoiceShortcuts(application.pool);
  } catch (error) {
    console.error("COMPANY2_INVOICE_SHORTCUTS_RECONCILIATION_FAILED",
      error instanceof Error ? error.message : String(error));
  }
}

// Owner-authorized initial-only intake: exactly nine missing October purchases.
// This never posts invoices or starts/resumes legacy accounting/stock workers.
if (!AUTOMATIONS_PAUSED) {
  try {
    await stageNineNewOctoberPurchasesOnce(application.pool);
  } catch (error) {
    console.error("OCT2026_NINE_PURCHASES_INITIAL_STAGING_FAILED",
      error instanceof Error ? error.message : String(error));
  }
}
// Strictly initial-only intake from the owner's مب.xlsx file. The source is
// SHA-256 verified, checked against both staged and posted identities and
// persisted only to legacy_import_staging. This does NOT start the paused
// 807-invoice recovery worker, or post any account/stock transactions.
if (!AUTOMATIONS_PAUSED) {
  try {
    await stagePrivateOctoberSalesFileOnce(application.pool);
  } catch (error) {
    console.error("PRIVATE_OCTOBER_SALES_INITIAL_STAGE_FAILED",
      error instanceof Error ? error.message : String(error));
  }
}
// The owner explicitly requested an immediate halt of the October 2026
// 807-invoice recovery. Mark the persisted run paused (without deleting any
// imported invoice or pending source data) and do not restart its worker.
// This applies only to this specific run and leaves the website and all other
// workers operational. A future resumption requires fresh owner approval.
const octoberSalesPausedByOwner = true;
if (octoberSalesPausedByOwner) {
  const result = await application.pool.query(
    "UPDATE legacy_import_runs SET status='paused',updated_at=clock_timestamp() WHERE company_id=$1 AND idempotency_key=$2 AND status IN ('running','rebuilding')",
    [2, OCTOBER_2026_SALES_RUN_ID],
  );
  console.info("OCT2026_SALES_RECOVERY_PAUSED_BY_OWNER", result.rowCount);
}
let resumeOctoberSales = false;
if (!AUTOMATIONS_PAUSED && !octoberSalesPausedByOwner) {
  try {
    resumeOctoberSales = await prepareOctober2026SalesRecovery(application.pool);
  } catch (error) {
    console.error("OCT2026_SALES_RECOVERY_NOT_STARTED",
      error instanceof Error ? error.message : String(error));
  }
}
if (!AUTOMATIONS_PAUSED) {
try {
  await importLegacyVouchersOnce(application.pool);
} catch (error) {
  console.error("LEGACY_VOUCHERS_IMPORT_FAILED", error instanceof Error ? error.message : String(error));
}
// Cover restarts after a date change before accepting item-search requests.
await prepareItemSaleRankings(application.pool);
}
if (AUTOMATIONS_PAUSED) console.info("ALRAESY_AUTOMATIONS_PAUSED", "workers, startup imports and application database requests paused");
let vite: import("vite").ViteDevServer | undefined;
if (!application.config.production) {
  const { createServer: createVite } = await import("vite");
  vite = await createVite({
    configFile: "apps/web/vite.config.ts",
    server: { middlewareMode: true },
    appType: "spa",
  });
  application.app.use(vite.middlewares);
}
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT must be between 1 and 65535");
const server = createServer(previewGate ? previewGate(application.app) : application.app);
server.listen(port, process.env.HOST ?? "0.0.0.0", () =>
  console.log(`Alraesy listening on port ${port}`),
);
// Strictly owner-authorized one-shot posting of 2026 non-market purchases.
// Never resumes the separate paused October sales recovery job.
if (!AUTOMATIONS_PAUSED && process.env.ALRAESY_POST_2026_NONMARKET_PURCHASES_88 === "1") {
  void postNonmarketPurchases2026Once(application.pool).catch(error =>
    console.error("OWNER_88_NONMARKET_PURCHASES_FATAL", error instanceof Error ? error.message : String(error)));
}
// User-approved 2026 sales outside all cashboxes; unrelated October recovery remains paused.
if (!AUTOMATIONS_PAUSED && process.env.ALRAESY_POST_2026_NONCASHBOX_SALES_494 === "1") {
  void post2026NoncashboxSalesOnce(application.pool).catch(error =>
    console.error("OWNER_NONCASH_SALES_2026_FATAL", error instanceof Error ? error.message : String(error)));
}
const noWorker = async (): Promise<void> => {};
const stopNotifications = AUTOMATIONS_PAUSED ? noWorker : startAttendanceNotifications(application.pool);
const stopPush = AUTOMATIONS_PAUSED ? noWorker : startPushNotifications(application.pool,application.config.appOrigin);
const stopItemSaleRankings = AUTOMATIONS_PAUSED ? noWorker : startItemSaleRankings(application.pool);
const stopInvoiceFollowups = AUTOMATIONS_PAUSED ? noWorker : startInvoicePostFollowups(application.pool);
const stopItemClearanceNotifications = AUTOMATIONS_PAUSED ? noWorker : startItemClearanceNotifications(application.pool);
// Explicit 2026-10-27 restoration: all recorded workers are enabled again.
// Invoice posting stays scoped to the authorized run and its persisted status.
const stopLegacyImport = startLegacyImportWorker(application.pool, {
  companyId: 2, idempotencyKey: "f03ead4a-40d9-4713-811c-6a366b7ec6c8",
});
const stopOctoberSales = resumeOctoberSales
  ? startLegacyImportWorker(application.pool, {
      companyId: 2, idempotencyKey: OCTOBER_2026_SALES_RUN_ID,
    }) : noWorker;
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const importStopped = stopLegacyImport();
  server.closeIdleConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await stopNotifications();
  await stopPush();
  await stopItemSaleRankings();
  await stopInvoiceFollowups();
  await stopItemClearanceNotifications();
  await importStopped;
  await vite?.close();
  await application.close();
}
process.once("SIGINT", () => {
  void shutdown().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
});
process.once("SIGTERM", () => {
  void shutdown().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
});
