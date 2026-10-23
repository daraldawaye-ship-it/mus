// Run interactively in the existing Render web service's Shell.
// This command reads metadata/counts only. It never copies or changes data.
import { Client } from "pg";

async function inspect(label, connectionString) {
  if (!connectionString) throw Object.assign(new Error(), { code: "MISSING_CONNECTION" });
  const url = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw Object.assign(new Error(), { code: "INVALID_CONNECTION" });
  const options = { connectionString, connectionTimeoutMillis: 15000, statement_timeout: 60000 };
  if (label === "source") {
    if (url.hostname !== "centerbeam.proxy.rlwy.net" || url.port !== "29292")
      throw Object.assign(new Error(), { code: "UNEXPECTED_SOURCE" });
    // Railway's template uses a self-signed server certificate. Require TLS.
    options.ssl = { rejectUnauthorized: false };
  }
  const client = new Client(options);
  try {
    await client.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { rows } = await client.query(`SELECT
      current_setting('server_version') AS server_version,
      pg_database_size(current_database())::text AS database_bytes,
      (SELECT rolcreatedb FROM pg_roles WHERE rolname=current_user) AS can_create_database,
      (SELECT count(*)::text FROM public.users) AS users,
      (SELECT count(*)::text FROM public.companies) AS companies,
      (SELECT count(*)::text FROM public.media_assets) AS media_assets,
      (SELECT count(*)::text FROM public.schema_migrations) AS applied_migrations,
      (SELECT max(version) FROM public.schema_migrations) AS last_migration`);
    const extensions = await client.query("SELECT extname, extversion FROM pg_extension ORDER BY extname");
    console.log(JSON.stringify({ database: label, ...rows[0], extensions: extensions.rows }));
    await client.query("ROLLBACK");
  } catch (error) {
    // Driver messages can include connection details. Report only safe codes.
    console.error(JSON.stringify({ database: label, error_code: error.code ?? "CHECK_FAILED" }));
    throw Object.assign(new Error("Migration preflight failed"), { code: "PREFLIGHT_FAILED" });
  } finally {
    await client.end().catch(() => {});
  }
}

try {
  await inspect("source", process.env.MIGRATION_SOURCE_DATABASE_URL);
  await inspect("target", process.env.DATABASE_URL);
  console.log("READ_ONLY_CHECK_COMPLETE: no data was changed.");
} catch {
  process.exitCode = 1;
}
