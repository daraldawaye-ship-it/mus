import { useSearchParams, Link } from "react-router-dom";
import { documentStatusLabels, documentStatuses, type CompanyContext } from "../../../../packages/contracts/src/index";
import type { JournalLine } from "../../../../packages/contracts/src/journal-lines";
import InteractiveColumnsTable, { type InteractiveTableColumn } from "../InteractiveColumnsTable";
import { usePagedQuery, useSession } from "../api";
import { formatMoney } from "../format-money";
import { errorMessage } from "../phase2";
import { Button, Card, DateField, Field, Notice, PageHeader, Select } from "../ui";

const defaultSort = "documentDate:desc,number:desc,id:asc";
const postedDateTime = new Intl.DateTimeFormat("en-GB", {
  timeZone:"Asia/Aden", year:"numeric", month:"2-digit", day:"2-digit",
  hour:"2-digit", minute:"2-digit", second:"2-digit", hourCycle:"h23",
});

export default function JournalLinesPage({ context }: {context:CompanyContext}) {
  const companyId = context.company.id;
  const {user}=useSession();
  const [params,setParams]=useSearchParams();
  const filters=new URLSearchParams();
  for(const key of ["dateFrom","dateTo","status"]){
    const value=params.get(key);
    if(value)filters.set(key,value);
  }
  const list=usePagedQuery<JournalLine>(`/companies/${companyId}/journal-lines?${filters}`,
    `company:${companyId}:finance:journal-lines`,defaultSort);
  const setFilter=(key:string,value:string)=>setParams(previous=>{
    const next=new URLSearchParams(previous);
    if(value)next.set(key,value);else next.delete(key);
    next.delete("page");
    return next;
  });
  const columns:InteractiveTableColumn<JournalLine>[]=[
    {key:"number",label:"رقم القيد",width:145,cell:r=><bdi>{r.number}</bdi>},
    {key:"documentDate",label:"التاريخ المكتوب",width:135,cell:r=><bdi>{r.documentDate}</bdi>},
    {key:"accountName",label:"اسم الحساب",width:245,cell:r=>r.accountName},
    {key:"postedAt",label:"الترحيل الفعلي (عدن)",width:190,cell:r=>r.postedAt
      ? <bdi>{postedDateTime.format(new Date(r.postedAt))}</bdi>
      : (r.status==="draft"?"لم يُرحّل":"—")},
    {key:"documentDescription",label:"بيان القيد",width:270,sortable:false,cell:r=>r.documentDescription||"—"},
    {key:"accountCode",label:"كود الحساب",width:130,cell:r=><bdi>{r.accountCode}</bdi>},
    {key:"debit",label:"مدين",width:115,cell:r=><bdi>{formatMoney(r.debit)}</bdi>},
    {key:"credit",label:"دائن",width:115,cell:r=><bdi>{formatMoney(r.credit)}</bdi>},
    {key:"currency",label:"العملة",width:85,sortable:false,cell:r=><bdi>{r.currencyCode}</bdi>},
    {key:"description",label:"بيان السطر",width:270,sortable:false,cell:r=>r.description||"—"},
    {key:"lineNumber",label:"السطر",width:70,sortable:false,cell:r=><bdi>{r.lineNumber}</bdi>},
    {key:"status",label:"الحالة",width:95,sortable:false,cell:r=>documentStatusLabels[r.status]},
    {key:"document",label:"الأصل",width:120,sortable:false,cell:r=>
      <Link to={`/companies/${companyId}/financial-documents/${r.documentId}`} aria-label={`فتح القيد ${r.number}`}>فتح القيد</Link>},
  ];
  const sort=list.sorting[0];
  const data=list.error?undefined:list.data;
  const total=data?.total??0;
  const pages=Math.max(1,Math.ceil(total/list.pageSize));
  return <>
    <PageHeader title="القيود بالسطور" description="يعرض كل سطر من القيد في صف مستقل، بما في ذلك المسودات ما لم تحدد حالة أخرى." />
    <Card>
      <div className="table-filters">
        <Field type="search" label="بحث في القيود والحسابات" placeholder="رقم القيد أو الحساب أو البيان"
          value={list.query} onChange={event=>list.setQuery(event.target.value)} />
        <DateField label="من التاريخ المكتوب" value={filters.get("dateFrom")??""}
          onCommit={value=>setFilter("dateFrom",value)} />
        <DateField label="إلى التاريخ المكتوب" value={filters.get("dateTo")??""}
          onCommit={value=>setFilter("dateTo",value)} />
        <Select label="الحالة" value={filters.get("status")??""} onChange={event=>setFilter("status",event.target.value)}>
          <option value="">الكل</option>
          {documentStatuses.map(status=><option key={status} value={status}>{documentStatusLabels[status]}</option>)}
        </Select>
      </div>
      {list.error&&<Notice tone="error">{errorMessage(list.error)}</Notice>}
      <InteractiveColumnsTable columns={columns} rows={data?.items??[]} rowKey={row=>row.id}
        visibleColumns={columns.map(column=>column.key)} allowColumnVisibility
        storageKey={`alraesy:d13:journal-lines:${companyId}:${user?.id??"guest"}`}
        sortKey={sort?.id} sortDirection={sort?.desc?"desc":"asc"}
        onSort={key=>list.setSorting([{id:key,desc:sort?.id===key?!sort.desc:false}])}
        dockRowSource={row=>({companyId,accountId:row.accountId,accountName:row.accountName})}
        ariaLabel="القيود بالسطور" emptyMessage={list.loading?"جارٍ تحميل السطور…":list.error?"تعذر عرض السطور.":"لا توجد سطور مطابقة."} />
      <div className="table-filters">
        <Select label="حجم الصفحة" value={list.pageSize} onChange={event=>list.setPageSize(Number(event.target.value))}>
          {[10,20,50,100].map(size=><option key={size} value={size}>{size}</option>)}
        </Select>
        <small>إجمالي السطور: {total} · صفحة {list.page} من {pages}</small>
        <Button type="button" size="compact" variant="secondary" disabled={list.page<=1}
          onClick={()=>list.setPage(list.page-1)}>السابق</Button>
        <Button type="button" size="compact" variant="secondary" disabled={list.page>=pages}
          onClick={()=>list.setPage(list.page+1)}>التالي</Button>
      </div>
    </Card>
  </>;
}
