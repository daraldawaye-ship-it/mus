import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { CompanyContext } from "../../../../packages/contracts/src/index.ts";
import { api, useSession } from "../api";
import { errorMessage } from "../phase2";
import { Button, Card, Notice, PageHeader } from "../ui";
import "./expiry-alert-follow-up.css";

type Kind = "expired" | "expiring-30";
type SortKey = "expiry" | "name" | "quantity" | "location";
type BatchRow = {
  balanceId: number; itemId: number; code: string; name: string;
  locationName: string; expiryDate: string; quantityUnit1: string;
};
type Report = {
  kind: Kind; asOf: string; page: number; pageSize: number; total: number;
  summary: {items: number; batches: number};
  items: BatchRow[];
};
const fmt = (value: string | number) => Number(value).toLocaleString("en-US",{
  minimumFractionDigits: 0,maximumFractionDigits: 4,
});

export function ExpiryAlertFollowUpPage({context,kind}: {
  context: CompanyContext; kind: Kind;
}) {
  const companyId = context.company.id;
  const {user} = useSession();
  const [params,setParams] = useSearchParams();
  const q=params.get("q")||"";
  const [search,setSearch] = useState(q);
  const sortValues: SortKey[]=["expiry","name","quantity","location"];
  const sortBy=sortValues.find(value=>value===params.get("sortBy"))??"expiry";
  const sortDir=params.get("sortDir")==="desc"?"desc":"asc";
  const page=Math.max(1,Math.min(100000,Number(params.get("page"))||1));
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
  const th=(key:SortKey,label:string)=><th aria-sort={sortBy===key?
    (sortDir==="asc"?"ascending":"descending"):undefined}>
    <button type="button" onClick={()=>update({
      sortBy:key,sortDir:key===sortBy&&sortDir==="asc"?"desc":"asc",page:"",
    })} title={"ترتيب حسب "+label}>{label} <span aria-hidden="true">
      {key===sortBy?(sortDir==="asc"?"▲":"▼"):"⇵"}</span></button>
  </th>;
  return <div className="expiry-alert-follow-up-page">
    <PageHeader title={title} description="عرض الدفعات ذات الرصيد الموجب فقط بحسب تاريخ الصلاحية المسجل وموقع المخزون."
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
        <span>عدد الدفعات/المواقع: <strong>{fmt(data.summary.batches)}</strong></span>
        <span>تاريخ الفحص: <strong>{data.asOf}</strong></span>
      </div>}
      <div className="expiry-alert-follow-up-controls">
        <label>بحث
          <input type="search" value={search} onChange={event=>setSearch(event.target.value)}
            placeholder="اسم الصنف أو الرمز أو الموقع"/>
        </label>
        <Button variant="secondary" size="compact" disabled={report.isFetching}
          onClick={()=>void report.refetch()}>تحديث</Button>
      </div>
      {report.isPending&&<Notice>جارٍ تحميل بيانات الدفعات…</Notice>}
      {report.isError&&<Notice tone="error">تعذر قراءة الدفعات: {errorMessage(report.error)}</Notice>}
      {data&&<>
        <div className="expiry-alert-follow-up-count">الدفعات المطابقة: {fmt(data.total)}</div>
        <div className="table-scroll expiry-alert-follow-up-scroll" role="region"
          aria-label={title}>
          <table dir="rtl">
            <thead><tr>
              {th("name","الصنف")}
              {th("quantity","الكمية المتوفرة (و1)")}
              {th("expiry","تاريخ الانتهاء")}
              {th("location","الموقع")}
              <th>حركة الدفعة</th>
            </tr></thead>
            <tbody>
              {data.items.map(item=><tr key={item.balanceId}>
                <td><Link to={"/companies/"+companyId+"/items/"+item.itemId}>
                  {item.name}</Link><small>{item.code}</small></td>
                <td><bdi>{fmt(item.quantityUnit1)}</bdi></td>
                <td dir="ltr">{item.expiryDate}</td>
                <td>{item.locationName}</td>
                <td><Link to={"/companies/"+companyId+"/stock-balances?itemId="+item.itemId+
                  "&expiryDate="+encodeURIComponent(item.expiryDate)}>عرض الرصيد</Link></td>
              </tr>)}
              {!data.items.length&&<tr><td colSpan={5}>
                لا توجد دفعات ذات رصيد موجب مطابقة للبحث في هذه الفئة.
              </td></tr>}
            </tbody>
          </table>
        </div>
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
      <small className="muted">يتجدد التنبيه الإجمالي طالما بقيت دفعة مطابقة. وتحدد عدد ساعات إعادة الفحص من كرت نوع التنبيه، دون إنشاء تنبيه منفصل لكل صنف أو دفعة.</small>
    </Card>
  </div>;
}
