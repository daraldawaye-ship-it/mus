import {DockSearchResults,focusFirstDockResult} from "./DockSearchResults";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { ItemMenuHistory, type ItemMenuQuickAction } from "./ItemMenuHistory";
import type { Page, User } from "../../../packages/contracts/src/index";
import { api, ApiFailure } from "./api";
import {
  readRecentEntity, rememberRecentEntity, RECENT_ENTITY_EVENT,
  type RecentEntity, type RecentEntityKind,
} from "./recent-entities";

type Choice = RecentEntity & { code?: string; barcode?: string; displayName?: string };
const config: Record<RecentEntityKind, { label: string; placeholder: string }> = {
  item: { label: "صنف", placeholder: "اسم الصنف أو التركيب أو الباركود أو الرمز…" },
  account: { label: "حساب", placeholder: "اسم الحساب أو رقمه…" },
  employee: { label: "مستخدم", placeholder: "اسم الموظف أو هاتفه أو بريده…" },
};

export function EntityMenuSearch({
  user, companyId, employeeId = null, employeeName, kind, itemMenuReset = 0,
  onEditItem = () => {}, onOpenComposition = () => {}, onItemQuickAction = () => {},
  canCreateMemo = false, canViewItemCompositions = false, renderSelection, renderAdjacent, fieldLabel, dockSelection, floatingResults=false,staffDockLookup,accountLookup,
}: {
  user: User;
  companyId: number | null;
  employeeId?: number | null;
  employeeName?: string | null;
  kind: RecentEntityKind;
  itemMenuReset?: number;
  onEditItem?: (itemId: number) => void;
  onOpenComposition?: (compositionId: number) => void;
  onItemQuickAction?: (action: ItemMenuQuickAction,itemId: number,itemName: string) => void;
  canCreateMemo?: boolean;
  canViewItemCompositions?: boolean;
  renderSelection?: (selected: RecentEntity | null) => ReactNode;
  renderAdjacent?: (selected: RecentEntity | null) => ReactNode;
  fieldLabel?: string;
  dockSelection?: RecentEntity;
  floatingResults?:boolean;
  staffDockLookup?:"limited"|"fallback";
  accountLookup?:"ledger";
}) {
  const [recent, setRecent] = useState<RecentEntity | null>(() =>
    readRecentEntity(user.id, companyId ?? 0, kind));
  const fallback: RecentEntity | null = kind === "employee" && !recent
    ? { id: companyId && employeeId ? employeeId : user.id,
        name: companyId && employeeId ? (employeeName || user.displayName) : user.displayName }
    : null;
  const selected = recent ?? fallback;
  const [entry, setEntry] = useState(selected?.name ?? "");
  const [search, setSearch] = useState("");
  const [focused, setFocused] = useState(false);
  const [page, setPage] = useState(1);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const fieldAnchor=useRef<HTMLSpanElement>(null);
  const resultsId = useId();
  const {label, placeholder} = config[kind];
  const company = companyId ?? 0;

  useEffect(() => {
    setRecent(readRecentEntity(user.id, company, kind));
    setFocused(false); setSearch(""); setPage(1); setActive(0);
  }, [user.id, company, kind]);
  useEffect(() => {
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<{userId:number;companyId:number;kind:RecentEntityKind;value:RecentEntity}>).detail;
      if (detail?.userId === user.id && detail.companyId === company && detail.kind === kind) {
        setRecent(detail.value);
        setEntry(detail.value.name);
        setFocused(false);
        setSearch(""); setPage(1); setActive(0);
      }
    };
    window.addEventListener(RECENT_ENTITY_EVENT, onChange);
    return () => window.removeEventListener(RECENT_ENTITY_EVENT, onChange);
  }, [user.id, company, kind]);
  useEffect(() => {
    if (!focused) setEntry(selected?.name ?? "");
  }, [selected?.id, selected?.name, focused]);
  useEffect(() => {
    const timer = window.setTimeout(() => { setSearch(entry.trim()); setPage(1); setActive(0); }, kind === "item" ? 110 : 230);
    return () => window.clearTimeout(timer);
  }, [entry]);

  useEffect(()=>{
    if(!dockSelection)return;
    setRecent(dockSelection);setEntry(dockSelection.name);
    setFocused(false);setSearch("");setPage(1);setActive(0);
  },[dockSelection]);

  const embeddedItem=kind==="item"?staffDockLookup:undefined;
  const limitedItem=embeddedItem==="limited";
  const minimumSearch=limitedItem?2:1;
  const canSearch=company>0&&search.length>=minimumSearch;
  const resource = kind === "item"
    ? `/companies/${company}/commerce-options?type=items`
    : kind === "account"
      ? (accountLookup==="ledger" ? `/companies/${company}/account-ledger/accounts`
        : `/companies/${company}/financial-options?type=accounts`)
      : `/companies/${company}/employees?active=true`;
  const sort = kind === "item" ? "saleTimes:desc,code:asc"
    : kind === "account" ? "name:asc" : "name:asc";
  const result = useQuery({
    queryKey: ["avatar-entity-search", user.id, company, kind, search, page, embeddedItem, accountLookup],
    queryFn: async ({signal}) => {
      const limited=()=>api<Page<Choice> & {hasMore?:boolean}>(
        `/companies/${company}/work-panel-items?${new URLSearchParams({q:search,page:String(page)})}`,{signal});
      if(limitedItem) return limited();
      try {
        return await api<Page<Choice> & {hasMore?:boolean}>(
          `${resource}${resource.includes("?")?"&":"?"}${new URLSearchParams({q:search,page:String(page),pageSize:"10",sort,...(kind === "item" ? {fast:"1"} : {})})}`,
          {signal});
      } catch (error) {
        if(embeddedItem==="fallback"&&search.length>=2&&search.length<=120&&!signal.aborted&&
          error instanceof ApiFailure&&error.status===403) return limited();
        throw error;
      }
    },
    enabled: canSearch && focused,
    staleTime: kind === "item" ? 30_000 : 3000,
    gcTime:embeddedItem?0:undefined,
  });
  const choices = embeddedItem&&result.isError?[]:result.data?.items??[];
  const hasNext = kind === "item" ? !!result.data?.hasMore : page * 10 < (result.data?.total ?? 0);
  const showPages = kind === "item" ? page > 1 || hasNext : (result.data?.total ?? 0) > 10;
  const choose = (value: Choice) => {
    rememberRecentEntity(user.id, company, kind, {id:value.id,name:value.name});
    setRecent({id:value.id,name:value.name});
    setEntry(value.name);
    setFocused(false);setSearch("");setPage(1);setActive(0);
    input.current?.blur();
  };
  const suggestionsOpen=company>0&&focused&&entry.trim().length>=minimumSearch;
  const suggestions=suggestionsOpen ? (
        <div className="user-menu-entity-results"
          id={resultsId} role="listbox" aria-label={`نتائج ${label}`}>
          {result.isFetching && <p className="user-menu-entity-hint">جارٍ البحث…</p>}
          {result.isError && <p className="user-menu-entity-hint">تعذر البحث أو ليست لديك صلاحية عرض هذه البيانات.</p>}
          {!result.isFetching && !result.isError && !choices.length &&
            <p className="user-menu-entity-hint">لا توجد نتائج مطابقة.</p>}
          {(search === entry.trim() ? choices : []).map((choice,index) => (
            <button key={choice.id} type="button" role="option"
              aria-selected={active === index}
              data-operator-action="entity.open" data-operator-detail={`menu.choose.${kind}`}
              className={`user-menu-entity-choice${active===index?" selected":""}`}
              onMouseDown={event => event.preventDefault()}
              onClick={() => choose(choice)}
            >
              <span title={choice.name}>{choice.name}</span>
              <small dir="auto">{kind === "employee"
                ? (choice.displayName ?? "") : (choice.code ?? choice.barcode ?? "")}</small>
            </button>
          ))}
          {showPages && (
            <div className="user-menu-entity-pager">
              <button type="button" data-operator-action="entity.open" data-operator-detail="menu.previous" disabled={page<=1 || result.isFetching}
                onClick={()=>{setPage(v=>v-1);setActive(0);}}>السابق</button>
              <span>{kind === "item" ? `صفحة ${page}` : `${page} / ${Math.max(1,Math.ceil((result.data?.total ?? 0)/10))}`}</span>
              <button type="button" data-operator-action="entity.open" data-operator-detail="menu.next" disabled={result.isFetching || !hasNext}
                onClick={()=>{setPage(v=>v+1);setActive(0);}}>التالي</button>
            </div>
          )}
        </div>
  ) : null;
  const searchField = (
      <label className="user-menu-entity-search">
        <span ref={fieldAnchor} className={`user-menu-entity-input-wrap${fieldLabel ? " has-field-label" : ""}`}>
          {fieldLabel && <span className="user-menu-entity-field-label">{fieldLabel}</span>}
          <Search size={17} aria-hidden="true" />
          <input
            ref={input}
            type="search"
            data-operator-search={kind === "item" ? "items.search" : undefined}
            aria-label={fieldLabel ?? `البحث عن ${label}`}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={floatingResults?suggestionsOpen:canSearch&&focused}
            aria-controls={(floatingResults?suggestionsOpen:canSearch&&focused) ? resultsId : undefined}
            autoComplete="off"
            placeholder={limitedItem?"اسم الصنف أو رمزه":placeholder}
            maxLength={limitedItem?120:undefined}
            value={entry}
            onFocus={event => { setFocused(true); event.currentTarget.select(); }}
            onChange={event => { setEntry(event.target.value); setFocused(true); setActive(0); }}
            onKeyDown={event => {
              if(floatingResults&&event.key==="Tab"&&!event.shiftKey&&focusFirstDockResult(resultsId)){
                event.preventDefault();return;
              }
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setActive(index => Math.max(0, Math.min(choices.length - 1,
                  index + (event.key === "ArrowDown" ? 1 : -1))));
              }
              if (event.key === "Enter") {
                event.preventDefault();
                if (choices[active] && !result.isFetching && search === entry.trim()) choose(choices[active]);
              }
              if (event.key === "Escape") {
                event.stopPropagation();setFocused(false);setEntry(selected?.name ?? "");
                input.current?.blur();
              }
            }}
          />
        </span>
      </label>
  );
  return (
    <div className="user-menu-entity-section">
      {renderAdjacent ? (
        <div className="work-panel-item-search-row">
          {searchField}
          {renderAdjacent(selected)}
        </div>
      ) : searchField}
      {company === 0 && (
        <p className="user-menu-entity-hint">
          {kind === "employee"
            ? "المستخدم الافتراضي هو حسابك. البحث عن الموظفين متاح عند الدخول إلى شركة."
            : "افتح الشركة للبحث عن " + label + " فيها."}
        </p>
      )}
      {suggestionsOpen && (floatingResults
        ? <DockSearchResults anchor={fieldAnchor} onDismiss={()=>setFocused(false)}>{suggestions}</DockSearchResults>
        : suggestions)}
      {renderSelection?.(selected)}
      {!renderSelection && kind === "item" && company > 0 && (
        <ItemMenuHistory userId={user.id} companyId={company}
          itemId={selected?.id ?? null} itemName={selected?.name ?? null}
          resetKey={itemMenuReset} onEditItem={onEditItem}
          onOpenComposition={onOpenComposition}
          onQuickAction={onItemQuickAction} canCreateMemo={canCreateMemo}
          canViewItemCompositions={canViewItemCompositions} />
      )}
      {!renderSelection && !focused && selected && kind !== "item" && (
        <p className="user-menu-entity-hint">
          {recent ? "آخر " + label + " تم التعامل معه: " : "المستخدم الافتراضي: "}
          <strong>{selected.name}</strong>
        </p>
      )}
    </div>
  );
}
