# Offline invoice save, reset, printing and letterhead — 2026-11-01

User request: **When a sales or purchase invoice is saved offline, reset the entry form for the next invoice; show a saved confirmation and a print button; print the company letterhead without a final invoice number.**

## Verified existing issue
- `apps/web/src/pages/CommercePages.tsx` previously queued a valid offline invoice using `queueOfflineOperation`, set `localQueued=true` and left the old lines and header in the editor. Its save button stayed disabled and there was no `savedInvoice` response from the server to make printing available.
- Online posting already cleared fields and printed using `InvoicePrintSheet`. The two paths diverged.

## Implementation
- After successful **durable IndexedDB queue write** (same idempotency key), the offline editor now runs the same `clearAfterSavedInvoice()` procedure as online: clears lines, customer/supplier, notes, discount and temporary doctor fields; resets the date; leaves the selected company branch/currency/showroom ready for the next invoice; focuses the first item search. Queue data is unaffected.
- Save confirmation and the **طباعة الفاتورة المحفوظة** button now appear for offline and online saves. Offline copy is built from the validated draft and `calculateInvoiceTotals` (discount/line totals), without pretending that any posting or inventory change happened.
- `InvoicePrintSheet` uses the exact same company header, matrix, totals and print CSS for both; `pendingSync` hides the final invoice number completely and prints `محفوظة على الجهاز — لم تُرحّل بعد`. Online posted invoice numbers remain visible.
- Company letterhead metadata GET and the image fetched from `/api/media/<UUID>/full` are saved in user-scoped IndexedDB snapshots. A previously viewed, authorized image can be used when disconnected; otherwise the textual company header is used. Metadata and image have distinct per-user/per-company keys; never cache another user's or company's letterhead. Image fetches do not bypass offline account switching or stale cookies.
- The print action waits for the letterhead image to load or for the company-text fallback to become ready. Both inline new-invoice printing and saved-invoice `?print=1` use the ready signal.
- A local invoice remains unposted until sync. Local printing NEVER confirms or assigns a server invoice number, never posts stock, never generates financial entries, and never deletes outbox entries.

## Checks and caveats
- Render Docker builds run `npm run check && npm run build`; validate successful build and `live` deploy before announcing publication.
- Unit coverage added to `tests/invoice-print-sheet.test.ts` for pending number suppression (tests are not automatically executed by the Render Dockerfile).
- First-ever offline printing of an image letterhead requires one online visit after the feature update, while authenticated in the corresponding company, to populate local metadata and blob. Text fallback still works if image unavailable.
- This is the *latest saved receipt in the open editor*. A new save replaces that preview; the queued source remains in IndexedDB. A separate pending-invoice history/print UI was not added in this increment.
