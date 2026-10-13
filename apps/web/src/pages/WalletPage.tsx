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
  type RewardTask,
  type RewardTaskDirectory,
  type RewardRepeatRule,
} from "../../../../packages/contracts/src/index";
import { api, usePagedQuery, useScopeGuard, useSession } from "../api";
import { errorMessage } from "../phase2";
import { usePageDirectory } from "../page-directory";
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
  const filters = new URLSearchParams();
  if (params.get("employeeId"))
    filters.set("employeeId", params.get("employeeId")!);
  const list = usePagedQuery<WalletEntry, WalletDirectory>(
    `${base}/wallet?${filters}`,
    scope,
    "createdAt:desc,id:desc",
  );
  const directory = usePageDirectory(companyId);
  const walletPage = directory.data?.find(
    (entry) => entry.key === "company.wallet",
  );
  const tasksPage = directory.data?.find(
    (entry) => entry.key === "company.reward-tasks",
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
  const [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  async function refresh() {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["list", user?.id, scope] }),
      client.invalidateQueries({
        queryKey: ["wallet-summary", user?.id, companyId],
      }),
    ]);
  }
  function changeEmployee(value: string) {
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
            ? "تمت إضافة النقاط وحفظها في السجل."
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
          : row.original.kind === "automatic"
            ? (automaticLabels[row.original.taskCode ?? ""] ?? "مكافأة آلية")
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
            سند #{row.original.financialDocumentId}
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
        description="رصيد الموظف وسجل المكافآت الآلية والإضافات الإدارية والتصحيحات داخل الشركة."
        actions={
          <>
            {tasksPage?.enabled && tasksPage.actionAccess.view && (
              <Link
                to={`${base}/reward-tasks`}
                className="button button-secondary"
              >
                <Settings2 size={15} />
                مهام المكافآت
              </Link>
            )}
            {canAward && (
              <Button
                onClick={openAward}
                disabled={pending || !list.data?.employees.length}
              >
                <Plus size={15} />
                إضافة نقاط
              </Button>
            )}
            <Button
              variant="ghost"
              onClick={() => void refresh()}
              disabled={list.loading}
            >
              <RefreshCw size={15} />
              تحديث
            </Button>
          </>
        }
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
          <Card title="النقاط المتاحة" description={wallet.employeeName}>
            <strong
              className="wallet-balance"
              data-wallet-points={wallet.points}
            >
              <bdi>{pointValue(wallet.points)}</bdi>
            </strong>
            <span> نقطة</span>
          </Card>
          <Card
            title="الرصيد المالي"
            description="المكافآت المالية والتحويل لم يُفعّلا بعد."
          >
            <strong className="wallet-balance">
              <bdi>
                {wallet.money} {wallet.currencyCode}
              </bdi>
            </strong>
          </Card>
        </div>
      )}
      {list.data && !wallet && (
        <Notice>
          لا توجد محفظة موظف لعرضها. أضف موظفًا مرتبطًا بمستخدم داخل الشركة
          أولًا.
        </Notice>
      )}
      <Card title="سجل النقاط والمحفظة">
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
                pattern="[1-9][0-9]*"
                maxLength={18}
                value={award.points}
                disabled={pending}
                onChange={(event) =>
                  setAward({
                    ...award,
                    points: normalizePoints(event.target.value),
                  })
                }
              />
              <Field
                label="سبب الإضافة"
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
              {pending ? "جارٍ الحفظ…" : award ? "إضافة النقاط" : "تأكيد العكس"}
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
    </div>
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
