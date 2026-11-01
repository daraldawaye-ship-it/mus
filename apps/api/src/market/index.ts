import { createMarketDatabase } from "./database.ts";
import { createMarketApp } from "./app.ts";
import { requireMarketSecret } from "./transport.ts";

const secret = process.env.MARKET_SERVICE_SECRET ?? "";
requireMarketSecret(secret);
const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
const pool = await createMarketDatabase(process.env.MARKET_DATABASE_URL ?? "", process.env.MARKET_DATABASE_SCHEMA ?? "market");
const app = createMarketApp(pool, secret);
const server = app.listen(port, "0.0.0.0", () => console.info("MEDICINE_MARKET_READY"));
server.requestTimeout = 10000;
server.headersTimeout = 10000;
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  server.closeIdleConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await pool.end();
};
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
