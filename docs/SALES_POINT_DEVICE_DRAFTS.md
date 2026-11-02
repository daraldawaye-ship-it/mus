# Device-local sales point drafts — 2 November 2026

## Request and boundary
Owner requires that invoices written in «مبيعات 1 / مبيعات 2 / …» are NOT lost when leaving the sales page, opening another page, refreshing the browser/PWA, or restarting the installed app on the same device. No invoice should be posted or queued as an offline invoice merely because a cashier started typing.

## Actual implementation
- `apps/web/src/sales-point-drafts.ts` uses **a dedicated device IndexedDB** `alraesy-sales-points-v1`, with distinct records scoped to `(userId, companyId, pointUUID)` and an owner index. The DB never communicates with the server and is independent of purchase drafts and the postable offline outbox. Writes are serialized to preserve latest edits and deletion order.
- `InvoicePointsWorkspace` in `apps/web/src/pages/CommercePages.tsx` loads saved points **before mounting any sales editor**, avoiding empty form overwrites. Up to 10 numbered tabs retain stable UUIDs and order; each editor receives its original form snapshot and can switch while all points remain mounted. Missing/unsupported IndexedDB surfaces a warning instead of inventing successful persistence.
- `InvoiceEditor` automatically writes its fields on each React change, asynchronously: line item/search/unit/quantity/price/expiry/original-line metadata, account/currency/branch/location, date, notes, header discount, doctor/customer information, original linked invoice and pending idempotency key. Restores manual/default selection flags. `savingInFlight` restores uncertain posted requests as `unknown` and preserves the same idempotency key if a page closes while a POST outcome is unknown.
- SPA navigation from a changed sales invoice offers **«مغادرة مع إبقاء الفواتير على الجهاز»** and awaits local writes. Browser unload prompts only while a write is pending/failed or posting has uncertain outcome; an ordinary safely persisted draft no longer needs a permanent warning.
- Explicitly closing a point asks before discarding an unsaved invoice and deletes only that local point; a confirmed server POST and a successfully queued offline invoice also delete its earlier *editable* snapshot to prevent reappearance as an unposted draft. Other points and already posted invoices are unaffected.
- Purchase working-draft workflows and offline invoice posting are unchanged. No new server endpoint, database schema, accounting, inventory action, or background posting.
- If browser/PWA website data is cleared or another device is used, local drafts are not available. Drafts are not encrypted and device sharing should use separate user accounts.

## Tests and deployment
`.github/workflows/sales-point-drafts-ci.yml` runs `npm ci`, `npm run check`, `npm run build`, `tests/sales-point-drafts.test.ts`. Tests exercise IndexedDB-compatible transaction sequencing, independent point snapshots, user/company boundaries, saves and deletion; CI also checks route wiring. Do not claim interactive browser acceptance unless tested. Verify actual Render release is live, not merely a successful commit.

Manual acceptance checklist: type in Sales 1, open Sales 2 and type different item; leave the sales route via the new keep-locally control; reopen, refresh, close/reopen the installed PWA; verify unchanged values and independent points. Verify saving Sales 1 removes only its own editable snapshot, does not duplicate on reload; test offline queue, uncertain network outcome, multiple users on same device, and local storage denial.
