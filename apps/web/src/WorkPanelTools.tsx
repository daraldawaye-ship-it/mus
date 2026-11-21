import { useState } from "react";
import type { User } from "../../../packages/contracts/src/index";
import { EntityMenuSearch } from "./EntityMenuSearch";
import { ItemMenuHistory } from "./ItemMenuHistory";
import "./pages/RaisedOptionKeys.css";

type ItemView = "movement" | "alternatives";
const itemViews: { key: ItemView; label: string }[] = [
  { key: "movement", label: "الحركة" },
  { key: "alternatives", label: "البدائل" },
];
/** Company-scoped tools reuse the same recent selection and reports as the menu. */
export function WorkPanelTools({ user, companyId }: {
  user: User;
  companyId: number | null;
}) {
  const [views, setViews] = useState<ItemView[]>([]);

  return (
    <div className="work-panel-tools">
      <section className="work-panel-tool-card work-panel-item-container" aria-label="حاوية الصنف">
        <div className="work-panel-item-body">
          <EntityMenuSearch user={user} companyId={companyId} kind="item" fieldLabel="بحث عن صنف"
            renderSelection={selected => (
              <>
                <div className="work-panel-item-options" role="group" aria-label="عرض بيانات الصنف">
                  {itemViews.map(view => {
                    const enabled = views.includes(view.key);
                    return (
                      <button key={view.key} type="button" aria-pressed={enabled}
                        className="design-press-key design-press-key-sm"
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
      </section>
      <section className="work-panel-tool-card work-panel-account-container" aria-label="حاوية الحساب">
        <h3 className="work-panel-tool-title">بحث عن حساب</h3>
        <EntityMenuSearch user={user} companyId={companyId} kind="account" renderSelection={() => null} />
      </section>
    </div>
  );
}
