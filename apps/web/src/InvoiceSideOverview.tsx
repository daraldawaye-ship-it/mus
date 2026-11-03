import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, useSession } from "./api";
import { isOfflineNow } from "./connection-mode";
import { formatWholeMoney } from "./format-money";
import type { CompanyContext } from "../../../packages/contracts/src/index.ts";
import { InvoiceSideRecentSales } from "./InvoiceSideRecentSales";
import { InvoiceSidePrivateNotes } from "./InvoiceSidePrivateNotes";
import { invoiceSideElapsed, invoiceSideDateTime } from "./invoice-side-time";

type View = "privateNotes" | "pouch" | "electronic" | "closings" | "present" | "recentSales";
type Transfer = { id: number; kind: "pouch" | "electronic"; amount: string; notes: string; createdAt: string };
type Transfers = {
  hasEmployee: boolean;
  transferWindowStartAt: string | null;
  closingWindowStartAt: string | null;
  pouch: { total: string; count: number; items: Transfer[] };
  electronic: { total: string; count: number; items: Transfer[] };
  closings: { count: number; shortageTotal: string; surplusTotal: string; items: {
    id: number; countedCash: string; bookBalance: string; difference: string;
    shortage: string; surplus: string; notes: string; createdAt: string;
  }[] };
};
type PresentEmployee = {
  employeeId: number;
  employeeName: string;
  isPresent: boolean;
  lastCheckedInAt: string | null;
};
const views: { value: View; label: string }[] = [
  { value: "privateNotes", label: "ملاحظاتي الخاصة" },
  { value: "pouch", label: "ترحيلاتي إلى الحافظة" },
  { value: "electronic", label: "ترحيلاتي إلى الحافظة الإلكترونية" },
  { value: "closings", label: "العجز والزيادة عند الإغلاق" },
  { value: "present", label: "المحضرون حاليًا" },
  { value: "recentSales", label: "آخر فواتير المبيعات" },
];
function EventTimestamp({ value, nowMs }: { value: string; nowMs: number }) {
  return <span className="invoice-side-event-time">
    <span className="invoice-side-event-elapsed">{invoiceSideElapsed(value, nowMs)}</span>
    <small className="invoice-side-event-datetime"><bdi>{invoiceSideDateTime(value)}</bdi></small>
  </span>;
}

/** The second (previously empty) invoice-side panel. Only the selected view
 * fetches, so item lookup and invoice entry do not wait for these reports.
 * Both queries retain the website's existing authentication and permissions.
 */
export function InvoiceSideOverview({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const { user } = useSession();
  const [view, setView] = useState<View>("privateNotes");
  const [clockNow, setClockNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = window.setInterval(() => setClockNow(Date.now()), 60_000);
    return () => window.clearInterval(tick);
  }, []);
  const menu = useRef<HTMLDetailsElement>(null);
  const offline = isOfflineNow();
  const transfers = useQuery<Transfers>({
    queryKey: ["invoice-side-cashbox", user?.id, companyId],
    queryFn: ({ signal }) => api<Transfers>(
      `/companies/${companyId}/sales/my-cashbox-transfers`, { signal }),
    enabled: !!user && (view === "pouch" || view === "electronic" || view === "closings") && !offline,
    staleTime: 5000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
  const presence = useQuery<{ items: PresentEmployee[] }>({
    queryKey: ["attendance", companyId, "currently-present"],
    queryFn: ({ signal }) => api<{ items: PresentEmployee[] }>(
      `/companies/${companyId}/attendance/currently-present`, { signal }),
    enabled: !!user && view === "present" && !offline,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });
  const selected = views.find(option => option.value === view)!;
  const section = view === "pouch" || view === "electronic" ? transfers.data?.[view] : null;
  const presentRows = (presence.data?.items ?? []).filter(row => row.isPresent);
  return (
    <section className="invoice-empty-panel invoice-side-overview" aria-label="خيارات الصندوق والحضور">
      <details className="invoice-side-overview-menu" ref={menu}>
        <summary aria-label="قائمة خيارات المساحة الجانبية">
          <span>{selected.label}</span><span aria-hidden="true">▾</span>
        </summary>
        <div className="invoice-side-overview-choices">
          {views.map(option => (
            <button key={option.value} type="button"
              className={view === option.value ? "is-selected" : ""}
              aria-current={view === option.value ? "true" : undefined}
              onClick={() => { setView(option.value); if (menu.current) menu.current.open = false; }}>
              {option.label}
            </button>
          ))}
        </div>
      </details>
      <div className="invoice-side-overview-content">
        {offline && view !== "privateNotes" && <small>هذه البيانات الحية تُحدّث عند عودة الاتصال بالإنترنت.</small>}
        {view === "privateNotes" ? (
          <InvoiceSidePrivateNotes />
        ) : (view === "pouch" || view === "electronic") ? (
          <>
            {!offline && transfers.isLoading && <small>جارٍ تحميل ترحيلاتك…</small>}
            {transfers.isError && !offline && <small role="alert">تعذر قراءة ترحيلات الصندوق. راجع صلاحيات حسابك أو الاتصال.</small>}
            {transfers.data && !transfers.data.hasEmployee &&
              <small>لا يوجد موظف فعّال مرتبط بحسابك لهذه الشركة.</small>}
            {transfers.data?.hasEmployee && (
              <>
                <small className="invoice-side-overview-since">
                  آخر 24 ساعة {transfers.data.transferWindowStartAt ? `(من ${invoiceSideDateTime(transfers.data.transferWindowStartAt)})` : ""}
                </small>
                <div className="invoice-side-overview-total">
                  <span>الإجمالي ({section?.count ?? 0} حركة)</span>
                  <strong><bdi>{formatWholeMoney(section?.total ?? "0")}</bdi></strong>
                </div>
                {section && section.items.length > 0 ? (
                  <div className="invoice-side-overview-scroll" role="region" tabIndex={0}
                    aria-label={selected.label}>
                    <table>
                      <thead><tr><th>التاريخ</th><th>المبلغ</th></tr></thead>
                      <tbody>{section.items.map(entry => (
                        <tr key={entry.id} title={entry.notes || undefined}>
                          <td><EventTimestamp value={entry.createdAt} nowMs={clockNow} />{entry.notes &&
                            <small className="invoice-side-overview-note">{entry.notes}</small>}</td>
                          <td className="invoice-side-overview-amount"><bdi>{formatWholeMoney(entry.amount)}</bdi></td>
                        </tr>
                      ))}</tbody>
                    </table>
                    {section.count > section.items.length &&
                      <small>تظهر آخر {section.items.length} حركة؛ الإجمالي يشمل جميع الحركات خلال آخر 24 ساعة.</small>}
                  </div>
                ) : !transfers.isLoading && <small>لا توجد ترحيلات في هذه الفترة.</small>}
              </>
            )}
          </>
        ) : view === "closings" ? (
          <>
            {!offline && transfers.isLoading && <small>جارٍ تحميل إغلاقات صندوقك…</small>}
            {!offline && transfers.isError && <small role="alert">تعذر عرض العجز والزيادة. راجع صلاحيات حسابك أو الاتصال.</small>}
            {transfers.data && !transfers.data.hasEmployee &&
              <small>لا يوجد موظف فعّال مرتبط بحسابك لهذه الشركة.</small>}
            {transfers.data?.hasEmployee && (
              <>
                <small className="invoice-side-overview-since">
                  آخر 14 ساعة {transfers.data.closingWindowStartAt ? `(من ${invoiceSideDateTime(transfers.data.closingWindowStartAt)})` : ""}
                </small>
                <div className="invoice-side-overview-variances">
                  <span>العجز <strong><bdi>{formatWholeMoney(transfers.data.closings.shortageTotal)}</bdi></strong></span>
                  <span>الزيادة <strong><bdi>{formatWholeMoney(transfers.data.closings.surplusTotal)}</bdi></strong></span>
                </div>
                <small>عدد الإغلاقات: {transfers.data.closings.count}</small>
                {transfers.data.closings.items.length > 0 ? (
                  <div className="invoice-side-overview-scroll" role="region" tabIndex={0}
                    aria-label="العجز والزيادة عند الإغلاق خلال آخر 14 ساعة">
                    <table>
                      <thead><tr><th>الإغلاق</th><th>العجز</th><th>الزيادة</th></tr></thead>
                      <tbody>{transfers.data.closings.items.map(entry => (
                        <tr key={entry.id} title={`الدفتر: ${formatWholeMoney(entry.bookBalance)}؛ النقد المعدود: ${formatWholeMoney(entry.countedCash)}${entry.notes ? `؛ ${entry.notes}` : ""}`}>
                          <td><time dateTime={entry.createdAt} className="invoice-side-closing-datetime">
                            <bdi>{invoiceSideDateTime(entry.createdAt)}</bdi>
                          </time>
                            {entry.notes && <small className="invoice-side-overview-note">{entry.notes}</small>}</td>
                          <td className="invoice-side-overview-amount"><bdi>{formatWholeMoney(entry.shortage)}</bdi></td>
                          <td className="invoice-side-overview-amount"><bdi>{formatWholeMoney(entry.surplus)}</bdi></td>
                        </tr>
                      ))}</tbody>
                    </table>
                    {transfers.data.closings.count > transfers.data.closings.items.length &&
                      <small>تظهر آخر {transfers.data.closings.items.length} عملية إغلاق؛ الإجماليات تشمل كل الإغلاقات خلال آخر 14 ساعة.</small>}
                  </div>
                ) : !transfers.isLoading && <small>لا توجد عمليات إغلاق خلال آخر 14 ساعة.</small>}
              </>
            )}
          </>
        ) : view === "recentSales" ? (
          <InvoiceSideRecentSales context={context} />
        ) : (
          <>
            {!offline && presence.isLoading && <small>جارٍ تحميل المحضرين…</small>}
            {!offline && presence.isError && <small role="alert">تعذر عرض المحضرين حاليًا؛ قد لا تكون لديك صلاحية صفحة الحضور الحالية.</small>}
            {presence.data && (
              <>
                <strong className="invoice-side-overview-presence-count">المحضرون الآن: {presentRows.length}</strong>
                {presentRows.length ? (
                  <ul className="invoice-side-overview-presence">
                    {presentRows.map(row => <li key={row.employeeId}>
                      <span>{row.employeeName}</span>
                      {row.lastCheckedInAt && <EventTimestamp value={row.lastCheckedInAt} nowMs={clockNow} />}
                    </li>)}
                  </ul>
                ) : <small>لا يوجد موظفون محضرون حاليًا.</small>}
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
