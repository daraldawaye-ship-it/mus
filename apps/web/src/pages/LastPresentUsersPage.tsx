import { useEffect, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, useSession } from "../api";
import { isOfflineNow } from "../connection-mode";
import { presenceDate, sinceText } from "../presence-format";
import { Button, Card, Notice, PageHeader } from "../ui";

type LastSeenUser = { id: number; name: string; lastSeenAt: string | null };
export function LastPresentUsersPage() {
  const { user } = useSession();
  const [now, setNow] = useState(Date.now());
  const permitted = !!user && (user.owner || user.kind === "admin");
  const list = useQuery({
    queryKey: ["public", "last-present", user?.id],
    queryFn: ({ signal }) => api<{ items: LastSeenUser[] }>("/users/last-present", { signal }),
    enabled: permitted && !isOfflineNow(),
    refetchInterval: 60_000,
  });
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, []);
  if (!user) return <Navigate to="/login" replace />;
  if (!permitted) return <Notice tone="error">هذه الصفحة لإدارة الموقع العام فقط.</Notice>;
  return <>
    <PageHeader title="آخر المتواجدين"
      description="آخر نشاط مسجل للمستخدمين في الموقع العام، وليس سجل الحضور الوظيفي."
      actions={<div className="actions">
        <Link className="button button-secondary" to="/users">المستخدمون</Link>
        <Button variant="secondary" onClick={() => void list.refetch()}>تحديث</Button>
      </div>} />
    <Card>
      {isOfflineNow() && <Notice>تظهر بيانات التواجد عند الاتصال بالإنترنت.</Notice>}
      {list.error && <Notice tone="error">تعذر تحميل آخر تواجد. أعد المحاولة بعد الاتصال.</Notice>}
      <div className="presence-table-scroll">
        <table className="presence-table">
          <thead><tr><th>اسم المستخدم</th><th>آخر تواجد</th><th>التاريخ والوقت</th></tr></thead>
          <tbody>
            {(list.data?.items ?? []).map(row => <tr key={row.id}>
              <td>{row.name}</td>
              <td>{sinceText(row.lastSeenAt, now)}</td>
              <td>{presenceDate(row.lastSeenAt)}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
      {list.isLoading && <p>جارٍ تحميل آخر المتواجدين…</p>}
      {list.data && !list.data.items.length && <p>لا توجد سجلات مستخدمين.</p>}
    </Card>
  </>;
}
