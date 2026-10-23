import { createServer } from "node:http";
import { createApp } from "./app.ts";
import { previewAccessGuard } from "./preview-access.ts";
import { startAttendanceNotifications } from "./services/attendance-notifications.ts";
import { startPushNotifications } from "./services/web-push.ts";

// Private previews fail closed unless public access is explicitly configured.
const previewGate = process.env.NODE_ENV === "production" &&
  process.env.PREVIEW_ACCESS_MODE !== "public"
  ? previewAccessGuard(process.env.PREVIEW_ACCESS_PASSWORD)
  : undefined;

const application = await createApp();
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
const stopNotifications = startAttendanceNotifications(application.pool);
const stopPush = startPushNotifications(application.pool,application.config.appOrigin);
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  server.closeIdleConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await stopNotifications();
  await stopPush();
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
