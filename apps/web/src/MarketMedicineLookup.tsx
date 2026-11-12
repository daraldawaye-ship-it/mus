import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { MarketCard } from "../../../packages/contracts/src/medicine-market";
import { api, useSession } from "./api";
import { Button, Dialog, Notice } from "./ui";

type MarketCardsPage = { items: MarketCard[]; total: number; page: number; pageSize: number };

export function MarketMedicineLookup({
  value,
  onChange,
  disabled = false,
  initialSearch = "",
}: {
  value: number | null;
  onChange: (id: number | null) => void;
  disabled?: boolean;
  initialSearch?: string;
}) {
  const { user } = useSession();
  const labelId = useId();
  const choiceId = useId();
  const searchId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const search = query.trim();

  const selected = useQuery({
    queryKey: ["market-medicine-link", user?.id, "selected", value],
    queryFn: ({ signal }) => api<{ card: MarketCard }>(
      "/medicine-market/cards/" + value, { signal },
    ),
    enabled: !!user && !!value,
    staleTime: 60000,
  });
  const results = useQuery({
    queryKey: ["market-medicine-link", user?.id, "search", search, page],
    queryFn: ({ signal }) => api<MarketCardsPage>(
      "/medicine-market/cards?" + new URLSearchParams({
        kind: "medicine",
        archived: "false",
        q: search,
        page: String(page),
        pageSize: "20",
      }), { signal },
    ),
    enabled: !!user && open && search.length > 0,
    staleTime: 15000,
  });

  const linked = selected.data?.card;
  const linkedName = linked?.kind === "medicine" ? linked.name : null;
  const beginSearch = () => {
    setQuery(initialSearch.trim());
    setPage(1);
    setOpen(true);
  };
  const options = (results.data?.items ?? []).filter(
    (card) => card.kind === "medicine" && !card.archived,
  );
  const total = results.data?.total ?? 0;
  return (
    <>
      <div className="field item-floating-picker">
        <label id={labelId}>ربط الصنف بصنف السوق</label>
        <div className="item-reference-field">
          <Button variant="secondary" disabled={disabled}
            aria-labelledby={labelId + " " + choiceId}
            onClick={beginSearch}>
            <span id={choiceId}>
              {linkedName ?? (value ? "صنف السوق #" + value : "بحث واختيار صنف السوق")}
            </span>
          </Button>
          {value !== null && (
            <Button variant="ghost" disabled={disabled}
              aria-label="إلغاء ربط الصنف بصنف السوق"
              onClick={() => onChange(null)}>×</Button>
          )}
        </div>
        {value !== null && (
          <small className="muted">
            {"معرف السوق: " + value}
            {linked?.archived ? " — الصنف مؤرشف في السوق" : ""}
            {linked && linked.kind !== "medicine" ? " — الربط لا يشير إلى صنف سوق" : ""}
          </small>
        )}
      </div>
      <Dialog open={open} title="البحث في أصناف السوق" onClose={() => setOpen(false)}>
        <div className="field">
          <label htmlFor={searchId}>اسم الصنف بالعربي أو الإنجليزي</label>
          <input
            id={searchId}
            type="search"
            autoFocus
            autoComplete="off"
            value={query}
            onChange={(event) => { setQuery(event.target.value); setPage(1); }}
            placeholder="اكتب اسم الصنف أو جزءًا منه"
            style={{ width: "100%", minHeight: 36, padding: "6px 10px" }}
          />
        </div>
        {search.length === 0 ? (
          <small className="muted">اكتب جزءًا من الاسم لعرض أصناف السوق.</small>
        ) : results.isPending ? (
          <small className="muted">جارٍ البحث…</small>
        ) : results.isError ? (
          <Notice tone="error">تعذر البحث في أصناف السوق. أعد المحاولة.</Notice>
        ) : options.length === 0 ? (
          <small className="muted">لا توجد أصناف مطابقة.</small>
        ) : (
          <>
            <div role="list" aria-label="نتائج البحث في السوق"
              style={{ display: "grid", gap: 4, maxHeight: "45vh", overflowY: "auto" }}>
              {options.map((card) => {
                const english = typeof card.data.englishName === "string"
                  ? card.data.englishName.trim() : "";
                return (
                  <button type="button" role="listitem" key={card.id}
                    onClick={() => { onChange(card.id); setOpen(false); }}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      gap: 8, width: "100%", padding: "7px 9px", textAlign: "start",
                      border: "1px solid var(--border, #62717b)", borderRadius: 6,
                      background: "transparent", color: "inherit", cursor: "pointer",
                    }}>
                    <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
                      <strong>{card.name}</strong>
                      {english && <small dir="ltr" style={{ textAlign: "start" }}>{english}</small>}
                    </span>
                    <small className="muted">{"#" + card.id}</small>
                  </button>
                );
              })}
            </div>
            {total > 20 && (
              <div className="form-actions">
                <Button variant="ghost" size="compact" disabled={page === 1}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}>السابق</Button>
                <small className="muted">{"صفحة " + page + " من " + Math.ceil(total / 20)}</small>
                <Button variant="ghost" size="compact" disabled={page * 20 >= total}
                  onClick={() => setPage((current) => current + 1)}>التالي</Button>
              </div>
            )}
          </>
        )}
      </Dialog>
    </>
  );
}
