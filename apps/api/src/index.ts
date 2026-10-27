import { createServer } from "node:http";
import { createApp } from "./app.ts";
import { importLegacyVouchersOnce } from "./services/import-legacy-vouchers-once.ts";
import { previewAccessGuard } from "./preview-access.ts";
import { startAttendanceNotifications } from "./services/attendance-notifications.ts";
import { startPushNotifications } from "./services/web-push.ts";
import { prepareItemSaleRankings, startItemSaleRankings } from "./services/item-sale-ranking-worker.ts";
import { startLegacyImportWorker } from "./services/legacy-import-worker.ts";
import { AUTOMATIONS_PAUSED } from "./automation-control.ts";

// Private previews fail closed unless public access is explicitly configured.
const previewGate = process.env.NODE_ENV === "production" &&
  process.env.PREVIEW_ACCESS_MODE !== "public"
  ? previewAccessGuard(process.env.PREVIEW_ACCESS_PASSWORD)
  : undefined;

const application = await createApp();
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
const noWorker = async (): Promise<void> => {};
const stopNotifications = AUTOMATIONS_PAUSED ? noWorker : startAttendanceNotifications(application.pool);
const stopPush = AUTOMATIONS_PAUSED ? noWorker : startPushNotifications(application.pool,application.config.appOrigin);
const stopItemSaleRankings = AUTOMATIONS_PAUSED ? noWorker : startItemSaleRankings(application.pool);
// Explicit 2026-10-27 restoration: all recorded workers are enabled again.
// Invoice posting stays scoped to the authorized run and its persisted status.
const stopLegacyImport = startLegacyImportWorker(application.pool, {
  companyId: 2, idempotencyKey: "f03ead4a-40d9-4713-811c-6a366b7ec6c8",
});
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
