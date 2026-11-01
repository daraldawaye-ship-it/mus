# Mobile offline page horizontal overflow — 2026-11-01

User supplied an Android PWA screenshot from company 2 while disconnected.
The company overview cards were displaced horizontally/cut off and the header
showed the entire "العودة إلى وضع الاتصال" caption alongside company title,
wallet balance, notification bell, and avatar.

## Cause and fix
- Mobile `.topbar` rendered fixed-size siblings. The reconnect control used
  `flex-shrink: 0` and `white-space: nowrap` for a long label. Once offline,
  this additional required width exceeded a portrait phone viewport.
- `ConnectionModeControl.tsx` now exposes an explicit accessible `aria-label`
  and keeps the same title and callback, but mobile CSS displays the
  `WifiOff` icon only (34px width). Desktop keeps the complete label.
- Small-screen `.topbar-start` is flexible (and clips only its own title
  text); the scope/company name ellipsizes. The action icons retain space.
- The mobile `.workspace`, `.workspace-body` and `.main-content` are
  bounded by the viewport, while company cards, attendance warnings and
  their descendants cannot inflate the top-level page width.
- Preserve scrolling for actual wide data tables; do **not** globally set
  `overflow-x: hidden` on every container or disable mobile navigation.
- CSS applies regardless of whether offline was triggered by a physical
  connection loss, an unreachable API, or an offline session.
- No changes were made to offline account identity, queue, invoices, or
  mutation authorization.

## Verification
Render Docker builds execute TypeScript check and Vite build. Following
deployment verify service `live`, health and a narrow portrait-device
offline screenshot; real-device checks must not be claimed unless performed.
