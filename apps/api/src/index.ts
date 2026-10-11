import { createServer } from "node:http";
import { createApp } from "./app.ts";

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
const server = createServer(application.app);
server.listen(port, process.env.HOST ?? "0.0.0.0", () =>
  console.log(`Tijara listening on port ${port}`),
);
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  server.closeIdleConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
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
