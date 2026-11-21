import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { CompanyContext } from "../../../../packages/contracts/src/index.ts";
import { api, useSession } from "../api";
import { errorMessage } from "../phase2";
import { Button, Card, Notice, PageHeader } from "../ui";
import InteractiveColumnsTable, { type InteractiveTableColumn } from "../InteractiveColumnsTable";
import "./expiry-alert-follow-up.css";

type Kind = "expired" | "expiring-30";
type SortKey = "expiry" | "name" | "quantity";
type ColumnKey = SortKey | "details";
type ExpiryItem = {
  itemId: number; code: string; name: string; unit1Name: string;
  expiryDate: string; quantityUnit1: string;
};
type Report = {
  kind: Kind; asOf: string; page: number; pageSize: number; total: number;
  summary: {items: number};
  items: ExpiryItem[];
};
const fmt = (value: string | number) => Number(value).toLocaleString("en-US",{
  minimumFractionDigits: 0,maximumFractionDigits: 4,
});
const sortValues: readonly SortKey[] = ["expiry", "name", "quantity"];
const expiringColumns: readonly ColumnKey[] = ["name", "quantity", "expiry"];
const expiredColumns: readonly ColumnKey[] = [...expiringColumns, "details"];
const rowKey = (row: ExpiryItem) => row.itemId;
const dockRowSource = (row: ExpiryItem) => ({ itemId: row.itemId, itemName: row.name });
const emptyMessage = "لا توجد أصناف مطابقة لهذه الفئة وفق أقرب تاريخ انتهاء في كرت الصنف.";

function readVisibleColumns(storageKey: string, defaultColumns: readonly ColumnKey[]): ColumnKey[] {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? "null");
    if (Array.isArray(saved)) {
      const selected = defaultColumns.filter(key => saved.includes(key));
      if (selected.length) return selected;
    }
  } catch { /* Missing or restricted browser storage must not prevent displaying the report. */ }
  return [...defaultColumns];
}

function ExpiryTable({ companyId, kind, scope, rows, title, sortBy, sortDir, onSort }: {
  companyId: number; kind: Kind; scope: string; rows: ExpiryItem[]; title: string;
  sortBy: SortKey; sortDir: "asc" | "desc"; onSort: (key: SortKey) => void;
}) {
  const visibilityKey = `alraesy:expiry-follow-up-visible:v1:${scope}`;
  const showDetails = kind === "expired";
  const defaultColumns = showDetails ? expiredColumns : expiringColumns;
  const [visible, setVisible] = useState(() => readVisibleColumns(visibilityKey, defaultColumns));
  const columns = useMemo<InteractiveTableColumn<ExpiryItem, ColumnKey>[]>(() => [
    { key: "name", label: "الصنف", width: 250, sortable: true, cell: item =>
      <span className="expiry-alert-item-name">
        {showDetails ? <Link to={`/companies/${companyId}/items/${item.itemId}`}>{item.name}</Link> : item.name}
        <small className="muted"><bdi>{item.code}</bdi></small>
      </span> },
    { key: "quantity", label: "صافي المتوفر دون المرتجعات (و1)", width: 194, sortable: true,
      cell: item => <span><bdi>{fmt(item.quantityUnit1)}</bdi> {item.unit1Name}</span> },
    { key: "expiry", label: "أقرب تاريخ انتهاء (من كرت الصنف)", width: 194, sortable: true,
      cell: item => <bdi dir="ltr">{item.expiryDate}</bdi> },
  ], [companyId, showDetails]);
  const allColumns = useMemo(() => {
    if (!showDetails) return columns;
    const details: InteractiveTableColumn<ExpiryItem, ColumnKey> = {
      key: "details", label: "التفاصيل", width: 146,
      cell: item => <Link to={`/companies/${companyId}/stock-balances?view=lots&itemId=${item.itemId}`}>
        تفاصيل الدفعات
      </Link>,
    };
    return [...columns, details];
  }, [columns, companyId, showDetails]);
  function saveVisible(next: ColumnKey[]) {
    if (!next.length) return;
    setVisible(next);
    try { window.localStorage.setItem(visibilityKey, JSON.stringify(next)); }
    catch { /* The selected columns still work in this view. */ }
  }
  return <>
    <details className="expiry-alert-follow-up-columns">
      <summary>الأعمدة ({visible.length}/{allColumns.length})</summary>
      <div role="group" aria-label="إظهار وإخفاء أعمدة الصلاحية">
        {allColumns.map(column => <label key={column.key}>
          <input type="checkbox" checked={visible.includes(column.key)}
            disabled={visible.length === 1 && visible.includes(column.key)}
            onChange={event => saveVisible(event.currentTarget.checked
              ? defaultColumns.filter(key => key === column.key || visible.includes(key))
              : visible.filter(key => key !== column.key))} />
          {column.label}
        </label>)}
        <Button type="button" size="compact" variant="secondary"
          disabled={visible.length === allColumns.length}
          onClick={() => saveVisible([...defaultColumns])}>إظهار الكل</Button>
      </div>
    </details>
    <InteractiveColumnsTable<ExpiryItem, ColumnKey>
      columns={allColumns} rows={rows} rowKey={rowKey}
      storageKey={`alraesy:expiry-follow-up-layout:v1:${scope}`} visibleColumns={visible}
      sortKey={sortBy} sortDirection={sortDir} onSort={key => { if (key !== "details") onSort(key); }}
      dockRowSource={dockRowSource} ariaLabel={title} emptyMessage={emptyMessage} />
  </>;
}

export function ExpiryAlertFollowUpPage({context,kind}: {
  context: CompanyContext; kind: Kind;
}) {
  const companyId = context.company.id;
  const {user} = useSession();
  const [params,setParams] = useSearchParams();
  const q=params.get("q")||"";
  const [search,setSearch] = useState(q);
  const sortBy=sortValues.find(value=>value===params.get("sortBy"))??"expiry";
  const sortDir=params.get("sortDir")==="desc"?"desc":"asc";
  const page=Math.max(1,Math.min(100000,Math.floor(Number(params.get("page"))||1)));
  const pageSize=[20,50,100].includes(Number(params.get("pageSize")))?
    Number(params.get("pageSize")):50;
  const update=(changes:Record<string,string>,replace=false)=>{
    setParams(before=>{
      const result=new URLSearchParams(before);
      for(const [key,value] of Object.entries(changes))
        if(value)result.set(key,value);else result.delete(key);
      return result;
    },{replace});
  };
  useEffect(()=>setSearch(q),[q]);
  useEffect(()=>{
    if(search.trim()===q)return;
    const timer=window.setTimeout(()=>update({q:search.trim(),page:""},true),350);
    return()=>window.clearTimeout(timer);
  },[search,q]);
  const queryString = new URLSearchParams({
    q,sortBy,sortDir,page:String(page),pageSize:String(pageSize),
  }).toString();
  const report=useQuery({
    queryKey:["expiry-alert-follow-up",user?.id,companyId,kind,queryString],
    queryFn:({signal})=>api<Report>(
      "/companies/"+companyId+"/expiry-alert-follow-up/"+kind+"?"+queryString,{signal}),
    enabled:!!user,staleTime:15000,
  });
  const data=report.data;
  const title=kind==="expired"?"متابعة الأصناف المنتهية الصلاحية":
    "متابعة الأصناف التي ستنتهي خلال 30 يومًا";
  const another=kind==="expired"?"expiring-items-follow-up":"expired-items-follow-up";
  const pages=Math.max(1,Math.ceil((data?.total??0)/pageSize));
  const layoutScope=`${user?.id??"guest"}:${companyId}:${kind}`;
  const onSort=(key:SortKey)=>update({
      sortBy:key,sortDir:key===sortBy&&sortDir==="asc"?"desc":"asc",page:"",
  });
  return <div className="expiry-alert-follow-up-page">
    <PageHeader title={title} description="سطر واحد لكل صنف، حسب أقرب تاريخ انتهاء في كرت الصنف وصافي المتوفر دون مخازن المرتجعات."
      actions={<>
        <Link className="button button-secondary" to={"/companies/"+companyId+"/"+another}>
          {kind==="expired"?"الأصناف القريبة من الانتهاء":"الأصناف المنتهية"}
        </Link>
        <Link className="button button-secondary" to={"/companies/"+companyId+"/item-order-levels"}>
          حدود طلب الأصناف
        </Link>
      </>}/>
    <Card>
      {data&&<div className="expiry-alert-follow-up-summary">
        <span>عدد الأصناف: <strong>{fmt(data.summary.items)}</strong></span>
        <span>تاريخ الفحص: <strong>{data.asOf}</strong></span>
      </div>}
      <div className="expiry-alert-follow-up-controls">
        <label>بحث
          <input type="search" value={search} onChange={event=>setSearch(event.target.value)}
            placeholder="اسم الصنف أو الرمز"/>
        </label>
        <Button variant="secondary" size="compact" disabled={report.isFetching}
          onClick={()=>void report.refetch()}>تحديث</Button>
      </div>
      {report.isPending&&<Notice>جارٍ تحميل بيانات الأصناف…</Notice>}
      {report.isError&&<Notice tone="error">تعذر قراءة أصناف الصلاحية: {errorMessage(report.error)}</Notice>}
      {data&&<>
        <div className="expiry-alert-follow-up-count">الأصناف المطابقة: {fmt(data.total)}</div>
        <ExpiryTable key={layoutScope} companyId={companyId} kind={kind} scope={layoutScope} rows={data.items}
          title={title} sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
        <div className="expiry-alert-follow-up-pages">
          <Button variant="secondary" disabled={page<=1}
            onClick={()=>update({page:String(page-1)})}>السابق</Button>
          <span>صفحة {page} من {pages}</span>
          <Button variant="secondary" disabled={page>=pages}
            onClick={()=>update({page:String(page+1)})}>التالي</Button>
          <label>الصفوف
            <select value={pageSize} onChange={event=>update({pageSize:event.target.value,page:""})}>
              <option value="20">20</option><option value="50">50</option><option value="100">100</option>
            </select>
          </label>
        </div>
      </>}
      <small className="muted">التاريخ مأخوذ من حقل «أقرب تاريخ انتهاء» بكرت الصنف، وهو للمتابعة المختصرة ولا يوزّع الكمية على دفعات الصلاحية.{kind==="expired"&&" يمكن فتح «تفاصيل الدفعات» لمراجعة تواريخ المخزون الفعلية."} يضبط تكرار التنبيه من كرت نوعه.</small>
    </Card>
  </div>;
}
