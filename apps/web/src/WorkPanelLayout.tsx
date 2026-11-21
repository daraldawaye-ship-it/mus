import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from "react";
import { GripHorizontal, GripVertical, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import "./WorkPanelLayout.css";

type StoredPanel = { desktop: number; mobile: number; open: boolean };
const DEFAULT: StoredPanel = { desktop: 320, mobile: 320, open: true };
const DESKTOP_RAIL = 24;
const MOBILE_RAIL = 30;
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
  const dragStart = useRef<{
    pointerId: number;
    x: number;
    y: number;
    size: number;
    previousSize: number;
    moved: boolean;
  } | null>(null);
  const suppressGripClick = useRef(false);

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
  const rail = mobile ? MOBILE_RAIL : DESKTOP_RAIL;
  const maxSize = Math.max(rail + 1, mobile
    ? Math.min(Math.round(viewport.height * 0.8), viewport.height - headerHeight - 130)
    : Math.min(660, contentWidth - 320));
  const sizeKey = mobile ? "mobile" : "desktop";
  const size = clamp(settings[sizeKey], rail + 1, maxSize);
  const displayedSize = settings.open ? size : rail;

  function setSize(value: number, previousSize?: number) {
    setSettings(s => value <= rail
      ? { ...s, ...(previousSize === undefined ? {} : { [sizeKey]: previousSize }), open: false }
      : { ...s, [sizeKey]: clamp(value, rail + 1, maxSize), open: true });
  }
  function startDrag(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || dragStart.current) return;
    suppressGripClick.current = false;
    dragStart.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      size: displayedSize,
      previousSize: settings[sizeKey],
      moved: false,
    };
    // The same grip stays mounted when the contents collapse so the drag can
    // cross the rail and reverse without releasing the pointer.
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    event.preventDefault();
  }
  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const drag = dragStart.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = mobile ? drag.y - event.clientY : event.clientX - drag.x;
    if (!drag.moved && Math.abs(delta) < 3) return;
    drag.moved = true;
    setSize(drag.size + delta, drag.previousSize);
  }
  function stopDrag(event: PointerEvent<HTMLButtonElement>) {
    const drag = dragStart.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    suppressGripClick.current = drag.moved || event.type === "pointercancel";
    dragStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }
  function handleKeys(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setSize(event.key === "Home" ? rail : maxSize);
      return;
    }
    const increment = mobile
      ? event.key === "ArrowUp" ? 20 : event.key === "ArrowDown" ? -20 : 0
      : event.key === "ArrowRight" ? 20 : event.key === "ArrowLeft" ? -20 : 0;
    if (increment) {
      event.preventDefault();
      setSize(displayedSize + increment);
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
            aria-valuemin={rail}
            aria-valuemax={maxSize}
            aria-valuenow={displayedSize}
            role="separator"
            tabIndex={0}
            title="اسحب لتغيير الحجم أو لطي اللوح، أو استخدم الأسهم"
            onPointerDown={startDrag}
            onPointerMove={moveDrag}
            onPointerUp={stopDrag}
            onPointerCancel={stopDrag}
            onLostPointerCapture={stopDrag}
            onClick={event => {
              if (event.detail !== 0 && suppressGripClick.current) {
                suppressGripClick.current = false;
                return;
              }
              setSettings(s => s.open ? s : { ...s, open: true });
            }}
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
