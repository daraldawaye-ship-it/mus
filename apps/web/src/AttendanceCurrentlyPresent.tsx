import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { isOfflineNow } from "./connection-mode";
import { presenceDate, sinceText } from "./presence-format";
import { Button, Notice } from "./ui";

type PresentEmployee = {
  employeeId: number;
  employeeName: string;
  isPresent: boolean;
  lastCheckedInAt: string | null;
  lastCheckedOutAt: string | null;
  lastActivityAt: string | null;
};

/** Relative time above its small exact timestamp, consistently for all columns. */
function LastTime({ value, now }: { value: string | null; now: number }) {
  return <div className="presence-time-cell">
    <span className="presence-time-relative">{sinceText(value, now)}</span>
    <small className="presence-time-date">{presenceDate(value)}</small>
  </div>;
}

/** Attendance punches are physical clock events; app activity is a separate
 * shared last-seen signal linked only through this company's employee account.
 */
export function AttendanceCurrentlyPresent({ companyId }: { companyId: number }) {
  const [now, setNow] = useState(Date.now());
  const list = useQuery({
    queryKey: ["attendance", companyId, "currently-present"],
    queryFn: ({ signal }) => api<{ items: PresentEmployee[] }>(
      `/companies/${companyId}/attendance/currently-present`, { signal }),
    enabled: !isOfflineNow(),
    // Punches invalidate this cache immediately; the poll catches other devices.
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
  useEffect(() => {
    // Update relative minutes/hours/days even without a new punch or activity.
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
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
        <thead><tr>
          <th>الموظف</th>
          <th>الحالة</th>
          <th>آخر حضور</th>
          <th>آخر انصراف</th>
          <th title="آخر تواجد أو تفاعل داخل أي قسم من تطبيق الرئيسي">آخر نشاط في النظام</th>
        </tr></thead>
        <tbody>{rows.map(row => <tr key={row.employeeId}
          className={row.isPresent ? "presence-employee-current" : undefined}>
          <td>{row.employeeName}</td>
          <td>{row.isPresent ? "محضر حاليًا" : "غير محضر"}</td>
          <td><LastTime value={row.lastCheckedInAt} now={now} /></td>
          <td><LastTime value={row.lastCheckedOutAt} now={now} /></td>
          <td><LastTime value={row.lastActivityAt} now={now} /></td>
        </tr>)}</tbody>
      </table>
    </div>
    {list.isLoading && <p>جارٍ تحميل الموظفين…</p>}
    {list.data && !rows.length && <p>لا يوجد موظفون فعالون في هذه الشركة.</p>}
  </>;
}
