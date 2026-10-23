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

## Cutover requirements

Verification of a snapshot does not authorize losing later source writes.
Quiesce the Railway application and workers for the final copy or prove that the
source has not changed since the verified snapshot. Keep the original Railway
database intact until the Render application and its copied data pass checks.

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
