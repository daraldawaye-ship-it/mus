// Migration is an explicitly configured, idempotent deployment operation.
// Without a run ID, startup behaves exactly like the ordinary application.
if (process.env.MIGRATION_STAGE_ID) {
  try {
    const { stageMigration } = await import("./migration-transfer.mjs");
    const summary = await stageMigration({
      sourceUrl: process.env.MIGRATION_SOURCE_DATABASE_URL,
      adminUrl: process.env.DATABASE_URL,
      runId: process.env.MIGRATION_STAGE_ID,
      enforceHosts: true,
    });
    console.log("MIGRATION_STAGE_VERIFIED " + JSON.stringify(summary));
  } catch (error) {
    console.error("MIGRATION_STAGE_FAILED " + (error.code ?? "CHECK_FAILED"));
    process.exit(1);
  }
}
await import("../src/index.ts");
