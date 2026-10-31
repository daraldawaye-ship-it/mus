import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { CompanyContext } from "../../../../packages/contracts/src/index.ts";
import { api, useSession } from "../api";
import { usePageDirectory } from "../page-directory";
import { errorMessage } from "../phase2";
import { Button, Card, Field, Notice, PageHeader, Select } from "../ui";
import { firstUnitStockText } from "../sale-stock-quantity";
import { rememberRecentEntity } from "../recent-entities";

const ranges = [
  { key: "stockMin", label: "الكمية المتوفرة (بدون مخازن المرتجعات) من" },
  { key: "stockMax", label: "الكمية المتوفرة (بدون مخازن المرتجعات) إلى" },
  { key: "monthMin", label: "المبيعات مرات في شهر من" },
  { key: "monthMax", label: "المبيعات مرات في شهر إلى" },
  { key: "fourMonthsMin", label: "المبيعات مرات في 4 أشهر من" },
  { key: "fourMonthsMax", label: "المبيعات مرات في 4 أشهر إلى" },
  { key: "allTimeMin", label: "المبيعات مرات منذ البداية من" },
  { key: "allTimeMax", label: "المبيعات مرات منذ البداية إلى" },
  { key: "coverageMin", label: "الكفاية من (يوم)" },
  { key: "coverageMax", label: "الكفاية إلى (يوم)" },
] as const;
type RangeKey = (typeof ranges)[number]["key"];
type Draft = Record<RangeKey, string> & { excludeZero: boolean; useReserve: boolean };
function readDraft(params: URLSearchParams): Draft {
  return {
    stockMin: params.get("stockMin") ?? "", stockMax: params.get("stockMax") ?? "",
    monthMin: params.get("monthMin") ?? "", monthMax: params.get("monthMax") ?? "",
    fourMonthsMin: params.get("fourMonthsMin") ?? "", fourMonthsMax: params.get("fourMonthsMax") ?? "",
    allTimeMin: params.get("allTimeMin") ?? "", allTimeMax: params.get("allTimeMax") ?? "",
    coverageMin: params.get("coverageMin") ?? "", coverageMax: params.get("coverageMax") ?? "",
    excludeZero: params.get("excludeZero") === "true",
    useReserve: params.get("useReserve") !== "false",
  };
}
type Row = {
  itemId: number; code: string; name: string; active: boolean;
  factor2: number; factor3: number; availableSmallest: string;
  availableUnit1: string; saleTimesMonth: string; saleTimesFourMonths: string;
  saleTimesAllTime: string; approximateCoverageDays: string | null;
  coverageAfterReserveDays: string | null;
};
type Response = {
  result: { rows: Row[]; total: number; page: number; pageSize: number; asOf: string };
};
const sortOptions = [
  ["code", "رمز الصنف"], ["name", "اسم الصنف"],
  ["stock", "الكمية المتوفرة"], ["month", "مرات المبيعات في شهر"],
  ["fourMonths", "مرات المبيعات في 4 أشهر"], ["allTime", "مرات المبيعات منذ البداية"],
  ["coverage", "الكفاية"],
] as const;
export function ItemOptionsListPage({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const { user } = useSession();
  const directory = usePageDirectory(companyId);
  const canView = !!directory.data?.find(row => row.key === "company.item-options-list")?.actionAccess.view;
  const [params, setParams] = useSearchParams();
  const [draft, setDraft] = useState<Draft>(() => readDraft(params));
  const [search, setSearch] = useState(params.get("q") ?? "");
  const paramsKey = params.toString();
  useEffect(() => {
    setDraft(readDraft(new URLSearchParams(paramsKey)));
    setSearch(new URLSearchParams(paramsKey).get("q") ?? "");
  }, [paramsKey]);
  const page = Math.max(1, Number(params.get("page") ?? "1") || 1);
  const pageSize = [20, 50, 100].includes(Number(params.get("pageSize")))
    ? Number(params.get("pageSize")) : 50;
  const request = new URLSearchParams(params);
  request.set("page", String(page));
  request.set("pageSize", String(pageSize));
  const resultQuery = useQuery({
    queryKey: ["item-options-list", user?.id, companyId, request.toString()],
    queryFn: ({ signal }) => api<Response>(
      `/companies/${companyId}/item-options-list?${request.toString()}`, { signal }),
    enabled: !!user && canView,
    staleTime: 0,
  });
  const result = resultQuery.data?.result;
  const pages = Math.max(1, Math.ceil((result?.total ?? 0) / pageSize));
  const change = (key: string, value: string) => {
    setParams(previous => {
      const next = new URLSearchParams(previous);
      if (value) next.set(key, value); else next.delete(key);
      if (key !== "page") next.delete("page");
      return next;
    });
  };
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setParams(previous => {
      const next = new URLSearchParams(previous);
      for (const { key } of ranges) {
        const value = draft[key].trim();
        if (value) next.set(key, value); else next.delete(key);
      }
      if (search.trim()) next.set("q", search.trim()); else next.delete("q");
      if (draft.excludeZero) next.set("excludeZero", "true"); else next.delete("excludeZero");
      if (!draft.useReserve) next.set("useReserve", "false"); else next.delete("useReserve");
      next.delete("page");
      return next;
    });
  }
  function reset() {
    setDraft(readDraft(new URLSearchParams()));
    setSearch("");
    setParams(new URLSearchParams());
  }
  const coverage = (row: Row) => params.get("useReserve") === "false"
    ? row.approximateCoverageDays : row.coverageAfterReserveDays;

  return <div className="wallet-page">
    <PageHeader title="قائمة الأصناف"
      description="تصفية الأصناف حسب المتوفر ومرات المبيعات والكفاية — دون احتساب مخازن المرتجعات في المتوفر"
      actions={<>
        <Link className="button button-secondary" to={`/companies/${companyId}/items`}>كروت الأصناف</Link>
        <Button variant="secondary" onClick={() => void resultQuery.refetch()}
          disabled={!canView || resultQuery.isFetching}>تحديث القائمة</Button>
      </>} />
    {directory.isPending && <Notice>جارٍ التحقق من صلاحيات القائمة…</Notice>}
    {!directory.isPending && !canView &&
      <Notice tone="warning">تحتاج الصفحة إلى صلاحيات الأصناف والمبيعات والمخزون والكفاية.</Notice>}
    <Card title="خيارات قائمة الأصناف">
      <form onSubmit={apply}>
        <div className="form-grid">
          <Field label="بحث عن صنف بالاسم أو الرمز أو الباركود" type="search"
            value={search} onChange={event => setSearch(event.target.value)} />
          <Select label="حالة الصنف" value={params.get("active") ?? "active"}
            onChange={event => change("active", event.target.value)}>
            <option value="active">الفعال</option>
            <option value="archived">المؤرشف</option>
            <option value="all">الكل</option>
          </Select>
          {ranges.map(({ key, label }) =>
            <Field key={key} label={label} type="number" step="any"
              placeholder="بدون حد" value={draft[key]}
              onChange={event => setDraft(previous => ({ ...previous, [key]: event.target.value }))} />
          )}
        </div>
        <div className="form-actions">
          <label className="checkbox">
            <input type="checkbox" checked={draft.excludeZero}
              onChange={event => setDraft(previous => ({ ...previous, excludeZero: event.target.checked }))} />
            استثناء الأصناف ذات الكمية الصفرية
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={draft.useReserve}
              onChange={event => setDraft(previous => ({ ...previous, useReserve: event.target.checked }))} />
            استخدام الكفاية مع الاحتياطي
          </label>
          <Button type="submit" disabled={!canView}>تطبيق الخيارات</Button>
          <Button type="button" variant="secondary" onClick={reset}>إعادة الافتراضيات</Button>
        </div>
      </form>
    </Card>
    {resultQuery.error && <Notice tone="error">{errorMessage(resultQuery.error)}</Notice>}
    <Card title="نتائج قائمة الأصناف">
      {result && <p className="muted">
        إجمالي الأصناف المطابقة: <bdi>{result.total.toLocaleString("en-US")}</bdi>
        {" "}· التاريخ: <bdi>{result.asOf}</bdi>
        {" "}· الصفحة <bdi>{page.toLocaleString("en-US")}</bdi> من <bdi>{pages.toLocaleString("en-US")}</bdi>
      </p>}
      <div className="form-actions">
        <Select label="ترتيب النتائج" value={params.get("sortBy") ?? "code"}
          onChange={event => change("sortBy", event.target.value)}>
          {sortOptions.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </Select>
        <Select label="اتجاه الترتيب" value={params.get("sortDir") ?? "asc"}
          onChange={event => change("sortDir", event.target.value)}>
          <option value="asc">تصاعدي</option><option value="desc">تنازلي</option>
        </Select>
        <Select label="الأصناف في الصفحة" value={String(pageSize)}
          onChange={event => change("pageSize", event.target.value)}>
          <option value="20">20</option><option value="50">50</option><option value="100">100</option>
        </Select>
      </div>
      {resultQuery.isPending && canView && <Notice>جارٍ تحميل الأصناف المطابقة…</Notice>}
      {result && <div className="table-scroll" role="region" aria-label="نتائج الأصناف حسب الخيارات">
        <table>
          <thead><tr>
            <th>رمز الصنف</th><th>اسم الصنف</th><th>المتوفر دون المرتجعات (الوحدة الأولى)</th>
            <th>مبيعات مرات في شهر</th><th>مبيعات مرات في 4 أشهر</th>
            <th>مبيعات مرات منذ البداية</th>
            <th>الكفاية (يوم)</th>
          </tr></thead>
          <tbody>
            {result.rows.map(row => <tr key={row.itemId}>
              <td><bdi>{row.code}</bdi></td>
              <td><Link to={`/companies/${companyId}/items/${row.itemId}`}
                onClick={() => {
                  if (user) rememberRecentEntity(user.id, companyId, "item",
                    { id: row.itemId, name: row.name });
                }}>{row.name}</Link>{!row.active && " (مؤرشف)"}</td>
              <td><bdi>{firstUnitStockText(row.availableSmallest, row)}</bdi></td>
              <td><bdi>{row.saleTimesMonth}</bdi></td>
              <td><bdi>{row.saleTimesFourMonths}</bdi></td>
              <td><bdi>{row.saleTimesAllTime}</bdi></td>
              <td><bdi>{coverage(row) ?? "—"}</bdi></td>
            </tr>)}
            {!result.rows.length && <tr><td colSpan={7}>لا توجد أصناف تطابق الخيارات الحالية.</td></tr>}
          </tbody>
        </table>
      </div>}
      {result && <div className="form-actions">
        <Button variant="secondary" disabled={resultQuery.isFetching || page <= 1}
          onClick={() => change("page", String(page - 1))}>السابق</Button>
        <span>صفحة <bdi>{page.toLocaleString("en-US")}</bdi> من <bdi>{pages.toLocaleString("en-US")}</bdi></span>
        <Button variant="secondary" disabled={resultQuery.isFetching || page >= pages}
          onClick={() => change("page", String(page + 1))}>التالي</Button>
      </div>}
      <small className="muted">
        الحقول الفارغة لا تضع أي حد أعلى أو أدنى، وتُحتسب مرات البيع صافي عدد فواتير البيع
        بعد طرح مرتجعات المبيعات. المتوفر يستبعد مخازن المرتجعات ويُعرض بالوحدة الأولى.
        تعتمد الكفاية على حسابات الموقع الحالية مع الاحتياطي أو بدونه حسب اختيارك.
      </small>
    </Card>
  </div>;
}
