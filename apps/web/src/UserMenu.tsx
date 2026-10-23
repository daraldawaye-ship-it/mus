import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
  CircleUserRound, Compass, Link2, LogOut, Palette, Settings,
  UserRound, Wrench, Package, WalletCards,
} from "lucide-react";
import type { User } from "../../../packages/contracts/src/index";
import { useAppearance } from "./theme";
import { thumbnailUrl } from "./ImageUpload";
import { ShortcutEditor, GeneralTableQuickAdd } from "./UserShortcuts";
import { UserShortcutMenuGrid } from "./UserShortcutMenuGrid";
import { EntityMenuSearch } from "./EntityMenuSearch";
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
  { key: "tools", label: "الأدوات", icon: Wrench },
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
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<SectionKey>("navigation");
  const [shortcutEditorOpen, setShortcutEditorOpen] = useState(false);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const scrollArea = useRef<HTMLDivElement>(null);

  useEffect(() => setOpen(false), [location.pathname, user.id]);
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
  const openMenu = () => {
    setActiveTab("navigation");
    setOpen(true);
  };
  const selectByKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = sections.findIndex(section => section.key === activeTab);
    // The UI is right-to-left; ArrowLeft moves to the next tab in reading order.
    const next = event.key === "Home" ? 0
      : event.key === "End" ? sections.length - 1
      : (index + (event.key === "ArrowLeft" ? 1 : -1) + sections.length) % sections.length;
    setActiveTab(sections[next].key);
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
            {sections.map(section => {
              const Icon = section.icon;
              const selected = section.key === activeTab;
              return (
                <button
                  type="button" key={section.key}
                  id={`user-menu-tab-${section.key}`}
                  role="tab"
                  className={`user-menu-tab${selected ? " is-active" : ""}`}
                  aria-selected={selected}
                  aria-controls="user-menu-tabpanel"
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setActiveTab(section.key)}
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
            aria-labelledby={`user-menu-tab-${activeTab}`}
            ref={scrollArea}
          >
            {activeTab === "navigation" && (
              <UserShortcutMenuGrid
                user={user} companyId={companyId} employeeId={employeeId}
                onNavigate={dismiss}
                onManage={() => { dismiss(); setShortcutEditorOpen(true); }}
                onQuickAdd={() => { dismiss(); setQuickAddOpen(true); }}
              />
            )}
            {(activeTab === "item" || activeTab === "financialAccount" || activeTab === "employee") && (
              <EntityMenuSearch key={`${user.id}:${companyId}:${activeTab}`}
                user={user} companyId={companyId} employeeId={employeeId}
                employeeName={employeeName}
                kind={activeTab === "item" ? "item" : activeTab === "financialAccount" ? "account" : "employee"} />
            )}
            {activeTab === "settings" && (
              <>
                <div className="user-menu-account-identity">
                  <Avatar user={user} large />
                  <span className="user-menu-identity-text">
                    <strong title={user.displayName}>{user.displayName}</strong>
                    <small title={user.email} dir="ltr">{user.email}</small>
                  </span>
                </div>
                <div className="user-menu-grid">
                  <NavLink to="/profile" className="user-menu-tile" onClick={dismiss}>
                    <CircleUserRound size={17} aria-hidden="true" />
                    <span>تعديل حسابي</span>
                  </NavLink>
                  <button type="button" className="user-menu-tile"
                    onClick={() => { dismiss(); appearance.open(); }}>
                    <Palette size={17} aria-hidden="true" />
                    <span>المظهر</span>
                  </button>
                  {(user.owner || user.kind === "admin") && (
                    <a href="/oauth/connections" className="user-menu-tile" onClick={dismiss}>
                      <Link2 size={17} aria-hidden="true" />
                      <span>اتصالات ChatGPT</span>
                    </a>
                  )}
                  <button type="button" className="user-menu-tile user-menu-tile-logout"
                    onClick={() => { dismiss(); onLogout(); }}>
                    <LogOut size={17} aria-hidden="true" />
                    <span>تسجيل الخروج</span>
                  </button>
                </div>
              </>
            )}
            {activeTab === "tools" && (
              <div className="user-menu-empty" aria-live="polite">
                لا توجد خيارات في هذا القسم حاليًا
              </div>
            )}
          </div>
          <div className="user-menu-tabs-footer">اسحب لأسفل لعرض المزيد من خيارات القسم</div>
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
