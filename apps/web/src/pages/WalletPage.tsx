import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Coins, Plus, RefreshCw, RotateCcw, Settings2 } from "lucide-react";
import {
  walletAwardSchema,
  walletReversalSchema,
  rewardTaskSettingsSchema,
  type CompanyContext,
  type WalletDirectory,
  type WalletEntry,
  type WalletTaskReport,
  type WalletTaskPostingStatus,
  type RewardTask,
  type RewardTaskDirectory,
  type RewardRepeatRule,
  type WalletConversionPreview,
  type WalletConversion,
  walletConversionSchema,
} from "../../../../packages/contracts/src/index";
import {
  ApiFailure,
  api,
  usePagedQuery,
  useScopeGuard,
  useSession,
} from "../api";
import { errorMessage } from "../phase2";
import { formatMoney } from "../format-money";
import { usePageDirectory } from "../page-directory";
import { PageActionsDropdown } from "../SalesHeaderActionsDropdown";
import { refreshWalletConversions } from "./WalletConversionsPage";
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

const time = (value: string) =>
  new Intl.DateTimeFormat("ar-YE", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Aden",
  }).format(new Date(value));
const pointValue = (value: string) => BigInt(value).toLocaleString("ar-YE");
const adenToday = () => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Aden", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: "year" | "month" | "day") =>
    parts.find(part => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
};
const normalizePoints = (value: string) =>
  value.replace(/[٠-٩۰-۹]/g, (digit) =>
    String(
      "٠١٢٣٤٥٦٧٨٩".includes(digit)
        ? "٠١٢٣٤٥٦٧٨٩".indexOf(digit)
        : "۰۱۲۳۴۵۶۷۸۹".indexOf(digit),
    ),
  );
const invoiceTasks = new Set([
  "SALE_SAVED",
  "PURCHASE_SAVED",
  "SALE_LINES",
  "PURCHASE_LINES",
]);
const automaticLabels: Record<string, string> = {
  SALE_SAVED: "مكافأة فاتورة مبيعات",
  PURCHASE_SAVED: "مكافأة فاتورة مشتريات",
  SALE_LINES: "مكافأة سطور المبيعات",
  PURCHASE_LINES: "مكافأة سطور المشتريات",
  RECEIPT_PRINT: "مكافأة طلب طباعة سند قبض",
  PAYMENT_PRINT: "مكافأة طلب طباعة سند صرف",
  PAGE_VISIT: "مكافأة زيارة صفحة",
  DAILY_LOGIN: "مكافأة دخول الشركة",
};
const repeatLabels: Record<RewardRepeatRule, string> = {
  "per-document": "لكل مستند",
  daily: "مرة يوميًا",
  "rolling-seven-days": "مرة خلال سبعة أيام",
  unlimited: "غير محدود",
};
type AwardDraft = {
  employeeId: number;
  points: string;
  reason: string;
  idempotencyKey: string;
};
type ReversalDraft = {
  entry: WalletEntry;
  reason: string;
  idempotencyKey: string;
};

export function WalletPage({ context }: { context: CompanyContext }) {
  const companyId = context.company.id,
    scope = `company:${companyId}:wallet`,
    base = `/companies/${companyId}`;
  const { user } = useSession(),
    client = useQueryClient(),
    guard = useScopeGuard(scope);
  const [params, setParams] = useSearchParams();
  const [fromDate, setFromDate] = useState(adenToday);
  const [toDate, setToDate] = useState(adenToday);
  const [posting, setPosting] = useState<WalletTaskPostingStatus>("all");
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [taskPage, setTaskPage] = useState(1);
  const dateRangeValid = Boolean(fromDate && toDate && fromDate <= toDate);
  const filters = new URLSearchParams();
  if (dateRangeValid) {
    filters.set("fromDate", fromDate);
    filters.set("toDate", toDate);
  }
  if (params.get("employeeId"))
    filters.set("employeeId", params.get("employeeId")!);
  const list = usePagedQuery<WalletEntry, WalletDirectory>(
    `${base}/wallet?${filters}`,
    scope,
    "createdAt:desc,id:desc",
  );
  const taskReport = useQuery({
    queryKey: ["wallet-task-report", user?.id, companyId, list.data?.wallet?.employeeId ?? null,
      fromDate, toDate, posting, selectedTask, taskPage],
    enabled: Boolean(user && list.data?.wallet?.employeeId && dateRangeValid),
    queryFn: ({signal}) => {
      const query = new URLSearchParams({
        employeeId: String(list.data!.wallet!.employeeId),
        fromDate, toDate, posting, page: String(taskPage), pageSize: "50",
      });
      if (selectedTask) query.set("taskKey", selectedTask);
      return api<WalletTaskReport>(`${base}/wallet/task-report?${query}`, {signal});
    },
  });
  const directory = usePageDirectory(companyId);
  const walletPage = directory.data?.find(
    (entry) => entry.key === "company.wallet",
  );
  const tasksPage = directory.data?.find(
    (entry) => entry.key === "company.reward-tasks",
  );
  const settingsPage = directory.data?.find(
    (entry) => entry.key === "company.wallet-settings",
  );
  const conversionsPage = directory.data?.find(
    (entry) => entry.key === "company.wallet-conversions",
  );
  const canAward = !!list.data?.canManage && !!walletPage?.actionAccess.create;
  const canViewInvoice = !!directory.data?.find(
    (entry) => entry.key === "company.invoice",
  )?.actionAccess.view;
  const canViewVoucher = !!directory.data?.find(
    (entry) => entry.key === "company.financial-document",
  )?.actionAccess.view;
  const canReverse =
    !!list.data?.canManage && !!walletPage?.actionAccess.reverse;
  const [award, setAward] = useState<AwardDraft | null>(null),
    [reversal, setReversal] = useState<ReversalDraft | null>(null);
  const [previewEmployeeId, setPreviewEmployeeId] = useState<number | null>(
    null,
  );
  const [returnToReview, setReturnToReview] = useState<number | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  async function refresh() {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["list", user?.id, scope] }),
      client.invalidateQueries({
        queryKey: ["wallet-summary", user?.id, companyId],
      }),
      client.invalidateQueries({ queryKey: ["wallet-task-report", user?.id, companyId] }),
    ]);
  }
  async function confirmReturnReview() {
    if (returnToReview === null || !reviewNote.trim() || pending) return;
    setPending(true);
    setError("");
    try {
      await api(`${base}/wallet/clearance-returns/${returnToReview}/review`, {
        method: "POST", body: { note: reviewNote.trim() }, signal: guard.signal,
      });
      if (!guard.isCurrent()) return;
      await refresh();
      if (guard.isCurrent()) {
        setNotice("تم توثيق مراجعة المرتجع دون خصم أي عمولة من الموظف.");
        setReviewNote("");
        setReturnToReview(null);
      }
    } catch (cause) {
      if (guard.isCurrent()) setError(errorMessage(cause));
    } finally {
      if (guard.isCurrent()) setPending(false);
    }
  }
  function changeEmployee(value: string) {
    setSelectedTask(null);
    setTaskPage(1);
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      value ? next.set("employeeId", value) : next.delete("employeeId");
      next.delete("page");
      return next;
    });
  }
  function openAward() {
    setError("");
    setAward({
      employeeId:
        list.data?.wallet?.employeeId ?? list.data?.employees[0]?.id ?? 0,
      points: "",
      reason: "",
      idempotencyKey: crypto.randomUUID(),
    });
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (pending || (!award && !reversal)) return;
    const parsed = award
      ? walletAwardSchema.safeParse(award)
      : walletReversalSchema.safeParse({
          entryId: reversal!.entry.id,
          reason: reversal!.reason,
          idempotencyKey: reversal!.idempotencyKey,
        });
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join(" · "));
      return;
    }
    setPending(true);
    setError("");
    setNotice("");
    const isAward = !!award;
    try {
      await api(`${base}/wallet/${isAward ? "awards" : "reversals"}`, {
        method: "POST",
        body: parsed.data,
        signal: guard.signal,
      });
      if (!guard.isCurrent()) return;
      if (isAward && award) changeEmployee(String(award.employeeId));
      await refresh();
      if (guard.isCurrent()) {
        setAward(null);
        setReversal(null);
        setNotice(
          isAward
            ? (BigInt(award?.points ?? "0") < 0n
              ? "تم خصم النقاط وتوثيق السبب في سجل المحفظة."
              : "تمت إضافة النقاط وحفظها في السجل.")
            : "تم عكس المكافأة مع الاحتفاظ بسجلها الأصلي.",
        );
      }
    } catch (cause) {
      if (guard.isCurrent()) setError(errorMessage(cause));
    } finally {
      if (guard.isCurrent()) setPending(false);
    }
  }
  const columns: ColumnDef<WalletEntry, unknown>[] = [
    {
      accessorKey: "createdAt",
      header: "الوقت",
      size: 180,
      cell: ({ row }) => time(row.original.createdAt),
    },
    {
      accessorKey: "kind",
      header: "العملية",
      size: 185,
      enableSorting: false,
      cell: ({ row }) =>
        row.original.kind === "manual"
          ? "إضافة إدارية"
          : row.original.kind === "manual_debit"
            ? "خصم إداري"
          : row.original.kind === "attendance"
            ? "مكافأة الدوام والحضور"
            : row.original.kind === "clearance"
              ? "عمولة تصريف"
              : row.original.kind === "automatic"
              ? (automaticLabels[row.original.taskCode ?? ""] ?? "مكافأة آلية")
              : row.original.kind === "conversion"
                ? "تحويل النقاط إلى الحساب"
                : "عكس مكافأة",
    },
    {
      accessorKey: "points",
      header: "النقاط",
      size: 105,
      cell: ({ row }) => <bdi>{pointValue(row.original.points)}</bdi>,
    },
    { accessorKey: "reason", header: "السبب", size: 250, enableSorting: false },
    {
      accessorKey: "createdByName",
      header: "بواسطة",
      size: 145,
      enableSorting: false,
    },
    {
      id: "reference",
      header: "المرجع",
      size: 120,
      enableSorting: false,
      cell: ({ row }) =>
        row.original.financialDocumentId !== null && canViewVoucher ? (
          <Link
            to={`${base}/financial-documents/${row.original.financialDocumentId}`}
          >
            {row.original.kind === "conversion" ? "قيد" : "سند"} #
            {row.original.financialDocumentId}
          </Link>
        ) : row.original.invoiceId !== null && canViewInvoice ? (
          <Link to={`${base}/invoices/${row.original.invoiceId}`}>
            فاتورة #{row.original.invoiceId}
          </Link>
        ) : row.original.kind === "reversal" ? (
          `عكس #${row.original.referenceId}`
        ) : row.original.reversedByEntryId ? (
          `عُكست #${row.original.reversedByEntryId}`
        ) : (
          `#${row.original.id}`
        ),
    },
    ...(canReverse
      ? [
          {
            id: "action",
            header: "الإجراء",
            size: 130,
            enableSorting: false,
            cell: ({ row }: { row: { original: WalletEntry } }) =>
              (row.original.kind === "manual" ||
                row.original.kind === "automatic") &&
              !row.original.reversedByEntryId ? (
                <Button
                  variant="ghost"
                  size="compact"
                  disabled={pending}
                  onClick={() => {
                    setError("");
                    setReversal({
                      entry: row.original,
                      reason: "",
                      idempotencyKey: crypto.randomUUID(),
                    });
                  }}
                >
                  <RotateCcw size={14} />
                  عكس المكافأة
                </Button>
              ) : (
                "—"
              ),
          },
        ]
      : []),
  ];
  const wallet = list.data?.wallet;
  return (
    <div className="wallet-page">
      <PageHeader
        title="النقاط والمحفظة"
        description="رصيد موحد بالريال اليمني: مكافآت وحضور وعمولات تصريف، بسجل واحد. الترحيل للحساب المحاسبي بطلب الموظف فقط."
        actions={<PageActionsDropdown actions={[
          ...(conversionsPage?.enabled && conversionsPage.actionAccess.view
            ? [{label:"تحويلات النقاط",to:`${base}/wallet-conversions`}] : []),
          ...(settingsPage?.enabled && settingsPage.actionAccess.view
            ? [{label:"إعدادات المحفظة",to:`${base}/wallet-settings`}] : []),
          ...(tasksPage?.enabled && tasksPage.actionAccess.view
            ? [{label:"مهام المكافآت",to:`${base}/reward-tasks`}] : []),
          ...(canAward ? [{label:"إضافة نقاط",onClick:openAward,
            disabled:pending || !list.data?.employees.length}] : []),
          {label:"تحديث",onClick:()=>{void refresh();},disabled:list.loading},
        ]}/>}
      />
      {notice && <Notice tone="success">{notice}</Notice>}
      {list.error && (
        <Notice tone="error">
          {errorMessage(list.error)}{" "}
          <Button variant="ghost" onClick={() => void list.refetch()}>
            إعادة المحاولة
          </Button>
        </Notice>
      )}
      {wallet && (
        <div className="wallet-summary">
          <Card title="رصيد المحفظة الموحد — ريال يمني" description={wallet.employeeName}>
            <strong
              className="wallet-balance"
              data-wallet-points={wallet.points}
            >
              <bdi>{pointValue(wallet.points)}</bdi>
            </strong>
            <span> نقطة = {pointValue(wallet.points)} ريال يمني</span>
            {BigInt(wallet.reservedPoints) > 0n && (
              <p>
                محجوزة لطلبات الاعتماد:{" "}
                <bdi>{pointValue(wallet.reservedPoints)}</bdi> ريال. إجمالي
                الرصيد: <bdi>{pointValue(wallet.totalPoints)}</bdi> ريال.
              </p>
            )}
            <div className="form-actions">
              <Button
                variant="secondary"
                size="compact"
                onClick={() => setPreviewEmployeeId(wallet.employeeId)}
              >
                معاينة تحويل النقاط
              </Button>
            </div>
          </Card>
        </div>
      )}
      {list.data && !wallet && (
        <Notice>
          لا توجد محفظة موظف لعرضها. أضف موظفًا مرتبطًا بمستخدم داخل الشركة
          أولًا.
        </Notice>
      )}
      {list.data?.canManage && list.data.pendingReturnReviews.length > 0 && (
        <Card title="مرتجعات التصريف — بانتظار مراجعة الإدارة"
          description="لا تُخصم أي عمولة آليًا. راجع فاتورة البيع الأصلية والمرتجع، ثم وثّق نتيجة المراجعة.">
          <div style={{overflowX:"auto"}}>
            <table>
              <thead><tr><th>المرتجع</th><th>فاتورة البيع</th>
                <th>الصنف</th><th>الموظف الأصلي</th><th>عمولة مرتبطة للمراجعة</th><th>الإجراء</th></tr></thead>
              <tbody>{list.data.pendingReturnReviews.map(row => (
                <tr key={row.id}>
                  <td>{canViewInvoice ? <Link to={`${base}/invoices/${row.invoiceId}`}>{row.invoiceNumber}</Link> : row.invoiceNumber}</td>
                  <td>{canViewInvoice ? <Link to={`${base}/invoices/${row.originalInvoiceId}`}>{row.originalInvoiceNumber}</Link> : row.originalInvoiceNumber}</td>
                  <td>{row.itemName}</td><td>{row.originalEmployeeName ?? "غير محدد"}</td>
                  <td><bdi>{formatMoney(row.candidateAmount)} {row.currencyCode}</bdi></td>
                  <td><Button variant="secondary" size="compact" disabled={pending}
                    onClick={() => {setReviewNote("");setError("");setReturnToReview(row.id);}}>
                    مراجعة
                  </Button></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </Card>
      )}
      <Dialog open={returnToReview !== null} title="مراجعة مرتجع تصريف"
        onClose={() => {if(!pending){setReturnToReview(null);setReviewNote("");}}}>
        <p>هذا الإجراء يوثّق المراجعة فقط؛ لن يخصم عمولة الموظف ولن ينشئ قيدًا ماليًا.</p>
        {error && <Notice tone="error">{error}</Notice>}
        <Field label="ملاحظات الإدارة" value={reviewNote} maxLength={1000}
          disabled={pending} onChange={event => setReviewNote(event.target.value)} />
        <div className="form-actions">
          <Button onClick={() => void confirmReturnReview()} disabled={pending || !reviewNote.trim()}>تأكيد المراجعة</Button>
          <Button variant="secondary" disabled={pending} onClick={() => setReturnToReview(null)}>إلغاء</Button>
        </div>
      </Dialog>

      <Card title="ملخص المهام والنقاط حسب الفترة"
        description="يُحسب عدد مرات كل مهمة وإجمالي نقاطها ضمن التاريخ المحدد بتوقيت عدن. تُوزّع النقاط المحوّلة للحساب المحاسبي على المكافآت الأقدم أولًا لأغراض هذا التقرير؛ ولا تغيّر هذه الطريقة القيود المحاسبية.">
        <div className="wallet-filters wallet-task-filter-bar">
          {list.data?.canManage && (
            <Select label="الموظف" value={params.get("employeeId") ?? wallet?.employeeId ?? ""}
              onChange={event => changeEmployee(event.target.value)}>
              <option value="">اختر الموظف</option>
              {list.data.employees.map(employee =>
                <option key={employee.id} value={employee.id}>{employee.name}</option>)}
            </Select>
          )}
          <Field label="من تاريخ" type="date" value={fromDate}
            onChange={event => { setFromDate(event.target.value); setSelectedTask(null); setTaskPage(1); }}/>
          <Field label="إلى تاريخ" type="date" value={toDate}
            onChange={event => { setToDate(event.target.value); setSelectedTask(null); setTaskPage(1); }}/>
          <Select label="حالة النقاط" value={posting}
            onChange={event => {
              setPosting(event.target.value as WalletTaskPostingStatus);
              setSelectedTask(null); setTaskPage(1);
            }}>
            <option value="all">الكل — المرحّلة وغير المرحّلة</option>
            <option value="posted">المرحّلة</option>
            <option value="unposted">غير المرحّلة</option>
          </Select>
        </div>
        {!dateRangeValid && <Notice tone="warning">حدد تاريخ بداية لا يتجاوز تاريخ النهاية.</Notice>}
        {taskReport.error && <Notice tone="error">
          {errorMessage(taskReport.error)}{" "}
          <Button variant="ghost" onClick={() => void taskReport.refetch()}>إعادة المحاولة</Button>
        </Notice>}
        {taskReport.isLoading && <p className="muted">جارٍ حساب إجماليات المهام…</p>}
        <div className="table-scroll">
          <table className="wallet-task-table" aria-label="إجماليات مهام النقاط">
            <thead><tr><th>الإجمالي</th><th>اسم المهمة</th><th>العدد</th></tr></thead>
            <tbody>
              {(taskReport.data?.tasks ?? []).map(task =>
                <tr key={task.key} className={selectedTask === task.key ? "wallet-task-selected" : undefined}>
                  <td><bdi>{pointValue(task.points)}</bdi></td>
                  <td><button type="button" className="wallet-task-name"
                    aria-expanded={selectedTask === task.key}
                    onClick={() => {
                      setTaskPage(1);
                      setSelectedTask(current => current === task.key ? null : task.key);
                    }}>{task.name}</button></td>
                  <td><bdi>{task.count.toLocaleString("ar-YE")}</bdi></td>
                </tr>)}
              {taskReport.data && taskReport.data.tasks.length > 0 &&
                <tr className="wallet-task-grand-total">
                  <th><bdi>{pointValue(taskReport.data.totalPoints)}</bdi></th>
                  <th>الإجمالي</th>
                  <th>{taskReport.data.totalCount.toLocaleString("ar-YE")}</th>
                </tr>}
            </tbody>
          </table>
        </div>
        {taskReport.data && !taskReport.data.tasks.length &&
          <p className="muted">لا توجد حركات نقاط ضمن الفترة والحالة المحددتين.</p>}
        {selectedTask && dateRangeValid && (
          <section className="wallet-task-inline-details" aria-label="تفاصيل المهمة المحددة">
            <div className="wallet-task-details-head">
              <strong>تفاصيل: {taskReport.data?.tasks.find(item => item.key === selectedTask)?.name ?? "المهمة"}</strong>
              <Button variant="secondary" size="compact" onClick={() => setSelectedTask(null)}>إغلاق التفاصيل</Button>
            </div>
            {taskReport.isFetching && <p className="muted">جارٍ تحميل تفاصيل المهمة…</p>}
            <div className="table-scroll">
              <table aria-label="حركات المهمة للفترة المحددة">
                <thead><tr><th>النقاط المحتسبة</th><th>التاريخ</th><th>السبب</th><th>المرجع</th><th>بواسطة</th></tr></thead>
                <tbody>{(taskReport.data?.details ?? []).map(row =>
                  <tr key={row.entry.id}>
                    <td><bdi>{pointValue(row.countedPoints)}</bdi></td>
                    <td>{time(row.entry.createdAt)}</td>
                    <td>{row.entry.reason}</td>
                    <td>{row.entry.financialDocumentId !== null && canViewVoucher
                      ? <Link to={`${base}/financial-documents/${row.entry.financialDocumentId}`}>سند #{row.entry.financialDocumentId}</Link>
                      : row.entry.invoiceId !== null && canViewInvoice
                        ? <Link to={`${base}/invoices/${row.entry.invoiceId}`}>فاتورة #{row.entry.invoiceId}</Link>
                        : `#${row.entry.id}`}</td>
                    <td>{row.entry.createdByName}</td>
                  </tr>)}</tbody>
              </table>
            </div>
            {taskReport.data && taskReport.data.detailTotal === 0 &&
              <p className="muted">لا توجد تفاصيل مطابقة.</p>}
            {taskReport.data && taskReport.data.detailTotal > 50 && (
              <div className="wallet-task-pager">
                <span>الصفحة {taskPage.toLocaleString("ar")} من {Math.ceil(taskReport.data.detailTotal/50).toLocaleString("ar")}</span>
                <Button variant="secondary" size="compact" disabled={taskPage <= 1 || taskReport.isFetching}
                  onClick={() => setTaskPage(page => page - 1)}>السابق</Button>
                <Button variant="secondary" size="compact"
                  disabled={taskPage * 50 >= taskReport.data.detailTotal || taskReport.isFetching}
                  onClick={() => setTaskPage(page => page + 1)}>التالي</Button>
              </div>
            )}
          </section>
        )}
      </Card>
      <Card title="سجل حركات المحفظة خلال الفترة"
        description="يشمل نقاط الحضور والمكافآت وعمولات التصريف؛ تُضاف كلها إلى الرصيد نفسه. 1 نقطة = 1 ريال يمني.">
        <div className="wallet-filters">
          {list.data?.canManage && (
            <Select
              label="الموظف"
              value={params.get("employeeId") ?? wallet?.employeeId ?? ""}
              onChange={(event) => changeEmployee(event.target.value)}
            >
              <option value="">اختر الموظف</option>
              {list.data.employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.name}
                </option>
              ))}
            </Select>
          )}
          <Field
            label="بحث في السجل"
            type="search"
            value={list.query}
            onChange={(event) => list.setQuery(event.target.value)}
            placeholder="السبب أو اسم منفذ العملية"
          />
        </div>
        <DataTable
          key={wallet?.employeeId ?? "none"}
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
          ariaLabel="سجل النقاط والمحفظة"
        />
      </Card>
      <Dialog
        open={!!award || !!reversal}
        title={award ? "إضافة نقاط للموظف" : "عكس إضافة نقاط"}
        onClose={() => {
          if (!pending) {
            setAward(null);
            setReversal(null);
          }
        }}
      >
        <form className="form-stack" onSubmit={save}>
          {error && <Notice tone="error">{error}</Notice>}
          {award && (
            <>
              <Select
                label="الموظف"
                required
                disabled={pending}
                value={award.employeeId || ""}
                onChange={(event) =>
                  setAward({ ...award, employeeId: Number(event.target.value) })
                }
              >
                <option value="">اختر الموظف</option>
                {list.data?.employees.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.name}
                  </option>
                ))}
              </Select>
              <Field
                label="عدد النقاط"
                required
                inputMode="numeric"
                pattern="-?[0-9]+"
                maxLength={19}
                value={award.points}
                disabled={pending}
                onChange={(event) =>
                  setAward({
                    ...award,
                    points: normalizePoints(event.target.value),
                  })
                }
              />
              <small className="muted">
                الموجب يضاف إلى المحفظة والسالب يخصم منها، دون تجاوز الرصيد المتاح.
              </small>
              <Field
                label="سبب الإضافة أو الخصم"
                required
                maxLength={500}
                value={award.reason}
                disabled={pending}
                onChange={(event) =>
                  setAward({ ...award, reason: event.target.value })
                }
              />
            </>
          )}
          {reversal && (
            <>
              <Notice tone="warning">
                سيُخصم {pointValue(reversal.entry.points)} نقطة من محفظة{" "}
                {reversal.entry.employeeName}. تبقى الإضافة الأصلية ويُحفظ تصحيح
                مرتبط بها.
              </Notice>
              <p>{reversal.entry.reason}</p>
              <Field
                label="سبب العكس"
                required
                maxLength={500}
                value={reversal.reason}
                disabled={pending}
                onChange={(event) =>
                  setReversal({ ...reversal, reason: event.target.value })
                }
              />
            </>
          )}
          <div className="form-actions">
            <Button type="submit" disabled={pending}>
              {pending ? "جارٍ الحفظ…" : award
                ? (award.points.startsWith("-") ? "خصم النقاط" : "إضافة النقاط")
                : "تأكيد العكس"}
            </Button>
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() => {
                setAward(null);
                setReversal(null);
              }}
            >
              إلغاء
            </Button>
          </div>
        </form>
      </Dialog>
      {previewEmployeeId !== null && (
        <ConversionPreviewDialog
          key={previewEmployeeId}
          companyId={companyId}
          employeeId={previewEmployeeId}
          canRequest={
            previewEmployeeId === context.employee?.id &&
            !!conversionsPage?.enabled &&
            !!conversionsPage.actionAccess.create
          }
          onClose={() => setPreviewEmployeeId(null)}
        />
      )}
    </div>
  );
}

type ConversionRequestDraft = {
  preview: WalletConversionPreview;
  payload: {
    employeeId: number;
    expectedPoints: string;
    expectedAmount: string;
    policyRevision: number;
    accountRevision: number;
    idempotencyKey: string;
  };
};

function ConversionPreviewDialog({
  companyId,
  employeeId,
  canRequest,
  onClose,
}: {
  companyId: number;
  employeeId: number;
  canRequest: boolean;
  onClose: () => void;
}) {
  const { user } = useSession(),
    client = useQueryClient(),
    guard = useScopeGuard(
      `company:${companyId}:wallet-conversion:${employeeId}`,
    );
  const draftKey = ["wallet-conversion-draft", user?.id, companyId, employeeId];
  const [draft, setDraft] = useState<ConversionRequestDraft | null>(
    () => client.getQueryData<ConversionRequestDraft>(draftKey) ?? null,
  );
  const [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [result, setResult] = useState<WalletConversion | null>(null);
  const directory = usePageDirectory(companyId);
  const canViewJournal = !!directory.data?.find(
    (page) => page.key === "company.financial-document" && page.enabled,
  )?.actionAccess.view;
  const query = useQuery({
    queryKey: ["wallet-conversion-preview", user?.id, companyId, employeeId],
    queryFn: ({ signal }) =>
      api<{ preview: WalletConversionPreview }>(
        `/companies/${companyId}/wallet/conversion-preview?employeeId=${employeeId}`,
        { signal },
      ),
    enabled: !!user && !draft && !result,
    staleTime: 0,
  });
  const preview = draft?.preview ?? query.data?.preview;
  async function convert() {
    if (saving || result || !preview || (!draft && !canRequest)) return;
    if (
      !draft &&
      (!preview.canConvert ||
        preview.amount === null ||
        preview.policyRevision === null ||
        preview.accountRevision === null)
    )
      return;
    const request = draft ?? {
      preview,
      payload: {
        employeeId,
        expectedPoints: preview.points,
        expectedAmount: preview.amount!,
        policyRevision: preview.policyRevision!,
        accountRevision: preview.accountRevision!,
        idempotencyKey: crypto.randomUUID(),
      },
    };
    const parsed = walletConversionSchema.safeParse(request.payload);
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join(" · "));
      return;
    }
    setDraft(request);
    client.setQueryDefaults(["wallet-conversion-draft"], { gcTime: Infinity });
    client.setQueryData(draftKey, request);
    setSaving(true);
    setError("");
    try {
      const response = await api<{ conversion: WalletConversion }>(
        `/companies/${companyId}/wallet-conversions`,
        { method: "POST", body: parsed.data, signal: guard.signal },
      );
      if (!guard.isCurrent()) return;
      client.removeQueries({ queryKey: draftKey, exact: true });
      setDraft(null);
      setResult(response.conversion);
      await refreshWalletConversions(
        client,
        user?.id,
        companyId,
        response.conversion.status === "posted",
      );
    } catch (cause) {
      if (!guard.isCurrent()) return;
      setError(errorMessage(cause));
      if (
        cause instanceof ApiFailure &&
        cause.status >= 400 &&
        cause.status < 500 &&
        !draft
      ) {
        client.removeQueries({ queryKey: draftKey, exact: true });
        setDraft(null);
        await query.refetch();
      }
    } finally {
      if (guard.isCurrent()) setSaving(false);
    }
  }
  return (
    <Dialog
      open
      title="معاينة تحويل النقاط"
      onClose={() => !saving && onClose()}
    >
      <div className="form-stack">
        {!draft && !result && query.isPending && (
          <Notice>جارٍ حساب معاينة التحويل…</Notice>
        )}
        {!draft && !result && query.error && (
          <Notice tone="error">
            {errorMessage(query.error)}{" "}
            <Button variant="ghost" onClick={() => void query.refetch()}>
              إعادة المحاولة
            </Button>
          </Notice>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        {draft && !saving && !result && (
          <Notice tone="warning">
            لم نتأكد من نتيجة الطلب. أعد تأكيده للتحقق دون تكرار التحويل. يمكنك
            إغلاق النافذة والعودة إلى الطلب نفسه.
          </Notice>
        )}
        {result ? (
          <>
            <Notice tone="success">
              {result.status === "posted"
                ? "تم تحويل النقاط إلى حساب الموظف وحفظ القيد المحاسبي."
                : result.status === "pending"
                  ? "أُرسل طلب التحويل وحُجزت نقاطه حتى قرار الإدارة."
                  : result.status === "rejected"
                    ? "رُفض طلب التحويل وأُعيدت نقاطه إلى الرصيد المتاح."
                    : "أُلغي طلب التحويل وأُعيدت نقاطه إلى الرصيد المتاح."}
            </Notice>
            <Field label="رقم طلب التحويل" value={`#${result.id}`} readOnly />
            <Field label="النقاط" value={pointValue(result.points)} readOnly />
            <Field
              label="المبلغ"
              value={`${formatMoney(result.amount)} ${result.currencyCode}`}
              readOnly
            />
            <Field
              label="الحساب"
              value={`${result.accountCode} — ${result.accountName}`}
              readOnly
            />
            {result.financialDocumentId !== null && canViewJournal && (
              <Link
                to={`/companies/${companyId}/financial-documents/${result.financialDocumentId}`}
              >
                فتح القيد{" "}
                {result.financialDocumentNumber ??
                  `#${result.financialDocumentId}`}
              </Link>
            )}
            <Link to={`/companies/${companyId}/wallet-conversions`}>
              متابعة طلبات التحويل
            </Link>
          </>
        ) : (
          preview && (
            <>
              <Field
                label="الرصيد المتاح (ريال يمني)"
                value={pointValue(preview.points)}
                readOnly
              />
              <Field
                label="وحدة الرصيد الثابتة"
                value={
                  preview.pointValue !== null
                    ? "1 نقطة = 1 ريال يمني"
                    : "غير متاح"
                }
                readOnly
              />
              <Field
                label="مبلغ التحويل المتوقع"
                value={
                  preview.amount !== null
                    ? `${formatMoney(preview.amount)} ${preview.currency?.code ?? ""}`.trim()
                    : "الإعدادات غير مكتملة"
                }
                readOnly
              />
              <Field
                label="حساب الموظف"
                value={
                  preview.account
                    ? `${preview.account.code} — ${preview.account.name}`
                    : "لا يوجد حساب مرتبط"
                }
                readOnly
              />
              <Field
                label="طريقة الاعتماد"
                value={
                  preview.approvalMode === "approval"
                    ? "يتطلب اعتماد الإدارة"
                    : preview.approvalMode === "direct"
                      ? "تحويل مباشر"
                      : "لم تحدد بعد"
                }
                readOnly
              />
              {preview.unavailableReason && (
                <Notice tone="warning">{preview.unavailableReason}</Notice>
              )}
              {canRequest && (draft || preview.canConvert) && (
                <Notice tone="warning">
                  {preview.approvalMode === "approval"
                    ? "سيُحجز كامل الرصيد المعروض حتى اعتماد الإدارة أو رفض الطلب أو إلغائه."
                    : "سيُخصم كامل الرصيد المعروض ويُسجل المبلغ في حسابك. هذه العملية ليست سند صرف نقدي."}
                </Notice>
              )}
              {!canRequest && preview.canConvert && (
                <Notice>طلب التحويل متاح للموظف من محفظته الشخصية.</Notice>
              )}
            </>
          )
        )}
        <div className="form-actions">
          {!result && (draft || (canRequest && preview?.canConvert)) && (
            <Button
              onClick={() => void convert()}
              disabled={saving || (!draft && query.isFetching)}
            >
              {saving
                ? "جارٍ تأكيد التحويل…"
                : draft
                  ? "إعادة تأكيد الطلب"
                  : preview?.approvalMode === "approval"
                    ? "إرسال طلب الاعتماد"
                    : "تأكيد تحويل النقاط"}
            </Button>
          )}
          <Button variant="secondary" disabled={saving} onClick={onClose}>
            إغلاق
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function RewardTasksPage({ context }: { context: CompanyContext }) {
  const companyId = context.company.id,
    scope = `company:${companyId}`,
    base = `/companies/${companyId}`;
  const { user } = useSession(),
    client = useQueryClient(),
    guard = useScopeGuard(`${scope}:reward-tasks`);
  const query = useQuery({
    queryKey: ["reward-tasks", user?.id, companyId],
    queryFn: ({ signal }) =>
      api<RewardTaskDirectory>(`${base}/reward-tasks`, { signal }),
    enabled: !!user,
  });
  const directory = usePageDirectory(companyId);
  const canEdit = !!directory.data?.find(
    (entry) => entry.key === "company.reward-tasks",
  )?.actionAccess.edit;
  const [search, setSearch] = useState(""),
    [draft, setDraft] = useState<RewardTask | null>(null),
    [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const filtered = (query.data?.tasks ?? []).filter((task) =>
    [task.name, task.code, task.description]
      .join(" ")
      .toLocaleLowerCase("ar")
      .includes(search.toLocaleLowerCase("ar")),
  );
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || pending) return;
    const {
      points,
      repeatRule,
      enabled,
      roleIds,
      pageKey,
      dailyLimit,
      revision,
    } = draft;
    const parsed = rewardTaskSettingsSchema.safeParse({
      points,
      repeatRule,
      enabled,
      roleIds,
      pageKey,
      dailyLimit,
      revision,
    });
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join(" · "));
      return;
    }
    setPending(true);
    setError("");
    setNotice("");
    try {
      await api(`${base}/reward-tasks/${encodeURIComponent(draft.code)}`, {
        method: "PUT",
        body: parsed.data,
        signal: guard.signal,
      });
      if (!guard.isCurrent()) return;
      await client.invalidateQueries({
        queryKey: ["reward-tasks", user?.id, companyId],
      });
      if (guard.isCurrent()) {
        setDraft(null);
        setNotice("تم حفظ إعدادات كرت المهمة.");
      }
    } catch (cause) {
      if (guard.isCurrent()) setError(errorMessage(cause));
    } finally {
      if (guard.isCurrent()) setPending(false);
    }
  }
  return (
    <div className="wallet-page">
      <PageHeader
        title="مهام المكافآت"
        description="تعريف المكافآت وقواعد الاستحقاق والأدوار المستفيدة."
        actions={
          <Link to={`${base}/wallet`} className="button button-secondary">
            <Coins size={15} />
            النقاط والمحفظة
          </Link>
        }
      />
      <Notice>
        مكافآت حفظ فواتير المبيعات والمشتريات وسطورها متاحة للتفعيل الآن من
        كروتها؛ ولا تُمنح أي نقاط تلقائيًا قبل تفعيل المهمة. يمكن جمع مكافأة
        الفاتورة مع مكافأة السطور: مثلًا 5 نقاط لحفظ فاتورة مبيعات + نقطتين لكل
        سطر منطقي من ثلاثة سطور = 11 نقطة. تكرار نفس الصنف والوحدة والسعر وتاريخ
        الصلاحية لا يضاعف عدد السطور المستحقة، والمردودات تُحسب أيضًا. يمكن كذلك
        تفعيل نقاط طلب طباعة سند القبض أو الصرف المرحّل مرة لكل سند ولكل موظف؛
        ولا يعد الطلب إثباتًا لخروج الورقة. مهمة زيارة صفحات الشركة متاحة
        للتفعيل كذلك، ويُحدد كرتها الصفحة وقاعدة التكرار وسقف اليوم. مكافأة دخول
        الشركة متاحة للتفعيل، وتُمنح للموظف مرة في اليوم بحسب توقيت عدن عند فتح
        نطاق شركته.
      </Notice>
      {notice && <Notice tone="success">{notice}</Notice>}
      {query.error && (
        <Notice tone="error">
          {errorMessage(query.error)}{" "}
          <Button variant="ghost" onClick={() => void query.refetch()}>
            إعادة المحاولة
          </Button>
        </Notice>
      )}
      <Card>
        <Field
          label="بحث في المهام"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="الاسم أو الكود أو الوصف"
        />
        <div className="table-scroll">
          <table aria-label="مهام المكافآت">
            <thead>
              <tr>
                <th>المهمة</th>
                <th>النقاط</th>
                <th>الاستحقاق</th>
                <th>الحالة</th>
                <th>الإجراء</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((task) => (
                <tr key={task.code}>
                  <td title={task.description}>{task.name}</td>
                  <td>
                    <bdi>{pointValue(task.points)}</bdi>
                  </td>
                  <td>{repeatLabels[task.repeatRule]}</td>
                  <td>
                    {task.implemented
                      ? task.enabled
                        ? "مفعّلة"
                        : "موقوفة"
                      : "مخططة"}
                  </td>
                  <td>
                    {canEdit && (
                      <Button
                        variant="ghost"
                        size="compact"
                        onClick={() => {
                          setError("");
                          setDraft({
                            ...task,
                            repeatRule:
                              task.code === "DAILY_LOGIN"
                                ? "daily"
                                : invoiceTasks.has(task.code) ||
                                    task.code === "RECEIPT_PRINT" ||
                                    task.code === "PAYMENT_PRINT"
                                  ? "per-document"
                                  : task.repeatRule,
                            roleIds: [...task.roleIds],
                          });
                        }}
                      >
                        تعديل الكرت
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!query.data && !query.error && <Notice>جارٍ تحميل المهام…</Notice>}
        {query.data && !filtered.length && (
          <Notice>لا توجد مهام مطابقة للبحث.</Notice>
        )}
      </Card>
      <Dialog
        open={!!draft}
        title="كرت مهمة المكافأة"
        onClose={() => {
          if (!pending) setDraft(null);
        }}
      >
        {draft && (
          <form className="form-stack" onSubmit={save}>
            <div>
              <h3>{draft.name}</h3>
              <p>{draft.description}</p>
              <bdi>{draft.code}</bdi>
            </div>
            {error && <Notice tone="error">{error}</Notice>}
            {!draft.implemented && (
              <Notice>
                هذه المهمة مخططة. حفظ إعداداتها لا يمنح نقاطًا تلقائية؛ تفعيلها
                يتاح بعد ربط الحدث.
              </Notice>
            )}
            <div className="form-grid">
              <Field
                label="قيمة المكافأة بالنقاط"
                required
                inputMode="numeric"
                pattern="0|[1-9][0-9]*"
                maxLength={18}
                disabled={pending}
                value={draft.points}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    points: normalizePoints(event.target.value),
                  })
                }
              />
              <Select
                label="قاعدة الاستحقاق"
                disabled={
                  pending ||
                  invoiceTasks.has(draft.code) ||
                  draft.code === "RECEIPT_PRINT" ||
                  draft.code === "PAYMENT_PRINT" ||
                  draft.code === "DAILY_LOGIN"
                }
                value={draft.repeatRule}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    repeatRule: event.target.value as RewardRepeatRule,
                  })
                }
              >
                {Object.entries(repeatLabels)
                  .filter(
                    ([key]) =>
                      draft.code !== "PAGE_VISIT" || key !== "per-document",
                  )
                  .map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
              </Select>
            </div>
            {invoiceTasks.has(draft.code) && (
              <Notice>
                تُحتسب هذه المهمة مرة لكل فاتورة جديدة بعد ترحيلها، ولا تتكرر
                عند إعادة فتحها أو إرسال الطلب ذاته. يمكن تفعيل مكافأة حفظ
                الفاتورة ومكافأة سطورها معًا؛ النقاط المحددة هنا للسطور هي لكل
                سطر منطقي.
              </Notice>
            )}
            {(draft.code === "RECEIPT_PRINT" ||
              draft.code === "PAYMENT_PRINT") && (
              <Notice>
                تُحتسب المكافأة عند طلب فتح طباعة سند مرحّل، مرة واحدة لكل سند
                ولكل موظف مؤهل. لا يؤكد النظام أن الورقة خرجت من الطابعة.
              </Notice>
            )}
            {draft.code === "DAILY_LOGIN" && (
              <Notice>
                تُحتسب مرة واحدة لكل موظف عند دخول هذه الشركة في يوم عدن، ولا
                تتكرر عند إعادة فتحها أو تحديثها. الدخول إلى الموقع العام وحده
                لا يمنح هذه المكافأة.
              </Notice>
            )}
            {draft.code === "PAGE_VISIT" && (
              <Select
                label="الصفحة المرتبطة"
                value={draft.pageKey ?? ""}
                disabled={pending}
                onChange={(event) =>
                  setDraft({ ...draft, pageKey: event.target.value || null })
                }
              >
                <option value="">اختر الصفحة</option>
                {query.data?.pages.map((page) => (
                  <option key={page.key} value={page.key}>
                    {page.name}
                  </option>
                ))}
              </Select>
            )}
            {draft.code === "PAGE_VISIT" && (
              <Notice>
                تُحتسب الزيارة عند فتح المستخدم صفحة شركة مصرحًا له بها، وليس
                عند تحديث بياناتها في الخلفية. الاستحقاق لكل موظف ومهمة وشركة
                وفق يوم عدن، أو سبعة أيام كاملة، أو أحداث الانتقال المختلفة.
              </Notice>
            )}
            {draft.code === "PAGE_VISIT" &&
              draft.repeatRule === "unlimited" && (
                <Field
                  label="الحد الأقصى للمكافآت يوميًا (الافتراضي 100)"
                  type="number"
                  min={1}
                  max={10000}
                  disabled={pending}
                  value={draft.dailyLimit ?? ""}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      dailyLimit:
                        event.target.value === ""
                          ? null
                          : Number(event.target.value),
                    })
                  }
                />
              )}
            <fieldset className="notification-recipients">
              <legend>الأدوار المستفيدة</legend>
              <p className="muted">
                ترك الأدوار فارغة يعني جميع الموظفين المؤهلين عند تفعيل المهمة.
              </p>
              {query.data?.roles.map((role) => (
                <label key={role.id} className="notification-checkbox">
                  <input
                    type="checkbox"
                    disabled={pending}
                    checked={draft.roleIds.includes(role.id)}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        roleIds: event.target.checked
                          ? [...draft.roleIds, role.id]
                          : draft.roleIds.filter((id) => id !== role.id),
                      })
                    }
                  />
                  <span>{role.name}</span>
                </label>
              ))}
            </fieldset>
            <label className="notification-checkbox">
              <input
                type="checkbox"
                checked={draft.enabled}
                disabled={pending || !draft.implemented}
                onChange={(event) =>
                  setDraft({ ...draft, enabled: event.target.checked })
                }
              />
              <span>تفعيل المهمة</span>
            </label>
            <div className="form-actions">
              <Button type="submit" disabled={pending}>
                {pending ? "جارٍ الحفظ…" : "حفظ الكرت"}
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
    </div>
  );
}
