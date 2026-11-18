import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
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
function ComparisonTable({rows,companyId,userId,sortKey,sortDir,onSort,canViewPayments}:{
  rows:Row[];companyId:number;userId:number|string;sortKey:ColumnKey;sortDir:"asc"|"desc";
  onSort:(key:ColumnKey)=>void;canViewPayments:boolean;
}){
  const storageKey=`alraesy:doctor-movement-columns-visible:v3:${companyId}:${userId}`;
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
      }}>الأعمدة ({visibleColumns.length}/{defaultColumnKeys.length})</Button>
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
      columns={canViewPayments?comparisonColumns:comparisonColumns.map(column=>
        paidKeys.includes(column.key)?{...column,sortable:false}:column)}
      rows={rows} rowKey={row=>row.doctorName}
      storageKey={`alraesy:doctor-movement-layout:v1:${companyId}:${userId}`}
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
export function DoctorMovementComparisonPage({context}:{context:CompanyContext}){
  const companyId=context.company.id;
  const {user}=useSession();
  const directory=usePageDirectory(companyId);
  const canView=!!directory.data?.find(entry=>entry.key==="company.doctor-movement-comparison"&&entry.enabled&&entry.actionAccess.view);
  const [params,setParams]=useSearchParams();
  const queryText=params.get("q")??"";
  const [search,setSearch]=useState(queryText);
  const page=Math.max(1,Math.floor(Number(params.get("page"))||1));
  const pageSize=[20,50,100].includes(Number(params.get("pageSize")))?
    Number(params.get("pageSize")):50;
  const sortKey=defaultColumnKeys.includes(params.get("sortKey") as ColumnKey)
    ?params.get("sortKey") as ColumnKey:"difference";
  const sortDir=params.get("sortDir")==="asc"?"asc":"desc";
  const [refreshTick,setRefreshTick]=useState(0);
  useEffect(()=>{
    const timer=window.setInterval(()=>setRefreshTick(t=>t+1),60_000);
    return ()=>window.clearInterval(timer);
  },[]);
  const filters=new URLSearchParams({q:queryText,page:String(page),pageSize:String(pageSize),sortKey,sortDir});
  const report=useQuery({
    queryKey:["doctor-movement-comparison",user?.id,companyId,filters.toString(),refreshTick],
    queryFn:({signal})=>api<{report:Report}>(`/companies/${companyId}/doctor-movement-comparison?${filters}`,{signal}),
    enabled:!!user&&canView,staleTime:0,refetchOnWindowFocus:true,
  });
  const data=report.data?.report;
  function change(key:"q"|"page"|"pageSize",value:string){
    setParams(previous=>{
      const next=new URLSearchParams(previous);
      if(value)next.set(key,value);else next.delete(key);
      if(key!=="page")next.delete("page");
      return next;
    });
  }
  function sortColumn(key:ColumnKey){
    if(data?.canViewPayments===false&&paidKeys.includes(key))return;
    setParams(previous=>{
      const next=new URLSearchParams(previous);
      const nextDir=sortKey===key?(sortDir==="desc"?"asc":"desc"):
        key==="doctorName"?"asc":"desc";
      next.set("sortKey",key);
      next.set("sortDir",nextDir);
      next.delete("page");
      return next;
    });
  }
  function submit(event:FormEvent){
    event.preventDefault();change("q",search.trim());
  }
  const maxPages=Math.max(1,Math.ceil((data?.total??0)/pageSize));
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
