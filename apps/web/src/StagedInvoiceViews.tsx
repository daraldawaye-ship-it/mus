import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, useSession } from "./api";
import { formatMoney } from "./format-money";
import { Button, Card, Notice } from "./ui";

type Paged<T> = {items:T[];total:number;page:number;pageSize:number};
type StageStatus = "pending" | "failed" | "excluded";
type StagedInvoice = {
  sourceSystem:string;sourceId:string;number:string;kind:"sale"|"purchase";
  documentDate:string;stageStatus:StageStatus;supplierReceiptNumber:string|null;
  description:string|null;sourceCreatedAt:string|null;
  counterpartyAccountName:string|null;supplierAccountName:string|null;
  locationName:string|null;currencyCode:string|null;lineCount:number;
  estimatedTotal:string;
};
type StagedLine = {
  lineNumber:number;itemId:number;itemCode:string|null;itemName:string|null;
  unit:number;unitName:string|null;quantity:string;unitPrice:string;expiryDate:string|null;
};
type StagedMovement = {
  sourceSystem:string;sourceId:string;invoiceNumber:string;documentDate:string;
  stageStatus:StageStatus;kind:"sale"|"purchase";lineNumber:number;
  itemCode:string|null;itemName:string|null;locationName:string|null;
  supplierAccountName:string|null;quantity:string;quantitySmallest:string|null;
  unitPrice:string;expiryDate:string|null;
};
const pageSize = 20;
const label = (status: StageStatus) =>
  status === "failed" ? "محفوظة أوليًا — تعذّر الترحيل" :
  status === "excluded" ? "محفوظة أوليًا — مستبعدة من الترحيل" : "محفوظة أوليًا";
const css = {overflowX:"auto" as const};
const tableClass = "data-table";
const cell = (value:string|null|undefined) => value || "—";

function Pagination({page,total,change}:{
  page:number;total:number;change:(page:number)=>void;
}) {
  const pages=Math.ceil(total/pageSize);
  if(pages<=1)return null;
  return <div className="form-actions">
    <Button variant="secondary" size="compact" onClick={()=>change(page-1)} disabled={page===1}>
      السابق
    </Button>
    <span>{page} / {pages} — {total} سجل</span>
    <Button variant="secondary" size="compact" onClick={()=>change(page+1)} disabled={page>=pages}>
      التالي
    </Button>
  </div>;
}

function StagedDetail({companyId,sourceSystem,sourceId}:{
  companyId:number;sourceSystem:string;sourceId:string;
}) {
  const {user}=useSession();
  const detail=useQuery({
    queryKey:["staged-invoice-detail",user?.id,companyId,sourceSystem,sourceId],
    queryFn:({signal})=>api<{invoice:{lines:StagedLine[];description:string|null}}>(
      "/companies/"+companyId+"/staged-invoices/"+
      encodeURIComponent(sourceSystem)+"/"+encodeURIComponent(sourceId),{signal}),
    enabled:!!user,
  });
  if(detail.isPending)return <p>جاري تحميل بنود الفاتورة…</p>;
  if(detail.error)return <Notice tone="error">تعذّر عرض بنود الفاتورة الأولية.</Notice>;
  const lines=detail.data?.invoice.lines ?? [];
  return <div style={css}>
    <p className="muted">بنود محفوظة كما وردت من المصدر، دون ترحيل للمخزون أو الحسابات.</p>
    <table className={tableClass}><thead><tr>
      <th>الصنف</th><th>الوحدة</th><th>الكمية الأصلية</th><th>السعر الأصلي</th><th>الانتهاء</th>
    </tr></thead><tbody>
      {lines.map(line=><tr key={line.lineNumber}>
        <td>{cell(line.itemCode)} — {cell(line.itemName)}</td>
        <td>{cell(line.unitName)}</td><td><bdi>{line.quantity}</bdi></td>
        <td><bdi>{line.unitPrice}</bdi></td><td>{cell(line.expiryDate)}</td>
      </tr>)}
    </tbody></table>
  </div>;
}

export function StagedInvoicesPanel({companyId,kind,q,dateFrom,dateTo,supplierQ,payerQ,branchId,locationId}:{
  companyId:number;kind:"sale"|"purchase";q:string;
  dateFrom:string;dateTo:string;supplierQ?:string;payerQ?:string;
  branchId?:string;locationId?:string;
}) {
  const {user}=useSession();
  const [page,setPage]=useState(1);
  const [selected,setSelected]=useState<string|null>(null);
  useEffect(()=>{setPage(1);setSelected(null)},[
    companyId,kind,q,dateFrom,dateTo,supplierQ,payerQ,branchId,locationId,
  ]);
  const query=useQuery({
    queryKey:["staged-invoices",user?.id,companyId,kind,q,dateFrom,dateTo,supplierQ,payerQ,branchId,locationId,page],
    queryFn:({signal})=>{
      const filters=new URLSearchParams({kind,q,page:String(page),pageSize:String(pageSize)});
      if(dateFrom)filters.set("dateFrom",dateFrom);
      if(dateTo)filters.set("dateTo",dateTo);
      if(supplierQ)filters.set("supplierQ",supplierQ);
      if(payerQ)filters.set("payerQ",payerQ);
      if(branchId)filters.set("branchId",branchId);
      if(locationId)filters.set("locationId",locationId);
      return api<Paged<StagedInvoice>>("/companies/"+companyId+"/staged-invoices?"+filters,{signal});
    },enabled:!!user,
  });
  const rows=query.data?.items ?? [];
  return <Card>
    <h3>الفواتير المحفوظة أوليًا ({kind==="sale"?"مبيعات":"مشتريات"})</h3>
    <p className="muted">تظهر هذه الفواتير للبحث والعرض فقط. لم تُرحّل محاسبيًا أو مخزنيًا، والصافي المعروض تقديري من بنود المصدر.</p>
    {query.isPending && <p>جاري تحميل الفواتير الأولية…</p>}
    {query.error && <Notice tone="error">تعذّر جلب الفواتير المحفوظة أوليًا.</Notice>}
    {!query.isPending && !query.error && <>
      <p>{query.data?.total ?? 0} فاتورة أولية تطابق البحث والفترة</p>
      <div style={css}><table className={tableClass}>
        <thead><tr><th>رقم المصدر</th><th>التاريخ</th><th>الحساب</th>
          {kind==="purchase" && <th>المورد</th>}
          <th>رقم الوصل</th><th>الموقع</th><th>البنود</th><th>الصافي التقريبي</th><th>الحالة</th><th>عرض</th>
        </tr></thead>
        <tbody>{rows.map(row=>{
          const key=row.sourceSystem+":"+row.sourceId;
          return <tr key={key}>
            <td><bdi>{row.number||row.sourceId}</bdi></td>
            <td>{row.documentDate}</td><td>{cell(row.counterpartyAccountName)}</td>
            {kind==="purchase"&&<td>{cell(row.supplierAccountName)}</td>}
            <td>{cell(row.supplierReceiptNumber)}</td><td>{cell(row.locationName)}</td>
            <td>{row.lineCount}</td>
            <td><bdi>≈ {formatMoney(row.estimatedTotal)} {cell(row.currencyCode)}</bdi></td>
            <td>{label(row.stageStatus)}</td>
            <td><Button size="compact" variant="secondary"
              onClick={()=>setSelected(selected===key?null:key)}>
              {selected===key?"إخفاء":"عرض"}
            </Button></td>
          </tr>;
        })}</tbody>
      </table></div>
      {selected&&rows.some(r=>r.sourceSystem+":"+r.sourceId===selected)&&
        (()=>{const row=rows.find(r=>r.sourceSystem+":"+r.sourceId===selected)!;
          return <StagedDetail key={selected} companyId={companyId}
            sourceSystem={row.sourceSystem} sourceId={row.sourceId}/>;
        })()}
      <Pagination page={page} total={query.data?.total??0} change={setPage}/>
    </>}
  </Card>;
}

export function StagedMovementsPanel({companyId,q,dateFrom,dateTo,itemId,locationId,kind,supplierAccountId,doctorId}:{
  companyId:number;q:string;dateFrom?:string;dateTo?:string;itemId?:string;
  locationId?:string;kind?:string;supplierAccountId?:string;doctorId?:string;
}) {
  const {user}=useSession();
  const [page,setPage]=useState(1);
  useEffect(()=>setPage(1),[companyId,q,dateFrom,dateTo,itemId,locationId,kind,supplierAccountId,doctorId]);
  const enabled=!kind || kind==="sale" || kind==="purchase";
  const query=useQuery({
    queryKey:["staged-stock-movements",user?.id,companyId,q,dateFrom,dateTo,itemId,locationId,kind,supplierAccountId,doctorId,page],
    queryFn:({signal})=>{
      const filters=new URLSearchParams({q,page:String(page),pageSize:String(pageSize)});
      if(dateFrom)filters.set("dateFrom",dateFrom);
      if(dateTo)filters.set("dateTo",dateTo);
      if(itemId)filters.set("itemId",itemId);
      if(locationId)filters.set("locationId",locationId);
      if(kind)filters.set("kind",kind);
      if(supplierAccountId)filters.set("supplierAccountId",supplierAccountId);
      if(doctorId)filters.set("doctorId",doctorId);
      return api<Paged<StagedMovement>>("/companies/"+companyId+"/staged-stock-movements?"+filters,{signal});
    },enabled:!!user && enabled,
  });
  if(!enabled)return null;
  return <Card>
    <h3>حركات الأصناف المحفوظة أوليًا</h3>
    <p className="muted">حركات مصدر للعرض فقط، ليست حركات مخزون فعلية ولا تدخل في الرصيد أو التكلفة. الإشارة بحسب البيع والشراء والمردود.</p>
    {query.isPending && <p>جاري تحميل حركات الأصناف الأولية…</p>}
    {query.error && <Notice tone="error">تعذّر جلب حركات الأصناف الأولية.</Notice>}
    {!query.isPending&&!query.error&&<>
      <p>{query.data?.total??0} بند أولي يطابق البحث</p>
      <div style={css}><table className={tableClass}>
        <thead><tr><th>التاريخ</th><th>نوع الحركة</th><th>الصنف</th>
          <th>الموقع</th><th>الكمية الأصلية</th><th>التغير المحسوب (أصغر وحدة)</th>
          <th>المورد</th><th>الفاتورة الأصلية</th><th>الحالة</th>
        </tr></thead><tbody>
        {(query.data?.items??[]).map(row=><tr key={row.sourceSystem+":"+row.sourceId+":"+row.lineNumber}>
          <td>{row.documentDate}</td>
          <td>{row.kind==="sale"?"مبيعات":"مشتريات"}</td>
          <td>{cell(row.itemCode)} — {cell(row.itemName)}</td>
          <td>{cell(row.locationName)}</td><td><bdi>{row.quantity}</bdi></td>
          <td><bdi>{cell(row.quantitySmallest)}</bdi></td>
          <td>{cell(row.supplierAccountName)}</td>
          <td><Link to={"/companies/"+companyId+"/"+(row.kind==="sale"?"sales?allDates=1&q=":"purchases?q=")+encodeURIComponent(row.sourceId)}>
            {row.invoiceNumber||row.sourceId}
          </Link></td>
          <td>{label(row.stageStatus)}</td>
        </tr>)}</tbody>
      </table></div>
      <Pagination page={page} total={query.data?.total??0} change={setPage}/>
    </>}
  </Card>;
}
