import { useQuery } from "@tanstack/react-query";
import { NavLink } from "react-router-dom";
import type { PageEntry, User } from "../../../packages/contracts/src/index";
import { api } from "./api";
import { useControls } from "./control";
import { usePageDirectory } from "./page-directory";

type SavedShortcuts = { pageKeys: string[] };

function eligible(entry: PageEntry, companyId: number | null) {
  return entry.enabled && entry.actionAccess.view && !!entry.href &&
    !entry.record && (entry.scope === "public" || companyId !== null);
}

/** Same permission-checked shortcuts as the old flyout, displayed within the
 * fixed-height navigation tab instead of opening a second floating panel. */
export function UserShortcutMenuGrid({
  user, companyId, employeeId, onNavigate, onManage, onQuickAdd,
}: {
  user: User;
  companyId: number | null;
  employeeId: number | null;
  onNavigate: () => void;
  onManage: () => void;
  onQuickAdd: () => void;
}) {
  const directory = usePageDirectory(companyId ?? undefined);
  const controls = useControls(companyId ?? 0, employeeId);
  const shortcuts = useQuery({
    queryKey: ["my-shortcuts", user.id, companyId],
    queryFn: ({ signal }) =>
      api<SavedShortcuts>("/my-shortcuts" +
        (companyId ? "?companyId=" + companyId : ""), { signal }),
  });
  if (controls.value("show_shortcuts_menu") === false) return null;

  const permitted = new Map((directory.data ?? [])
    .filter(entry => eligible(entry, companyId))
    .map(entry => [entry.key, entry]));
  const defaultPage = permitted.get(companyId ? "company.pages" : "public.pages") ??
    permitted.get("public.pages");
  const defaultHref = defaultPage?.href ??
    (!directory.data && directory.isLoading
      ? (companyId ? `/companies/${companyId}/pages` : "/pages")
      : null);
  const chosen = (shortcuts.data?.pageKeys ?? [])
    .map(key => permitted.get(key))
    .filter((entry): entry is PageEntry =>
      !!entry && entry.key !== defaultPage?.key)
    .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
  const allowQuickAdd = (user.owner || user.kind === "admin") &&
    !!permitted.get("public.general-table")?.actionAccess.create;

  return (
    <div className="user-menu-grid user-menu-shortcuts-grid" aria-label="التنقل والاختصارات">
      {defaultHref && (
        <NavLink to={defaultHref} className="user-menu-tile" onClick={onNavigate}>
          <span>قائمة الصفحات</span>
        </NavLink>
      )}
      {chosen.map(entry => (
        <NavLink
          key={entry.key} to={entry.href!} title={entry.name}
          className="user-menu-tile" onClick={onNavigate}
        >
          <span>{entry.name}</span>
        </NavLink>
      ))}
      {allowQuickAdd && (
        <button type="button" className="user-menu-tile" onClick={onQuickAdd}>
          <span>إضافة إلى الجدول العام</span>
        </button>
      )}
      <button type="button" className="user-menu-tile" onClick={onManage}>
        <span>تحديد اختصاراتي</span>
      </button>
      {directory.isLoading && <span className="user-menu-grid-note">جارٍ تحميل الصفحات…</span>}
      {shortcuts.isError && <span className="user-menu-grid-note">تعذر تحميل الاختصارات</span>}
    </div>
  );
}
