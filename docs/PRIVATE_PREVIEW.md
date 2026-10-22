# Private DigitalOcean preview — isolated from Railway

This setup applies **only** to the `preview/digitalocean-2026-10-23` branch.
Do not merge it into the Railway deployment branch or enable automatic deploys.

## DigitalOcean App Platform

- Source: `daraldawaye-ship-it/mus`, branch `preview/digitalocean-2026-10-23`, **Autodeploy disabled**.
- One Dockerfile Web Service, HTTP port `3000`, instance `512 MB / $5 per month`.
- One separate **development** PostgreSQL database (currently displayed at `$7/month`). The platform-generated service-level `DATABASE_URL` must point to this database, **never** to Railway.
- App-level variable `APP_ORIGIN=${APP_URL}` (runtime), where `APP_URL` is the platform-generated HTTPS app URL.
- Add app-level variable `PREVIEW_ACCESS_PASSWORD` (runtime, **Encrypt checked**): a private random password of 16–256 characters. **Never** put the password in Git, a screenshot, or chat.
- The HTTP Basic Auth username is `preview`. The browser will prompt for this username and the secret password when visiting the HTTPS app URL.
- Without the password, production-mode startup **fails closed**. No pages, assets, or API routes are accessible anonymously. The `GET /api/health` readiness endpoint is intentionally exempt so that Docker and DigitalOcean can check health.
- The database is empty by default. Do not migrate or copy production data without explicit permission.
- Default `ondigitalocean.app` DNS is publicly discoverable; Basic Auth protects the content, not the existence of the hostname.
- Estimated platform cost at setup: `$12/month` before taxes or extra usage. Review billing before clicking **Create App**.

## Verification after approval and creation

1. Visit the HTTPS app URL in a private browser window. Confirm a Basic Auth prompt appears.
2. Wrong credentials must return HTTP 401; the correct `preview` username and configured password must show the app.
3. Verify `/api/health` returns `{"ok":true}` without credentials.
4. Test sign-in and a sample operation using only preview data.
5. Confirm the Railway application and its PostgreSQL database remain unchanged.
