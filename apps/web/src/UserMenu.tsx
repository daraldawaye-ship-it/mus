import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { NavLink, useLocation } from "react-router-dom";
import {
  CircleUserRound, Compass, Link2, LogOut, Palette, Settings,
  UserRound, Wrench, Package, WalletCards, RefreshCw, ClipboardList, ShieldCheck, Users,
} from "lucide-react";
import type { User } from "../../../packages/contracts/src/index";
import { useAppearance } from "./theme";
import { thumbnailUrl } from "./ImageUpload";
import { ShortcutEditor, GeneralTableQuickAdd } from "./UserShortcuts";
import { UserShortcutMenuGrid } from "./UserShortcutMenuGrid";
import { EntityMenuSearch } from "./EntityMenuSearch";
import { openItemCardSheet } from "./ItemCardBottomSheetHost";
import { usePageDirectory } from "./page-directory";
import { api } from "./api";
import { readMenuNavigation, saveMenuNavigation } from "./menu-navigation-cache";
import { allowedAvatarTabs } from "./avatar-menu-permissions";
import { refreshEntireApp } from "./app-force-refresh";
import "./user-menu-tabs.css";

function Avatar({ user, large = false }: { user: User; large?: boolean }) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [user.image]);
  const parts = (user.displayName || user.name).trim().split(/\s+/).filter(Boolean);
  const initials = parts.slice(0, 2).map((part) => Array.from(part)[0] ?? "").join("") || "م";
  return (
    <span className={`user-avatar${large ? " user-avatar-large" : ""}`}>
      {user.image && !imageFailed ? (
        <img
          src={thumbnailUrl(user.image)}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setImageFailed(true)}
        />
      ) : initials ? (
        <span aria-hidden="true">{initials}</span>
      ) : (
        <CircleUserRound size={20} aria-hidden="true" />
      )}
    </span>
  );
}

const sections = [
  { key: "navigation", label: "التنقل", icon: Compass },
  { key: "item", label: "صنف", icon: Package },
  { key: "financialAccount", label: "حساب", icon: WalletCards },
  { key: "employee", label: "مستخدم", icon: UserRound },
  { key: "tools", label: "أخرى", icon: Wrench },
  { key: "settings", label: "الإعدادات", icon: Settings },
] as const;
type SectionKey = typeof sections[number]["key"];

export function UserMenu({
  user,
  onLogout,
  companyId = null,
  employeeId = null,
  employeeName = null,
}: {
  user: User;
  onLogout: () => void;
  companyId?: number | null;
  employeeId?: number | null;
  employeeName?: string | null;
}) {
  const appearance = useAppearance();
  const location = useLocation();
  const directory = usePageDirectory(companyId ?? undefined);
  // Start loading navigation preferences before the avatar menu is opened.
  // The last authorized snapshot paints immediately on repeat visits/offline.
  const shortcuts = useQuery({
    queryKey: ["my-shortcuts", user.id, companyId],
    queryFn: ({ signal }) => api<{ pageKeys: string[] }>(
      "/my-shortcuts" + (companyId ? "?companyId=" + companyId : ""), { signal }),
    networkMode: "always",
    staleTime: 10_000,
  });
  useEffect(() => {
    if (directory.data && shortcuts.data) {
      saveMenuNavigation(user, companyId, directory.data, shortcuts.data.pageKeys);
    }
  }, [user.id, user.owner, user.kind, companyId, directory.data, shortcuts.data]);
  const cachedMenu = readMenuNavigation(user.id, companyId);
  const permittedTabs = directory.data
    ? allowedAvatarTabs(user.owner, companyId, directory.data)
    : cachedMenu?.tabs ?? allowedAvatarTabs(user.owner, companyId, undefined);
  const visibleSections = sections.filter(section => permittedTabs.includes(section.key));
  // Follow current server page permissions; do not hardcode a user's role.
  const canViewPage = (key: string) => directory.data?.some(entry =>
    entry.key === key && entry.enabled && entry.visible && entry.actionAccess.view,
  ) === true;
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<SectionKey>("navigation");
  const [itemMenuReset, setItemMenuReset] = useState(0);
  const [shortcutEditorOpen, setShortcutEditorOpen] = useState(false);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const scrollArea = useRef<HTMLDivElement>(null);

  useEffect(() => setOpen(false), [location.pathname, user.id]);
  useEffect(() => {
    if (!permittedTabs.includes(activeTab)) setActiveTab("navigation");
  }, [activeTab, permittedTabs.join("|")]);
  const displayedTab = permittedTabs.includes(activeTab) ? activeTab : "navigation";
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus();
    const onOutside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onOutside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("pointerdown", onOutside);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);
  useEffect(() => {
    if (scrollArea.current) scrollArea.current.scrollTop = 0;
  }, [activeTab]);

  const dismiss = () => setOpen(false);
  async function fullRefresh() {
    if (refreshBusy || !window.confirm("سيجلب التطبيق أحدث إصدار من الموقع. قد تفقد التعديلات غير المحفوظة على هذه الصفحة. هل تريد المتابعة؟")) return;
    setRefreshBusy(true);
    try {
      await refreshEntireApp();
    } catch (error) {
      setRefreshBusy(false);
      window.alert(error instanceof Error ? error.message : "تعذر تحديث الموقع. حاول مرة أخرى.");
    }
  }
  const openMenu = () => {
    setActiveTab("navigation");
    setOpen(true);
  };
  const selectByKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = visibleSections.findIndex(section => section.key === displayedTab);
    // The UI is right-to-left; ArrowLeft moves to the next tab in reading order.
    const next = event.key === "Home" ? 0
      : event.key === "End" ? visibleSections.length - 1
      : (index + (event.key === "ArrowLeft" ? 1 : -1) + visibleSections.length) % visibleSections.length;
    setActiveTab(visibleSections[next].key);
    menu.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };

  return (
    <div className="user-menu" ref={container}>
      <button
        className="user-menu-trigger"
        type="button"
        ref={trigger}
        aria-label="قائمة المستخدم"
        title={user.displayName}
        aria-haspopup="dialog"
        aria-controls={open ? "user-account-menu" : undefined}
        aria-expanded={open}
        onClick={() => open ? dismiss() : openMenu()}
      >
        <Avatar user={user} />
      </button>
      {open && (
        <div
          className="user-menu-panel user-menu-tabbed-panel"
          id="user-account-menu"
          role="dialog"
          aria-label="قائمة المستخدم والأقسام"
          ref={menu}
        >
          <div className="user-menu-tabs" role="tablist"
            aria-label="أقسام قائمة المستخدم"
            onKeyDown={selectByKeyboard}>
            {visibleSections.map(section => {
              const Icon = section.icon;
              const selected = section.key === displayedTab;
              return (
                <button
                  type="button" key={section.key}
                  id={`user-menu-tab-${section.key}`}
                  role="tab"
                  className={`user-menu-tab${selected ? " is-active" : ""}`}
                  aria-selected={selected}
                  aria-controls="user-menu-tabpanel"
                  tabIndex={selected ? 0 : -1}
                  onClick={() => {
                    if (section.key === "item" && displayedTab === "item")
                      setItemMenuReset(value => value + 1);
                    setActiveTab(section.key);
                  }}
                >
                  <Icon size={16} aria-hidden="true" />
                  <span>{section.label}</span>
                </button>
              );
            })}
          </div>
          <div
            id="user-menu-tabpanel"
            className="user-menu-tab-content"
            role="tabpanel"
            tabIndex={0}
            aria-labelledby={`user-menu-tab-${displayedTab}`}
            ref={scrollArea}
          >
            {displayedTab === "navigation" && (
              <UserShortcutMenuGrid
                user={user} companyId={companyId} employeeId={employeeId}
                onNavigate={dismiss}
                onManage={() => { dismiss(); setShortcutEditorOpen(true); }}
                onQuickAdd={() => { dismiss(); setQuickAddOpen(true); }}
              />
            )}
            {(displayedTab === "item" || displayedTab === "financialAccount" || displayedTab === "employee") && (
              <EntityMenuSearch key={`${user.id}:${companyId}:${displayedTab}`}
                user={user} companyId={companyId} employeeId={employeeId}
                employeeName={employeeName}
                kind={displayedTab === "item" ? "item" : displayedTab === "financialAccount" ? "account" : "employee"}
                itemMenuReset={itemMenuReset}
                 onEditItem={itemId => {
                   if (!companyId) return;
                   dismiss();
                   openItemCardSheet(companyId, itemId);
                 }} />
            )}
            {displayedTab === "settings" && (
              <>
                <div className="user-menu-account-identity">
                  <Avatar user={user} large />
                  <span className="user-menu-identity-text">
                    <strong title={user.displayName}>{user.displayName}</strong>
                    <small title={user.email} dir="ltr">{user.email}</small>
                  </span>
                </div>

              </>
            )}
            {displayedTab === "tools" && (
              <div className="user-menu-grid user-menu-item-actions" aria-label="روابط أخرى">
                {companyId && canViewPage("company.attendance-current") && (
                  <NavLink className="user-menu-tile"
                    to={`/companies/${companyId}/attendance-current`} onClick={dismiss}>
                    <ClipboardList size={18} aria-hidden="true" />
                    <span>المحضرون حاليًا</span>
                  </NavLink>
                )}
                {companyId && canViewPage("company.pages") && (
                  <NavLink className="user-menu-tile"
                    to={`/companies/${companyId}/pages`} onClick={dismiss}>
                    <ShieldCheck size={18} aria-hidden="true" />
                    <span>صلاحيات الصفحات</span>
                  </NavLink>
                )}
                {canViewPage("public.last-present") && (
                  <NavLink className="user-menu-tile" to="/users/last-present" onClick={dismiss}>
                    <Users size={18} aria-hidden="true" />
                    <span>آخر المتواجدين</span>
                  </NavLink>
                )}
                {!directory.data && <div className="user-menu-grid-note">جارٍ تحميل الروابط المسموح بها…</div>}
                {directory.data && !(
                  (companyId && canViewPage("company.attendance-current")) ||
                  (companyId && canViewPage("company.pages")) ||
                  canViewPage("public.last-present")
                ) && <div className="user-menu-grid-note">لا توجد خيارات أخرى مصرح بها.</div>}
              </div>
            )}
          </div>
          <div className="user-menu-tabs-footer user-menu-settings-actions" role="group"
            aria-label="إجراءات المستخدم والتحديث">
            <NavLink to="/profile" className="user-menu-tile" onClick={dismiss}>
              <CircleUserRound size={15} aria-hidden="true" />
              <span>تعديل حسابي</span>
            </NavLink>
            <button type="button" className="user-menu-tile"
              onClick={() => { dismiss(); appearance.open(); }}>
              <Palette size={15} aria-hidden="true" />
              <span>المظهر</span>
            </button>
            {(user.owner || user.kind === "admin") && (
              <a href="/oauth/connections" className="user-menu-tile" onClick={dismiss}>
                <Link2 size={15} aria-hidden="true" />
                <span>اتصالات ChatGPT</span>
              </a>
            )}
            <button type="button" className="user-menu-tile user-menu-tile-logout"
              onClick={() => { dismiss(); onLogout(); }}>
              <LogOut size={15} aria-hidden="true" />
              <span>تسجيل الخروج</span>
            </button>
            <button type="button" className="user-menu-tile user-menu-full-refresh"
              disabled={refreshBusy} aria-label="تحديث الموقع بالكامل"
              title="جلب أحدث إصدار من الموقع مثل تحديث Ctrl+F5"
              onClick={() => { void fullRefresh(); }}>
              <RefreshCw size={15} aria-hidden="true" className={refreshBusy ? "is-spinning" : ""} />
              <span>{refreshBusy ? "جارٍ التحديث" : "تحديث شامل"}</span>
            </button>
          </div>
        </div>
      )}
      <ShortcutEditor user={user} companyId={companyId}
        open={shortcutEditorOpen} onClose={() => setShortcutEditorOpen(false)} />
      {(user.owner || user.kind === "admin") && (
        <GeneralTableQuickAdd open={quickAddOpen} onClose={() => setQuickAddOpen(false)} />
      )}
    </div>
  );
}
