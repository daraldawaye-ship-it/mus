import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { api, useSession } from "./api";
import { browserInstallationId } from "./company-device-discovery";
import { isOfflineNow } from "./connection-mode";
import { refreshAttendance } from "./AttendancePunchControls";

type Approval = {
  id: string;
  kind: "check-in" | "check-out";
  recordId: number | null;
  employeeName: string;
  requestedAt: string;
};
type ApprovalList = { items: Approval[] };

export function AttendanceApprovalBanner({ companyId }: { companyId: number }) {
  const { user } = useSession();
  const client = useQueryClient();
  const deviceId = useMemo(() => browserInstallationId(), []);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [hiddenId, setHiddenId] = useState<string | null>(null);
  const base = `/companies/${companyId}/attendance/approval-requests`;
  const pending = useQuery({
    queryKey: ["attendance-approvals", user?.id, companyId, deviceId],
    queryFn: ({ signal }) => api<ApprovalList>(
      `${base}?deviceId=${encodeURIComponent(deviceId!)}`, { signal },
    ),
    enabled: !!user && !!deviceId && !isOfflineNow(),
    refetchInterval: (query) => query.state.data?.items.length ? 2500 : 7000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
    retry: 1,
  });
  const visible = pending.data?.items.filter((item) => item.id !== hiddenId) ?? [];
  const current = visible[0];
  if (!current || !deviceId) return null;
  const kindName = current.kind === "check-in" ? "الحضور" : "الانصراف";
  async function decide(approved: boolean) {
    if (!current || !deviceId || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await api<{status: string;alreadyHandled: boolean}>(
        `${base}/${current.id}/resolve`, {
          method: "POST", body: { deviceId, approved },
        },
      );
      setHiddenId(current.id);
      setMessage(result.alreadyHandled ? "تمت معالجة الطلب من جهاز آخر." :
        approved ? "تمت المصادقة." : "تم تسجيل عدم المصادقة وإشعار المسؤولين.");
      void refreshAttendance(client, user?.id, companyId);
      await pending.refetch();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "تعذر إرسال المصادقة");
      await pending.refetch();
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside className="attendance-approval-banner" role="status" aria-live="polite"
      aria-label="طلب مصادقة الحضور والانصراف">
      <div className="attendance-approval-copy">
        <strong>قام {current.employeeName} بتسجيل {kindName}</strong>
        <span>{new Intl.DateTimeFormat("ar-YE", {
          timeZone: "Asia/Aden", dateStyle: "short", timeStyle: "short",
        }).format(new Date(current.requestedAt))} · بانتظار المصادقة
          {visible.length > 1 ? ` · ${visible.length} طلبات` : ""}
        </span>
        {message && <span>{message}</span>}
      </div>
      <button type="button" disabled={busy} onClick={() => void decide(true)}
        className="attendance-approval-yes"><Check size={16} /> مصادقة</button>
      <button type="button" disabled={busy} onClick={() => void decide(false)}
        className="attendance-approval-no"><X size={16} /> عدم المصادقة</button>
    </aside>
  );
}
