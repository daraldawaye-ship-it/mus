import type { Pool } from "pg";
import { HttpError } from "../errors.ts";

/** Read-only, bounded PostgreSQL statistics. Row counts are catalog estimates unless requested explicitly. */
export async function databaseMonitor(pool: Pool, name: string, capacityGB = 5) {
  const [summary, tables] = await Promise.all([
    pool.query([
      "SELECT current_database() AS name, current_schema() AS schema,",
      "pg_database_size(current_database())::text AS database_bytes,",
      "(SELECT COUNT(*)::int FROM pg_stat_user_tables) AS table_count,",
      "(SELECT COALESCE(SUM(n_live_tup),0)::bigint::text FROM pg_stat_user_tables) AS estimated_rows,",
      "(SELECT COALESCE(SUM(n_dead_tup),0)::bigint::text FROM pg_stat_user_tables) AS dead_rows,",
      "(SELECT COALESCE(SUM(pg_indexes_size(relid)),0)::bigint::text FROM pg_stat_user_tables) AS index_bytes,",
      "(SELECT COUNT(*)::int FROM pg_stat_activity WHERE datname=current_database()) AS connections,",
      "(SELECT COALESCE(MAX(numbackends),0)::int FROM pg_stat_database WHERE datname=current_database()) AS active_connections,",
      "(SELECT COALESCE(MAX(xact_commit),0)::bigint::text FROM pg_stat_database WHERE datname=current_database()) AS transactions_committed,",
      "(SELECT COALESCE(MAX(xact_rollback),0)::bigint::text FROM pg_stat_database WHERE datname=current_database()) AS transactions_rolled_back,",
      "(SELECT COALESCE(MAX(deadlocks),0)::bigint::text FROM pg_stat_database WHERE datname=current_database()) AS deadlocks,",
      "(SELECT COALESCE(MAX(blks_hit),0)::bigint::text FROM pg_stat_database WHERE datname=current_database()) AS cache_hits,",
      "(SELECT COALESCE(MAX(blks_read),0)::bigint::text FROM pg_stat_database WHERE datname=current_database()) AS blocks_read,",
      "current_setting('server_version') AS postgres_version"
    ].join(" ")),
    pool.query([
      "SELECT schemaname AS schema, relname AS name,",
      "n_live_tup::bigint::text AS estimated_rows, n_dead_tup::bigint::text AS dead_rows,",
      "pg_relation_size(relid)::bigint::text AS data_bytes,",
      "pg_indexes_size(relid)::bigint::text AS index_bytes,",
      "pg_total_relation_size(relid)::bigint::text AS total_bytes,",
      "last_vacuum, last_autovacuum, last_analyze, last_autoanalyze",
      "FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC, schemaname, relname"
    ].join(" "))
  ]);
  const row = summary.rows[0];
  const used = Number(row.database_bytes);
  const cap = capacityGB > 0 ? capacityGB * 1e9 : null;
  return {
    name, database: row.name, schema: row.schema, measuredAt: new Date().toISOString(),
    capacityBytes: cap, capacitySource: "render-configured-5gb",
    databaseBytes: used, remainingBytes: cap === null ? null : Math.max(0, cap - used),
    summary: {
      tableCount: Number(row.table_count), estimatedRows: Number(row.estimated_rows),
      deadRows: Number(row.dead_rows), indexBytes: Number(row.index_bytes),
      connections: Number(row.connections), activeConnections: Number(row.active_connections),
      transactionsCommitted: Number(row.transactions_committed),
      transactionsRolledBack: Number(row.transactions_rolled_back),
      deadlocks: Number(row.deadlocks), cacheHits: Number(row.cache_hits),
      blocksRead: Number(row.blocks_read), postgresVersion: row.postgres_version
    },
    tables: tables.rows.map(t => ({
      schema: t.schema, name: t.name, estimatedRows: Number(t.estimated_rows),
      deadRows: Number(t.dead_rows), dataBytes: Number(t.data_bytes),
      indexBytes: Number(t.index_bytes), totalBytes: Number(t.total_bytes),
      lastVacuum: t.last_autovacuum ?? t.last_vacuum ?? null,
      lastAnalyze: t.last_autoanalyze ?? t.last_analyze ?? null
    }))
  };
}

/** Explicit expensive count: one verified ordinary/partitioned table, timeout 2500ms. */
export async function exactTableCount(pool: Pool, schema: string, table: string) {
  if (!schema || !table || schema.length > 63 || table.length > 63) {
    throw new HttpError(400, "invalid_table", "اسم الجدول غير صالح");
  }
  const check = await pool.query(
    "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')",
    [schema, table]
  );
  if (!check.rowCount) throw new HttpError(404, "missing_table", "الجدول غير موجود");
  const quote = (s: string) => '"' + s.replaceAll('"','""') + '"';
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '2500ms'");
    const result = await client.query("SELECT COUNT(*)::bigint::text AS count FROM " + quote(schema) + "." + quote(table));
    await client.query("COMMIT");
    return { schema, table, count: Number(result.rows[0].count) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if ((error as {code?: string}).code === "57014") {
      throw new HttpError(408, "count_timeout", "الجدول كبير؛ استخدم عدد الصفوف التقريبي لتجنب الضغط");
    }
    throw error;
  } finally {
    client.release();
  }
}
