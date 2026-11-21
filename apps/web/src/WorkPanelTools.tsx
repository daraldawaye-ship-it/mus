import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { GripHorizontal } from "lucide-react";
import type { User } from "../../../packages/contracts/src/index";
import { EntityMenuSearch } from "./EntityMenuSearch";
import { ItemMenuHistory } from "./ItemMenuHistory";
import "./pages/ConnectedOptionKeys.css";

type ItemView = "movement" | "alternatives";
const itemViews: { key: ItemView; label: string }[] = [
  { key: "movement", label: "الحركة" },
  { key: "alternatives", label: "البدائل" },
];
const DEFAULT_HEIGHT = 380;
const MIN_HEIGHT = 136;

function loadHeight(key: string): number {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    if (Number.isFinite(saved?.height)) return Math.max(MIN_HEIGHT, saved.height);
  } catch { /* private mode or malformed saved height */ }
  return DEFAULT_HEIGHT;
}

/** Company-scoped tools reuse the same recent selection and reports as the menu. */
export function WorkPanelTools({ user, companyId, availableHeight }: {
  user: User;
  companyId: number | null;
  availableHeight: number;
}) {
  const storageKey = `alraesy:work-panel-tools:v1:${user.id}:${companyId ?? 0}`;
  const [savedHeight, setSavedHeight] = useState(() => loadHeight(storageKey));
  const [views, setViews] = useState<ItemView[]>([]);
  const dragStart = useRef<{ y: number; height: number } | null>(null);
  // Leave room for the board heading and the account search. The outer board
  // still scrolls when the user makes the mobile panel particularly short.
  const maxHeight = Math.max(MIN_HEIGHT, availableHeight - 120);
  const height = Math.min(savedHeight, maxHeight);

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify({ height: savedHeight })); } catch { /* private mode */ }
  }, [savedHeight, storageKey]);

  function resize(value: number) {
    setSavedHeight(Math.min(maxHeight, Math.max(MIN_HEIGHT, value)));
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
        <div className="work-panel-item-body">
          <EntityMenuSearch user={user} companyId={companyId} kind="item" fieldLabel="بحث عن صنف"
            renderSelection={selected => (
              <>
                <div className="work-panel-item-options design-connected-options design-connected-options-row" role="group" aria-label="عرض بيانات الصنف">
                  {itemViews.map(view => {
                    const enabled = views.includes(view.key);
                    return (
                      <button key={view.key} type="button" aria-pressed={enabled}
                        onClick={() => setViews(previous => previous.includes(view.key)
                          ? previous.filter(value => value !== view.key)
                          : [...previous, view.key])}>
                        {view.label}
                      </button>
                    );
                  })}
                </div>
                {!!companyId && itemViews.filter(view => views.includes(view.key)).map(view => (
                  <div className="work-panel-item-report" key={`${companyId}:${selected?.id ?? "none"}:${view.key}`}>
                    <ItemMenuHistory userId={user.id} companyId={companyId}
                      itemId={selected?.id ?? null} itemName={selected?.name ?? null} fixedView={view.key}
                      hideHeading={view.key === "movement"} />
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
