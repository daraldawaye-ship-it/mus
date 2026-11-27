import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Building2, Image as ImageIcon } from "lucide-react";
import { Link } from "react-router-dom";
import InteractiveColumnsTable, { type InteractiveTableColumn } from "../InteractiveColumnsTable";
import { DefineMarketAgentsAction } from "./DefineMarketAgentsAction";
import { ImagePreviewModal } from "../ImagePreviewModal";
import { MarketCardIcon, hasMarketCardImage, marketCardImageVariant } from "../MarketCardIcon";
import { api, useSession } from "../api";
import { Button, Card, Field, Notice, PageHeader, Select } from "../ui";

type Row = {
  id: number; name: string; englishName: string | null; dosageForm: string | null;
  composition: string | null; agent: string | null; manufacturer: string | null; manufacturerAgent: string | null;
  hasImage: boolean; updatedAt: string; archived: boolean; revision: number;
  medicineImage: string | null; agentId: number | null; agentRevision: number | null; agentImage: string | null;
  agentMedicines: number | null; agentManufacturers: number | null; compositionMedicines: number | null;
};
type Column = Exclude<keyof Row, "archived" | "revision" | "medicineImage" | "agentId" | "agentRevision" | "agentImage">;
type Results = { items: Row[]; total: number; page: number; pageSize: number };
const PAGE_SIZE = 50;
const root = "/medicine-market";
const countFormat = new Intl.NumberFormat("en-US");
const dateFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Aden", dateStyle: "short" });
const show = (value: string | null) => value || "—";
const showDate = (value: string) => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? dateFormat.format(time) : "—";
};
const showCount = (value: number | null) => value == null ? "—" : countFormat.format(value);
function MedicineIcon({row}: {row: Row}) {
  const card = {id:row.id,kind:"medicine" as const,revision:row.revision,data:{image:row.medicineImage}};
  if (!row.hasImage) return <span title="بلا صورة">—</span>;
  if (!hasMarketCardImage(card) || !row.medicineImage)
    return <span title="الصورة غير متاحة للمعاينة"><ImageIcon size={17} aria-label="الصورة غير متاحة للمعاينة"/></span>;
  const src = /^https:\/\//i.test(row.medicineImage)
    ? marketCardImageVariant(card,"preview") : row.medicineImage;
  return <span data-scroll-gesture="ignore">
    <ImagePreviewModal src={src} alt={`صورة ${row.name}`} marketImage>
      <MarketCardIcon card={card}/>
    </ImagePreviewModal>
  </span>;
}
function AgentCell({row}: {row: Row}) {
  if (!row.agent || row.agentId == null) return <>—</>;
  const card = {id:row.agentId,kind:"agent" as const,revision:row.agentRevision ?? 1,data:{image:row.agentImage}};
  return <span style={{display:"inline-flex",alignItems:"center",gap:6}}>
    {hasMarketCardImage(card) ? <MarketCardIcon card={card}/> : <Building2 size={17} aria-hidden="true"/>}
    <span>{row.agent}</span>
  </span>;
}
const columns: InteractiveTableColumn<Row, Column>[] = [
  {key:"id", label:"الرقم", width:85, sortable:true, cell: row => row.id},
  {key:"name", label:"اسم الصنف", width:280, sortable:true, cell: row =>
    <Link to={`${root}?kind=medicine&card=${row.id}${row.archived ? "&archived=true" : ""}`}>{row.name}</Link>},
  {key:"englishName", label:"الاسم الإنجليزي", width:220, sortable:true, cell: row => <bdi dir="ltr">{show(row.englishName)}</bdi>},
  {key:"composition", label:"التركيب", width:210, sortable:true, cell: row => show(row.composition)},
  {key:"compositionMedicines", label:"أصناف التركيب", width:125, sortable:true, cell: row => showCount(row.compositionMedicines)},
  {key:"dosageForm", label:"الشكل الصيدلاني", width:145, sortable:true, cell: row => show(row.dosageForm)},
  {key:"agent", label:"الوكيل", width:230, sortable:true, cell: row => <AgentCell row={row}/>},
  {key:"agentMedicines", label:"أصناف الوكيل", width:125, sortable:true, cell: row => showCount(row.agentMedicines)},
  {key:"agentManufacturers", label:"مصنّعو الوكيل", width:135, sortable:true, cell: row => showCount(row.agentManufacturers)},
  {key:"manufacturer", label:"الشركة المصنّعة", width:190, sortable:true, cell: row => show(row.manufacturer)},
  {key:"manufacturerAgent", label:"وكيل المصنّع", width:190, sortable:true, cell: row => show(row.manufacturerAgent)},
  {key:"hasImage", label:"الصورة", width:102, sortable:true, cell: row => <MedicineIcon row={row}/>},
  {key:"updatedAt", label:"آخر تعديل", width:130, sortable:true, cell: row => <bdi>{showDate(row.updatedAt)}</bdi>},
];
const visibleColumns = columns.map(column => column.key);
const linkFilters = [
  {key:"agentLink",label:"الوكيل",present:"له وكيل",missing:"بلا وكيل"},
  {key:"compositionLink",label:"التركيب",present:"له تركيب",missing:"بلا تركيب"},
  {key:"manufacturerLink",label:"الشركة المصنّعة",present:"له شركة مصنّعة",missing:"بلا شركة مصنّعة"},
] as const;


export default function MarketMedicineAdminPage() {
  const {user} = useSession();
  const [draft, setDraft] = useState("");
  const [filters, setFilters] = useState({
    q: "", archived: "false", image: "all", agentLink: "all", compositionLink: "all", manufacturerLink: "all", page: 1, sort: "updatedAt" as Column, direction: "desc" as "asc" | "desc",
  });
  useEffect(() => {
    const q = draft.trim();
    const timer = window.setTimeout(() => setFilters(value => value.q === q ? value : {...value,q,page:1}), 220);
    return () => window.clearTimeout(timer);
  }, [draft]);
  const {page,sort,direction} = filters;
  const query = useQuery({
    queryKey:["medicine-market",user?.id,"owner-medicines",filters],
    queryFn:({signal}) => api<Results>(`${root}/owner/medicines?${new URLSearchParams({
      ...filters,page:String(page),pageSize:String(PAGE_SIZE),
    })}`,{signal}),
  });
  const total = query.data?.total ?? 0;
  const lastPage = Math.max(1,Math.ceil(total/PAGE_SIZE));
  function movePage(next: number) { setFilters(value => ({...value,page:next})); }
  function orderBy(key: Column) {
    setFilters(value => ({
      ...value, page:1, sort:key,
      direction:value.sort === key ? value.direction === "asc" ? "desc" : "asc"
        : key === "updatedAt" || key === "id" || key === "hasImage" || key.endsWith("Medicines") || key === "agentManufacturers" ? "desc" : "asc",
    }));
  }

  return <section dir="rtl">
    <PageHeader title="إدارة أصناف السوق" actions={<><DefineMarketAgentsAction/><Link to={root}>العودة إلى سوق الأدوية</Link></>} />
    <Card>
      <div className="page-actions">
        <Field label="بحث" type="search" maxLength={200} value={draft} placeholder="اسم الصنف أو رقمه أو الوكيل…"
          onChange={event => setDraft(event.target.value)} />
        <Select label="حالة الكرت" value={filters.archived} onChange={event => {
          const archived = event.target.value;
          setFilters(value => ({...value,archived,page:1}));
        }}>
          <option value="false">المنشورة غير المؤرشفة</option>
          <option value="true">المؤرشفة</option>
        </Select>
        <Select label="حالة الصورة" value={filters.image} onChange={event => {
          const image = event.target.value;
          setFilters(value => ({...value,image,page:1}));
        }}>
          <option value="all">الكل</option>
          <option value="present">لها صورة</option>
          <option value="missing">بلا صورة</option>
        </Select>
        {linkFilters.map(({key,label,present,missing}) =>
          <Select key={key} label={label} value={filters[key]} onChange={event => {
            const next = event.target.value;
            setFilters(value => ({...value,[key]:next,page:1}));
          }}>
            <option value="all">الكل</option>
            <option value="present">{present}</option>
            <option value="missing">{missing}</option>
          </Select>
        )}
        <Button size="compact" variant="secondary" disabled={query.isFetching} onClick={() => void query.refetch()}>تحديث</Button>
      </div>
      <p className="muted" aria-live="polite">{query.data ? `النتائج: ${countFormat.format(total)}` : ""}</p>
      {query.isError ? <Notice tone="error">تعذر تحميل أصناف السوق. اضغط «تحديث» للمحاولة مجددًا.</Notice> :
        <InteractiveColumnsTable storageKey={`market-admin-medicines:${user?.id}`}
          allowColumnVisibility visibleColumns={visibleColumns} rowKey={row => row.id}
          columns={columns} rows={query.data?.items ?? []} ariaLabel="أصناف السوق"
          sortKey={sort} sortDirection={direction} onSort={orderBy}
          emptyMessage={query.isFetching ? "جارٍ تحميل الأصناف…" : "لا توجد أصناف مطابقة."} />}
      <div className="form-actions">
        <Button variant="secondary" size="compact" disabled={page === 1 || query.isFetching}
          onClick={() => movePage(page-1)}>السابق</Button>
        <span>صفحة {page} من {lastPage}</span>
        <Button variant="secondary" size="compact" disabled={page >= lastPage || query.isFetching}
          onClick={() => movePage(page+1)}>التالي</Button>
      </div>
    </Card>
  </section>;
}
