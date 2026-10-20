import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { Bell, Check, CheckCheck, ChevronDown, Clock3, ExternalLink, X } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  notificationActionSchema,
  type NotificationDirectory,
  type NotificationRecord,
} from "../../../packages/contracts/src/index";
import { api, useSession } from "./api";
import { errorMessage } from "./phase2";
import { usePageDirectory } from "./page-directory";

type SnoozeDraft = { record: NotificationRecord; until: string };
type HeadsUp = {
  id: number;
  title: string;
  message: string;
  href: string;
  importance: "low" | "medium" | "high" | "critical";
};
// Never treat a pushed or database-provided destination as an external URL.
const safeNotificationHref = (url: string | null | undefined, fallback: string) =>
  url?.startsWith("/") && !url.startsWith("//") ? url : fallback;

const adenTime = (value: string) =>
  new Intl.DateTimeFormat("ar-YE", {
    timeZone: "Asia/Aden", dateStyle: "medium", timeStyle: "short",
  }).format(new Date(value));

function initialAdenDateTime() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Aden", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(Date.now() + 24 * 60 * 60 * 1000)).replace(" ", "T");
}

export function NotificationBell({ companyId }: { companyId?: number }) {
  const { user } = useSession();
  const client = useQueryClient();
  const location = useLocation();
  const scope = companyId ? `company:${companyId}` : "public";
  const base = companyId ? `/companies/${companyId}` : "";
  const directory = usePageDirectory(companyId);
  const page = directory.data?.find(
    (entry) =>
      entry.key === `${companyId ? "company" : "public"}.notifications`,
  );
  const allowed = !!user && (!page || (page.enabled && page.actionAccess.view));
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const [actionMenu, setActionMenu] = useState<number | null>(null);
  const [snooze, setSnooze] = useState<SnoozeDraft | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [headsUp, setHeadsUp] = useState<HeadsUp | null>(null);
  const mountedAt = useRef(Date.now());
  const seenNotifications = useRef(new Set<number>());
  const open = position !== null;
  const query = useQuery({
    queryKey: ["notifications", user?.id, scope, "bell"],
    queryFn: ({ signal }) =>
      api<NotificationDirectory>(
        `${base}/notifications?state=active&grouped=1&page=1&pageSize=5&sort=createdAt:desc,id:desc`,
        { signal },
      ),
    enabled: allowed,
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
  });

  // The Push service worker forwards newly received alerts immediately to an
  // open tab. The existing 30s inbox refresh is a fallback for devices without
  // a working Push subscription. Do not replay historical unread alerts.
  useEffect(() => {
    if (!allowed || !user || !("serviceWorker" in navigator)) return;
    function onPush(event: MessageEvent) {
      const incoming: unknown = event.data;
      if (!incoming || typeof incoming !== "object") return;
      const data = incoming as { type?: unknown; id?: unknown };
      if (data.type !== "alraesy:push-notification" ||
          typeof data.id !== "number" || !Number.isSafeInteger(data.id) || data.id < 1) return;
      // Service workers are shared across tabs, which might represent different
      // sessions. Never trust broadcast payload text; fetch the authorized inbox.
      void query.refetch();
    }
    navigator.serviceWorker.addEventListener("message", onPush);
    return () => navigator.serviceWorker.removeEventListener("message", onPush);
  }, [allowed, user?.id, base, query.refetch]);

  useEffect(() => {
    if (!allowed || !query.data) return;
    const fresh = query.data.items.find((item) =>
      !item.readAt && item.groupUnread > 0 &&
      Date.parse(item.createdAt) > mountedAt.current &&
      !seenNotifications.current.has(item.id)
    );
    if (!fresh) return;
    seenNotifications.current.add(fresh.id);
    setHeadsUp({
      id: fresh.id, title: fresh.title, message: fresh.message,
      href: safeNotificationHref(fresh.href, `${base}/notifications`),
      importance: fresh.importance,
    });
  }, [allowed, query.data, base]);

  useEffect(() => {
    if (!headsUp) return;
    const timeout = window.setTimeout(() => setHeadsUp((prev) =>
      prev?.id === headsUp.id ? null : prev
    ), 8500);
    return () => window.clearTimeout(timeout);
  }, [headsUp]);

  useEffect(() => {
    setHeadsUp(null);
    mountedAt.current = Date.now();
    seenNotifications.current.clear();
  }, [user?.id]);

  function close() {
    setPosition(null);
    setActionMenu(null);
    setSnooze(null);
  }

  // Navigating to the linked record or the full inbox dismisses the preview.
  useEffect(() => {
    setPosition(null);
    setActionMenu(null);
    setSnooze(null);
  }, [location.pathname, location.search, companyId]);

  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !trigger.current?.contains(target)) close();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (snooze) setSnooze(null);
        else if (actionMenu !== null) setActionMenu(null);
        else {
          close();
          trigger.current?.focus();
        }
      }
    };
    const resize = () => close();
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", keydown);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", pointer);
      document.removeEventListener("keydown", keydown);
      window.removeEventListener("resize", resize);
    };
  }, [open, snooze, actionMenu]);

  function toggle() {
    if (open) {
      close();
      return;
    }
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(400, window.innerWidth - 16);
    const maxHeight = Math.max(180, window.innerHeight - 16);
    const availableBelow = window.innerHeight - rect.bottom - 8;
    const above = availableBelow < 280 && rect.top > availableBelow;
    const height = Math.min(maxHeight, 520);
    const top = above
      ? Math.max(8, rect.top - height - 5)
      : Math.min(window.innerHeight - Math.min(height, maxHeight) - 8, rect.bottom + 5);
    setPosition({
      top: Math.max(8, top),
      left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
      width,
      maxHeight,
    });
    setActionMenu(null);
    setSnooze(null);
    setError("");
    setNotice("");
    void query.refetch();
  }

  async function refresh() {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["notifications", user?.id] }),
      client.invalidateQueries({ queryKey: ["list", user?.id, `${scope}:notifications`] }),
      ...(companyId ? [client.invalidateQueries({
        queryKey: ["list", user?.id, "public:notifications"],
      })] : []),
    ]);
  }

  async function perform(record: NotificationRecord, action: "complete" | "read" | "snooze", until?: string) {
    if (busy !== null) return;
    const payload = action === "snooze"
      ? { action, revision: record.revision, until }
      : { action, revision: record.revision };
    const parsed = notificationActionSchema.safeParse(payload);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "تعذر التحقق من الإجراء.");
      return;
    }
    setBusy(record.id);
    setError("");
    setNotice("");
    try {
      await api(`${base}/notifications/${record.id}/action`, {
        method: "POST", body: parsed.data,
      });
      setActionMenu(null);
      setSnooze(null);
      await refresh();
      setNotice(action === "complete" ? "تم إنجاز الإشعار." :
        action === "snooze" ? "تم تأجيل الإشعار." : "تم تعيين الإشعار كمقروء.");
    } catch (cause) {
      setError(errorMessage(cause));
      // Refresh stale revisions after an action conflict.
      void query.refetch();
    } finally {
      setBusy(null);
    }
  }

  function submitSnooze(event: FormEvent) {
    event.preventDefault();
    if (!snooze) return;
    const until = new Date(`${snooze.until}:00+03:00`);
    if (Number.isNaN(until.getTime()) ||
        until.getTime() <= Date.now() ||
        until.getTime() > Date.now() + 366 * 86400000) {
      setError("حدد موعدًا لاحقًا خلال سنة بتوقيت عدن.");
      return;
    }
    void perform(snooze.record, "snooze", until.toISOString());
  }

  if (!allowed) return null;
  const unread = query.data?.unread ?? 0;
  const items = query.data?.items ?? [];

  return (
    <>
      {headsUp && createPortal(
        <div
          className={`notification-heads-up importance-${headsUp.importance}`}
          role="status" aria-live="polite" dir="rtl"
          key={headsUp.id}
        >
          <Bell size={19} aria-hidden="true" />
          <div className="notification-heads-up-content">
            <strong>{headsUp.title}</strong>
            <p>{headsUp.message}</p>
          </div>
          <Link to={headsUp.href} className="button button-primary button-compact"
            onClick={() => setHeadsUp(null)}>فتح</Link>
          <button type="button" className="notification-heads-up-close"
            aria-label="إغلاق التنبيه" onClick={() => setHeadsUp(null)}>
            <X size={16} />
          </button>
        </div>,
        document.body,
      )}
      <button
        ref={trigger}
        type="button"
        className="button button-ghost notification-bell"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={query.isError ? "الإشعارات، تعذر تحديث العدد" : `الإشعارات، ${unread} غير مقروء`}
        title="آخر الإشعارات"
        onClick={toggle}
      >
        <Bell size={18} />
        {unread > 0 && (
          <span className="notification-count" aria-hidden="true">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
        {query.isError && (
          <span className="notification-count notification-count-error" aria-hidden="true">!</span>
        )}
      </button>

      {position && createPortal(
        <div
          ref={panel}
          className="notification-quick-popover"
          role="dialog"
          aria-label="آخر خمس مجموعات من الإشعارات"
          dir="rtl"
          style={{
            position: "fixed", top: position.top, left: position.left,
            width: position.width, maxHeight: position.maxHeight,
            zIndex: 10030,
          }}
        >
          <div className="notification-quick-heading">
            <strong>آخر الإشعارات مجمّعة</strong>
            <span>{unread.toLocaleString("ar")} غير مقروء</span>
          </div>

          {(error || notice) && (
            <div className={error ? "notification-quick-error" : "notification-quick-success"} role="status">
              {error || notice}
            </div>
          )}

          <div className="notification-quick-items">
            {query.isLoading && !query.data && (
              <p className="notification-quick-placeholder">جارٍ تحميل الإشعارات…</p>
            )}
            {query.isError && !query.data && (
              <p className="notification-quick-placeholder">
                تعذر تحميل الإشعارات.{" "}
                <button type="button" className="notification-quick-link" onClick={() => void query.refetch()}>
                  إعادة المحاولة
                </button>
              </p>
            )}
            {query.data && items.length === 0 && (
              <p className="notification-quick-placeholder">لا توجد إشعارات قيد المتابعة حاليًا.</p>
            )}
            {items.map((record) => (
              <article
                key={record.id}
                className={`notification-quick-item${record.groupUnread>0 ? " is-unread" : ""}`}
              >
                <div className="notification-quick-item-top">
                  {record.href ? (
                    <Link className="notification-quick-title" to={record.href} onClick={close}>
                      {record.title}
                    </Link>
                  ) : (
                    <strong className="notification-quick-title">{record.title}</strong>
                  )}
                  {record.groupCount>1&&<span className="notification-group-count"
                    title={`عدد التنبيهات من هذا النوع: ${record.groupCount}`}>
                    {record.groupCount.toLocaleString("ar")} إشعار
                  </span>}
                  <button
                    type="button"
                    className="notification-quick-menu-trigger"
                    aria-expanded={actionMenu === record.id}
                    aria-label={`إجراءات آخر إشعار: ${record.title}`}
                    disabled={busy !== null}
                    onClick={() => {
                      setError(""); setNotice("");
                      setSnooze(null);
                      setActionMenu(current => current === record.id ? null : record.id);
                    }}
                  >
                    الإجراءات <ChevronDown size={12} />
                  </button>
                </div>
                <p className="notification-quick-message">
                  {record.groupCount>1&&<strong>آخر إشعار: </strong>}
                  {record.message}
                </p>
                {record.groupCount>1&&<Link
                  className="notification-quick-link"
                  to={`${base}/notifications?grouped=0&code=${encodeURIComponent(record.code)}&state=active`}
                  onClick={close}>
                  عرض جميع إشعارات هذا النوع
                </Link>}
                <div className="notification-quick-meta">
                  <time dateTime={record.createdAt}>{adenTime(record.createdAt)}</time>
                  {record.groupUnread>0&&<span className="notification-quick-new">
                    {record.groupUnread.toLocaleString("ar")} غير مقروء
                  </span>}
                </div>
                {actionMenu === record.id && (
                  <div className="notification-quick-action-list">
                    <button type="button" disabled={busy !== null}
                      onClick={() => void perform(record, "complete")}>
                      <CheckCheck size={14} /> إنجاز
                    </button>
                    {record.canSnooze && (
                      <button type="button" disabled={busy !== null}
                        onClick={() => {
                          setError("");
                          setSnooze({ record, until: initialAdenDateTime() });
                          setActionMenu(null);
                        }}>
                        <Clock3 size={14} /> تأجيل
                      </button>
                    )}
                    {!record.readAt && (
                      <button type="button" disabled={busy !== null}
                        onClick={() => void perform(record, "read")}>
                        <Check size={14} /> مقروء
                      </button>
                    )}
                    {record.href && (
                      <Link to={record.href} onClick={close}>
                        <ExternalLink size={14} /> فتح المرتبط
                      </Link>
                    )}
                  </div>
                )}
                {snooze?.record.id === record.id && (
                  <form className="notification-quick-snooze" onSubmit={submitSnooze}>
                    <label htmlFor="notification-quick-until">موعد المتابعة (عدن)</label>
                    <input id="notification-quick-until" type="datetime-local"
                      value={snooze.until} required disabled={busy !== null}
                      onChange={event => setSnooze({ ...snooze, until: event.target.value })} />
                    <div>
                      <button type="submit" className="button button-primary button-compact"
                        disabled={busy !== null}>{busy === record.id ? "جارٍ الحفظ…" : "حفظ التأجيل"}</button>
                      <button type="button" className="button button-secondary button-compact"
                        disabled={busy !== null} onClick={() => setSnooze(null)}>إلغاء</button>
                    </div>
                  </form>
                )}
              </article>
            ))}
          </div>

          <Link className="notification-quick-footer" to={`${base}/notifications`} onClick={close}>
            عرض جميع الإشعارات <ExternalLink size={14} />
          </Link>
        </div>,
        document.body,
      )}
    </>
  );
}
