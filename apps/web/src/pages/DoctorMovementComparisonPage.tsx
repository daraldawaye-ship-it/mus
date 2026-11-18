import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import type { CompanyContext } from "../../../../packages/contracts/src/index.ts";
import { api, useSession } from "../api";
import { usePageDirectory } from "../page-directory";
import { errorMessage } from "../phase2";
import { formatWholeMoney } from "../format-money";
import { Button, Card, Field, Notice, PageHeader, Select } from "../ui";

type Row = { doctorName:string;currentAmount:string;previousAmount:string;difference:string };
type Report = {
  untilAt:string;recentFrom:string;previousFrom:string;
  page:number;pageSize:number;total:number;
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
  const [refreshTick,setRefreshTick]=useState(0);
  useEffect(()=>{
    const timer=window.setInterval(()=>setRefreshTick(t=>t+1),60_000);
    return ()=>window.clearInterval(timer);
  },[]);
  const filters=new URLSearchParams({q:queryText,page:String(page),pageSize:String(pageSize)});
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
        <div className="table-scroll" role="region" aria-label="مقارنة حركة الأطباء والجهات"
          style={{maxHeight:"70vh",overflow:"auto"}}>
          <table style={{width:"100%",minWidth:570,fontVariantNumeric:"tabular-nums"}}>
            <thead><tr>
              <th style={{position:"sticky",top:0,zIndex:1}}>الاسم المشترك للطبيب أو الجهة</th>
              <th style={{position:"sticky",top:0,zIndex:1}}>آخر 168 ساعة</th>
              <th style={{position:"sticky",top:0,zIndex:1}}>الـ168 ساعة السابقة</th>
              <th style={{position:"sticky",top:0,zIndex:1}}>الفارق (+ / −)</th>
            </tr></thead>
            <tbody>
              {data.items.map(row=><tr key={row.doctorName}>
                <td>{row.doctorName}</td>
                <td dir="ltr">{formatWholeMoney(row.currentAmount)}</td>
                <td dir="ltr">{formatWholeMoney(row.previousAmount)}</td>
                <td dir="ltr"><strong>{signText(row.difference)}</strong></td>
              </tr>)}
              {!data.items.length&&<tr><td colSpan={4}>لا توجد حركة مطابقة خلال آخر 336 ساعة.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="form-actions">
          <Button variant="secondary" disabled={page<=1||report.isFetching}
            onClick={()=>change("page",String(page-1))}>السابق</Button>
          <span>صفحة {page} من {maxPages} — {data.total} اسمًا</span>
          <Button variant="secondary" disabled={page>=maxPages||report.isFetching}
            onClick={()=>change("page",String(page+1))}>التالي</Button>
        </div>
        <small className="muted">الأرقام بالعملة الأساسية للشركة مع إخفاء رمز العملة والكسور في العرض فقط.
          الكروت ذات الاسم المشترك الواحد تُجمع في صف واحد؛ الفارق = الفترة الأحدث ناقص السابقة.</small>
      </Card>
    </>}
  </div>;
}
