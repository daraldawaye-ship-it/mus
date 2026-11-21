import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from "react";
import { GripHorizontal, GripVertical, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import "./WorkPanelLayout.css";

type StoredPanel = { desktop: number; mobile: number; open: boolean };
const DEFAULT: StoredPanel = { desktop: 320, mobile: 320, open: true };
const MIN_DESKTOP = 220;
const STORAGE_PREFIX = "alraesy:work-panel:v1:";
const MOBILE_QUERY = "(max-width: 680px)";

function loadPanel(userId: number | null): StoredPanel {
  if (userId == null) return DEFAULT;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_PREFIX + userId) || "null");
    return {
      desktop: Number.isFinite(saved?.desktop) ? saved.desktop : DEFAULT.desktop,
      mobile: Number.isFinite(saved?.mobile) ? saved.mobile : DEFAULT.mobile,
      open: typeof saved?.open === "boolean" ? saved.open : DEFAULT.open,
    };
  } catch {
    return DEFAULT;
  }
}
function clamp(n: number, min: number, max: number) {
  return Math.min(Math.max(n, min), Math.max(min, max));
}

export function WorkPanelLayout({ enabled, userId, renderTools, children }: {
  enabled: boolean;
  userId: number | null;
  renderTools?: (availableHeight: number) => ReactNode;
  children: ReactNode;
}) {
  const [settings, setSettings] = useState<StoredPanel>(() => loadPanel(userId));
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches);
  const [headerHeight, setHeaderHeight] = useState(44);
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const layoutRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<{ x: number; y: number; size: number } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const media = window.matchMedia(MOBILE_QUERY);
    const measure = () => {
      setMobile(media.matches);
      setViewport({ width: window.innerWidth, height: window.innerHeight });
      const header = layoutRef.current?.parentElement?.querySelector(".topbar");
      if (header) setHeaderHeight(Math.round(header.getBoundingClientRect().height));
    };
    measure();
    const header = layoutRef.current?.parentElement?.querySelector(".topbar");
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (header) observer?.observe(header);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || userId == null) return;
    try { localStorage.setItem(STORAGE_PREFIX + userId, JSON.stringify(settings)); } catch { /* private mode */ }
  }, [enabled, settings, userId]);

  const contentWidth = layoutRef.current?.getBoundingClientRect().width
    || viewport.width - (viewport.width > 680 ? 64 : 0);
  const maxDesktop = Math.max(MIN_DESKTOP, Math.min(660, contentWidth - 320));
  const maxMobile = Math.max(64, Math.min(Math.round(viewport.height * 0.8), viewport.height - headerHeight - 130));
  const size = mobile
    ? clamp(settings.mobile, 64, maxMobile)
    : clamp(settings.desktop, MIN_DESKTOP, maxDesktop);
  const displayedSize = settings.open ? size : mobile ? 30 : 24;

  function setSize(value: number) {
    if (mobile) setSettings(s => ({ ...s, mobile: clamp(value, 64, maxMobile), open: true }));
    else setSettings(s => ({ ...s, desktop: clamp(value, MIN_DESKTOP, maxDesktop), open: true }));
  }
  function startDrag(event: PointerEvent<HTMLButtonElement>) {
    if (!settings.open) {
      setSettings(s => ({ ...s, open: true }));
      return;
    }
    dragStart.current = { x: event.clientX, y: event.clientY, size };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    if (!dragStart.current) return;
    const delta = mobile
      ? dragStart.current.y - event.clientY
      : event.clientX - dragStart.current.x;
    setSize(dragStart.current.size + delta);
  }
  function stopDrag(event: PointerEvent<HTMLButtonElement>) {
    dragStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }
  function handleKeys(event: KeyboardEvent<HTMLButtonElement>) {
    const increment = mobile
      ? event.key === "ArrowUp" ? 20 : event.key === "ArrowDown" ? -20 : 0
      : event.key === "ArrowRight" ? 20 : event.key === "ArrowLeft" ? -20 : 0;
    if (increment) {
      event.preventDefault();
      setSize(size + increment);
    }
  }

  const style = {
    "--work-panel-size": `${displayedSize}px`,
    "--work-panel-top": `${headerHeight}px`,
  } as CSSProperties;

  return (
    <div
      ref={layoutRef}
      className={`resizable-work-panel-layout${enabled ? " is-enabled" : ""}`}
      style={enabled ? style : undefined}
    >
      <div className="resizable-work-panel-page">{children}</div>
      {enabled && (
        <aside
          className={`resizable-work-panel-frame${settings.open ? "" : " is-collapsed"}`}
          aria-label="لوح العمل التجريبي"
          data-panel-state={settings.open ? "open" : "closed"}
        >
          {settings.open && (
            <div className="resizable-work-panel-content" dir="rtl">
              <div className="resizable-work-panel-heading">
                <strong>لوح العمل</strong>
                <button
                  type="button"
                  className="resizable-work-panel-toggle"
                  aria-label="طي لوح العمل"
                  title="طي اللوح"
                  onClick={() => setSettings(s => ({ ...s, open: false }))}
                >
                  <PanelLeftClose size={16} />
                </button>
              </div>
              {renderTools?.(mobile ? size : viewport.height - headerHeight)}
            </div>
          )}
          {!settings.open && (
            <button
              type="button"
              className="resizable-work-panel-expand"
              aria-label="فتح لوح العمل"
              title="فتح لوح العمل"
              onClick={() => setSettings(s => ({ ...s, open: true }))}
            >
              <PanelLeftOpen size={16} />
            </button>
          )}
          <button
            type="button"
            className="resizable-work-panel-grip"
            aria-label={mobile ? "سحب خطاف اللوح لتغيير ارتفاعه" : "سحب خطاف اللوح لتغيير عرضه"}
            aria-orientation={mobile ? "horizontal" : "vertical"}
            aria-valuemin={mobile ? 64 : MIN_DESKTOP}
            aria-valuemax={mobile ? maxMobile : maxDesktop}
            aria-valuenow={size}
            role="separator"
            tabIndex={0}
            title="اسحب لتغيير حجم اللوح، أو استخدم الأسهم"
            onPointerDown={startDrag}
            onPointerMove={moveDrag}
            onPointerUp={stopDrag}
            onPointerCancel={stopDrag}
            onKeyDown={handleKeys}
          >
            <GripHorizontal className="resizable-work-panel-icon-mobile" size={17} />
            <GripVertical className="resizable-work-panel-icon-desktop" size={17} />
          </button>
        </aside>
      )}
    </div>
  );
}
