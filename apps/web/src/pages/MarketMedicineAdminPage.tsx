import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import InteractiveColumnsTable, { type InteractiveTableColumn } from "../InteractiveColumnsTable";
import { api, useSession } from "../api";
import { Button, Card, Field, Notice, PageHeader, Select } from "../ui";

type Row = {
  id: number; name: string; englishName: string | null; dosageForm: string | null;
  composition: string | null; agent: string | null; manufacturer: string | null;
  hasImage: boolean; updatedAt: string; archived: boolean;
};
type Column = Exclude<keyof Row, "archived">;
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
const columns: InteractiveTableColumn<Row, Column>[] = [
  {key:"id", label:"الرقم", width:85, sortable:true, cell: row => row.id},
  {key:"name", label:"اسم الصنف", width:280, sortable:true, cell: row =>
    <Link to={`${root}?kind=medicine&card=${row.id}${row.archived ? "&archived=true" : ""}`}>{row.name}</Link>},
  {key:"englishName", label:"الاسم الإنجليزي", width:220, sortable:true, cell: row => <bdi dir="ltr">{show(row.englishName)}</bdi>},
  {key:"composition", label:"التركيب", width:210, sortable:true, cell: row => show(row.composition)},
  {key:"dosageForm", label:"الشكل الصيدلاني", width:145, sortable:true, cell: row => show(row.dosageForm)},
  {key:"agent", label:"الوكيل", width:185, sortable:true, cell: row => show(row.agent)},
  {key:"manufacturer", label:"الشركة المصنّعة", width:190, sortable:true, cell: row => show(row.manufacturer)},
  {key:"hasImage", label:"الصورة", width:102, sortable:true, cell: row => row.hasImage ? "موجودة" : "غير موجودة"},
  {key:"updatedAt", label:"آخر تعديل", width:130, sortable:true, cell: row => <bdi>{showDate(row.updatedAt)}</bdi>},
];
const visibleColumns = columns.map(column => column.key);

export default function MarketMedicineAdminPage() {
  const {user} = useSession();
  const [draft, setDraft] = useState("");
  const [filters, setFilters] = useState({
    q: "", archived: "false", image: "all", page: 1, sort: "updatedAt" as Column, direction: "desc" as "asc" | "desc",
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
        : key === "updatedAt" || key === "id" || key === "hasImage" ? "desc" : "asc",
    }));
  }

  return <section dir="rtl">
    <PageHeader title="إدارة أصناف السوق" actions={<Link to={root}>العودة إلى سوق الأدوية</Link>} />
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
