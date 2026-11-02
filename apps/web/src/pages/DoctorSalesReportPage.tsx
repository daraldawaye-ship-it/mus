import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { CompanyContext } from "../../../../packages/contracts/src/index.ts";
import { api, useSession } from "../api";
import { usePageDirectory } from "../page-directory";
import { errorMessage } from "../phase2";
import { formatMoney, formatWholeMoney } from "../format-money";
import { adenInvoiceToday } from "../invoice-save-date";
import { Button, Card, Field, Notice, PageHeader, Select } from "../ui";

interface Row {
 doctorKey:string;doctorName:string;doctorKind:"doctor"|"nurse"|"entity"|null;
 invoiceCount:number;returnCount:number;netBaseAmount:string;baseCurrencyCode:string;
 currencies:Array<{currencyCode:string;netAmount:string}>;
}
interface Report {
 dateFrom:string;dateTo:string;page:number;pageSize:number;total:number;
 totalBase:string;totalInvoices:number;totalReturns:number;
 baseCurrencyCode:string|null;items:Row[];
}
const kindLabel=(kind:Row["doctorKind"])=>kind==="doctor"?"طبيب":kind==="nurse"?"ممرض":
 kind==="entity"?"جهة":"غير مصنف";
export function DoctorSalesReportPage({context}:{context:CompanyContext}){
 const companyId=context.company.id;
 const {user}=useSession();
 const directory=usePageDirectory(companyId);
 const canView=!!directory.data?.find(x=>x.key==="company.doctor-sales-report"&&x.actionAccess.view&&x.enabled);
 const [params,setParams]=useSearchParams();
 const compact=params.get("compact")==="1";
 const [,setClockTick]=useState(0);
 useEffect(()=>{
  if(!compact)return;
  const timer=window.setInterval(()=>setClockTick(x=>x+1),60_000);
  return ()=>window.clearInterval(timer);
 },[compact]);
 const today=adenInvoiceToday();
 const lastThreeFrom=adenInvoiceToday(new Date(Date.now()-2*86_400_000));
 const from=compact?lastThreeFrom:(params.get("dateFrom")??today.slice(0,7)+"-01");
 const to=compact?today:(params.get("dateTo")??today);
 const q=params.get("q")??"";
 const [search,setSearch]=useState(q);
 const rawPage=Number(params.get("page")??"1");
 const page=Number.isInteger(rawPage)&&rawPage>0?rawPage:1;
 const pageSize=[20,50,100].includes(Number(params.get("pageSize")))?
   Number(params.get("pageSize")):50;
 const invalid=from>to;
 const filters=new URLSearchParams({
  dateFrom:from,dateTo:to,q:compact?"":q,
  page:String(page),pageSize:String(compact?100:pageSize),
  ...(compact?{medicalOnly:"true"}:{}),
 });
 const report=useQuery({
  queryKey:["doctor-sales-report",user?.id,companyId,filters.toString()],
  queryFn:({signal})=>api<{report:Report}>(`/companies/${companyId}/doctor-sales-report?${filters}`,{signal}),
  enabled:!!user&&canView&&!invalid,staleTime:0,refetchOnWindowFocus:true,
 });
 const data=report.data?.report;
 function change(key:string,value:string){
  setParams(previous=>{
   const next=new URLSearchParams(previous);
   if(value)next.set(key,value);else next.delete(key);
   if(key!=="page")next.delete("page");
   return next;
  });
 }
 if(compact)return <div className="wallet-page">
  <PageHeader title="مبيعات الأطباء — آخر 3 أيام"
   description={`من ${from} إلى ${to} (يشمل اليومين)، بعد الخصومات والمردودات`}
   actions={<>
    <Link className="button button-secondary"
     to={`/companies/${companyId}/doctor-sales-report`}>التقرير الكامل</Link>
    <Button variant="secondary" disabled={!canView||report.isFetching}
     onClick={()=>void report.refetch()}>تحديث</Button>
   </>}/>
  {directory.isPending&&<Notice>جارٍ التحقق من صلاحية التقرير…</Notice>}
  {!directory.isPending&&!canView&&<Notice tone="warning">ليست لديك صلاحية عرض التقرير.</Notice>}
  {report.error&&<Notice tone="error">{errorMessage(report.error)}</Notice>}
  {report.isPending&&canView&&<Notice>جارٍ حساب القائمة…</Notice>}
  {canView&&data&&<Card title="الأطباء والممرضون وغير المصنفين">
   <div className="table-scroll"><table>
    <thead><tr><th>الطبيب</th><th>المبلغ</th></tr></thead>
    <tbody>
     {data.items.map(row=><tr key={row.doctorKey}>
      <td>{row.doctorName}</td>
      <td dir="ltr"><strong>{formatWholeMoney(row.netBaseAmount)}</strong></td>
     </tr>)}
     {!data.items.length&&<tr><td colSpan={2}>لا توجد مبيعات مطابقة في الأيام الثلاثة.</td></tr>}
    </tbody>
   </table></div>
   <div className="form-actions">
    <Button variant="secondary" disabled={page<=1||report.isFetching}
     onClick={()=>change("page",String(page-1))}>السابق</Button>
    <span>صفحة {page} من {Math.max(1,Math.ceil(data.total/100))} — {data.total} اسمًا</span>
    <Button variant="secondary" disabled={page*100>=data.total||report.isFetching}
     onClick={()=>change("page",String(page+1))}>التالي</Button>
   </div>
  </Card>}
 </div>;
 return <div className="wallet-page">
  <PageHeader title="مبيعات الأطباء والجهات"
    description="إجمالي صافي المبيعات لكل طبيب أو ممرض أو جهة بين تاريخين، بعد الخصومات والمردودات"
    actions={<Button variant="secondary" disabled={!canView||report.isFetching}
     onClick={()=>void report.refetch()}>تحديث</Button>}/>
  {directory.isPending&&<Notice>جارٍ التحقق من الصلاحيات…</Notice>}
  {!directory.isPending&&!canView&&<Notice tone="warning">لا تملك صلاحية عرض هذا التقرير.</Notice>}
  <Card title="البحث والفترة"><div className="form-grid">
   <Field label="من تاريخ" type="date" value={from} onChange={e=>change("dateFrom",e.target.value)}/>
   <Field label="إلى تاريخ" type="date" value={to} onChange={e=>change("dateTo",e.target.value)}/>
   <form className="form-actions" onSubmit={e=>{e.preventDefault();change("q",search.trim());}}>
    <Field label="طبيب أو جهة" value={search} onChange={e=>setSearch(e.target.value)}/>
    <Button type="submit">بحث</Button>
   </form>
   <Select label="عدد الصفوف" value={String(pageSize)} onChange={e=>change("pageSize",e.target.value)}>
    <option value="20">20</option><option value="50">50</option><option value="100">100</option>
   </Select>
  </div>
  {invalid&&<Notice tone="warning">تاريخ البداية أكبر من النهاية.</Notice>}
  </Card>
  {report.error&&<Notice tone="error">{errorMessage(report.error)}</Notice>}
  {report.isPending&&canView&&!invalid&&<Notice>جارٍ حساب الإجماليات…</Notice>}
  {data&&canView&&<Card title="إجمالي الفترة">
   <div className="form-grid">
    <p>صافي المبيعات: <strong>{formatMoney(data.totalBase)} {data.baseCurrencyCode??""}</strong></p>
    <p>الأطباء والجهات: <strong>{data.total}</strong></p>
    <p>عدد الفواتير: <strong>{data.totalInvoices}</strong></p>
    <p>منها فواتير مردود: <strong>{data.totalReturns}</strong></p>
   </div>
   <p className="muted">الإجمالي بالعملة الأساسية؛ تُخصم المردودات والخصومات، وتُعرض العملات الأخرى مستقلة.</p>
  </Card>}
  {data&&canView&&<Card title="مبيعات كل طبيب أو جهة">
   <div className="table-scroll"><table><thead><tr>
    <th>الطبيب أو الجهة</th><th>النوع</th><th>الفواتير</th><th>المردودات</th>
    <th>صافي المبيعات بالعملة الأساسية</th><th>العملات</th>
   </tr></thead><tbody>
    {data.items.map(row=><tr key={row.doctorKey}>
     <td>{row.doctorName}</td><td>{kindLabel(row.doctorKind)}</td>
     <td>{row.invoiceCount}</td><td>{row.returnCount}</td>
     <td>{formatMoney(row.netBaseAmount)} {row.baseCurrencyCode}</td>
     <td>{row.currencies.map(c=><div key={c.currencyCode}>{formatMoney(c.netAmount)} {c.currencyCode}</div>)}</td>
    </tr>)}
    {!data.items.length&&<tr><td colSpan={6}>لا توجد مبيعات مطابقة.</td></tr>}
   </tbody></table></div>
   <div className="form-actions">
    <Button variant="secondary" disabled={page<=1} onClick={()=>change("page",String(page-1))}>السابق</Button>
    <span>صفحة {page} من {Math.max(1,Math.ceil(data.total/pageSize))} — {data.total} نتيجة</span>
    <Button variant="secondary" disabled={page*pageSize>=data.total} onClick={()=>change("page",String(page+1))}>التالي</Button>
   </div>
   <p className="muted">يتضمن التقرير الجهات المؤرشفة والأسماء غير المصنفة والفواتير التي ليس لها طبيب («غير محدد»).</p>
  </Card>}
 </div>;
}
