import { Pool } from "pg";
import { createMarketDatabase } from "./database.ts";
import { transferMarket } from "./transfer.ts";

// Explicit maintenance invocation only; never imported by either application's startup.
if (!process.argv.includes("--apply") || process.env.MARKET_TRAFFIC_FROZEN !== "confirmed") throw new Error("Freeze all market traffic, verify maintenance, then use --apply and MARKET_TRAFFIC_FROZEN=confirmed");
const sourceUrl = process.env.MARKET_SOURCE_DATABASE_URL, targetUrl = process.env.MARKET_DATABASE_URL;
if (!sourceUrl || !targetUrl) throw new Error("Both source and dedicated market database URLs are required");
const sourceSchema = process.env.MARKET_SOURCE_DATABASE_SCHEMA ?? "public";
if (!/^[a-z][a-z0-9_]{0,62}$/.test(sourceSchema)) throw new Error("Invalid source schema");
const source = new Pool({ connectionString: sourceUrl, max: 1, connectionTimeoutMillis: 3000, options: `-c search_path=${sourceSchema}` });
let target: Pool | undefined;
try {
  target = await createMarketDatabase(targetUrl, process.env.MARKET_DATABASE_SCHEMA ?? "market");
  console.info(JSON.stringify({ verified: await transferMarket(source, target) }));
} finally { await source.end(); await target?.end(); }
