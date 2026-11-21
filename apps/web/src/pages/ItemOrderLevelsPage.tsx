import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { CompanyContext } from "../../../../packages/contracts/src/index.ts";
import { api, useSession } from "../api";
import { errorMessage } from "../phase2";
import { Button, Card, Notice, PageHeader } from "../ui";
import "./item-order-levels.css";

type LevelRow = {
  itemId: number; code: string; name: string; active: boolean;
  availableUnit1: string; saleQuantityMonth: string; orderAlertQuantity: string;
  differenceUnit1: string; belowLimit: boolean;
};
type LevelReport = {
  asOf: string; page: number; pageSize: number; total: number;
  summary: {
    activeConfigured: number; lowActive: number; aboveActive: number;
    archivedConfigured: number; suppressedLow: number; activeIncidents: number;
    notificationEnabled: boolean; notifyOwner: boolean; workerBlocked: boolean;
  };
  items: LevelRow[];
};
type SortKey = "urgency" | "name" | "stock" | "sold" | "threshold" | "difference";
const numberText = (value: string | number) => {
  const [integer, fraction = ""] = String(value).split(".");
  const digits = fraction.replace(/0+$/, "");
  return integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",") +
    (digits ? "." + digits : "");
};

export function ItemOrderLevelsPage({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const [search, setSearch] = useState(q);
  const validStatus = ["all", "active", "archived"] as const;
  const validLevel = ["all", "low", "above"] as const;
  const validSort = ["urgency", "name", "stock", "sold", "threshold", "difference"] as const;
  const rawStatus = params.get("status");
  const status = validStatus.find(value => value === rawStatus) ?? "all";
  const rawLevel = params.get("level");
  const level = validLevel.find(value => value === rawLevel) ?? "all";
  const rawSort = params.get("sortBy");
  const sortBy = validSort.find(value => value === rawSort) ?? "urgency";
  const sortDir = params.get("sortDir") === "desc" ? "desc" : "asc";
  const page = Math.max(1, Math.min(100000, Number(params.get("page")) || 1));
  const pageSize = [20, 50, 100].includes(Number(params.get("pageSize")))
    ? Number(params.get("pageSize")) : 50;
  const itemId = params.get("itemId") || "";
  const update = (changes: Record<string, string>, replace = false) => {
    setParams(previous => {
      const next = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(changes)) {
        if (!value) next.delete(key); else next.set(key, value);
      }
      return next;
    }, { replace });
  };
  useEffect(() => { setSearch(q); }, [q]);
  useEffect(() => {
    if (search.trim() === q) return;
    const timer = window.setTimeout(() =>
      update({ q: search.trim(), page: "" }, true), 350);
    return () => window.clearTimeout(timer);
  }, [search, q]);
  const queryString = new URLSearchParams({
    q, status, level, sortBy, sortDir,
    page: String(page), pageSize: String(pageSize),
    ...(itemId ? { itemId } : {}),
  }).toString();
  const report = useQuery({
    queryKey: ["item-order-levels", user?.id, companyId, queryString],
    queryFn: ({ signal }) => api<LevelReport>(
      "/companies/" + companyId + "/item-order-levels?" + queryString, { signal }),
    enabled: !!user,
    staleTime: 15_000,
  });
  const data = report.data;
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / pageSize));
  const sortHeader = (key: Exclude<SortKey, "urgency">, label: string) =>
    <th scope="col" aria-sort={sortBy === key ? (sortDir === "asc" ? "ascending" : "descending") : undefined}>
      <button type="button" onClick={() => update({
        sortBy: key, sortDir: sortBy === key && sortDir === "asc" ? "desc" : "asc", page: "",
      })}>{label} <span aria-hidden="true">{sortBy === key ? (sortDir === "asc" ? "▲" : "▼") : "⇵"}</span></button>
    </th>;
  return <div className="item-order-levels-page">
    <PageHeader title="متابعة حدود طلب الأصناف الخاصة"
      description="جميع الأصناف التي حُددت لها «كمية الطلب» في كرت الصنف، بما فيها الصفر. المتوفر يستثني مخازن المرتجعات."
      actions={<>
        <Link className="button button-secondary"
          to={"/companies/" + companyId + "/item-options-list"}>قائمة الأصناف</Link>
        <Link className="button button-secondary"
          to={"/companies/" + companyId + "/notification-templates"}>أنواع التنبيهات</Link>
      </>} />
    <Card>
      {data && <div className="item-order-levels-summary" aria-label="ملخص أصناف حدود الطلب">
        <span>الأصناف الفعالة ذات الحد: <strong>{numberText(data.summary.activeConfigured)}</strong></span>
        <span>عند أو دون الحد: <strong className="item-order-levels-low">{numberText(data.summary.lowActive)}</strong></span>
        <span>فوق الحد: <strong>{numberText(data.summary.aboveActive)}</strong></span>
        <span>مؤرشفة ولها حد: <strong>{numberText(data.summary.archivedConfigured)}</strong></span>
      </div>}
      {data && !data.summary.notifyOwner &&
        <Notice tone="warning">«إرسال التنبيه للمالك» غير مفعّل حاليًا في كرت نوع التنبيه. راجع إعداداته في «أنواع التنبيهات» لاستقبال إشعاراته.</Notice>}
      {data && (!data.summary.notificationEnabled || data.summary.workerBlocked) &&
        <Notice tone="warning">فحص هذا التنبيه أو إرساله غير متاح حاليًا بسبب إعدادات التنبيه/الصفحة أو ترحيل بيانات معلّق.</Notice>}
      {data && data.summary.suppressedLow > 0 &&
        <small className="muted">{data.summary.suppressedLow} من الأصناف المنخفضة لديها واقعة قديمة غير قابلة لإعادة الإشعار إلا بعد ارتفاع الرصيد فوق الحد ثم انخفاضه مجددًا.</small>}
      <div className="item-order-levels-controls">
        <label>بحث الصنف
          <input type="search" value={search} onChange={event => setSearch(event.target.value)}
            placeholder="اسم الصنف أو رمزه" />
        </label>
        <label>مقارنة حد الطلب
          <select value={level} onChange={event => update({ level: event.target.value, itemId: "", page: "" })}>
            <option value="all">جميع الحدود</option>
            <option value="low">عند الحد أو دونه</option>
            <option value="above">فوق الحد</option>
          </select>
        </label>
        <label>حالة الصنف
          <select value={status} onChange={event => update({ status: event.target.value, itemId: "", page: "" })}>
            <option value="all">الكل</option>
            <option value="active">فعال</option>
            <option value="archived">مؤرشف</option>
          </select>
        </label>
        <Button variant="secondary" size="compact" disabled={report.isFetching}
          onClick={() => void report.refetch()}>تحديث</Button>
      </div>
      {itemId && <div className="item-order-levels-focus">
        تعرض الصفحة الصنف المرتبط بالتنبيه فقط.
        <Button size="compact" variant="secondary"
          onClick={() => update({ itemId: "", q: "", level: "", status: "", page: "" })}>
          إظهار جميع الأصناف
        </Button>
      </div>}
      {report.isPending && <Notice>جارٍ تحميل حدود الطلب والأرصدة…</Notice>}
      {report.isError && <Notice tone="error">تعذر تحميل التقرير: {errorMessage(report.error)}</Notice>}
      {data && <>
        <div className="item-order-levels-results">
          <span>المطابق: <strong>{numberText(data.total)}</strong> صنف</span>
          <span>تاريخ الأرصدة: {data.asOf}</span>
        </div>
        <div className="table-scroll item-order-levels-scroll" role="region" aria-label="الأصناف ذات حد الطلب">
          <table>
            <thead><tr>
              {sortHeader("name", "الصنف")}
              {sortHeader("stock", "الكمية المتوفرة (و1)")}
              {sortHeader("sold", "الكمية المباعة في شهر (و1)")}
              {sortHeader("threshold", "كمية حد الطلب (و1)")}
              {sortHeader("difference", "الفارق عن الحد")}
              <th>الحالة</th>
            </tr></thead>
            <tbody>
              {data.items.map(item => <tr key={item.itemId}
                className={!item.active ? "item-order-levels-archived" :
                  item.belowLimit ? "item-order-levels-warning" : undefined}>
                <td><span className="company-item-label">{item.name}</span>
                  <small>{item.code}</small></td>
                <td><bdi>{numberText(item.availableUnit1)}</bdi></td>
                <td><bdi>{numberText(item.saleQuantityMonth)}</bdi></td>
                <td><bdi>{numberText(item.orderAlertQuantity)}</bdi></td>
                <td><bdi>{numberText(item.differenceUnit1)}</bdi></td>
                <td>{!item.active ? "مؤرشف" : item.belowLimit ? "وصل إلى الحد" : "فوق الحد"}</td>
              </tr>)}
              {!data.items.length && <tr><td colSpan={6}>لا توجد أصناف مطابقة.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="form-actions item-order-levels-pages">
          <Button variant="secondary" disabled={page <= 1}
            onClick={() => update({ page: String(page - 1) })}>السابق</Button>
          <span>صفحة {page} من {pages}</span>
          <Button variant="secondary" disabled={page >= pages}
            onClick={() => update({ page: String(page + 1) })}>التالي</Button>
          <label>الأصناف في الصفحة
            <select value={pageSize} onChange={event =>
              update({ pageSize: event.target.value, page: "" })}>
              <option value="20">20</option><option value="50">50</option><option value="100">100</option>
            </select>
          </label>
        </div>
      </>}
      <small className="muted">تُعتبر العتبة مستوفاة عندما يكون الرصيد في المعرض والمخازن غير المرتجعة مساويًا للحد أو أقل منه. يُصدر التنبيه مرة واحدة لكل واقعة انخفاض، ويُعاد بعد ارتفاع الرصيد فوق الحد ثم هبوطه مجددًا؛ لا يعني عدم التكرار أن الصنف تعافى.</small>
    </Card>
  </div>;
}
