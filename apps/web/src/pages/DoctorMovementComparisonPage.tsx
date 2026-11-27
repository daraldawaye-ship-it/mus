import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { CalendarRange, Columns3, LockKeyhole, RefreshCw, Search, TrendingUp } from "lucide-react";
import type { CompanyContext } from "../../../../packages/contracts/src/index.ts";
import { api, useSession } from "../api";
import { usePageDirectory } from "../page-directory";
import { errorMessage } from "../phase2";
import { formatWholeMoney } from "../format-money";
import { Button, Card, Dialog, Field, Notice, PageHeader, Select } from "../ui";
import InteractiveColumnsTable, { type InteractiveTableColumn } from "../InteractiveColumnsTable";
import "./DoctorMovementComparisonPage.css";

type Row = {
  doctorName:string;category:string;department:string;phone:string;
  currentAmount:string;previousAmount:string;difference:string;
  invoiceCountCurrent:string;invoiceCountPrevious:string;invoiceCountDifference:string;
  paidCurrent:string|null;paidPrevious:string|null;
  slipsCurrent:string|null;slipsPrevious:string|null;
};
const categoryLabels:Record<string,string>={
  doctor:"طبيب",nurse:"ممرض",entity:"جهة",
};
const money=(value:string|null)=>value===null?"—":formatWholeMoney(value);
const paidKeys:readonly ColumnKey[]=["paidCurrent","paidPrevious","slipsCurrent","slipsPrevious"];

type ColumnKey=keyof Row;
const formerColumnKeys:ColumnKey[]=[
  "doctorName","category","department","phone",
  "currentAmount","previousAmount","difference",
  "paidCurrent","paidPrevious","slipsCurrent","slipsPrevious",
];
// Default order (RTL) requested by the owner in the 19 Nov comparison screenshot.
// The eight featured columns come first; all remaining columns follow.
const defaultColumnKeys:ColumnKey[]=[
  "doctorName","category","currentAmount","invoiceCountCurrent",
  "difference","invoiceCountDifference","paidCurrent","slipsCurrent",
  "department","phone","previousAmount","invoiceCountPrevious",
  "paidPrevious","slipsPrevious",
];
const comparisonColumns:InteractiveTableColumn<Row,ColumnKey>[]=[
  {key:"doctorName",label:"الاسم المشترك للطبيب أو الجهة",width:245,sortable:true,
    cell:row=><span>{row.doctorName}</span>},
  {key:"category",label:"الفئة",width:85,sortable:true,
    cell:row=><span>{categoryLabels[row.category]??(row.category||"—")}</span>},
  {key:"department",label:"الجهة",width:145,sortable:true,
    cell:row=><span>{row.department||"—"}</span>},
  {key:"phone",label:"رقم الهاتف",width:132,sortable:true,
    cell:row=><bdi dir="ltr">{row.phone||"—"}</bdi>},
  {key:"currentAmount",label:"آخر 168 ساعة",width:142,sortable:true,
    cell:row=><bdi dir="ltr">{formatWholeMoney(row.currentAmount)}</bdi>},
  {key:"previousAmount",label:"الـ168 ساعة السابقة",width:154,sortable:true,
    cell:row=><bdi dir="ltr">{formatWholeMoney(row.previousAmount)}</bdi>},
  {key:"difference",label:"الفارق (+ / −)",width:138,sortable:true,
    cell:row=><strong><bdi dir="ltr">{signText(row.difference)}</bdi></strong>},
  {key:"invoiceCountCurrent",label:"مرات الفواتير — آخر 168 ساعة",width:168,sortable:true,
    cell:row=><bdi dir="ltr">{row.invoiceCountCurrent}</bdi>},
  {key:"invoiceCountPrevious",label:"مرات الفواتير — الـ168 السابقة",width:180,sortable:true,
    cell:row=><bdi dir="ltr">{row.invoiceCountPrevious}</bdi>},
  {key:"invoiceCountDifference",label:"فارق مرات الفواتير (+ / −)",width:170,sortable:true,
    cell:row=><strong><bdi dir="ltr">{signText(row.invoiceCountDifference)}</bdi></strong>},
  {key:"paidCurrent",label:"المسدد له بدون قصاصات — آخر 168 ساعة",width:215,sortable:true,
    cell:row=><bdi dir="ltr">{money(row.paidCurrent)}</bdi>},
  {key:"paidPrevious",label:"المسدد له بدون قصاصات — الـ168 السابقة",width:218,sortable:true,
    cell:row=><bdi dir="ltr">{money(row.paidPrevious)}</bdi>},
  {key:"slipsCurrent",label:"قصاصات مسددة — آخر 168 ساعة",width:195,sortable:true,
    cell:row=><bdi dir="ltr">{money(row.slipsCurrent)}</bdi>},
  {key:"slipsPrevious",label:"قصاصات مسددة — الـ168 السابقة",width:200,sortable:true,
    cell:row=><bdi dir="ltr">{money(row.slipsPrevious)}</bdi>},
];
comparisonColumns.sort((a,b)=>defaultColumnKeys.indexOf(a.key)-defaultColumnKeys.indexOf(b.key));
function readVisibleColumns(storageKey:string):ColumnKey[]{
  try{
    const current=window.localStorage.getItem(storageKey);
    const previousV2=current===null?window.localStorage.getItem(storageKey.replace(":v3:",":v2:")):null;
    const previousV1=current===null&&previousV2===null?
      window.localStorage.getItem(storageKey.replace(":v3:",":v1:")):null;
    const saved:unknown=JSON.parse(current??previousV2??previousV1??"null");
    if(Array.isArray(saved)){
      const selected=defaultColumnKeys.filter(key=>saved.includes(key));
      if(current===null){
        // Existing explicit choices remain; only newly introduced columns
        // are visible by default. A v1 layout predates metadata/payouts.
        const knownBefore=previousV2!==null?formerColumnKeys:
          ["doctorName","currentAmount","previousAmount","difference"];
        const migrated=defaultColumnKeys.filter(key=>
          selected.includes(key)||!knownBefore.includes(key));
        if(migrated.length)return migrated;
      }
      if(selected.length)return selected;
    }
  }catch{ /* Private browsing must not stop the table. */ }
  return [...defaultColumnKeys];
}
function ComparisonTable({rows,companyId,userId,sortKey,sortDir,onSort,canViewPayments,onInspect}:{
  rows:Row[];companyId:number;userId:number|string;sortKey:ColumnKey;sortDir:"asc"|"desc";
  onSort:(key:ColumnKey)=>void;canViewPayments:boolean;onInspect?:(row:Row)=>void;
}){
  const layoutPrefix = onInspect ? "private-doctor-movement" : "doctor-movement";
  const storageKey=`alraesy:${layoutPrefix}-columns-visible:v3:${companyId}:${userId}`;
  const columns = comparisonColumns.map(column => {
    if (onInspect && column.key === "doctorName") {
      return { ...column, cell: (row: Row) => <button type="button" className="movement-name"
        onClick={() => onInspect(row)} aria-label={`تفاصيل ${row.doctorName}`}>{row.doctorName}</button> };
    }
    if (!canViewPayments && paidKeys.includes(column.key)) return { ...column, sortable: false };
    return column;
  });
  const [visibleColumns,setVisibleColumns]=useState<ColumnKey[]>(()=>readVisibleColumns(storageKey));
  const [editingColumns,setEditingColumns]=useState<ColumnKey[]>(visibleColumns);
  const [columnsOpen,setColumnsOpen]=useState(false);
  function commitVisible(){
    if(!editingColumns.length)return;
    const selected=defaultColumnKeys.filter(key=>editingColumns.includes(key));
    setVisibleColumns(selected);
    try{window.localStorage.setItem(storageKey,JSON.stringify(selected));}catch{/* optional */}
    setColumnsOpen(false);
  }
  return <>
    <div className="form-actions doctor-comparison-table-actions">
      <Button variant="secondary" onClick={()=>{
        setEditingColumns(visibleColumns);setColumnsOpen(true);
      }}>{onInspect && <Columns3 size={16} aria-hidden="true" />}الأعمدة ({visibleColumns.length}/{defaultColumnKeys.length})</Button>
    </div>
    <Dialog open={columnsOpen} title="إظهار وإخفاء أعمدة المقارنة"
      onClose={()=>setColumnsOpen(false)}>
      <div className="form-stack">
        {comparisonColumns.map(column=><label key={column.key} className="doctor-comparison-column-choice">
          <input type="checkbox" checked={editingColumns.includes(column.key)}
            onChange={event=>setEditingColumns(previous=>
              event.target.checked?[...previous,column.key]:previous.filter(k=>k!==column.key))}/>
          {column.label}
        </label>)}
        <div className="form-actions">
          <Button variant="secondary" onClick={()=>setEditingColumns([...defaultColumnKeys])}>إظهار الكل</Button>
          <Button onClick={commitVisible} disabled={!editingColumns.length}>موافق</Button>
          <Button variant="secondary" onClick={()=>setColumnsOpen(false)}>إلغاء</Button>
        </div>
      </div>
    </Dialog>
    <InteractiveColumnsTable<Row,ColumnKey>
      className="doctor-comparison-draggable-table"
      ariaLabel="مقارنة حركة الأطباء والجهات"
      columns={columns}
      rows={rows} rowKey={row=>row.doctorName}
      storageKey={`alraesy:${layoutPrefix}-layout:v1:${companyId}:${userId}`}
      visibleColumns={visibleColumns}
      sortKey={sortKey} sortDirection={sortDir} onSort={onSort}
      emptyMessage="لا توجد حركة مطابقة خلال آخر 336 ساعة."
    />
  </>;
}

type Report = {
  untilAt:string;recentFrom:string;previousFrom:string;
  canViewPayments:boolean;page:number;pageSize:number;total:number;
  totalCurrent:string;totalPrevious:string;totalDifference:string;items:Row[];
};
const aden=new Intl.DateTimeFormat("ar-YE",{
  timeZone:"Asia/Aden",year:"numeric",month:"2-digit",day:"2-digit",
  hour:"2-digit",minute:"2-digit",hour12:false,
});
function signText(value:string):string{
  const whole=formatWholeMoney(value);
  return !whole.startsWith("-") && !/^0(?:\.0+)?$/.test(value) && !/^0$/.test(whole)
    ? "+"+whole : whole;
}
const privatePage = "private-doctor-movement";
const standardPage = "doctor-movement-comparison";

function deltaTone(value: string) {
  const whole = formatWholeMoney(value);
  return whole === "0" ? "neutral" : whole.startsWith("-") ? "down" : "up";
}

function PeriodRange({ from, until }: { from: string; until: string }) {
  return <span className="movement-period-range">
    <bdi>{aden.format(new Date(from))}</bdi>
    <span>إلى</span>
    <bdi>{aden.format(new Date(until))}</bdi>
  </span>;
}

function MovementOverview({ data }: { data: Report }) {
  return <section className="movement-metrics" aria-label="إجماليات النتائج المطابقة">
    <article className="movement-metric movement-metric-current">
      <div className="movement-metric-label"><span className="movement-period-dot" /> آخر 168 ساعة</div>
      <strong dir="ltr">{formatWholeMoney(data.totalCurrent)}</strong>
      <PeriodRange from={data.recentFrom} until={data.untilAt} />
    </article>
    <article className="movement-metric">
      <div className="movement-metric-label"><span className="movement-period-dot movement-period-dot-previous" /> الـ168 ساعة السابقة</div>
      <strong dir="ltr">{formatWholeMoney(data.totalPrevious)}</strong>
      <PeriodRange from={data.previousFrom} until={data.recentFrom} />
    </article>
    <article className="movement-metric">
      <div className="movement-metric-label"><TrendingUp size={17} aria-hidden="true" /> فارق صافي المبيعات</div>
      <strong dir="ltr" data-tone={deltaTone(data.totalDifference)}>{signText(data.totalDifference)}</strong>
      <span className="movement-period-range">الفترة الأخيرة ناقص الفترة السابقة</span>
    </article>
  </section>;
}

function MovementDetails({ row, onClose }: { row: Row | null; onClose: () => void }) {
  if (!row) return null;
  const metrics = [
    { label: "صافي المبيعات", current: money(row.currentAmount), previous: money(row.previousAmount) },
    { label: "مرات الفواتير", current: row.invoiceCountCurrent, previous: row.invoiceCountPrevious },
    { label: "المسدد له بدون قصاصات", current: money(row.paidCurrent), previous: money(row.paidPrevious) },
    { label: "قصاصات مسددة", current: money(row.slipsCurrent), previous: money(row.slipsPrevious) },
  ];
  return <Dialog open onClose={onClose} title={row.doctorName} className="movement-details">
    <dl className="movement-details-meta">
      <div><dt>الفئة</dt><dd>{categoryLabels[row.category] ?? (row.category || "—")}</dd></div>
      <div><dt>الجهة</dt><dd>{row.department || "—"}</dd></div>
      <div><dt>الهاتف</dt><dd><bdi dir="ltr">{row.phone || "—"}</bdi></dd></div>
    </dl>
    <table className="movement-details-table" aria-label="تفاصيل الفترتين">
      <thead><tr><th scope="col">البند</th><th scope="col">آخر 168 ساعة</th><th scope="col">الـ168 السابقة</th></tr></thead>
      <tbody>{metrics.map(metric => <tr key={metric.label}>
        <th scope="row">{metric.label}</th><td dir="ltr">{metric.current}</td><td dir="ltr">{metric.previous}</td>
      </tr>)}</tbody>
    </table>
    <div className="movement-details-deltas">
      <div>الفارق المالي <strong dir="ltr" data-tone={deltaTone(row.difference)}>{signText(row.difference)}</strong></div>
      <div>فارق مرات الفواتير <strong dir="ltr" data-tone={deltaTone(row.invoiceCountDifference)}>{signText(row.invoiceCountDifference)}</strong></div>
    </div>
  </Dialog>;
}

export function DoctorMovementComparisonPage({context,privateView=false}:{
  context:CompanyContext; privateView?:boolean;
}){
  const companyId=context.company.id;
  const {user, employeePreview, visitorOnly}=useSession();
  const directory=usePageDirectory(companyId);
  const reportPage = privateView ? privatePage : standardPage;
  const canView=(!privateView || (!!user?.owner && !employeePreview && !visitorOnly)) &&
    !!directory.data?.find(entry=>entry.key===`company.${reportPage}`&&entry.enabled&&entry.actionAccess.view);
  const [params,setParams]=useSearchParams();
  const queryText=(params.get("q")??"").slice(0,120);
  const [search,setSearch]=useState(queryText);
  useEffect(() => setSearch(queryText), [queryText]);
  const page=Math.min(100_000,Math.max(1,Math.floor(Number(params.get("page"))||1)));
  const pageSize=[20,50,100].includes(Number(params.get("pageSize")))?
    Number(params.get("pageSize")):50;
  const sortKey=defaultColumnKeys.includes(params.get("sortKey") as ColumnKey)
    ?params.get("sortKey") as ColumnKey:"difference";
  const sortDir=params.get("sortDir")==="asc"?"asc":"desc";
  const filters=new URLSearchParams({q:queryText,page:String(page),pageSize:String(pageSize),sortKey,sortDir});
  const report=useQuery({
    queryKey:[reportPage,user?.id,companyId,filters.toString()],
    queryFn:({signal})=>api<{report:Report}>(`/companies/${companyId}/${reportPage}?${filters}`,{signal}),
    enabled:!!user&&canView,staleTime:0,refetchOnWindowFocus:true,refetchInterval:60_000,
  });
  const data=report.data?.report;
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const selectedRow = data?.items.find(row => row.doctorName === selectedName) ?? null;
  useEffect(() => {
    if (privateView && data && page > 1 && !data.items.length) {
      setParams(previous => {
        const next = new URLSearchParams(previous);
        next.delete("page");
        return next;
      }, { replace: true });
    }
  }, [privateView, data, page, setParams]);
  function change(key:"q"|"page"|"pageSize",value:string){
    setParams(previous=>{
      const next=new URLSearchParams(previous);
      if(value)next.set(key,value);else next.delete(key);
      if(key!=="page")next.delete("page");
      return next;
    });
  }
  function sortColumn(key:ColumnKey, direction?: "asc" | "desc"){
    if(data?.canViewPayments===false&&paidKeys.includes(key))return;
    setParams(previous=>{
      const next=new URLSearchParams(previous);
      const nextDir=direction ?? (sortKey===key?(sortDir==="desc"?"asc":"desc"):
        key==="doctorName"?"asc":"desc");
      next.set("sortKey",key);
      next.set("sortDir",nextDir);
      next.delete("page");
      return next;
    });
  }
  function submit(event:FormEvent){
    event.preventDefault();change("q",search.trim().slice(0,120));
  }
  const maxPages=Math.max(1,Math.ceil((data?.total??0)/pageSize));
  if (privateView) return <section className="movement-dashboard" dir="rtl" aria-labelledby="movement-title">
    <header className="movement-hero">
      <div>
        <div className="movement-company"><CalendarRange size={17} aria-hidden="true" />{context.company.name}</div>
        <h1 id="movement-title">مقارنة حركة الأطباء والجهات</h1>
        <p>صافي المبيعات والفواتير والسداد خلال فترتين متتاليتين، كل منهما 168 ساعة.</p>
      </div>
      <div className="movement-hero-controls">
        <span className="movement-private"><LockKeyhole size={15} aria-hidden="true" /> للمالك فقط</span>
        <Button variant="secondary" disabled={!canView || report.isFetching}
          onClick={() => void report.refetch()}><RefreshCw size={16} aria-hidden="true" /> تحديث البيانات</Button>
      </div>
    </header>
    {directory.isPending && <Notice>جارٍ التحقق من الصلاحيات…</Notice>}
    {!directory.isPending && !canView && <Notice tone="warning">هذه اللوحة لمالك المنصة فقط.</Notice>}
    {canView && <>
      {report.error && <Notice tone="error">{errorMessage(report.error)}</Notice>}
      {report.isPending && <div role="status"><Notice>جارٍ تحميل المقارنة…</Notice></div>}
      {data && !report.error && <MovementOverview data={data} />}
      <section className="movement-results" aria-labelledby="movement-results-heading" aria-busy={report.isFetching}>
        <div className="movement-results-heading">
          <div>
            <h2 id="movement-results-heading">حركة الأطباء والجهات</h2>
            {data && !report.error && <p>{data.total} اسمًا · توقيت عدن</p>}
          </div>
          <form className="movement-search" role="search" onSubmit={submit}>
            <label className="movement-search-field">
              <Search size={17} aria-hidden="true" />
              <input aria-label="الاسم المشترك للطبيب أو الجهة" placeholder="ابحث بالاسم المشترك"
                value={search} maxLength={120} onChange={event => setSearch(event.target.value)} />
            </label>
            <Button type="submit">بحث</Button>
            {queryText && <Button variant="ghost" onClick={() => {
              setSearch(""); change("q", "");
            }}>مسح</Button>}
          </form>
        </div>
        <div className="movement-sort-settings">
          <Select label="الترتيب حسب" value={sortKey} onChange={event => sortColumn(event.target.value as ColumnKey)}>
            {comparisonColumns.map(column => <option key={column.key} value={column.key}>{column.label}</option>)}
          </Select>
          <Select label="اتجاه الترتيب" value={sortDir} onChange={event => sortColumn(sortKey, event.target.value === "asc" ? "asc" : "desc")}>
            <option value="desc">تنازلي</option>
            <option value="asc">تصاعدي</option>
          </Select>
          <Select label="عدد الصفوف" value={String(pageSize)} onChange={event => change("pageSize", event.target.value)}>
            <option value="20">20</option><option value="50">50</option><option value="100">100</option>
          </Select>
        </div>
        {data && !report.error && <>
          <ComparisonTable companyId={companyId} userId={user?.id ?? "guest"}
            rows={data.items} sortKey={sortKey} sortDir={sortDir} canViewPayments={data.canViewPayments}
            onSort={sortColumn} onInspect={row => setSelectedName(row.doctorName)} />
          <div className="movement-pages" aria-label="صفحات المقارنة">
            <Button variant="secondary" disabled={page<=1||report.isFetching}
              onClick={()=>change("page",String(page-1))}>السابق</Button>
            <span>صفحة {page} من {maxPages}</span>
            <Button variant="secondary" disabled={page>=maxPages||report.isFetching}
              onClick={()=>change("page",String(page+1))}>التالي</Button>
          </div>
          <MovementDetails row={selectedRow} onClose={() => setSelectedName(null)} />
        </>}
      </section>
      <details className="movement-method">
        <summary>طريقة الاحتساب</summary>
        <p>تُحسب الفترتان حسب وقت التسجيل الفعلي بتوقيت عدن. يُحسب صافي فواتير البيع المرحّلة بعد الخصومات والمردودات، ويشمل العدد فاتورة مردود البيع المرحّلة مرة واحدة. الفارق هو قيمة الفترة الأخيرة ناقص قيمة الفترة السابقة.</p>
        <p>المبالغ المسددة من صرف العهدة أو السند المباشر، وتُعرض القصاصات في أعمدة مستقلة. القيم بالعملة الأساسية للشركة، مع التقريب عند العرض.</p>
      </details>
    </>}
  </section>;

  return <div className="wallet-page">
    <PageHeader title="مقارنة حركة الأطباء والجهات"
      description="مقارنة متحركة حسب ساعة تسجيل الفاتورة الفعلية، لا حسب تاريخ المستند. صافي المبيعات بعد الخصومات والمردودات."
      actions={<Button variant="secondary" disabled={!canView||report.isFetching}
        onClick={()=>void report.refetch()}>تحديث الآن</Button>}/>
    {directory.isPending&&<Notice>جارٍ التحقق من صلاحيات التقرير…</Notice>}
    {!directory.isPending&&!canView&&<Notice tone="warning">ليست لديك صلاحية عرض هذا التقرير.</Notice>}
    <Card title="البحث">
      <div className="form-actions">
        <form className="form-actions" onSubmit={submit}>
          <Field label="اسم الطبيب أو الجهة" value={search} onChange={e=>setSearch(e.target.value)}
            placeholder="الاسم المشترك من كرت الأطباء"/>
          <Button type="submit">بحث</Button>
        </form>
        <Select label="عدد الصفوف" value={String(pageSize)} onChange={e=>change("pageSize",e.target.value)}>
          <option value="20">20</option><option value="50">50</option><option value="100">100</option>
        </Select>
      </div>
    </Card>
    {report.error&&<Notice tone="error">{errorMessage(report.error)}</Notice>}
    {report.isPending&&canView&&<Notice>جارٍ مقارنة آخر 336 ساعة…</Notice>}
    {data&&canView&&<>
      <Card title="إجمالي المقارنة">
        <p className="muted" style={{marginBottom:6}}>
          آخر 168 ساعة: من {aden.format(new Date(data.recentFrom))} إلى {aden.format(new Date(data.untilAt))}.
          {" "}الـ168 ساعة السابقة: من {aden.format(new Date(data.previousFrom))} إلى {aden.format(new Date(data.recentFrom))}.
        </p>
        <div className="form-actions" style={{gap:18}}>
          <span>آخر 168 ساعة: <strong dir="ltr">{formatWholeMoney(data.totalCurrent)}</strong></span>
          <span>الـ168 السابقة: <strong dir="ltr">{formatWholeMoney(data.totalPrevious)}</strong></span>
          <span>الفارق: <strong dir="ltr">{signText(data.totalDifference)}</strong></span>
          <span>الأطباء والجهات: <strong>{data.total}</strong></span>
        </div>
      </Card>
      <Card title="مقارنة كل طبيب أو جهة">
        <ComparisonTable key={`${companyId}:${user?.id??"guest"}`}
          companyId={companyId} userId={user?.id??"guest"}
          rows={data.items} sortKey={sortKey} sortDir={sortDir}
          onSort={sortColumn} canViewPayments={data.canViewPayments}/>
        <div className="form-actions">
          <Button variant="secondary" disabled={page<=1||report.isFetching}
            onClick={()=>change("page",String(page-1))}>السابق</Button>
          <span>صفحة {page} من {maxPages} — {data.total} اسمًا</span>
          <Button variant="secondary" disabled={page>=maxPages||report.isFetching}
            onClick={()=>change("page",String(page+1))}>التالي</Button>
        </div>
        <small className="muted">الأرقام بالعملة الأساسية للشركة دون رمز العملة أو الكسور.
          الفئة والجهة والهاتف من كرت الاسم المشترك، والمبالغ المسددة من صرف العهدة أو السند المباشر.
          عمولات الطبيب/الممرض منفصلة عن القصاصات، ولا تُكرر قيود السندات.
          فارق المبيعات وفارق مرات الفواتير = آخر 168 ساعة ناقص الـ168 السابقة.
          عدد الفواتير يشمل فواتير البيع المرحّلة ومردودات البيع المرحّلة، كل فاتورة مرة واحدة.
          {!data.canViewPayments&&" بيانات الصرف محجوبة عن الحسابات غير المخولة بالاطلاع المالي."}</small>
      </Card>
    </>}
  </div>;
}
