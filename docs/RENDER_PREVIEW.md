# Private Render preview

This configuration belongs only to branch `preview/render-2026-10-23` in
`daraldawaye-ship-it/mus`. Do not merge it into `codex/deploy-phase2`, change the
Railway deployment, or copy production data or credentials.

## Verified account and proposed resources

On 2026-10-23, Render MCP connected successfully to the user-confirmed
Render workspace. Its service list was empty and no
Postgres instances existed. No resources were created during preparation.

`render.yaml` describes one new Docker web service, `alraesy-private-preview`,
and one new managed PostgreSQL database, `alraesy-preview-db`, both in Frankfurt.
The web service uses `0.5c-512mb`, one instance, and port 10000. PostgreSQL uses
`0.1c-256mb`, major version 17, exactly 1 GB of storage, and storage autoscaling
is disabled. Explicit sizing avoids the 15 GB Basic-tier default.

The published starting prices are $7/month for web compute and $6/month for
the smallest paid Postgres instance, including 1 GB storage: approximately
$13/month for these additional resources. Workspace subscription, taxes,
additional bandwidth/build usage and later upgrades are separate. Confirm the
actual Render billing terms before creating either paid resource. The user's
existing workspace subscription is not approval for additional compute charges.

No paid resources may be created until the user approves the additional cost.
Do not click Apply on a Blueprint or issue an equivalent MCP/API create call
before that approval. Saving or pushing this configuration does not deploy it.

## Isolation and private access

- The web source is pinned to `preview/render-2026-10-23`, not `main` or Railway's
  production branch. Automatic service deploys and preview environments are off.
- `DATABASE_URL` is populated only through `fromDatabase` referencing the new
  preview database. This is the internal connection in the same region/workspace.
- `ipAllowList: []` disables public database access. Do not replace it with
  `0.0.0.0/0` to simplify access.
- Render generates a random `PREVIEW_ACCESS_PASSWORD` with `generateValue: true`.
  Its base64 value is accepted by the existing preview gate. Retrieve it only in
  the Render Dashboard's secret editor; never put it in Git, logs, or chat.
- Browser Basic Auth uses username `preview`. Application sign-in remains a
  separate layer. Production startup refuses a missing/invalid preview secret
  before database access. Only exact `GET /api/health` is anonymous.
- The existing configuration uses Render's documented `RENDER_EXTERNAL_URL` as
  the HTTPS application origin when `APP_ORIGIN` is unset. A later custom domain
  needs an explicit `APP_ORIGIN` with that final HTTPS origin.
- Leave production OAuth settings, Web Push keys and owner secrets unset. Do not
  import production records. Use only synthetic preview data.
- Basic Auth and MCP's Bearer authentication use the same Authorization header;
  this browser preview is not a replacement for the production MCP integration.

## Deploy after cost approval

1. Verify the exact branch and `render.yaml` are committed and pushed.
2. If using the Blueprint Dashboard, choose the preview branch explicitly before
   applying. The new Blueprint link is
   https://dashboard.render.com/blueprint/new?repo=https://github.com/daraldawaye-ship-it/mus
   and defaults may otherwise select another branch. Do not apply `main`.
3. Review both plans, 1 GB storage, generated preview secret, database binding,
   Frankfurt region, and disabled autodeploy. Complete Git provider connection
   only if Render requests it.
4. If tools create resources directly instead, use this same desired state and
   verify any fields the MCP schema cannot set through the Dashboard/API first;
   do not claim a Blueprint manages resources created independently.
5. Monitor the specific deploy until `live`, then verify HTTPS, anonymous health,
   anonymous/wrong-password rejection, authenticated pages and static assets.
6. Open an interactive shell on this **paid preview web service** and run
   `npm run owner:create`. Enter a separate preview name, email and password when
   prompted. Password input is hidden. The command refuses an existing owner.
   Do not add owner creation to the normal startup command.
7. Sign in as that owner, create a synthetic company and verify accounts and
   currencies. Restart manually and verify data persists. Never claim deployment
   from a Git push or a local build alone.

## Free tier is a temporary alternative

Render's free web service sleeps after 15 minutes without inbound traffic and
has no interactive shell. Free PostgreSQL expires after 30 days, has no backups,
and has 1 GB storage. A paid workspace subscription does not remove these limits.
It is not the continuous paid setup declared here. Free services still count
against shared build/bandwidth allowances; overages can be billed when a payment
method exists. Do not silently substitute it or describe it as permanent storage.

## Validation

The application code is unchanged from the already verified private-preview
commit `d3e2a73`. Earlier focused validation passed TypeScript, frontend build,
11 preview-access/deployment tests, and an isolated Chromium/PostgreSQL smoke
check with all 114 migrations and synthetic company creation. Those are local
results, not a verified Render deployment or a Docker image build.

The Render Blueprint passed local validation against the complete current
JSON Schema served at https://render.com/schema/render.yaml.json (Draft
2020-12), YAML parsing, and focused assertions for the source branch, disabled
autodeploy/previews, one web instance, private database allowlist, fixed 1 GB
storage, disabled storage autoscaling, PostgreSQL 17, generated preview secret
and exact internal database reference. `git diff --check` passed. Render CLI
was not installed or authenticated in this environment, so CLI/API account-aware
validation has not been run. The first provider validation will occur during
Blueprint review, before Apply. No application code or migrations changed.

Sources checked on 2026-10-23:
- https://render.com/docs/blueprint-spec
- https://render.com/docs/compute-plans
- https://render.com/docs/configure-environment-variables
- https://render.com/docs/environment-variables
- https://render.com/docs/private-network
- https://render.com/docs/free
- https://render.com/pricing
