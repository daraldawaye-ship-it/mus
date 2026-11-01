# Multiple invoice points in one Alraesy window (2026-11-01)

## Owner's request
The cashier wants to serve two or three customers without opening the installed Windows PWA several times. Display numbered points immediately above the invoice: «مبيعات 1», «مبيعات 2», «مبيعات 3» with «فاتورة أخرى» to add another. Purchases use the same pattern. Preserve independent in-progress transactions in a single browser/PWA window.

## Implementation
- `apps/web/src/pages/CommercePages.tsx`: `InvoicePointsWorkspace` owns up to 10 numbered tab IDs (stable UUID identities). One `InvoiceEditor` is mounted for each open point and remains mounted while inactive; this preserves each point's selected lines, account, branch/location, currency, doctor/customer, notes, discount, return link, pending idempotency key, and receipt state **without committing a document when switching**.
- Switching changes only the visible panel and active sidebar item. Each editor keeps its own save/POST and offline `queueOfflineOperation`; an offline saved invoice is not final posted until server synchronization.
- Only the active editor processes global Ctrl+S and requests DOM focus. Fixed field IDs are scoped by point UUID to prevent targeting another point's controls.
- The parent contains the **single** React Router navigation blocker, protecting unsaved or uncertain invoices in any point. A point with unsaved data requires explicit confirmation to close; points with a save in progress or unresolved save result cannot be closed. Closing a clean point has no accounting or stock effects.
- The existing invoice posting, stocked quantities, accounting entries, offline outbox, and server permissions were **not modified**.
- `apps/web/src/styles.css`: compact RTL numbered tabs and add/close buttons; hidden tabs use inline `display:none`, and the tab strip is not printed.
- On page reload, unsaved point drafts are NOT persisted to storage; this implementation preserves drafts across switching within the open route only. Browser navigation and unload warnings remain in force. Do not suggest it saves drafts across reloads without adding an explicit safe storage layer.

## Testing/operations
The Render Dockerfile runs `npm run check && npm run build` as part of its build. Always verify deployment `live` and `/api/health` after publishing. Browser acceptance checks: create point 1 with item A, open point 2 with item B, return to point 1 and confirm its lines and totals remain; save point 2 and confirm point 1 unchanged; keyboard Ctrl+S acts only on the active point; test closing dirty point, route-change warnings, and offline saving.
Source commits: `a0e749ee774ae6dfd72c369326cc40da100d6db8` (TSX) and `14dc8e3bf55036ae7be931f594cd05709a40116c` (CSS).
