import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type {
  AttendanceDirectory,
  AttendanceRecord,
} from "../../../packages/contracts/src/index";
import { ApiFailure, api, useScopeGuard, useSession } from "./api";
import { Button, Notice } from "./ui";
import { errorMessage } from "./phase2";

// Both the company's opening page and the full attendance page use this
// exact same mutation, retry state and query invalidation. There must not be
// two independent attendance systems.
type PunchRequest =
  | { out: false; idempotencyKey: string }
  | { out: true; recordId: number };

const localTime = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat("ar-YE", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "Asia/Aden",
      }).format(new Date(value))
    : "—";

export function refreshAttendance(
  client: QueryClient,
  userId: number | undefined,
  companyId: number,
) {
  return Promise.all([
    client.invalidateQueries({
      queryKey: ["list", userId, `company:${companyId}:attendance`],
    }),
    client.invalidateQueries({
      queryKey: ["wallet-summary", userId, companyId],
    }),
    client.invalidateQueries({
      queryKey: ["list", userId, `company:${companyId}:wallet`],
    }),
    client.invalidateQueries({ queryKey: ["notifications", userId] }),
    client.invalidateQueries({
      queryKey: ["list", userId, `company:${companyId}:notifications`],
    }),
  ]);
}

export function AttendancePunchControls({
  companyId,
  directory,
  compact = false,
}: {
  companyId: number;
  directory?: AttendanceDirectory;
  compact?: boolean;
}) {
  const { user } = useSession();
  const client = useQueryClient();
  const guard = useScopeGuard(`company:${companyId}:attendance-punch`);
  const base = `/companies/${companyId}/attendance`;
  const overview = useQuery({
    queryKey: ["list", user?.id, `company:${companyId}:attendance`, "overview"],
    queryFn: ({ signal }) => api<AttendanceDirectory>(base, { signal }),
    enabled: !!user && !directory,
  });
  const data = directory ?? overview.data;
  const punchKey = ["attendance-punch", user?.id, companyId];
  const [submittedPunch, setSubmittedPunch] = useState<PunchRequest | null>(
    () => client.getQueryData<PunchRequest>(punchKey) ?? null,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const punchLock = useRef(false);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void client.invalidateQueries({
          queryKey: ["list", user?.id, `company:${companyId}:attendance`],
        });
      }
    }, 30000);
    return () => window.clearInterval(timer);
  }, [client, user?.id, companyId]);

  useEffect(() => {
    if (!submittedPunch) return;
    const preventLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventLeave);
    return () => window.removeEventListener("beforeunload", preventLeave);
  }, [submittedPunch]);

  async function punch(out: boolean) {
    if (punchLock.current || !data) return;
    if (
      !submittedPunch &&
      (out ? !data.canCheckOut || !data.openRecord : !data.canCheckIn)
    ) return;
    const retry = !!submittedPunch;
    const frozen: PunchRequest =
      submittedPunch ??
      (out
        ? { out: true, recordId: data.openRecord!.id }
        : { out: false, idempotencyKey: crypto.randomUUID() });
    client.setQueryDefaults(["attendance-punch"], { gcTime: Infinity });
    client.setQueryData(punchKey, frozen);
    setSubmittedPunch(frozen);
    punchLock.current = true;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const response = await api<{ record: AttendanceRecord }>(
        base + (frozen.out ? "/check-out" : "/check-in"),
        {
          method: "POST",
          signal: guard.signal,
          body: frozen.out
            ? { recordId: frozen.recordId }
            : { idempotencyKey: frozen.idempotencyKey },
        },
      );
      if (!guard.isCurrent()) return;
      client.removeQueries({ queryKey: punchKey, exact: true });
      setSubmittedPunch(null);
      void refreshAttendance(client, user?.id, companyId);
      setNotice(
        response.record.closeSource === "automatic"
          ? "أُغلقت الجلسة تلقائيًا بعد 16 ساعة وتحتاج مراجعة."
          : `${frozen.out ? "تم تسجيل الانصراف" : "تم تسجيل الحضور"}: ${localTime(
              frozen.out ? response.record.checkedOutAt : response.record.checkedInAt,
            )}`,
      );
    } catch (cause) {
      if (!guard.isCurrent()) return;
      setError(errorMessage(cause));
      if (
        !retry &&
        cause instanceof ApiFailure &&
        cause.status >= 400 &&
        cause.status < 500
      ) {
        client.removeQueries({ queryKey: punchKey, exact: true });
        setSubmittedPunch(null);
      }
    } finally {
      punchLock.current = false;
      if (guard.isCurrent()) setPending(false);
    }
  }

  return (
    <div className="company-attendance-actions">
      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice tone="success">{notice}</Notice>}
      {!directory && overview.isPending && <p className="muted">جارٍ تحميل حالة الحضور…</p>}
      {!directory && overview.error && (
        <Notice tone="error">
          {errorMessage(overview.error)}{" "}
          <Button variant="ghost" onClick={() => void overview.refetch()}>
            إعادة المحاولة
          </Button>
        </Notice>
      )}
      {data && !data.selfEmployeeId ? (
        <Notice>يلزم ربط حسابك بموظف فعال في هذه الشركة لتسجيل الحضور والانصراف.</Notice>
      ) : (
        <>
          <div className="form-actions">
            <Button
              disabled={pending || !!submittedPunch || !data?.canCheckIn}
              onClick={() => void punch(false)}
            >
              تسجيل الحضور
            </Button>
            <Button
              variant="secondary"
              disabled={pending || !!submittedPunch || !data?.canCheckOut}
              onClick={() => void punch(true)}
            >
              تسجيل الانصراف
            </Button>
            {!compact && (
              <Button variant="ghost" disabled={pending}
                onClick={() => void refreshAttendance(client, user?.id, companyId)}>
                تحديث
              </Button>
            )}
            {pending && <span>جارٍ الحفظ…</span>}
          </div>
          {submittedPunch && !pending && (
            <Notice tone="warning">
              لم تتأكد نتيجة التسجيل بعد.{" "}
              <Button onClick={() => void punch(submittedPunch.out)}>
                التحقق من نتيجة التسجيل
              </Button>
            </Notice>
          )}
          {data?.openRecord && (
            <p className="muted">
              الجلسة المفتوحة منذ: {localTime(data.openRecord.checkedInAt)}
            </p>
          )}
          {!data?.openRecord && data?.todayRecord?.checkedOutAt && (
            <p className="muted">
              آخر انصراف: {localTime(data.todayRecord.checkedOutAt)}
            </p>
          )}
        </>
      )}
    </div>
  );
}
