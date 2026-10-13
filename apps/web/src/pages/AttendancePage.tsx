import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
  attendanceScheduleSchema,
  type AttendanceDirectory,
  type AttendanceRecord,
  type AttendanceReport,
  type AttendanceReportRow,
  type AttendanceStatus,
  type AttendanceSchedule,
  type CompanyContext,
} from "../../../../packages/contracts/src/index";
import { api, usePagedQuery, useSession, useScopeGuard } from "../api";
import { errorMessage } from "../phase2";
import {
  Button,
  Card,
  DataTable,
  Dialog,
  Field,
  Notice,
  PageHeader,
  Select,
} from "../ui";
const days = [
  "الأحد",
  "الاثنين",
  "الثلاثاء",
  "الأربعاء",
  "الخميس",
  "الجمعة",
  "السبت",
];
const time = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat("ar-YE", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "Asia/Aden",
      }).format(new Date(value))
    : "—";
const statusLabels: Record<AttendanceStatus, string> = {
  present: "حضور مكتمل",
  open: "حاضر",
  missingCheckout: "انصراف غير مسجل",
  absent: "غياب",
  waiting: "لم يبدأ الدوام",
  notRecorded: "حضور غير مسجل",
  rest: "خارج أيام الدوام",
  unconfigured: "لا يوجد إعداد محفوظ لهذا اليوم",
};
const duration = (minutes: number | null) =>
  minutes === null ? "—" : `${Math.floor(minutes / 60)} س ${minutes % 60} د`;
type Draft = {
  employeeId: number;
  branchId: number;
  workDays: number[];
  startTime: string;
  endTime: string;
  active: boolean;
  revision: number | null;
};
export function AttendancePage({ context }: { context: CompanyContext }) {
  const companyId = context.company.id,
    { user } = useSession(),
    guard = useScopeGuard(`company:${companyId}:attendance`),
    client = useQueryClient();
  const [params, setParams] = useSearchParams(),
    filters = new URLSearchParams();
  for (const key of ["day", "employeeId", "status"])
    if (params.get(key)) filters.set(key, params.get(key)!);
  const list = usePagedQuery<AttendanceReportRow, AttendanceReport>(
    `/companies/${companyId}/attendance/report?${filters}`,
    `company:${companyId}:attendance`,
    "workDate:desc,id:desc",
  );
  const base = `/companies/${companyId}/attendance`;
  const overview = useQuery({
    queryKey: ["list", user?.id, `company:${companyId}:attendance`, "overview"],
    queryFn: ({ signal }) => api<AttendanceDirectory>(base, { signal }),
    enabled: !!user,
  });
  const data = overview.data;
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void list.refetch();
        void overview.refetch();
      }
    }, 30000);
    return () => window.clearInterval(timer);
  }, [base, list.refetch, overview.refetch]);
  const [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null),
    [checkInKey, setCheckInKey] = useState(() => crypto.randomUUID());
  const ownSchedule = data?.schedules.find(
    (s) => s.employeeId === data.selfEmployeeId,
  );
  function filter(key: string, value: string) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      value ? next.set(key, value) : next.delete(key);
      next.delete("page");
      return next;
    });
  }
  async function refresh() {
    await client.invalidateQueries({
      queryKey: ["list", user?.id, `company:${companyId}:attendance`],
    });
  }
  async function punch(out: boolean) {
    if (pending || !data) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const response = await api<{ record: AttendanceRecord }>(
        base + (out ? "/check-out" : "/check-in"),
        {
          method: "POST",
          signal: guard.signal,
          body: out
            ? { recordId: data.openRecord!.id }
            : { idempotencyKey: checkInKey },
        },
      );
      if (!guard.isCurrent()) return;
      if (!out) setCheckInKey(crypto.randomUUID());
      await refresh();
      if (guard.isCurrent())
        setNotice(
          `${out ? "تم تسجيل الانصراف" : "تم تسجيل الحضور"}: ${time(out ? response.record.checkedOutAt : response.record.checkedInAt)}`,
        );
    } catch (cause) {
      if (guard.isCurrent()) setError(errorMessage(cause));
    } finally {
      if (guard.isCurrent()) setPending(false);
    }
  }
  function openSchedule(employeeId: number) {
    const previous = data?.schedules.find((s) => s.employeeId === employeeId);
    setDraft({
      employeeId,
      branchId: previous?.branchId ?? data?.branches[0]?.id ?? 0,
      workDays: previous?.workDays ?? [0, 1, 2, 3, 4],
      startTime: previous?.startTime ?? "08:00",
      endTime: previous?.endTime ?? "16:00",
      active: previous?.active ?? true,
      revision: previous?.revision ?? null,
    });
    setError("");
  }
  async function saveSchedule(event: FormEvent) {
    event.preventDefault();
    if (!draft || pending) return;
    const { employeeId, ...body } = draft,
      parsed = attendanceScheduleSchema.safeParse(body);
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => i.message).join(" · "));
      return;
    }
    setPending(true);
    setError("");
    try {
      await api(base + `/schedules/${employeeId}`, {
        method: "PUT",
        body: parsed.data,
        signal: guard.signal,
      });
      if (!guard.isCurrent()) return;
      await refresh();
      if (guard.isCurrent()) {
        setDraft(null);
        setNotice("تم حفظ إعداد الدوام.");
      }
    } catch (cause) {
      if (guard.isCurrent()) setError(errorMessage(cause));
    } finally {
      if (guard.isCurrent()) setPending(false);
    }
  }
  const columns: ColumnDef<AttendanceReportRow, unknown>[] = [
    { accessorKey: "workDate", header: "يوم الدوام" },
    ...(context.general
      ? [{ accessorKey: "employeeName", header: "الموظف" }]
      : []),
    { accessorKey: "branchName", header: "الفرع", enableSorting: false },
    {
      accessorKey: "checkedInAt",
      header: "الحضور",
      cell: ({ row }) => time(row.original.checkedInAt),
    },
    {
      accessorKey: "checkedOutAt",
      header: "الانصراف",
      cell: ({ row }) =>
        row.original.checkedOutAt ? time(row.original.checkedOutAt) : "—",
    },
    {
      id: "schedule",
      header: "الدوام المقرر",
      enableSorting: false,
      cell: ({ row }) => (
        <bdi>
          {row.original.startTime ?? "—"} — {row.original.endTime ?? "—"}
        </bdi>
      ),
    },
    {
      accessorKey: "status",
      header: "الحالة",
      cell: ({ row }) => statusLabels[row.original.status],
    },
    {
      accessorKey: "lateMinutes",
      header: "التأخير",
      cell: ({ row }) => duration(row.original.lateMinutes),
    },
    {
      accessorKey: "workedMinutes",
      header: "مدة العمل",
      cell: ({ row }) => duration(row.original.workedMinutes),
    },
    {
      accessorKey: "earlyLeaveMinutes",
      header: "الانصراف المبكر",
      cell: ({ row }) => duration(row.original.earlyLeaveMinutes),
    },
  ];
  return (
    <>
      <PageHeader
        title="الحضور والانصراف"
        description="توقيت الشركة: عدن. التسجيل بوقت الخادم، وسجل واحد لكل يوم دوام."
      />
      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice tone="success">{notice}</Notice>}
      {(list.error || overview.error) && (
        <Notice tone="error">
          {errorMessage(list.error || overview.error)}{" "}
          <Button
            onClick={() => {
              void list.refetch();
              void overview.refetch();
            }}
          >
            إعادة المحاولة
          </Button>
        </Notice>
      )}
      <Card title="حضورك اليوم">
        {data && !data.selfEmployeeId ? (
          <Notice>
            حسابك غير مرتبط بموظف في هذه الشركة؛ يمكنك إدارة الدوام وسجل
            الموظفين.
          </Notice>
        ) : (
          <>
            {ownSchedule ? (
              <p>
                الفرع: {ownSchedule.branchName} · الدوام:{" "}
                <bdi>
                  {ownSchedule.startTime} — {ownSchedule.endTime}
                </bdi>{" "}
                · الأيام: {ownSchedule.workDays.map((d) => days[d]).join("، ")}
                {!ownSchedule.active ? " — الدوام غير مفعّل" : ""}
              </p>
            ) : (
              <Notice>
                اطلب من المدير إعداد فرعك وأيام دوامك ومواعيده قبل تسجيل الحضور.
              </Notice>
            )}
            <div className="form-actions">
              <Button
                disabled={pending || !data?.canCheckIn}
                onClick={() => void punch(false)}
              >
                تسجيل الحضور
              </Button>
              <Button
                variant="secondary"
                disabled={pending || !data?.canCheckOut}
                onClick={() => void punch(true)}
              >
                تسجيل الانصراف
              </Button>
              {pending && <span>جارٍ الحفظ…</span>}
              <Button
                variant="ghost"
                disabled={pending || list.loading}
                onClick={() => {
                  void list.refetch();
                  void overview.refetch();
                }}
              >
                تحديث
              </Button>
            </div>
            {data?.openRecord && (
              <p>
                حضور مفتوح ليوم {data.openRecord.workDate}:{" "}
                {time(data.openRecord.checkedInAt)}
              </p>
            )}
            {!data?.openRecord && data?.todayRecord?.checkedOutAt && (
              <p>سُجل الانصراف: {time(data.todayRecord.checkedOutAt)}</p>
            )}
          </>
        )}
      </Card>
      <Card
        title={context.general ? "تقرير الدوام اليومي" : "تقرير دوامك"}
        description="يُحسب الغياب بعد نهاية الدوام، والتأخير والانصراف المبكر بالدقائق الكاملة دون سماح تلقائي. مدة العمل للحضور المكتمل فقط؛ لا تُحسب خصومات أو رواتب."
      >
        {list.data && (
          <p aria-label="ملخص الدوام">
            الحضور: {list.data.summary.attended} · الغياب:{" "}
            {list.data.summary.absent} · المتأخرون: {list.data.summary.late} ·
            انصراف غير مسجل: {list.data.summary.missingCheckout} · مجموع مدة
            العمل: {duration(list.data.summary.workedMinutes)}
          </p>
        )}
        <div className="table-filters">
          <Field
            label="يوم السجل"
            type="date"
            value={params.get("day") ?? data?.workDate ?? ""}
            onChange={(e) => filter("day", e.target.value)}
          />
          {context.general && (
            <Select
              label="الموظف"
              value={params.get("employeeId") ?? ""}
              onChange={(e) => filter("employeeId", e.target.value)}
            >
              <option value="">جميع الموظفين</option>
              {data?.employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </Select>
          )}
          <Select
            label="حالة الدوام"
            value={params.get("status") ?? ""}
            onChange={(e) => filter("status", e.target.value)}
          >
            <option value="">جميع الحالات</option>
            <option value="late">المتأخرون</option>
            {Object.entries(statusLabels).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </Select>
          <Field
            label="بحث في الحضور"
            type="search"
            value={list.query}
            onChange={(e) => list.setQuery(e.target.value)}
          />
        </div>
        <DataTable
          columns={columns}
          data={list.data?.items ?? []}
          total={list.data?.total ?? 0}
          page={list.page}
          pageSize={list.pageSize}
          onPageChange={list.setPage}
          onPageSizeChange={list.setPageSize}
          sorting={list.sorting}
          onSortingChange={list.setSorting}
          loading={list.loading}
          ariaLabel="سجل الحضور والانصراف"
        />
      </Card>
      {context.general && (
        <Card
          title="إعداد دوام الموظفين"
          description="حدد الفرع والأيام ووقت البداية والنهاية. انتهاء الدوام قبل بدايته يعني امتداده لليوم التالي."
        >
          {!data?.employees.length && (
            <Notice>أضف موظفًا واربطه بمستخدم من صفحة الموظفين أولًا.</Notice>
          )}
          <div className="table-scroll">
            <table aria-label="إعداد دوام الموظفين">
              <thead>
                <tr>
                  <th>الإجراء</th>
                  <th>الموظف</th>
                  <th>الفرع</th>
                  <th>الدوام</th>
                  <th>أيام العمل</th>
                </tr>
              </thead>
              <tbody>
                {data?.employees.map((e) => {
                  const schedule = data.schedules.find(
                    (s) => s.employeeId === e.id,
                  );
                  return (
                    <tr key={e.id}>
                      <td>
                        <Button
                          size="compact"
                          variant="secondary"
                          disabled={pending}
                          aria-label={`إعداد دوام ${e.name}`}
                          onClick={() => openSchedule(e.id)}
                        >
                          إعداد الدوام
                        </Button>
                      </td>
                      <td>{e.name}</td>
                      <td>{schedule?.branchName ?? "غير محدد"}</td>
                      <td>
                        <bdi>
                          {schedule
                            ? `${schedule.startTime} — ${schedule.endTime}`
                            : "غير محدد"}
                        </bdi>
                      </td>
                      <td>
                        {schedule?.workDays.map((d) => days[d]).join("، ")}
                        {schedule && !schedule.active ? " (غير مفعّل)" : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <Dialog
        open={!!draft}
        title="إعداد الدوام"
        onClose={() => {
          if (!pending) setDraft(null);
        }}
      >
        {draft && (
          <form
            className="form-stack"
            onSubmit={(event) => void saveSchedule(event)}
          >
            {error && <Notice tone="error">{error}</Notice>}
            <p>
              {data?.employees.find((e) => e.id === draft.employeeId)?.name}
            </p>
            <div className="form-grid">
              <Select
                label="فرع الدوام"
                required
                value={draft.branchId || ""}
                disabled={pending}
                onChange={(e) =>
                  setDraft({ ...draft, branchId: Number(e.target.value) })
                }
              >
                <option value="">اختر الفرع</option>
                {data?.branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
              <Field
                label="بداية الدوام"
                type="time"
                required
                disabled={pending}
                value={draft.startTime}
                onChange={(e) =>
                  setDraft({ ...draft, startTime: e.target.value })
                }
              />
              <Field
                label="نهاية الدوام"
                type="time"
                required
                disabled={pending}
                value={draft.endTime}
                onChange={(e) =>
                  setDraft({ ...draft, endTime: e.target.value })
                }
              />
            </div>
            <div className="form-actions">
              {days.map((day, index) => (
                <label key={day} className="check-label">
                  <input
                    type="checkbox"
                    disabled={pending}
                    checked={draft.workDays.includes(index)}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        workDays: e.target.checked
                          ? [...draft.workDays, index]
                          : draft.workDays.filter((d) => d !== index),
                      })
                    }
                  />
                  {day}
                </label>
              ))}
            </div>
            <label className="check-label">
              <input
                type="checkbox"
                disabled={pending}
                checked={draft.active}
                onChange={(e) =>
                  setDraft({ ...draft, active: e.target.checked })
                }
              />
              الدوام مفعّل
            </label>
            <div className="form-actions">
              <Button type="submit" disabled={pending}>
                {pending ? "جارٍ الحفظ…" : "حفظ الدوام"}
              </Button>
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() => setDraft(null)}
              >
                إلغاء
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </>
  );
}
