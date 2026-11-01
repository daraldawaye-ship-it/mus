# Fast avatar navigation and offline shortcuts (2026-11-01)

The avatar menu has six tabs and a 3-column navigation grid. Previously the
grid displayed only a default link while `GET /page-catalog` and
`GET /my-shortcuts` resolved, causing an initial partial menu followed by
several links appearing seconds later. Offline reloads suffered the same delay.

Implementation:
- `UserMenu.tsx` starts the scoped `/my-shortcuts` query at mount time, even
  before the user opens the avatar menu. The existing `usePageDirectory`
  simultaneously loads pages.
- After **both** responses have arrived, `menu-navigation-cache.ts` records
  one small, synchronous, seven-day localStorage snapshot per verified
  `user.id` and active `companyId` (or public scope).
- The snapshot stores the *filtered* link names and internal routes, allowed
  avatar tab labels, default pages link, and quick-add display flag. No
  credentials, accounting data, session tokens or broad company records are
  stored in this mirror.
- On a repeat visit or disconnected PWA restart, `UserMenu.tsx` and
  `UserShortcutMenuGrid.tsx` render from that snapshot before async reads
  resolve. Fresh page permissions and shortcut preferences then replace it
  together, avoiding a partially rendered list.
- The existing `offline-storage.ts` / IndexedDB authorized GET snapshots
  still serve the actual offline catalog and preferences. This synchronous
  mirror is a *UI-only display hint*, not a permission grant. Server APIs,
  route checks and per-page action guards remain authoritative; deleted or
  revoked shortcuts are removed on the next online refresh.
- Manual changes through `ShortcutEditor` update React Query's
  `my-shortcuts` key, which in turn refreshes the local navigation mirror.
- On a first-ever login (with no prior authorized snapshot), initial server
  synchronization is still necessary. Offline navigation is available only
  after a successful online visit has populated the local caches.

Focused tests: `tests/menu-navigation-cache.test.ts` checks filtering,
deduplication/order, company/user isolation, expiration, and disallowed links.

For every future navigation change, keep snapshots user/company-scoped and
presentation-only. Never treat localStorage or IndexedDB as proof of current
authorization, nor enable mutations solely because a cached link exists.

## زر تعديل كرت الصنف من قائمة المستخدم (2026-11-01)

في تبويب «صنف» من قائمة الصورة الشخصية، يظهر زر «تعديل كرت الصنف» كخيار سادس بجوار مشتريات ومبيعات وتسويات ومناقلات والبدائل. يظل معطلاً حتى اختيار صنف داخل الشركة. عند الضغط يُغلق منيو الصورة الشخصية ويُفتح `ItemCardBottomSheetHost` عبر `openItemCardSheet(companyId, itemId)` دون تغيير الصفحة أو إنشاء نموذج تعديل مكرر. يستمر `InvoiceItemEditor` في التحقق من صلاحيات عرض/تعديل صفحات الأصناف وكرت الصنف ومن قيود الكتابة على الخادم. أصبح مضيف اللوحة يعمل بـ `navigationContext` (الشركة النشطة أو آخر شركة مسموحة) ليدعم القائمة في الصفحات العامة كذلك. اختبر التدفق في `tests/browser-header-item-search.ts`؛ لا تخزن بيانات تعديل ضمن كاش التنقل.
