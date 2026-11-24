import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { CompanyContext } from "../../../../packages/contracts/src/index.ts";
import { api, useSession } from "../api";
import { errorMessage } from "../phase2";
import { Button, Card, Notice, PageHeader } from "../ui";
import InteractiveColumnsTable, { type InteractiveTableColumn } from "../InteractiveColumnsTable";
import "./item-order-levels.css";

type Row = {
  itemId: number;code:string;name:string;active:boolean;
  orderStoppedUntil:string|null;orderAlertQuantity:string|null;currentlyStopped:boolean;
};
type Report = {
  asOf:string;total:number;page:number;pageSize:number;
  summary:{currentCount:number;endedCount:number};items:Row[];
};
type Sort = "stopDate"|"name"|"code";
type Column = Sort|"quantity"|"status";
const columns: InteractiveTableColumn<Row,Column>[] = [
  {key:"name",label:"الصنف",width:230,sortable:true,
    cell: row=><span className="company-item-label">{row.name}</span>},
  {key:"code",label:"الكود",width:105,sortable:true,cell: row=><bdi>{row.code}</bdi>},
  {key:"stopDate",label:"توقف الطلب حتى",width:155,sortable:true,
    cell: row=><bdi>{row.orderStoppedUntil??"—"}</bdi>},
  {key:"quantity",label:"كمية الطلب",width:110,cell: row=><bdi>{row.orderAlertQuantity??"فارغ"}</bdi>},
  {key:"status",label:"حالة الإيقاف",width:158,cell: row=><span>
    {!row.active?"الصنف مؤرشف — ":""}{row.currentlyStopped?"الإيقاف سارٍ":row.orderStoppedUntil?"انتهى الإيقاف":"لم يعد متوقفًا"}
  </span>},
];
const visibleColumns=columns.map(column=>column.key);
const format = (value:number)=>value.toLocaleString("en-US");

export function StoppedOrderItemsPage({context}:{context:CompanyContext}) {
  const companyId=context.company.id;
  const {user}=useSession();
  const [params,setParams]=useSearchParams();
  const q=params.get("q")??"";
  const [search,setSearch]=useState(q);
  const itemId=params.get("itemId")??"";
  const invoiceId=params.get("invoiceId")??"";
  const status=(["current","ended","all"] as const).find(x=>x===params.get("status"))??"current";
  const sortBy=(["stopDate","name","code"] as const).find(x=>x===params.get("sortBy"))??"stopDate";
  const sortDir=params.get("sortDir")==="desc"?"desc":"asc";
  const page=Math.max(1,Math.min(100000,Number(params.get("page"))||1));
  const pageSize=[10,20,50,100].includes(Number(params.get("pageSize")))?
    Number(params.get("pageSize")):50;
  const update=(changes:Record<string,string>,replace=false)=>{
    setParams(previous=>{
      const next=new URLSearchParams(previous);
      for(const [key,value] of Object.entries(changes)){
        if(value)next.set(key,value);else next.delete(key);
      }
      return next;
    },{replace});
  };
  useEffect(()=>setSearch(q),[q]);
  useEffect(()=>{
    if(search.trim()===q)return;
    const timer=window.setTimeout(()=>update({q:search.trim(),page:"",itemId:"",invoiceId:""},true),350);
    return()=>window.clearTimeout(timer);
  },[search,q]);
  const queryString=new URLSearchParams({
    q,status,sortBy,sortDir,page:String(page),pageSize:String(pageSize),
    ...(/^[1-9]\d*$/.test(itemId)?{itemId}:{}),
  }).toString();
  const report=useQuery({
    queryKey:["stopped-order-items",user?.id,companyId,queryString],
    queryFn:({signal})=>api<Report>(
      `/companies/${companyId}/stopped-order-items?${queryString}`,{signal}),
    enabled:!!user,staleTime:15000,
  });
  const data=report.data;
  const pages=Math.max(1,Math.ceil((data?.total??0)/pageSize));
  const tableScope=`alraesy:stopped-order-items:d13:v1:${user?.id??"guest"}:${companyId}`;
  return <div className="item-order-levels-page">
    <PageHeader title="الأصناف المتوقف طلبها"
      description="الأصناف التي أُوقف طلبها من كرت الصنف، حسب تاريخ الإيقاف بتوقيت اليمن. الصفحة للمتابعة فقط ولا تعدل الطلب أو المخزون."
      actions={<>
        <Link className="button button-secondary" to={`/companies/${companyId}/item-options-list`}>قائمة الأصناف</Link>
        <Link className="button button-secondary" to={`/companies/${companyId}/item-order-levels`}>حدود طلب الأصناف</Link>
      </>}/>
    <Card>
      {data&&<div className="item-order-levels-summary">
        <span>إيقاف سارٍ: <strong>{format(data.summary.currentCount)}</strong></span>
        <span>إيقاف انتهى: <strong>{format(data.summary.endedCount)}</strong></span>
        <span>التاريخ: <bdi>{data.asOf}</bdi></span>
      </div>}
      {itemId&&<div className="item-order-levels-focus">
        عرض الصنف المرتبط بالتنبيه.
        {(/^[1-9]\d*$/.test(invoiceId))&&
          <Link className="button button-secondary" to={`/companies/${companyId}/invoices/${invoiceId}`}>
            فتح فاتورة المشتريات
          </Link>}
        <Button size="compact" variant="secondary" onClick={()=>update({itemId:"",invoiceId:"",q:"",status:"current",page:""})}>
          عرض جميع الأصناف
        </Button>
      </div>}
      <div className="item-order-levels-controls">
        <label>بحث الصنف
          <input type="search" placeholder="اسم الصنف أو رمزه" value={search}
            onChange={event=>setSearch(event.target.value)}/>
        </label>
        <label>حالة الإيقاف
          <select value={status} onChange={event=>update({status:event.target.value,page:"",itemId:"",invoiceId:""})}>
            <option value="current">إيقاف سارٍ</option>
            <option value="ended">انتهى إيقافه</option>
            <option value="all">الكل</option>
          </select>
        </label>
        <Button variant="secondary" size="compact" disabled={report.isFetching}
          onClick={()=>void report.refetch()}>تحديث</Button>
      </div>
      {report.isPending&&<Notice>جارٍ تحميل الأصناف المتوقف طلبها…</Notice>}
      {report.isError&&<Notice tone="error">تعذر تحميل الأصناف: {errorMessage(report.error)}</Notice>}
      {data&&<>
        <div className="item-order-levels-results">
          <span>المطابق: <strong>{format(data.total)}</strong> صنف</span>
        </div>
        <InteractiveColumnsTable<Row,Column>
          key={tableScope} storageKey={tableScope} allowColumnVisibility visibleColumns={visibleColumns}
          ariaLabel="الأصناف المتوقف طلبها" emptyMessage="لا توجد أصناف مطابقة."
          columns={columns} rows={data.items} rowKey={row=>row.itemId}
          dockRowSource={row=>({companyId,itemId:row.itemId,itemName:row.name})}
          sortKey={sortBy} sortDirection={sortDir} onSort={key=>{
            if(key==="quantity"||key==="status")return;
            update({sortBy:key,sortDir:sortBy===key&&sortDir==="asc"?"desc":"asc",page:""});
          }} />
        <div className="form-actions item-order-levels-pages">
          <Button variant="secondary" disabled={page<=1} onClick={()=>update({page:String(page-1)})}>السابق</Button>
          <span>صفحة {page} من {pages}</span>
          <Button variant="secondary" disabled={page>=pages} onClick={()=>update({page:String(page+1)})}>التالي</Button>
          <label>عدد الأصناف
            <select value={pageSize} onChange={event=>update({pageSize:event.target.value,page:""})}>
              <option value="10">10</option><option value="20">20</option><option value="50">50</option><option value="100">100</option>
            </select>
          </label>
        </div>
      </>}
      <small className="muted">«كمية الطلب» المحددة، بما فيها الصفر، تمنع تنبيه شراء صنف متوقف طلبه؛ يصدر التنبيه عند ترك الحقل فارغًا فقط.</small>
    </Card>
  </div>;
}
