# Temporary automation pause — 2026-10-27

Explicit user instruction: stop ALL automatic operations/jobs, including application work in PostgreSQL, and record what must be restored later. Do not resume without a new explicit instruction.

Control: `apps/api/src/automation-control.ts`, `AUTOMATIONS_PAUSED = true`.

Stopped at startup and throughout the process:
- Legacy voucher raw intake (`importLegacyVouchersOnce`).
- Sales ranking startup calculation (`prepareItemSaleRankings`).
- Attendance and notification producer (`startAttendanceNotifications`): inventory scans, due memo schedules, reminder recurrence, attendance checks and forgotten-session closure.
- Web Push delivery queue (`startPushNotifications`).
- Periodic sales-count ranking calculation (`startItemSaleRankings`).
- Historical invoice import/rebuild worker (`startLegacyImportWorker`). Existing import remains persisted as paused.

Production HTTP maintenance runs BEFORE sessions, OAuth, MCP and business APIs. It returns 503 for all requests except the stateless GET `/api/health`. This prevents request-triggered account/item statistics refresh, automatic rewards, stock/journal creation and session writes as well as manual business writes. No business table is erased or rewritten. Database FK, integrity and immutability triggers remain installed. With application mutations blocked, they have no new application writes to process.

PostgreSQL itself remains running. Its internal engine maintenance, platform backups and startup schema-version checks are not disabled. No database-native scheduler was configured by this change; do not claim external schedules were stopped without inspecting them.

## Database-side pause

Migration133 saves and disables 28 derived statistics/supplier-update table triggers and pauses 19 direct calculation/invalidation SQL functions. Exact original trigger modes and function definitions are stored in `automation_paused_triggers` and `automation_paused_functions`. The persistent switch is `automation_database_pause.paused`. FK, accounting/stock integrity, source snapshots, immutable history and permission protection are kept enabled. No business rows are changed or deleted by the pause.

Live metadata inspection before this change found only `plpgsql` and `pg_trgm` extensions and no `cron`, `pgagent` or `timescaledb_information` schemas. No database-native scheduler was found.

To restore database-side behavior after explicit user instruction, the database owner can call `restore_database_automation()` in a controlled transaction. It restores each exact saved function and trigger mode and marks the pause restored; it does not execute calculations, start import jobs or restart application workers. Review the required one-time rebuild separately. Do not simply enable every trigger or lose modes that were disabled before maintenance.

Restore only on explicit user request:
1. Review this inventory and the unfinished import; do not resume an old import automatically.
2. Change the central pause constant to false, validate, publish to `preview/render-2026-10-23`, manually deploy the existing Render service and verify live/health.
3. Recheck overdue notification/reminder/attendance queues before enabling execution: previously due tasks can catch up. Keep the historical import paused unless separately requested.
4. Rebuild required item/account statistics once, only under the user's requested scope. Do not replay imports or duplicate stock/journals.
