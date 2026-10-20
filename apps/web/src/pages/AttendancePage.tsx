import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
  attendanceAdjustmentSchema,
  type AttendanceDirectory,
  type AttendanceRecord,
  type AttendanceReport,
  type AttendanceReportRow,
  type CompanyContext,
} from "../../../../packages/contracts/src/index";
import {
  ApiFailure,
  api,
  usePagedQuery,
  useSession,
  useScopeGuard,
} from "../api";
import { usePageDirectory } from "../page-directory";
import { AttendancePunchControls, refreshAttendance } from "../AttendancePunchControls";
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

const time = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat("ar-YE", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "Asia/Aden",
      }).format(new Date(value))
    : "—";
const pointsText = (value: string) => BigInt(value).toLocaleString("ar-YE");
const duration = (minutes: number | null) =>
  minutes === null ? "—" : `${Math.floor(minutes / 60)} س ${minutes % 60} د`;
const secondsDuration = (seconds: string) =>
  duration(Number(BigInt(seconds) / 60n));
const hoursInSeconds = (hours: string) => {
  const [whole, fraction = ""] = hours.split(".");
  return (BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"))) * 36n;
};
const statusLabels: Record<string, string> = {
  present: "جلسات مكتملة",
  open: "جلسة مفتوحة",
  missingCheckout: "تحتاج مراجعة",
  review: "تحتاج مراجعة",
  notRecorded: "لا توجد جلسات مسجلة",
  unconfigured: "إعداد النقاط غير محدد",
};
type AdjustmentRequest = {
  record: AttendanceRecord;
  payload: {
    recordId: number;
    points: string;
    reason: string;
    idempotencyKey: string;
  };
};
export function AttendancePage({ context }: { context: CompanyContext }) {
  const { user } = useSession();
  return (
    <AttendanceContent
      key={`${user?.id}:${context.company.id}`}
      context={context}
    />
  );
}
function AttendanceContent({ context }: { context: CompanyContext }) {
  const companyId = context.company.id,
    base = `/companies/${companyId}/attendance`;
  const { user } = useSession(),
    client = useQueryClient(),
    guard = useScopeGuard(`company:${companyId}:attendance`);
  const directory = usePageDirectory(companyId);
  const attendanceEntry = directory.data?.find(
    (entry) => entry.key === "company.attendance",
  );
  const employeesEntry = directory.data?.find(
    (entry) => entry.key === "company.employees",
  );
  const mayAdjust =
    context.general &&
    !!attendanceEntry?.enabled &&
    !!attendanceEntry.actionAccess.edit;
  const mayEditEmployees =
    context.general &&
    !!employeesEntry?.enabled &&
    !!employeesEntry.actionAccess.view &&
    !!employeesEntry.actionAccess.edit;
  const [params, setParams] = useSearchParams();
  const view = params.get("view") === "sessions" ? "sessions" : "daily";
  const filters = new URLSearchParams();
  for (const key of ["day", "employeeId", "status"])
    if (params.get(key)) filters.set(key, params.get(key)!);
  const overview = useQuery({
    queryKey: ["list", user?.id, `company:${companyId}:attendance`, "overview"],
    queryFn: ({ signal }) => api<AttendanceDirectory>(base, { signal }),
    enabled: !!user,
  });
  const data = overview.data;
  const [notice, setNotice] = useState("");
  const adjustmentKey = ["attendance-adjustment", user?.id, companyId];
  const restored = client.getQueryData<AdjustmentRequest>(adjustmentKey);
  const [submittedAdjustment, setSubmittedAdjustment] =
    useState<AdjustmentRequest | null>(() => restored ?? null);
  const [target, setTarget] = useState<AttendanceRecord | null>(
    restored?.record ?? null,
  );
  const [adjustmentPoints, setAdjustmentPoints] = useState(
    restored?.payload.points ?? "",
  );
  const [reason, setReason] = useState(restored?.payload.reason ?? "");
  const [adjusting, setAdjusting] = useState(false),
    [adjustmentError, setAdjustmentError] = useState("");
  const adjustmentLock = useRef(false),
    adjustmentFormId = useId();
  const lockedAdjustment = adjusting || !!submittedAdjustment;
  useEffect(() => {
    if (!submittedAdjustment) return;
    const preventLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventLeave);
    return () => window.removeEventListener("beforeunload", preventLeave);
  }, [submittedAdjustment]);
  function filter(key: string, value: string) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      value ? next.set(key, value) : next.delete(key);
      next.delete("page");
      return next;
    });
  }
  function openAdjustment(record: AttendanceRecord) {
    if (lockedAdjustment || !mayAdjust) return;
    setTarget(record);
    setAdjustmentPoints("");
    setReason("");
    setAdjustmentError("");
  }
  function closeAdjustment() {
    if (lockedAdjustment) return;
    setTarget(null);
    setAdjustmentError("");
  }
  async function adjust(event: FormEvent) {
    event.preventDefault();
    if (
      adjustmentLock.current ||
      !target ||
      (!mayAdjust && !submittedAdjustment)
    )
      return;
    const parsed = attendanceAdjustmentSchema.safeParse(
      submittedAdjustment?.payload ?? {
        recordId: target.id,
        points: adjustmentPoints,
        reason,
        idempotencyKey: crypto.randomUUID(),
      },
    );
    if (!parsed.success) {
      setAdjustmentError(
        parsed.error.issues.map((issue) => issue.message).join(" · "),
      );
      return;
    }
    const retry = !!submittedAdjustment,
      frozen: AdjustmentRequest = { record: target, payload: parsed.data };
    client.setQueryDefaults(["attendance-adjustment"], { gcTime: Infinity });
    client.setQueryData(adjustmentKey, frozen);
    setSubmittedAdjustment(frozen);
    adjustmentLock.current = true;
    setAdjusting(true);
    setAdjustmentError("");
    setNotice("");
    try {
      await api(`${base}/adjustments`, {
        method: "POST",
        body: frozen.payload,
        signal: guard.signal,
      });
      if (!guard.isCurrent()) return;
      client.removeQueries({ queryKey: adjustmentKey, exact: true });
      setSubmittedAdjustment(null);
      setTarget(null);
      setAdjustmentPoints("");
      setReason("");
      setNotice(
        "تم تسجيل تعديل النقاط في المحفظة دون تغيير أوقات الحضور والانصراف.",
      );
      void refreshAttendance(client, user?.id, companyId);
    } catch (cause) {
      if (!guard.isCurrent()) return;
      setAdjustmentError(errorMessage(cause));
      if (
        !retry &&
        cause instanceof ApiFailure &&
        cause.status >= 400 &&
        cause.status < 500
      ) {
        client.removeQueries({ queryKey: adjustmentKey, exact: true });
        setSubmittedAdjustment(null);
      }
    } finally {
      adjustmentLock.current = false;
      if (guard.isCurrent()) setAdjusting(false);
    }
  }
  return (
    <div className="wallet-page">
      <PageHeader
        title="الحضور والانصراف"
        description="سجّل الحضور والانصراف في أي وقت، ويمكنك تسجيل أكثر من جلسة في اليوم. التوقيت: عدن."
      />
      {notice && <Notice tone="success">{notice}</Notice>}
      {overview.error && (
        <Notice tone="error">
          {errorMessage(overview.error)}{" "}
          <Button variant="ghost" onClick={() => void overview.refetch()}>
            إعادة المحاولة
          </Button>
        </Notice>
      )}
      <Card title="حضورك اليوم">
        {data && !data.selfEmployeeId ? (
          <Notice>
            حسابك غير مرتبط بموظف في هذه الشركة. يمكنك متابعة سجلات الموظفين.
          </Notice>
        ) : (
          <>
            {data?.ownSettings && (
              <dl className="details-list">
                <dt>قيمة الساعة</dt>
                <dd>
                  {data.ownSettings.hourlyPoints === null
                    ? "غير محددة"
                    : `${pointsText(data.ownSettings.hourlyPoints)} نقطة`}
                </dd>
                <dt>الساعات الافتراضية</dt>
                <dd>
                  {(data.dailySummary?.defaultDailyHours ??
                    data.ownSettings.defaultDailyHours) === null
                    ? "غير محددة"
                    : `${data.dailySummary?.defaultDailyHours ?? data.ownSettings.defaultDailyHours} ساعة يوميًا`}
                </dd>
                <dt>السماح بالإضافي</dt>
                <dd>
                  {(data.dailySummary?.allowOvertime ??
                  data.ownSettings.allowOvertime)
                    ? "نعم"
                    : "لا"}
                </dd>
                {data.ownSettings.expectedStartTime && (
                  <>
                    <dt>وقت الحضور الافتراضي</dt>
                    <dd>
                      <bdi>{data.ownSettings.expectedStartTime}</bdi> للمتابعة؛
                      يمكنك التسجيل في أي وقت.
                    </dd>
                  </>
                )}
              </dl>
            )}
            {data?.dailySummary && (
              <p aria-label="ملخص حضورك اليوم">
                الجلسات: {data.dailySummary.sessionCount} · المدة المكتملة:{" "}
                {secondsDuration(data.dailySummary.closedSeconds)} · المدة
                المحتسبة: {secondsDuration(data.dailySummary.paidSeconds)} ·
                نقاط الساعات: {pointsText(data.dailySummary.points)}
              </p>
            )}
            {!!data?.dailySummary.reviewCount && (
              <Notice tone="warning">
                لديك {data.dailySummary.reviewCount} جلسة تحتاج مراجعة. لا تُمنح
                نقاط الساعات للجلسة التي أُغلقت تلقائيًا؛ يمكن للإدارة تسجيل
                تعويض مستقل.
              </Notice>
            )}
            {data?.dailySummary.defaultDailyHours &&
              data.dailySummary.allowOvertime === false &&
              BigInt(data.dailySummary.paidSeconds) >=
                hoursInSeconds(data.dailySummary.defaultDailyHours) && (
                <Notice tone="warning">
                  بلغت الساعات الافتراضية لليوم. يمكنك تسجيل جلسات جديدة،
                  وتُحتسب نقاط الساعات حتى السقف اليومي المحدد.
                </Notice>
              )}
            <AttendancePunchControls companyId={companyId} directory={data} />
            <p className="muted">
              بعد 16 ساعة دون انصراف، تُغلق الجلسة تلقائيًا وتُحال للمراجعة.
              أوقات التسجيل محفوظة ولا تُعدّل يدويًا.
            </p>
          </>
        )}
      </Card>
      <Card title={context.general ? "سجل حضور الموظفين" : "سجل حضورك"}>
        <div className="wallet-filters" role="tablist" aria-label="عرض الحضور">
          {[
            { value: "daily", label: "الملخص اليومي" },
            { value: "sessions", label: "جلسات الحضور" },
          ].map((item) => (
            <Button
              key={item.value}
              role="tab"
              aria-selected={view === item.value}
              variant={view === item.value ? "primary" : "secondary"}
              onClick={() =>
                setParams((previous) => {
                  const next = new URLSearchParams(previous);
                  item.value === "daily"
                    ? next.delete("view")
                    : next.set("view", item.value);
                  next.delete("page");
                  next.delete("sort");
                  next.delete("status");
                  return next;
                })
              }
            >
              {item.label}
            </Button>
          ))}
        </div>
        <div className="table-filters">
          <Field
            label="يوم السجل"
            type="date"
            value={params.get("day") ?? data?.today ?? ""}
            onChange={(event) => filter("day", event.target.value)}
          />
          {context.general && (
            <Select
              label="الموظف"
              value={params.get("employeeId") ?? ""}
              onChange={(event) => filter("employeeId", event.target.value)}
            >
              <option value="">جميع الموظفين</option>
              {data?.employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.name}
                </option>
              ))}
            </Select>
          )}
          {view === "daily" && (
            <Select
              label="حالة الحضور"
              value={params.get("status") ?? ""}
              onChange={(event) => filter("status", event.target.value)}
            >
              <option value="">جميع الحالات</option>
              {["present", "open", "missingCheckout", "notRecorded"].map(
                (status) => (
                  <option key={status} value={status}>
                    {statusLabels[status]}
                  </option>
                ),
              )}
            </Select>
          )}
        </div>
        {view === "sessions" ? (
          <AttendanceSessions
            key="sessions"
            context={context}
            resource={`${base}?${filters}`}
            onAdjust={openAdjustment}
            mayAdjust={mayAdjust}
          />
        ) : (
          <AttendanceDailyReport
            key="daily"
            context={context}
            resource={`${base}/report?${filters}`}
          />
        )}
      </Card>
      {mayEditEmployees && (
        <Card title="إعداد الحضور والنقاط">
          <p>
            حدد قيمة الساعة والساعات اليومية الافتراضية وإمكانية الدوام الإضافي
            من كرت الموظف.
          </p>
          <Link
            className="button button-secondary"
            to={`/companies/${companyId}/employees`}
          >
            فتح الموظفين
          </Link>
        </Card>
      )}
      <Dialog
        open={!!target}
        title="تعويض / خصم نقاط"
        onClose={closeAdjustment}
        footer={
          <>
            <Button
              variant="secondary"
              disabled={lockedAdjustment}
              onClick={closeAdjustment}
            >
              إغلاق
            </Button>
            <Button
              type="submit"
              form={adjustmentFormId}
              disabled={adjusting || (!mayAdjust && !submittedAdjustment)}
            >
              {adjusting
                ? "جارٍ الحفظ…"
                : submittedAdjustment
                  ? "إعادة محاولة الحفظ"
                  : "حفظ تعديل النقاط"}
            </Button>
          </>
        }
      >
        {target && (
          <form
            id={adjustmentFormId}
            className="form-stack"
            onSubmit={(event) => void adjust(event)}
          >
            {adjustmentError && <Notice tone="error">{adjustmentError}</Notice>}
            {submittedAdjustment && !adjusting && (
              <Notice tone="warning">
                لم تتأكد نتيجة الحفظ بعد. أعد المحاولة بنفس التعديل للتحقق دون
                تكرار النقاط.
              </Notice>
            )}
            <p>
              {target.employeeName} · جلسة {time(target.checkedInAt)}
            </p>
            <Field
              label="النقاط"
              inputMode="text"
              value={adjustmentPoints}
              onChange={(event) => setAdjustmentPoints(event.target.value)}
              disabled={lockedAdjustment}
              required
              maxLength={25}
              hint="عدد موجب للتعويض، أو سالب للخصم، مثل 20 أو -20."
            />
            <Field
              label="سبب التعويض أو الخصم"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={lockedAdjustment}
              required
              maxLength={500}
            />
            <p className="muted">
              يُسجل التعديل في محفظة الموظف ويرتبط بهذه الجلسة. يبقى وقت الحضور
              والانصراف كما هو.
            </p>
          </form>
        )}
      </Dialog>
    </div>
  );
}
function AttendanceDailyReport({
  context,
  resource,
}: {
  context: CompanyContext;
  resource: string;
}) {
  const list = usePagedQuery<AttendanceReportRow, AttendanceReport>(
    resource,
    `company:${context.company.id}:attendance`,
    "workDate:desc,id:desc",
  );
  const columns: ColumnDef<AttendanceReportRow, unknown>[] = [
    { accessorKey: "workDate", header: "اليوم" },
    ...(context.general
      ? [{ accessorKey: "employeeName", header: "الموظف" }]
      : []),
    {
      accessorKey: "checkedInAt",
      header: "أول حضور",
      cell: ({ row }) => time(row.original.checkedInAt),
    },
    {
      accessorKey: "checkedOutAt",
      header: "آخر انصراف",
      cell: ({ row }) => time(row.original.checkedOutAt),
    },
    { accessorKey: "sessionCount", header: "الجلسات", enableSorting: false },
    {
      accessorKey: "status",
      header: "الحالة",
      cell: ({ row }) => statusLabels[row.original.status] ?? "—",
    },
    {
      accessorKey: "workedMinutes",
      header: "المدة المكتملة",
      cell: ({ row }) => duration(row.original.workedMinutes),
    },
    {
      id: "paid",
      header: "المدة المحتسبة",
      enableSorting: false,
      cell: ({ row }) => secondsDuration(row.original.paidSeconds),
    },
    {
      id: "points",
      header: "نقاط الساعات",
      enableSorting: false,
      cell: ({ row }) => pointsText(row.original.points),
    },
    {
      id: "review",
      header: "جلسات للمراجعة",
      enableSorting: false,
      cell: ({ row }) => row.original.reviewCount || "—",
    },
  ];
  return (
    <>
      <p className="muted">
        يُجمع وقت الجلسات المكتملة لكل موظف يوميًا؛ عدم تسجيل جلسة لا يُحسب
        غيابًا.
      </p>
      {list.data && (
        <p aria-label="ملخص السجل">
          الجلسات: {list.data.summary.sessionCount} · المدة المكتملة:{" "}
          {secondsDuration(list.data.summary.closedSeconds)} · المدة المحتسبة:{" "}
          {secondsDuration(list.data.summary.paidSeconds)} · نقاط الساعات:{" "}
          {pointsText(list.data.summary.points)} · جلسات للمراجعة:{" "}
          {list.data.summary.reviewCount}
        </p>
      )}
      {list.error && (
        <Notice tone="error">
          {errorMessage(list.error)}{" "}
          <Button variant="ghost" onClick={() => void list.refetch()}>
            إعادة المحاولة
          </Button>
        </Notice>
      )}
      <Field
        label="بحث في الحضور"
        type="search"
        value={list.query}
        onChange={(event) => list.setQuery(event.target.value)}
      />
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
        ariaLabel="الملخص اليومي للحضور"
      />
    </>
  );
}
function AttendanceSessions({
  context,
  resource,
  mayAdjust,
  onAdjust,
}: {
  context: CompanyContext;
  resource: string;
  mayAdjust: boolean;
  onAdjust: (record: AttendanceRecord) => void;
}) {
  const list = usePagedQuery<AttendanceRecord, AttendanceDirectory>(
    resource,
    `company:${context.company.id}:attendance`,
    "workDate:desc,id:desc",
  );
  const columns: ColumnDef<AttendanceRecord, unknown>[] = [
    ...(mayAdjust
      ? [
          {
            id: "adjust",
            header: "الإجراء",
            enableSorting: false,
            cell: ({ row }: { row: { original: AttendanceRecord } }) => (
              <Button
                size="compact"
                variant="secondary"
                onClick={() => onAdjust(row.original)}
              >
                تعويض / خصم نقاط
              </Button>
            ),
          },
        ]
      : []),
    { accessorKey: "workDate", header: "اليوم" },
    ...(context.general
      ? [{ accessorKey: "employeeName", header: "الموظف" }]
      : []),
    {
      accessorKey: "checkedInAt",
      header: "الحضور",
      cell: ({ row }) => time(row.original.checkedInAt),
    },
    {
      accessorKey: "checkedOutAt",
      header: "الانصراف",
      cell: ({ row }) => time(row.original.checkedOutAt),
    },
    {
      id: "worked",
      header: "المدة الفعلية",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.checkedOutAt
          ? duration(
              Math.max(
                0,
                Math.floor(
                  (Date.parse(row.original.checkedOutAt) -
                    Date.parse(row.original.checkedInAt)) /
                    60000,
                ),
              ),
            )
          : "—",
    },
    {
      id: "paid",
      header: "المدة المحتسبة",
      enableSorting: false,
      cell: ({ row }) => secondsDuration(row.original.paidSeconds),
    },
    {
      id: "points",
      header: "نقاط الساعات",
      enableSorting: false,
      cell: ({ row }) => pointsText(row.original.points),
    },
    {
      id: "close",
      header: "الإغلاق",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.closeSource === "automatic"
          ? "تلقائي · تحتاج مراجعة"
          : row.original.closeSource === "manual"
            ? "انصراف مسجل"
            : "جلسة مفتوحة",
    },
  ];
  return (
    <>
      {list.error && (
        <Notice tone="error">
          {errorMessage(list.error)}{" "}
          <Button variant="ghost" onClick={() => void list.refetch()}>
            إعادة المحاولة
          </Button>
        </Notice>
      )}
      <Field
        label="بحث في جلسات الحضور"
        type="search"
        value={list.query}
        onChange={(event) => list.setQuery(event.target.value)}
      />
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
        ariaLabel="جلسات الحضور والانصراف"
      />
    </>
  );
}
