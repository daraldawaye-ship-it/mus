import { Pool, type PoolClient } from "pg";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export type Database = Pool | PoolClient;
export async function createDatabase(
  databaseUrl: string,
  schema = "public",
): Promise<Pool> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema))
    throw new Error("Invalid database schema");
  const bootstrap = new Pool({ connectionString: databaseUrl });
  try {
    await transaction(bootstrap, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        schema,
      ]);
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    });
  } finally {
    await bootstrap.end();
  }
  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
    max: 10,
  });
  try {
    await migrate(pool);
  } catch (error) {
    await pool.end();
    throw error;
  }
  return pool;
}
export async function transaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await operation(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function migrate(pool: Pool): Promise<void> {
  await transaction(pool, async (client) => {
    // A schema-specific transaction lock serializes startup and migration application.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext(current_schema()))",
    );
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
    const names = (await readdir(directory))
      .filter((name) => /^\d+_[a-z_]+\.sql$/.test(name))
      .sort();
    for (const name of names) {
      const applied = await client.query(
        "SELECT 1 FROM schema_migrations WHERE version=$1",
        [name],
      );
      if (applied.rowCount) continue;
      await client.query(await readFile(`${directory}/${name}`, "utf8"));
      await client.query("INSERT INTO schema_migrations(version) VALUES($1)", [
        name,
      ]);
    }
  });
}
