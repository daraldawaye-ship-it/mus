import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, useSession } from "./api";
import { isOfflineNow } from "./connection-mode";
import { formatWholeMoney } from "./format-money";

type View = "pouch" | "electronic" | "present";
type Transfer = { id: number; kind: "pouch" | "electronic"; amount: string; notes: string; createdAt: string };
type Transfers = {
  hasEmployee: boolean;
  lastClosedAt: string | null;
  pouch: { total: string; count: number; items: Transfer[] };
  electronic: { total: string; count: number; items: Transfer[] };
};
type PresentEmployee = {
  employeeId: number;
  employeeName: string;
  isPresent: boolean;
  lastCheckedInAt: string | null;
};
const views: { value: View; label: string }[] = [
  { value: "pouch", label: "ترحيلاتي إلى الحافظة" },
  { value: "electronic", label: "ترحيلاتي إلى الحافظة الإلكترونية" },
  { value: "present", label: "المحضرون حاليًا" },
];
const localTime = (value: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Aden", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(value));

/** The second (previously empty) invoice-side panel. Only the selected view
 * fetches, so item lookup and invoice entry do not wait for these reports.
 * Both queries retain the website's existing authentication and permissions.
 */
export function InvoiceSideOverview({ companyId }: { companyId: number }) {
  const { user } = useSession();
  const [view, setView] = useState<View>("pouch");
  const menu = useRef<HTMLDetailsElement>(null);
  const offline = isOfflineNow();
  const transfers = useQuery<Transfers>({
    queryKey: ["invoice-side-cashbox", user?.id, companyId],
    queryFn: ({ signal }) => api<Transfers>(
      `/companies/${companyId}/sales/my-cashbox-transfers`, { signal }),
    enabled: !!user && view !== "present" && !offline,
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
  const section = view === "present" ? null : transfers.data?.[view];
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
        {offline && <small>هذه البيانات الحية تُحدّث عند عودة الاتصال بالإنترنت.</small>}
        {view !== "present" ? (
          <>
            {!offline && transfers.isLoading && <small>جارٍ تحميل ترحيلاتك…</small>}
            {transfers.isError && !offline && <small role="alert">تعذر قراءة ترحيلات الصندوق. راجع صلاحيات حسابك أو الاتصال.</small>}
            {transfers.data && !transfers.data.hasEmployee &&
              <small>لا يوجد موظف فعّال مرتبط بحسابك لهذه الشركة.</small>}
            {transfers.data?.hasEmployee && (
              <>
                <small className="invoice-side-overview-since">
                  من آخر إغلاق: {transfers.data.lastClosedAt ? localTime(transfers.data.lastClosedAt) : "منذ بداية تسجيل الحركات"}
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
                          <td>{localTime(entry.createdAt)}{entry.notes &&
                            <small className="invoice-side-overview-note">{entry.notes}</small>}</td>
                          <td className="invoice-side-overview-amount"><bdi>{formatWholeMoney(entry.amount)}</bdi></td>
                        </tr>
                      ))}</tbody>
                    </table>
                    {section.count > section.items.length &&
                      <small>تظهر آخر {section.items.length} حركة؛ الإجمالي يشمل جميع الحركات بعد الإغلاق.</small>}
                  </div>
                ) : !transfers.isLoading && <small>لا توجد ترحيلات في هذه الفترة.</small>}
              </>
            )}
          </>
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
                      <small>{row.lastCheckedInAt ? localTime(row.lastCheckedInAt) : ""}</small>
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
