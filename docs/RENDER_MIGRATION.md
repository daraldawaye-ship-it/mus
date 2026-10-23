# Full Railway to Render migration

The user authorized replacing all experimental Render data with the complete
Railway dataset. Do not merge test users into production identities. The physical
Render database remains on its existing paid plan; creating a logical candidate
database within that instance does not provision another paid instance.

## Transfer and verification

The temporary Docker tools are pinned to the verified official PostgreSQL 18
image digest. The Render entrypoint runs a transfer only when an explicit
`MIGRATION_STAGE_ID` is present. Credentials are runtime secrets, never image
arguments, files in Git, command arguments or log output.

`migration-transfer.mjs` exports a repeatable-read snapshot, dumps the complete
source, and persists the compressed archive in numbered bytea chunks under
`_alraesy_migration` in the original Render database. It restores into a fresh
logical database using one transaction and no owner/ACL recreation. The existing
application database is not overwritten during compatibility verification.

Every application table is verified using its exact row count and an ordered
SHA-256 fingerprint of all serialized rows, including bytea, numeric and JSON
values. Sequence states, column types/defaults/nullability, constraints, indexes,
functions, views, triggers and extensions are compared. Database locale is
preserved. PostgreSQL 18's extra NOT NULL catalog entries are represented by the
same column flags on PostgreSQL 17. The only expression normalization handles
equivalent unbounded varchar-literal array casts emitted differently by PG17/18.

Run state, archive checksums and manifests are durable in `_alraesy_migration`.
A completed run ID is idempotent; failed/incomplete IDs require review and are
never retried destructively. No application or background workers connect to the
candidate until cutover.

The final operation uses `MIGRATION_FINAL_ID` after the Render web service has
entered `MIGRATION_MAINTENANCE=true` (HTTP health remains ready, other routes are
503 and no application workers start). The original public schema is renamed
and the complete dump is restored by psql 18 in the same transaction. Errors
roll that transaction back. All data/schema/sequence checks must pass before
the obsolete preview schema is dropped. The physical database connection and
Blueprint `fromDatabase` binding stay unchanged.

## Cutover requirements

Verification of a snapshot does not authorize losing later source writes.
Quiesce the Railway application and workers for the final copy or prove that the
source has not changed since the verified snapshot. Keep the original Railway
database intact until the Render application and its copied data pass checks.

Railway reported that deployments were paused during the migration, so the
temporary source maintenance command could not be deployed. Its configuration
was reverted to `npm start` and its unused destination secret was cleared.
`sourceReadOnly` provides a scoped fallback: record the source database's prior
`default_transaction_read_only`, set it on, and drain existing sessions of the
same application role. New application sessions inherit read-only mode. This is
not ALTER SYSTEM and does not alter business records. The prior setting is
restored automatically if final transfer fails; an explicit
`MIGRATION_UNFREEZE_SOURCE_ID` also supports recovery. Do not re-enable old-site
writes after a successful cutover.

Preserve existing Web Push keys without logging their values. Accounts/password
hashes and media transfer in the database; provider callbacks, browser sessions,
push consent and ChatGPT OAuth resource bindings need validation for the new
origin. Do not invent or reset an owner account.

After successful promotion, clear migration runtime controls/source credentials,
remove the temporary external database allow rule and Railway TCP proxy when no
longer required, and remove the migration tools from normal application startup.

## Local evidence

An isolated PostgreSQL 18.6 source with all 114 repository migrations was dumped
with pg_dump 18.6 and restored on PostgreSQL 17.11. The integration check covered
124 tables, 64 sequences and 3162 schema objects including a test-only schema,
exact 28-digit NUMERIC values, near-limit bigint, Arabic text/JSON and a 2 MB
binary image. It verified a concurrent write excluded by the exported snapshot,
an immutable trigger after restore, preservation of the original target user,
archive chunk checksum and idempotent completion. The full Docker image built
successfully with TypeScript checking and the frontend build. These local checks
do not themselves establish a completed live migration.

Further local tests verified source-session draining and denied writes, restored
the previous database setting, and performed full in-place replacement using a
non-superuser database owner. The previous preview owner was discarded, while the
target database name/credentials remained unchanged. A separate incompatible
PG18 virtual-column fixture exercised transaction rollback on PG17.

## Live cutover evidence (2026-10-23)

The compatibility copy matched all table contents and schema definitions. The
only mismatch was the notification identity sequence advancing while Railway
workers ran. The final run `20261023_final1` used the recorded source read-only
boundary, removed the unused candidate to free space, and replaced the preview
schema in the existing Render database. It completed with all table, sequence
and schema fingerprints equal and `in_place: true`; no preview owner was merged.

Render deployment `dep-dbdnu8m7bikc73e9ehf0` became live at 15:44 UTC. Both local
and public HTTPS checks passed for health, the frontend, authenticated-API
rejection and OAuth resource discovery. A subsequent direct query confirmed
that the target database remains writable and contains one original owner.

Migration source credentials and run controls were cleared after verification.
Normal production startup no longer imports migration jobs; PostgreSQL migration
binaries were removed from the runtime image. Recovery tooling remains in Git
for review, but must be invoked deliberately with the matching tools and access.
Do not re-run the old source dump over production. Browser Web Push still needs
the source VAPID pair if those secrets have not yet been configured.

At cleanup readback, Render reported 5 GB provisioned storage (autoscaling off).
The Blueprint records that existing size; cleanup does not resize the database.
