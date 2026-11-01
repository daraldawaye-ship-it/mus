import { Pool } from "pg";
import { readFile, readdir } from "node:fs/promises";
import { transaction } from "../db.ts";

/** Deliberately does not use createDatabase: accounting migrations/workers must never run here. */
export async function createMarketDatabase(url: string, schema = "market") {
  if (!url.trim()) throw new Error("MARKET_DATABASE_URL is required; no primary database fallback");
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error("Invalid market schema");
  const pool = new Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 1000,
    idleTimeoutMillis: 10000, statement_timeout: 2500, lock_timeout: 750,
    idle_in_transaction_session_timeout: 5000, options: `-c search_path=${schema}` });
  pool.on("error", () => console.error("MARKET_DATABASE_CONNECTION_ERROR"));
  try {
    await transaction(pool, async db => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`market-migrations:${schema}`]);
      await db.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
      if ((await db.query("SELECT to_regclass('companies') existing")).rows[0].existing) throw new Error("Refusing to initialize market over company schema");
      await db.query("CREATE TABLE IF NOT EXISTS market_schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
      const directory = new URL("../../market-migrations/", import.meta.url);
      for (const name of (await readdir(directory)).filter(n => /^\d+_[a-z_]+\.sql$/.test(n)).sort()) {
        if ((await db.query("SELECT 1 FROM market_schema_migrations WHERE version=$1", [name])).rowCount) continue;
        await db.query(await readFile(new URL(name, directory), "utf8"));
        await db.query("INSERT INTO market_schema_migrations(version) VALUES($1)", [name]);
      }
    });
    return pool;
  } catch (error) { await pool.end(); throw error; }
}
