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

Restore only on explicit user request:
1. Review this inventory and the unfinished import; do not resume an old import automatically.
2. Change the central pause constant to false, validate, publish to `preview/render-2026-10-23`, manually deploy the existing Render service and verify live/health.
3. Recheck overdue notification/reminder/attendance queues before enabling execution: previously due tasks can catch up. Keep the historical import paused unless separately requested.
4. Rebuild required item/account statistics once, only under the user's requested scope. Do not replay imports or duplicate stock/journals.
