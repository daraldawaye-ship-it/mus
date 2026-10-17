import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { CircleUserRound, Link2, LogOut, Palette } from "lucide-react";
import type { User } from "../../../packages/contracts/src/index";
import { useAppearance } from "./theme";
import { thumbnailUrl } from "./ImageUpload";
import { UserShortcutFlyout, ShortcutEditor, GeneralTableQuickAdd } from "./UserShortcuts";

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

export function UserMenu({
  user,
  onLogout,
  companyId = null,
  employeeId = null,
}: {
  user: User;
  onLogout: () => void;
  companyId?: number | null;
  employeeId?: number | null;
}) {
  const appearance = useAppearance();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [shortcutEditorOpen, setShortcutEditorOpen] = useState(false);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => setOpen(false), [location.pathname, user.id]);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
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

  const dismiss = () => setOpen(false);
  return (
    <div className="user-menu" ref={container}>
      <button
        className="user-menu-trigger"
        type="button"
        ref={trigger}
        aria-label="قائمة المستخدم"
        title={user.displayName}
        aria-haspopup="menu"
        aria-controls={open ? "user-account-menu" : undefined}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Avatar user={user} />
      </button>
      {open && (
        <div
          className="user-menu-panel"
          id="user-account-menu"
          role="menu"
          aria-label="خيارات المستخدم"
          ref={menu}
        >
          <div className="user-menu-identity">
            <Avatar user={user} large />
            <span className="user-menu-identity-text">
              <strong title={user.displayName}>{user.displayName}</strong>
              <small title={user.email} dir="ltr">{user.email}</small>
            </span>
          </div>
          <div className="user-menu-items">
            <NavLink
              to="/profile"
              role="menuitem"
              className="user-menu-item"
              onClick={dismiss}
            >
              <CircleUserRound size={17} aria-hidden="true" />
              تعديل حسابي
            </NavLink>
            <button
              className="user-menu-item"
              type="button"
              role="menuitem"
              onClick={() => {
                dismiss();
                appearance.open();
              }}
            >
              <Palette size={17} aria-hidden="true" />
              المظهر
            </button>
            {(user.owner || user.kind === "admin") && (
              <a className="user-menu-item" role="menuitem" href="/oauth/connections">
                <Link2 size={17} aria-hidden="true" />
                اتصالات ChatGPT
              </a>
            )}
            <UserShortcutFlyout user={user} companyId={companyId}
              employeeId={employeeId}
              onNavigate={dismiss}
              onManage={()=>{dismiss();setShortcutEditorOpen(true);}}
              onQuickAdd={()=>{dismiss();setQuickAddOpen(true);}}
            />
            <button
              className="user-menu-item user-menu-logout"
              type="button"
              role="menuitem"
              onClick={() => {
                dismiss();
                onLogout();
              }}
            >
              <LogOut size={17} aria-hidden="true" />
              تسجيل الخروج
            </button>
          </div>
        </div>
      )}
      <ShortcutEditor user={user} companyId={companyId}
        open={shortcutEditorOpen} onClose={()=>setShortcutEditorOpen(false)}/>
      {(user.owner||user.kind==="admin")&&<GeneralTableQuickAdd
        open={quickAddOpen} onClose={()=>setQuickAddOpen(false)}/>}
    </div>
  );
}
