import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { memoStatusLabels, type CompanyContext, type MemoStatus } from "../../../../packages/contracts/src/index";
import { api, useSession } from "../api";
import InteractiveColumnsTable, { type InteractiveTableColumn } from "../InteractiveColumnsTable";
import { errorMessage } from "../phase2";
import { Button, Card, Field, Notice, PageHeader } from "../ui";

type Row = {id:number;itemId:number|null;itemName:string|null;title:string;senderName:string;currentName:string;status:MemoStatus;createdAt:string;
  quantityAvailable:string|null;quantityReturns:string|null;defaultSupplyMaxQuantity:string|null;
  defaultSupplyMaxNotes:string|null};
type List = {items:Row[];total:number;page:number;pageSize:number;canOpenMemo:boolean};
const sorts = ["title","senderName","currentName","status","createdAt",
  "quantityAvailable","quantityReturns","defaultSupplyMaxQuantity","defaultSupplyMaxNotes"] as const;
type Sort = (typeof sorts)[number];
type Column = Sort|"open";
const title = "المذكرات المرتبطة بصنف";
const dateFormat = new Intl.DateTimeFormat("ar-YE", {timeZone:"Asia/Aden",dateStyle:"short",timeStyle:"short"});

export function ItemReturnRequestsPage({context}:{context:CompanyContext}) {
  const companyId = context.company.id;
  const {user} = useSession();
  const [params,setParams] = useSearchParams();
  const q = (params.get("q") ?? "").slice(0,200);
  const showCompleted = params.get("showCompleted") === "true";
  const sortKey = sorts.find(key => key === params.get("sortBy")) ?? "createdAt";
  const sortDirection = params.get("sortDir") === "asc" ? "asc" : "desc";
  const rawPage = Number(params.get("page"));
  const page = Number.isInteger(rawPage) && rawPage >= 1 && rawPage <= 1000000 ? rawPage : 1;
  const rawPageSize = Number(params.get("pageSize"));
  const pageSize = [10,25,50,100].includes(rawPageSize) ? rawPageSize : 25;
  function update(values:Record<string,string>) {
    setParams(previous => {
      const next = new URLSearchParams(previous);
      for (const [key,value] of Object.entries(values)) value ? next.set(key,value) : next.delete(key);
      return next;
    },{replace:true});
  }
  const query = new URLSearchParams({q,sort:`${sortKey}:${sortDirection}`,page:String(page),pageSize:String(pageSize),
    ...(showCompleted ? {showCompleted:"true"} : {})}).toString();
  const list = useQuery({queryKey:["item-return-requests",user?.id,companyId,query],
    queryFn:({signal}) => api<List>(`/companies/${companyId}/item-return-requests?${query}`,{signal}),enabled:!!user});
  const result = list.data;
  const canOpenMemo = !!result?.canOpenMemo;
  const cols = useMemo<InteractiveTableColumn<Row,Column>[]>(() => [
    {key:"title",label:"المذكرة",width:270,sortable:true,cell:row=>row.title},
    {key:"quantityAvailable",label:"الكمية بدون مخازن المرتجعات",width:184,sortable:true,cell:row=><bdi>{row.quantityAvailable}</bdi>},
    {key:"quantityReturns",label:"الكمية في مخازن المرتجعات",width:177,sortable:true,cell:row=><bdi>{row.quantityReturns}</bdi>},
    {key:"defaultSupplyMaxQuantity",label:"أعلى كمية توفير افتراضية",width:165,sortable:true,cell:row=><bdi>{row.defaultSupplyMaxQuantity}</bdi>},
    {key:"defaultSupplyMaxNotes",label:"ملاحظات أعلى كمية توفير افتراضية",width:207,sortable:true,cell:row=>row.defaultSupplyMaxNotes},
    {key:"senderName",label:"المرسل",width:144,sortable:true,cell:row=>row.senderName},
    {key:"currentName",label:"المسؤول الحالي",width:144,sortable:true,cell:row=>row.currentName},
    {key:"status",label:"الحالة",width:120,sortable:true,cell:row=>memoStatusLabels[row.status]},
    {key:"createdAt",label:"وقت الإرسال",width:175,sortable:true,cell:row=><bdi>{dateFormat.format(new Date(row.createdAt))}</bdi>},
    ...(canOpenMemo ? [{key:"open" as const,label:"فتح",width:70,cell:(row:Row)=><Link className="button button-secondary button-compact"
      to={`/companies/${companyId}/memos/${row.id}`} aria-label={`عرض ${row.title}`}>عرض</Link>}] : []),
  ],[canOpenMemo,companyId]);
  const pages = Math.max(1,Math.ceil((result?.total ?? 0)/pageSize));
  return <div className="wallet-page">
    <PageHeader title={title} description="كل المذكرات المرتبطة بصنف والمتاحة لك. الكميات الحالية بالوحدة الأولى، ولا تُرحّل حركة من هذه القائمة."
      actions={<Button variant="secondary" size="compact" disabled={list.isFetching} onClick={()=>void list.refetch()}>تحديث</Button>}/>
    <Card>
      <Field label="بحث عن مذكرة" value={q} maxLength={200} onChange={event=>update({q:event.target.value,page:""})}/>
      <label className="u-check">
        <input type="checkbox" checked={showCompleted}
          onChange={event=>update({showCompleted:event.target.checked ? "true" : "",page:""})}/>
        <span>إظهار المنجز</span>
      </label>
      {list.isPending && <Notice>جارٍ تحميل المذكرات…</Notice>}
      {list.error && <Notice tone="error">{errorMessage(list.error)}</Notice>}
      {result && <>
        <InteractiveColumnsTable<Row,Column> columns={cols} rows={result.items} rowKey={row=>row.id}
          dockRowSource={row=>({companyId,itemId:row.itemId,itemName:row.itemName})}
          ariaLabel={title} emptyMessage={showCompleted ? "لا توجد مذكرات مرتبطة بصنف ضمن صلاحياتك." : "لا توجد مذكرات غير منجزة ضمن صلاحياتك."}
          storageKey={`alraesy:d13:item-return-requests:${user?.id ?? "guest"}:${companyId}`}
          visibleColumns={cols.map(column=>column.key)} allowColumnVisibility
          sortKey={sortKey} sortDirection={sortDirection} onSort={key=>{
            if (key !== "open") update({sortBy:key,sortDir:sortKey===key&&sortDirection==="asc"?"desc":"asc",page:""});
          }}/>
        <div className="form-actions">
          <Button variant="secondary" size="compact" disabled={page<=1||list.isFetching} onClick={()=>update({page:String(page-1)})}>السابق</Button>
          <span>صفحة {page} من {pages} · {result.total} مذكرة</span>
          <Button variant="secondary" size="compact" disabled={page>=pages||list.isFetching} onClick={()=>update({page:String(page+1)})}>التالي</Button>
          <label>عدد المذكرات <select value={pageSize} onChange={event=>update({pageSize:event.target.value,page:""})}>
            {[10,25,50,100].map(size=><option key={size} value={size}>{size}</option>)}
          </select></label>
        </div>
      </>}
    </Card>
  </div>;
}
