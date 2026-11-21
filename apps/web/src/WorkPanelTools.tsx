import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Check, GripHorizontal } from "lucide-react";
import type { User } from "../../../packages/contracts/src/index";
import { EntityMenuSearch } from "./EntityMenuSearch";
import { ItemMenuHistory } from "./ItemMenuHistory";

type ItemView = "movement" | "alternatives";
type ToolSettings = { height: number; views: ItemView[] };
const itemViews: { key: ItemView; label: string }[] = [
  { key: "movement", label: "حركة الصنف" },
  { key: "alternatives", label: "بدائل الصنف" },
];
const DEFAULT: ToolSettings = { height: 380, views: ["movement", "alternatives"] };
const MIN_HEIGHT = 136;

function loadSettings(key: string): ToolSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    return {
      height: Number.isFinite(saved?.height) ? Math.max(MIN_HEIGHT, saved.height) : DEFAULT.height,
      views: Array.isArray(saved?.views)
        ? itemViews.filter(view => saved.views.includes(view.key)).map(view => view.key)
        : DEFAULT.views,
    };
  } catch { return DEFAULT; }
}

/** Company-scoped tools reuse the same recent selection and reports as the menu. */
export function WorkPanelTools({ user, companyId, availableHeight }: {
  user: User;
  companyId: number | null;
  availableHeight: number;
}) {
  const storageKey = `alraesy:work-panel-tools:v1:${user.id}:${companyId ?? 0}`;
  const [settings, setSettings] = useState(() => loadSettings(storageKey));
  const dragStart = useRef<{ y: number; height: number } | null>(null);
  // Leave room for the board heading and the account search. The outer board
  // still scrolls when the user makes the mobile panel particularly short.
  const maxHeight = Math.max(MIN_HEIGHT, availableHeight - 120);
  const height = Math.min(settings.height, maxHeight);

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(settings)); } catch { /* private mode */ }
  }, [settings, storageKey]);

  function resize(value: number) {
    setSettings(previous => ({ ...previous, height: Math.min(maxHeight, Math.max(MIN_HEIGHT, value)) }));
  }
  function startResize(event: PointerEvent<HTMLButtonElement>) {
    dragStart.current = { y: event.clientY, height };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
  function stopResize(event: PointerEvent<HTMLButtonElement>) {
    dragStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }
  function resizeWithKeys(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      resize(height + (event.key === "ArrowDown" ? 20 : -20));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      resize(event.key === "Home" ? MIN_HEIGHT : maxHeight);
    }
  }

  return (
    <div className="work-panel-tools">
      <section className="work-panel-tool-card work-panel-item-container" aria-label="حاوية الصنف" style={{ height }}>
        <h3 className="work-panel-tool-title">بحث عن صنف</h3>
        <div className="work-panel-item-body">
          <EntityMenuSearch user={user} companyId={companyId} kind="item"
            renderSelection={selected => (
              <>
                <div className="work-panel-choice-chips" role="group" aria-label="عرض بيانات الصنف">
                  {itemViews.map(view => {
                    const enabled = settings.views.includes(view.key);
                    return (
                      <button key={view.key} type="button" aria-pressed={enabled}
                        className={enabled ? "selected" : ""}
                        onClick={() => setSettings(previous => ({
                          ...previous,
                          views: previous.views.includes(view.key)
                            ? previous.views.filter(value => value !== view.key)
                            : [...previous.views, view.key],
                        }))}>
                        {enabled && <Check size={12} aria-hidden="true" />}
                        {view.label}
                      </button>
                    );
                  })}
                </div>
                {!!companyId && itemViews.filter(view => settings.views.includes(view.key)).map(view => (
                  <div className="work-panel-item-report" key={`${companyId}:${selected?.id ?? "none"}:${view.key}`}>
                    <ItemMenuHistory userId={user.id} companyId={companyId}
                      itemId={selected?.id ?? null} itemName={selected?.name ?? null} fixedView={view.key} />
                  </div>
                ))}
              </>
            )} />
        </div>
        <button type="button" className="work-panel-container-grip" role="separator"
          aria-label="تغيير ارتفاع حاوية الصنف" aria-orientation="horizontal"
          aria-valuemin={MIN_HEIGHT} aria-valuemax={maxHeight} aria-valuenow={height}
          title="اسحب لتكبير حاوية الصنف أو تصغيرها، أو استخدم الأسهم"
          onPointerDown={startResize}
          onPointerMove={event => {
            if (dragStart.current) resize(dragStart.current.height + event.clientY - dragStart.current.y);
          }}
          onPointerUp={stopResize} onPointerCancel={stopResize} onKeyDown={resizeWithKeys}>
          <GripHorizontal size={16} aria-hidden="true" />
        </button>
      </section>
      <section className="work-panel-tool-card work-panel-account-container" aria-label="حاوية الحساب">
        <h3 className="work-panel-tool-title">بحث عن حساب</h3>
        <EntityMenuSearch user={user} companyId={companyId} kind="account" renderSelection={() => null} />
      </section>
    </div>
  );
}
