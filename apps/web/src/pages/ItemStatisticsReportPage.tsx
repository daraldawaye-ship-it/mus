import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type {
 CompanyContext, ItemActivityReport, ItemActivityReportMetric,
 ItemActivityReportPeriod,
} from "../../../../packages/contracts/src/index.ts";
import { api, useSession } from "../api";
import { usePageDirectory } from "../page-directory";
import { errorMessage } from "../phase2";
import { Button, Card, Field, Notice, PageHeader, Select } from "../ui";

const periods:readonly {key:ItemActivityReportPeriod;label:string}[]=[
 {key:"oneMonth",label:"آخر شهر"},
 {key:"fourMonths",label:"آخر 4 أشهر"},
 {key:"twelveMonths",label:"آخر 12 شهرًا"},
 {key:"allTime",label:"منذ البداية"},
];
const metrics:Record<ItemActivityReportMetric,string>={
 saleTimes:"مرات البيع الصافية",
 sale:"الكمية المباعة",purchase:"الكمية المشتراة",
 saleReturn:"مرتجع المبيعات",purchaseReturn:"مرتجع المشتريات",
};
const sortMetric=(metric:ItemActivityReportMetric,period:ItemActivityReportPeriod)=>{
 const periodKey={oneMonth:"OneMonth",fourMonths:"FourMonths",
   twelveMonths:"TwelveMonths",allTime:"AllTime"}[period];
 return metric+periodKey;
};
const asQuantity=(s:string)=>BigInt(s).toLocaleString("en-US");
const asFirstUnit=(q:{numerator:string;denominator:string;decimal:string|null})=>{
 const exact=q.decimal??`${q.numerator}/${q.denominator}`;
 return exact.replace(/^(-?\d+)/,n=>BigInt(n).toLocaleString("en-US"));
};
export function ItemStatisticsReportPage({context}:{context:CompanyContext}){
 const companyId=context.company.id;
 const {user}=useSession();
 const directory=usePageDirectory(companyId);
 const [params,setParams]=useSearchParams();
 const [typedSearch,setTypedSearch]=useState(params.get("q")??"");
 const q=params.get("q")??"";
 const active=params.get("active")??"active";
 const metric=(["saleTimes","sale","purchase","saleReturn","purchaseReturn"] as string[])
    .includes(params.get("metric")??"") ?
    params.get("metric") as ItemActivityReportMetric:"saleTimes";
 const sortPeriod=(["oneMonth","fourMonths","twelveMonths","allTime"] as string[])
    .includes(params.get("sortPeriod")??"") ?
    params.get("sortPeriod") as ItemActivityReportPeriod:"oneMonth";
 const order=params.get("order")==="asc"?"asc":"desc";
 const sort=params.get("sort")??"code";
 const page=Math.max(1,Number(params.get("page")??"1")||1);
 const pageSize=Number(params.get("pageSize"))===100?100:50;
 useEffect(()=>setTypedSearch(q),[q,companyId]);
 const change=(key:string,value:string)=>{
   setParams(prev=>{
     const next=new URLSearchParams(prev);
     if(value)next.set(key,value);else next.delete(key);
     if(key!=="page")next.delete("page");
     return next;
   });
 };
 const canView=!!directory.data?.find(x=>x.key==="company.item-statistics-report")?.actionAccess.view;
 const request=new URLSearchParams({
   q,active,
   page:String(page),pageSize:String(pageSize),
   sortBy:sort==="code"?"code":sort==="name"?"name":sortMetric(metric,sortPeriod),
   sortDir:sort==="code"||sort==="name"?"asc":order,
 });
 const report=useQuery({
   queryKey:["item-statistics-report",user?.id,companyId,request.toString()],
   queryFn:({signal})=>api<{report:ItemActivityReport}>(
     `/companies/${companyId}/item-statistics-report?${request.toString()}`,{signal}),
   enabled:!!user&&canView,
   staleTime:0,
   refetchOnWindowFocus:true,
 });
 const result=report.data?.report;
 const totalPages=Math.max(1,Math.ceil((result?.total??0)/pageSize));
 return <div className="wallet-page">
   <PageHeader title="تقرير إحصائيات الأصناف"
     description="مرات البيع الصافية والكميات لكل صنف خلال شهر و4 أشهر وسنة ومنذ البداية — بتوقيت عدن"
     actions={<>
       <Link className="button button-secondary" to={`/companies/${companyId}/items`}>الأصناف</Link>
       <Button variant="secondary" disabled={report.isFetching} onClick={()=>void report.refetch()}>تحديث التقرير</Button>
     </>}/>
   {directory.isPending&&<Notice>جارٍ التحقق من صلاحيات التقرير…</Notice>}
   {!directory.isPending&&!canView&&<Notice tone="warning">
     يتطلب عرض التقرير صلاحية الأصناف وفواتير المبيعات والمشتريات.
   </Notice>}
   {report.error&&<Notice tone="error">{errorMessage(report.error)}</Notice>}
   <Card title="البحث والتصفية">
     <div className="form-grid">
       <form onSubmit={e=>{e.preventDefault();change("q",typedSearch.trim());}}
         className="form-actions">
         <Field label="اسم الصنف أو رمزه أو باركوده" value={typedSearch} maxLength={120}
           onChange={e=>setTypedSearch(e.target.value)}/>
         <Button type="submit">بحث</Button>
       </form>
       <Select label="حالة الصنف" value={active}
         onChange={e=>change("active",e.target.value)}>
         <option value="active">الأصناف الفعالة</option>
         <option value="all">جميع الأصناف</option>
         <option value="archived">الأصناف المؤرشفة</option>
       </Select>
       <Select label="نوع الحركة المعروضة" value={metric}
         onChange={e=>change("metric",e.target.value)}>
         {Object.entries(metrics).map(([key,label])=>
           <option value={key} key={key}>{label}</option>)}
       </Select>
       <Select label="ترتيب النتائج" value={sort} onChange={e=>change("sort",e.target.value)}>
         <option value="code">رمز الصنف</option>
         <option value="name">اسم الصنف</option>
         <option value="quantity">حسب القيمة المحددة (مرات أو كمية)</option>
       </Select>
       {sort==="quantity"&&<>
         <Select label="فترة الفرز" value={sortPeriod} onChange={e=>change("sortPeriod",e.target.value)}>
           {periods.map(p=><option key={p.key} value={p.key}>{p.label}</option>)}
         </Select>
         <Select label="اتجاه الفرز" value={order} onChange={e=>change("order",e.target.value)}>
           <option value="desc">الأكثر أولًا</option>
           <option value="asc">الأقل أولًا</option>
         </Select>
       </>}
       <Select label="عدد الأصناف في الصفحة" value={pageSize}
         onChange={e=>change("pageSize",e.target.value)}>
         <option value={50}>50</option><option value={100}>100</option>
       </Select>
     </div>
   </Card>
   <Card title={`إحصائيات الأصناف — ${metrics[metric]}`}>
     <p className="muted">
       {result?<>حتى تاريخ <bdi>{result.asOf}</bdi> · عدد الأصناف المطابقة:{" "}
        <bdi>{result.total.toLocaleString("en-US")}</bdi></>:""}
       {" "}· {metric==="saleTimes"
         ? "مرة بيع واحدة لكل فاتورة بيع للصنف، ناقص مرة عن كل فاتورة مرتجع له. يمكن أن تكون النتيجة سالبة."
         : "المرتجعات معروضة بصورة منفصلة عن كميات المبيعات والمشتريات."}
     </p>
     {report.isPending&&canView&&<Notice>جارٍ تحميل الإحصائيات…</Notice>}
     {result&&<>
       <div className="table-scroll" role="region" aria-label="جدول إحصائيات جميع الأصناف">
         <table>
           <thead><tr>
             <th>الرصيد بالوحدة الأولى</th><th>الصنف</th><th>{metric==="saleTimes"?"نوع العدد":"الوحدة الصغرى"}</th>
             {periods.map(p=><th key={p.key}>{p.label}</th>)}
           </tr></thead>
           <tbody>
             {result.rows.map(row=><tr key={row.itemId}>
               <td dir="ltr" style={{textAlign:"end"}}>{row.stockUnit1
                 ? <><bdi>{asFirstUnit(row.stockUnit1)}</bdi>{" "}{row.unit1Name}</>
                 : "—"}</td>
               <td><Link to={`/companies/${companyId}/items/${row.itemId}`}>{row.name}</Link>
                 {!row.active&&" (مؤرشف)"}</td>
               <td>{metric==="saleTimes"?"مرة":row.unitName}</td>
               {periods.map(p=><td key={p.key} dir="ltr" style={{textAlign:"end"}}>
                 <bdi>{asQuantity(row[metric][p.key])}</bdi>
               </td>)}
             </tr>)}
             {result.rows.length===0&&<tr><td colSpan={7}>
               لا توجد أصناف مطابقة لهذه التصفية.
             </td></tr>}
           </tbody>
         </table>
       </div>
       <div className="form-actions">
         <Button variant="secondary" disabled={report.isFetching||page<=1}
           onClick={()=>change("page",String(page-1))}>السابق</Button>
         <span>صفحة <bdi>{page.toLocaleString("en-US")}</bdi> من <bdi>{totalPages.toLocaleString("en-US")}</bdi></span>
         <Button variant="secondary" disabled={report.isFetching||page>=totalPages}
           onClick={()=>change("page",String(page+1))}>التالي</Button>
       </div>
     </>}
     <small className="muted">
       مرات البيع = عدد فواتير بيع الصنف − عدد فواتير مرتجعه (ولو ظهر الناتج سالبًا).
       الرصيد الحالي في العمود الأول محسوب بالوحدة الأولى بدقة، وقد يظهر على صورة كسر؛ ويُحجب عمن لا يملك صلاحية المخزون.
       أما كميات الحركات خلال الفترات فتُعرض بالوحدة الصغرى، ولا تُجمع كميات أصناف مختلفة.
       تُحتسب الفترات من الفواتير المُرحّلة حتى اليوم. انقر اسم الصنف لعرض التفاصيل.
     </small>
   </Card>
 </div>;
}
