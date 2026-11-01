import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { isOfflineNow } from "./connection-mode";
import { presenceDate } from "./presence-format";
import { Button, Notice } from "./ui";

type PresentEmployee = {
  employeeId: number;
  employeeName: string;
  isPresent: boolean;
  lastCheckedInAt: string | null;
  lastCheckedOutAt: string | null;
};
/** Actual punch records, not browser session/online status. Managers only. */
export function AttendanceCurrentlyPresent({ companyId }: { companyId: number }) {
  const [now, setNow] = useState(Date.now());
  const list = useQuery({
    queryKey: ["attendance", companyId, "currently-present"],
    queryFn: ({ signal }) => api<{ items: PresentEmployee[] }>(
      `/companies/${companyId}/attendance/currently-present`, { signal }),
    enabled: !isOfflineNow(),
    // Every 15 seconds while visible; an attendance punch invalidates this
    // cache immediately. Inactive background tabs are not polled.
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const rows = list.data?.items ?? [];
  const count = rows.filter(e => e.isPresent).length;
  return <>
    <div className="actions">
      <strong>المحضرون الآن: {count} من {rows.length}</strong>
      <Button variant="secondary" onClick={() => void list.refetch()}>تحديث الحضور</Button>
    </div>
    {isOfflineNow() && <Notice>قد لا تعكس بيانات الحضور المحفوظة تغييرات الآخرين حتى عودة الاتصال.</Notice>}
    {list.error && <Notice tone="error">تعذر تحميل سجل الحضور الحالي.</Notice>}
    <div className="presence-table-scroll">
      <table className="presence-table">
        <thead><tr><th>الموظف</th><th>الحالة</th><th>آخر حضور</th><th>آخر انصراف</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.employeeId}
          className={row.isPresent ? "presence-employee-current" : undefined}>
          <td>{row.employeeName}</td>
          <td>{row.isPresent ? "محضر حاليًا" : "غير محضر"}</td>
          <td>{presenceDate(row.lastCheckedInAt)}</td>
          <td>{presenceDate(row.lastCheckedOutAt)}</td>
        </tr>)}</tbody>
      </table>
    </div>
    {list.isLoading && <p>جارٍ تحميل الموظفين…</p>}
    {list.data && !rows.length && <p>لا يوجد موظفون فعالون في هذه الشركة.</p>}
    <span className="visually-hidden">{now > 0 ? "يُحدّث العرض دوريًا" : ""}</span>
  </>;
}
