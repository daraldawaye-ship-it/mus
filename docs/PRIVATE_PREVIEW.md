# Private DigitalOcean preview — isolated from Railway

This setup applies **only** to the `preview/digitalocean-2026-10-23` branch.
Do not merge it into the Railway deployment branch or enable automatic deploys.

## Reviewable DigitalOcean configuration

[`.do/app.yaml`](../.do/app.yaml) describes the intended App Platform resources. Saving this file does not create an app or approve its cost. **Creating paid resources is not authorized yet.** Review the actual DigitalOcean billing preview and obtain the user's approval before clicking **Create App** or issuing any equivalent API/CLI create action.

- Source: `daraldawaye-ship-it/mus`, branch `preview/digitalocean-2026-10-23`, **Autodeploy disabled** (`deploy_on_push: false`).
- One Dockerfile Web Service, HTTP port `3000`, one `apps-s-1vcpu-0.5gb` instance (512 MB; the current equivalent of the deprecated `basic-xxs` plan).
- One new, separate **development** PostgreSQL database, named `preview-db`, with `production: false`. The spec omits `cluster_name` so App Platform provisions a new development cluster. Do not attach an existing production cluster or restore/copy production data.
- Service-level runtime `DATABASE_URL=${preview-db.DATABASE_URL}` binds only the new database. Do not paste a connection string from Railway or any other production environment. Startup automatically applies migrations to the configured database, so verify this binding before starting the service or opening its console.
- Service-level runtime `APP_ORIGIN=${APP_URL}`, where `APP_URL` is the platform-generated HTTPS app URL.
- Service-level runtime `PREVIEW_ACCESS_PASSWORD` is an encrypted secret with an intentionally empty value in Git. Before an approved creation, set a private random password of 16–256 characters in DigitalOcean's secure variable editor (**Encrypt checked**). **Never** put the password in Git, a screenshot, or chat. Do not save the secret into an exported spec committed to Git.
- Edge caching is disabled for this private dynamic application. Routing sends the entire path to the single web service, and readiness uses `/api/health`.
- No production environment variables, Google/Apple credentials, Web Push keys, owner credentials, or production data are included. Leave these integrations unset for this preview; Web Push remains disabled without VAPID keys.
- The HTTP Basic Auth username is `preview`. The browser will prompt for this username and the secret password when visiting the HTTPS app URL.
- Without the password, production-mode startup **fails closed**. No pages, assets, or API routes are accessible anonymously. The `GET /api/health` readiness endpoint is intentionally exempt so that Docker and DigitalOcean can check health.
- Default `ondigitalocean.app` DNS is publicly discoverable; Basic Auth protects the content, not the existence of the hostname.
- The previous estimate was `$12/month` (`$5` web service + `$7` development database), before taxes or additional usage. This is an estimate, not a current price quote or cost approval; confirm plan availability and the actual total in DigitalOcean before creation. Region is left to App Platform's default and must also be reviewed there.

The fields follow DigitalOcean's [official App spec](https://github.com/digitalocean/openapi/blob/main/specification/resources/apps/models/app_spec.yml), [compute size definitions](https://github.com/digitalocean/openapi/blob/main/specification/resources/apps/models/app_component_instance_base.yml), and [database spec](https://github.com/digitalocean/openapi/blob/main/specification/resources/apps/models/app_database_spec.yml). Local schema validation does not verify account access, regional availability, billing, or a successful deployment.

## Create the preview owner after approved deployment

The new database has no default user or owner. In the **preview-web** service's interactive App Platform console, confirm it belongs to `alraesy-private-preview` and uses the `preview-db` binding, then run:

```sh
npm run owner:create
```

Enter a separate preview name, email, and password when prompted; password entry is hidden and requires at least 12 characters. Do not send these credentials in chat or use production credentials. Run this once only: the command rejects creation when an owner already exists. Do not add owner creation to the Dockerfile, startup command, or a recurring deployment job.

HTTP Basic Auth is an additional preview gate; it does not create or replace the application's own sign-in. Sign in with the new preview owner to create a sample company and use only synthetic preview data.

## Preview integration limit

The gate requires HTTP `Authorization: Basic` on every non-health route. ChatGPT's MCP connection requires `Authorization: Bearer` on its requests, so this browser-oriented preview cannot be used directly as the connected MCP API while this gate is active. Do not weaken the gate or reuse the production integration to work around this limit.

## Verification after approval and creation

1. Visit the HTTPS app URL in a private browser window. Confirm a Basic Auth prompt appears.
2. Wrong credentials must return HTTP 401; the correct `preview` username and configured password must show the app.
3. Verify `/api/health` returns `{"ok":true}` without credentials.
4. Confirm runtime `DATABASE_URL` remains bound to the new `preview-db`, then create the preview owner as described above. Test sign-in and a sample operation using only preview data.
5. Verify direct page links and a static asset require the same Basic Auth credentials, and repeat the checks after a manual restart to confirm the database persists.
6. Keep all work confined to this app and branch; do not modify Railway or its PostgreSQL database. Do not infer a successful deployment from a Git push or a healthy local test.

## Local verification — 2026-10-23

- `npm run check` and `npm run build` passed; the 11 focused preview-access and deployment tests passed.
- The YAML passed local validation against DigitalOcean's official OpenAPI App spec and referenced component, database, variable, ingress, and health-check schemas. Additional assertions checked the exact preview branch, disabled autodeploy, one 512 MB instance, the new development database binding, runtime-only variables, and the empty encrypted preview secret.
- Starting the actual production entry point without the preview secret failed before database access.
- An integrated local HTTP smoke check used a freshly initialized, dedicated PostgreSQL cluster. All 114 migrations applied, and the initial database contained no users or companies. Anonymous API and built-asset access was rejected.
- Chromium passed both the preview gate and application sign-in, then created a synthetic company and verified Arabic accounts and currencies in that isolated database.

These results verify local behavior only. No DigitalOcean app or paid database was created, no DigitalOcean HTTPS/TLS or live deployment was verified, and no Docker image was built during these checks. Railway and production databases were not accessed.
