# Local-first invoice item search — 2026-11-01

## Owner request and diagnosis

The owner observed noticeably slower searches after ranking by monthly net sale quantity plus saleable stock. Four sampled authenticated connector requests (including connector overhead) took roughly 2.1–4.7 seconds, with the new order slower than the older saleTimes order. Those were **not database-only timings** and are not representative of actual device latency. The server already stores sale quantities; it did not recalculate all invoice history for every search. The current online route nevertheless joins ranking and stock snapshots and sorts matching items on each request. The legacy offline fallback also cloned and sorted the entire downloaded catalog from IndexedDB for each typed term.

The owner wants the offline downloaded item database used during normal online cashier entry, with everything ready and background updates.

## Actual changes

- `apps/web/src/offline-shared-items.ts` now prepares **one in-memory normalized, preordered index** per authorized user/company when a *complete* shared item download and user-specific daily rank snapshot are present. It loads IndexedDB once, sorts the snapshot once, then per typed input scans preordered strings for at most the requested page plus one row, with exact code/barcode matches ahead of priority rank. It does not compute sales, stock, or sort the collection on every keystroke. Additional indexed fields include Arabic and English composition names.
- `CommercePages.tsx` attempts `fastLocalInvoiceItems` before its current fast commerce-options API. Incomplete/missing/stale live snapshots safely fall back to online search; input debounce reduces from 100ms to 60ms. All existing item selection, unit/price, stock posting, accounting and saving remain unchanged. The editor warms the local index when opened.
- For **live** local search, `offline-shared.ts` requires that the **current login** has received an authenticated successful GET for the same company's item-options scope (e.g. item-changes). Persisted offline grants alone do not authorize online local reads. Offline fallback continues to honor the previously authorized, time-bounded company/user grant.
- Daily `item-sale-ranks` in `routes-commerce-options.ts` now returns `stockAvailable` only when `canReadItemStock` authorizes that user. This value is saved only inside their user-scoped `SaleRankSnapshot.stocks`; the company's shared item cards remain stripped of restricted stock. It is a **point-in-time saleable** showroom + warehouse quantity, not a continuously updated live balance. No new materialized SQL totals or migration was added.
- `offline-sale-rank-sync.ts` invalidates the prepared index when a complete fresh rank/stock snapshot arrives. Existing shared item catalog batches and delta refreshes (approximately two minutes while connected; immediate upon invoice reset) invalidate the index after updates. The ranking snapshot continues to refresh once per Aden calendar day to avoid expensive all-item requests for every cashier every few minutes.
- Search priority continues to be net monthly quantity plus available stock, with 20 displayed matches, retaining exact code/barcode preference and company/employee data protection. Search and indexing never writes financial documents.

## Limits / checks

- First time on a device, the item catalog and ranking must finish downloading, so online API is used until local data is ready.
- Online live rank must be for the current Aden day; offline may use the last complete authorized ranking. Stock shown from the local rank snapshot may be stale until the next daily refresh; stock **availability for posting is checked on the server**. Do not treat local stock snapshot as reservation or final inventory authority.
- On-device web/PWA rendering latency was not benchmarked with the real employee browser; don't promise a numeric speedup without measuring it.
- Check Docker TypeScript compilation and Vite build, Render live deploy and health endpoint, inspect authorized `/item-sale-ranks` sample, then test a 3-character search on an installed app with a complete downloaded catalog, and compare network calls and input-to-dropdown time.
- Changes: `0547e758` current-session grant; `8f9ff76c` index; `97d66c49` optional stock feed; `4d9d13d3` stock cache schema; `19ebcaf4` daily sync; `aec5d6b0` invalidation; `9ce307a0` editor local first; `cde84ff2` TypeScript fix.
