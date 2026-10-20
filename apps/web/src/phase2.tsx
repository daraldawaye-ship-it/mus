import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CompanyContext,
  CompanyCurrency,
  Page,
} from "../../../packages/contracts/src/index";
import { api, useSession } from "./api";
import { Button, Field, Notice, Select } from "./ui";
import { lookupOptionLabel } from "./lookup-option-label";

/** Pick active Yemeni rial for new documents without altering saved records.
 * Fetch through the same finance/commerce permissions as each document editor. */
export function useDefaultYerCurrency(
  companyId: number,
  resource: "financial-options" | "commerce-options",
) {
  const { user } = useSession();
  const result = useQuery({
    queryKey: ["company", user?.id, companyId, "default-yer", resource],
    queryFn: ({ signal }) =>
      api<Page<CompanyCurrency>>(
        `/companies/${companyId}/${resource}?type=currencies&active=true&q=YER&page=1&pageSize=20`,
        { signal },
      ),
    enabled: !!user && companyId > 0,
  });
  return result.data?.items.find(
    (item) => item.code === "YER" && item.active,
  ) ?? null;
}

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "تعذر إكمال الطلب. حاول مجددًا.";

export function moduleAccess(
  context: CompanyContext,
  module: "accounts" | "currencies" | "locations",
  manage = false,
) {
  return (
    context.general ||
    context.permissions.some(
      (permission) =>
        permission === `${module}.manage` ||
        (!manage && permission === `${module}.view`),
    )
  );
}

export function useMasterChanges(companyId: number) {
  const client = useQueryClient();
  const { user } = useSession();
  return async () => {
    await client.invalidateQueries({
      predicate: ({ queryKey }) =>
        queryKey[1] === user?.id &&
        ((queryKey[0] === "company" && queryKey[2] === companyId) ||
          (queryKey[0] === "master" && queryKey[2] === companyId) ||
          (queryKey[0] === "list" &&
            String(queryKey[2]).startsWith(`company:${companyId}:`))),
    });
  };
}

/** Searches each page on the server, while preserving an explicit selection. */
export function ServerLookup<T extends { id: number }>({
  companyId,
  resource,
  label,
  value,
  onChange,
  display,
  disabled = false,
  required = false,
  accept,
  emptyLabel = "اختر من النتائج",
  pageSize = 20,
  sort = "code:asc",
  singleInput = false,
  searchPlaceholder = "ابحث باسم الحساب أو رقمه",
  noResultsLabel = "لا توجد حسابات مطابقة.",
}: {
  companyId: number;
  resource: string;
  label: string;
  value: T | null;
  onChange: (value: T | null) => void;
  display: (value: T) => string;
  disabled?: boolean;
  required?: boolean;
  accept?: (value: T) => boolean;
  emptyLabel?: string;
  pageSize?: 20 | 50 | 100;
  sort?: "code:asc" | "name:asc" | "arabicName:asc";
  /** In invoice/voucher heads search and select in the same field. */
  singleInput?: boolean;
  searchPlaceholder?: string;
  noResultsLabel?: string;
}) {
  const { user } = useSession();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const dropdownId = useId();
  const [entry, setEntry] = useState(() => value ? display(value) : "");
  const [lookupOpen, setLookupOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputArea = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState<{top:number;left:number;width:number;maxHeight:number}|null>(null);
  useEffect(() => {
    if (!lookupOpen) setEntry(value ? display(value) : "");
  }, [value?.id, lookupOpen]);
  function placePopup() {
    const rect = inputArea.current?.querySelector("input")?.getBoundingClientRect();
    if (!rect) return;
    const topSpace = window.innerHeight - rect.bottom - 8;
    const above = topSpace < 180 && rect.top > topSpace;
    setBounds({
      top: above ? Math.max(8,rect.top-Math.min(290,rect.top-12)-5) : rect.bottom+4,
      left: Math.max(8,Math.min(rect.left,window.innerWidth-Math.min(Math.max(rect.width,250),window.innerWidth-16)-8)),
      width: Math.min(Math.max(rect.width,250),window.innerWidth-16),
      maxHeight: above ? Math.max(80,Math.min(290,rect.top-12)) : Math.max(80,Math.min(290,topSpace)),
    });
  }
  useEffect(() => {
    if (!lookupOpen) return;
    const outside = (event: PointerEvent) => {
      const target=event.target as Node;
      if (!inputArea.current?.contains(target) && !popup.current?.contains(target)) setLookupOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key==="Escape") setLookupOpen(false);
    };
    const recalc=()=>placePopup();
    document.addEventListener("pointerdown",outside);
    document.addEventListener("keydown",escape);
    window.addEventListener("resize",recalc);
    window.addEventListener("scroll",recalc,true);
    return () => {
      document.removeEventListener("pointerdown",outside);
      document.removeEventListener("keydown",escape);
      window.removeEventListener("resize",recalc);
      window.removeEventListener("scroll",recalc,true);
    };
  }, [lookupOpen]);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1024 : window.innerWidth,
  );
  useEffect(() => {
    const resize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const result = useQuery({
    queryKey: ["master", user?.id, companyId, "lookup", resource, query, page, pageSize, sort],
    queryFn: ({ signal }) => {
      const [path, search = ""] = resource.split("?");
      const params = new URLSearchParams(search);
      params.set("q", query);
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));
      params.set("sort", sort);
      return api<Page<T>>(`${path}?${params}`, { signal });
    },
    enabled: !!user,
  });
  const items = (result.data?.items ?? []).filter(
    (item) => !accept || accept(item),
  );
  const options =
    value && !items.some((item) => item.id === value.id)
      ? [value, ...items]
      : items;
  const choose = (next: T) => {
    onChange(next);
    setEntry(display(next));
    setQuery("");
    setPage(1);
    setLookupOpen(false);
  };
  if (singleInput) {
    return <div className="server-lookup server-lookup-single" ref={inputArea}>
      <Field
        label={label}
        type="search"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={lookupOpen}
        aria-controls={lookupOpen ? dropdownId : undefined}
        autoComplete="off"
        value={entry}
        disabled={disabled}
        required={required}
        placeholder={searchPlaceholder}
        onFocus={(event) => { setLookupOpen(true); setHighlight(0); placePopup(); event.currentTarget.select(); }}
        onBlur={() => { setLookupOpen(false); if (!value) { setQuery(""); setPage(1); } }}
        onChange={(event) => {
          const text=event.target.value;
          setEntry(text); setQuery(text); setPage(1); setHighlight(0); setLookupOpen(true); placePopup();
          if(value) onChange(null);
        }}
        onKeyDown={(event) => {
          if (!lookupOpen) return;
          if (event.key==="ArrowDown" || event.key==="ArrowUp") {
            event.preventDefault();
            setHighlight(index => Math.max(0, Math.min(options.length-1,index+(event.key==="ArrowDown"?1:-1))));
          } else if (event.key==="Enter") {
            event.preventDefault();
            if (options[highlight]) choose(options[highlight]);
          } else if (event.key==="Escape") {
            event.preventDefault(); setLookupOpen(false);
          }
        }}
      />
      {lookupOpen && bounds && createPortal(
        <div ref={popup} id={dropdownId} className="account-lookup-popup" role="listbox"
          aria-label={label}
          style={{position:"fixed",zIndex:10020,top:bounds.top,left:bounds.left,width:bounds.width,maxHeight:bounds.maxHeight}}>
          {result.error && <div className="account-lookup-status text-error">{errorMessage(result.error)}</div>}
          {!result.isFetching && options.length===0 && <div className="account-lookup-status">{noResultsLabel}</div>}
          {result.isFetching && <div className="account-lookup-status">جارٍ البحث…</div>}
          <div className="account-lookup-options">
            {options.map((item,index) => (
              <button key={item.id} type="button" role="option" aria-selected={value?.id===item.id}
                className={index===highlight?"account-lookup-option active":"account-lookup-option"}
                title={display(item)} onPointerDown={event=>event.preventDefault()}
                onClick={()=>choose(item)} onMouseEnter={()=>setHighlight(index)}>
                {display(item)}
              </button>
            ))}
          </div>
          <div className="account-lookup-pages">
            <button type="button" disabled={page<=1 || result.isFetching}
              onPointerDown={event=>event.preventDefault()}
              onClick={()=>{setPage(v=>v-1);setHighlight(0);}}>السابق</button>
            <span>{page} / {Math.max(1,Math.ceil((result.data?.total??0)/pageSize))}</span>
            <button type="button" disabled={result.isFetching || page*pageSize >= (result.data?.total??0)}
              onPointerDown={event=>event.preventDefault()}
              onClick={()=>{setPage(v=>v+1);setHighlight(0);}}>التالي</button>
          </div>
        </div>, 
        // Native modal dialogs live in the browser's top layer. Portaling the
        // results into document.body puts them *behind* that layer regardless
        // of z-index and makes the options impossible to click. Keep the
        // popup in the nearest open dialog (or the body on ordinary pages).
        inputArea.current?.closest("dialog[open]") ?? document.body
      )}
    </div>;
  }
  return (
    <div className="server-lookup">
      <Field
        label={`بحث عن ${label}`}
        type="search"
        value={query}
        disabled={disabled}
        onChange={(event) => {
          setQuery(event.target.value);
          setPage(1);
        }}
        placeholder="الاسم أو الكود"
      />
      <Select
        label={label}
        value={value?.id ?? ""}
        required={required}
        title={value ? display(value) : label}
        disabled={disabled || result.isFetching}
        onChange={(event) =>
          onChange(
            options.find((item) => item.id === Number(event.target.value)) ??
              null,
          )
        }
      >
        <option value="">{emptyLabel}</option>
        {options.map((item) => (
          <option key={item.id} value={item.id} title={display(item)}>
            {lookupOptionLabel(display(item), viewportWidth)}
          </option>
        ))}
      </Select>
      {result.error && (
        <Notice tone="error">{errorMessage(result.error)}</Notice>
      )}
      <div className="lookup-pages">
        <Button
          size="compact"
          variant="secondary"
          disabled={disabled || result.isFetching || page <= 1}
          onClick={() => setPage(page - 1)}
        >
          نتائج سابقة
        </Button>
        <span className="muted" aria-live="polite">
          {result.isFetching
            ? "جارٍ البحث…"
            : `صفحة ${page} · ${result.data?.total ?? 0} نتيجة`}
        </span>
        <Button
          size="compact"
          variant="secondary"
          disabled={
            disabled ||
            result.isFetching ||
            page * pageSize >= (result.data?.total ?? 0)
          }
          onClick={() => setPage(page + 1)}
        >
          نتائج تالية
        </Button>
      </div>
    </div>
  );
}
