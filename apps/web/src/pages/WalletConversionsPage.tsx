import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Coins, RefreshCw } from "lucide-react";
import {
  walletConversionDecisionSchema,
  type CompanyContext,
  type WalletConversion,
  type WalletConversionDirectory,
} from "../../../../packages/contracts/src/index";
import {
  ApiFailure,
  api,
  usePagedQuery,
  useScopeGuard,
  useSession,
} from "../api";
import { usePageDirectory } from "../page-directory";
import { errorMessage } from "../phase2";
import { formatMoney } from "../format-money";
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

const statusLabels: Record<WalletConversion["status"], string> = {
  pending: "بانتظار الاعتماد",
  posted: "مُرحّل إلى الحساب",
  rejected: "مرفوض",
  cancelled: "ملغي من الموظف",
};
const actionLabels = {
  approve: "اعتماد التحويل",
  reject: "رفض الطلب",
  cancel: "إلغاء طلب التحويل",
};
type DecisionAction = keyof typeof actionLabels;
type DecisionDraft = {
  conversion: WalletConversion;
  action: DecisionAction;
  payload: { revision: number; reason: string; idempotencyKey: string };
  submitted: boolean;
};
const pointsText = (value: string) => BigInt(value).toLocaleString("ar-YE");
const time = (value: string) =>
  new Intl.DateTimeFormat("ar-YE", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Aden",
  }).format(new Date(value));

export function refreshWalletConversions(
  client: QueryClient,
  userId: number | undefined,
  companyId: number,
  posted = false,
) {
  const scopes = new Set([
    `company:${companyId}:wallet`,
    `company:${companyId}:wallet-conversions`,
  ]);
  return client.invalidateQueries({
    predicate: ({ queryKey }) =>
      queryKey[1] === userId &&
      ((queryKey[0] === "list" &&
        (scopes.has(String(queryKey[2])) ||
          (posted &&
            String(queryKey[2]).startsWith(
              `company:${companyId}:finance:`,
            )))) ||
        (["wallet-summary", "wallet-conversion-preview"].includes(
          String(queryKey[0]),
        ) &&
          queryKey[2] === companyId) ||
        (posted && queryKey[0] === "finance" && queryKey[2] === companyId)),
  });
}

export function WalletConversionsPage({
  context,
}: {
  context: CompanyContext;
}) {
  const { user } = useSession();
  return (
    <WalletConversionsContent
      key={`${user?.id}:${context.company.id}`}
      context={context}
    />
  );
}

function WalletConversionsContent({ context }: { context: CompanyContext }) {
  const companyId = context.company.id,
    base = `/companies/${companyId}`,
    scope = `company:${companyId}:wallet-conversions`;
  const { user } = useSession(),
    client = useQueryClient(),
    guard = useScopeGuard(scope);
  const [params, setParams] = useSearchParams();
  const filters = new URLSearchParams();
  if (params.get("status")) filters.set("status", params.get("status")!);
  const list = usePagedQuery<WalletConversion, WalletConversionDirectory>(
    `${base}/wallet-conversions?${filters}`,
    scope,
    "createdAt:desc,id:desc",
  );
  const directory = usePageDirectory(companyId);
  const page = directory.data?.find(
    (entry) => entry.key === "company.wallet-conversions",
  );
  const walletPage = directory.data?.find(
    (entry) => entry.key === "company.wallet",
  );
  const canManage =
    !!list.data?.canManage && !!page?.enabled && !!page.actionAccess.post;
  const canCancel = !!page?.enabled && !!page.actionAccess.edit;
  const canViewJournal = !!directory.data?.find(
    (entry) => entry.key === "company.financial-document" && entry.enabled,
  )?.actionAccess.view;
  const [selected, setSelected] = useState<WalletConversion | null>(null),
    [decision, setDecision] = useState<DecisionDraft | null>(null),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const decisionKey = (id: number) => [
    "wallet-conversion-decision",
    user?.id,
    companyId,
    id,
  ];
  function open(conversion: WalletConversion) {
    const cached = client.getQueryData<DecisionDraft>(
      decisionKey(conversion.id),
    );
    setSelected(conversion);
    setDecision(cached ?? null);
    setError("");
  }
  function choose(action: DecisionAction) {
    if (!selected || saving) return;
    setError("");
    setDecision({
      conversion: selected,
      action,
      payload: {
        revision: selected.revision,
        reason: "",
        idempotencyKey: crypto.randomUUID(),
      },
      submitted: false,
    });
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving || !decision || !selected) return;
    const allowed =
      decision.action === "cancel"
        ? canCancel && decision.conversion.employeeId === context.employee?.id
        : canManage;
    if (!allowed && !decision.submitted) return;
    const parsed = walletConversionDecisionSchema.safeParse(decision.payload);
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join(" · "));
      return;
    }
    const frozen: DecisionDraft = {
      ...decision,
      payload: parsed.data,
      submitted: true,
    };
    const key = decisionKey(frozen.conversion.id);
    client.setQueryDefaults(["wallet-conversion-decision"], {
      gcTime: Infinity,
    });
    client.setQueryData(key, frozen);
    setDecision(frozen);
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await api<{ conversion: WalletConversion }>(
        `${base}/wallet-conversions/${frozen.conversion.id}/${frozen.action}`,
        { method: "POST", body: frozen.payload, signal: guard.signal },
      );
      if (!guard.isCurrent()) return;
      client.removeQueries({ queryKey: key, exact: true });
      setDecision(null);
      setSelected(response.conversion);
      setNotice(
        frozen.action === "approve"
          ? "تم اعتماد التحويل وترحيل المبلغ إلى حساب الموظف."
          : frozen.action === "reject"
            ? "رُفض طلب التحويل وأُعيدت النقاط المحجوزة إلى الرصيد المتاح."
            : "أُلغي الطلب وأُعيدت النقاط المحجوزة إلى الرصيد المتاح.",
      );
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
        !decision.submitted
      ) {
        client.removeQueries({ queryKey: key, exact: true });
        setDecision(null);
        const fresh = await list.refetch();
        const record = fresh.data?.items.find(
          (item) => item.id === frozen.conversion.id,
        );
        if (guard.isCurrent() && record) setSelected(record);
      }
    } finally {
      if (guard.isCurrent()) setSaving(false);
    }
  }
  const columns: ColumnDef<WalletConversion, unknown>[] = [
    {
      accessorKey: "id",
      header: "الطلب",
      size: 85,
      cell: ({ row }) => `#${row.original.id}`,
    },
    {
      accessorKey: "createdAt",
      header: "الوقت",
      size: 160,
      cell: ({ row }) => time(row.original.createdAt),
    },
    { accessorKey: "employeeName", header: "الموظف", size: 150 },
    {
      accessorKey: "points",
      header: "النقاط",
      size: 100,
      cell: ({ row }) => <bdi>{pointsText(row.original.points)}</bdi>,
    },
    {
      accessorKey: "amount",
      header: "المبلغ",
      size: 135,
      cell: ({ row }) => (
        <bdi>
          {formatMoney(row.original.amount)} {row.original.currencyCode}
        </bdi>
      ),
    },
    {
      accessorKey: "status",
      header: "الحالة",
      size: 150,
      cell: ({ row }) => statusLabels[row.original.status],
    },
    {
      id: "reference",
      header: "القيد",
      size: 125,
      enableSorting: false,
      cell: ({ row }) =>
        row.original.financialDocumentId !== null ? (
          canViewJournal ? (
            <Link
              to={`${base}/financial-documents/${row.original.financialDocumentId}`}
            >
              {row.original.financialDocumentNumber ??
                `#${row.original.financialDocumentId}`}
            </Link>
          ) : (
            (row.original.financialDocumentNumber ??
            `#${row.original.financialDocumentId}`)
          )
        ) : (
          "—"
        ),
    },
    {
      id: "actions",
      header: "الإجراء",
      size: 130,
      enableSorting: false,
      cell: ({ row }) => (
        <Button
          variant="ghost"
          size="compact"
          disabled={saving}
          onClick={() => open(row.original)}
        >
          عرض ومتابعة
        </Button>
      ),
    },
  ];
  return (
    <div className="wallet-page">
      <PageHeader
        title="تحويلات النقاط"
        description="طلبات تحويل النقاط وسجل اعتمادها وترحيلها إلى الحسابات."
        actions={
          <>
            {walletPage?.enabled && walletPage.actionAccess.view && (
              <Link to={`${base}/wallet`} className="button button-secondary">
                <Coins size={15} />
                النقاط والمحفظة
              </Link>
            )}
            <Button
              variant="ghost"
              disabled={list.loading || saving}
              onClick={() =>
                void refreshWalletConversions(client, user?.id, companyId)
              }
            >
              <RefreshCw size={15} />
              تحديث
            </Button>
          </>
        }
      />
      <Notice>
        اعتماد التحويل يثبت مستحقًا في حساب الموظف ولا يعني صرف مبلغ نقدي.
        السداد الفعلي يحتاج سند صرف منفصلًا وترحيلًا بصلاحية مالية،
        ولا تُنشأ أي عمولة تصريف أو دفعة رواتب تلقائيًا.
      </Notice>
      {notice && <Notice tone="success">{notice}</Notice>}
      {list.error && (
        <Notice tone="error">
          {errorMessage(list.error)}{" "}
          <Button variant="ghost" onClick={() => void list.refetch()}>
            إعادة المحاولة
          </Button>
        </Notice>
      )}
      <Card
        title={
          list.data?.canManage ? "طلبات الموظفين" : "طلبات التحويل الخاصة بي"
        }
      >
        <div className="wallet-filters">
          <Field
            label="بحث في التحويلات"
            type="search"
            value={list.query}
            onChange={(event) => list.setQuery(event.target.value)}
            placeholder="الموظف أو الحساب أو سبب القرار"
          />
          <Select
            label="الحالة"
            value={params.get("status") ?? ""}
            onChange={(event) =>
              setParams((previous) => {
                const next = new URLSearchParams(previous);
                event.target.value
                  ? next.set("status", event.target.value)
                  : next.delete("status");
                next.delete("page");
                return next;
              })
            }
          >
            <option value="">جميع الحالات</option>
            {Object.entries(statusLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
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
          ariaLabel="سجل تحويلات النقاط"
        />
      </Card>
      <Dialog
        open={!!selected}
        title={`طلب التحويل #${selected?.id ?? ""}`}
        onClose={() => {
          if (!saving) {
            setSelected(null);
            setDecision(null);
            setError("");
          }
        }}
      >
        {selected && (
          <div className="form-stack">
            <div className="form-grid">
              <Field label="الموظف" value={selected.employeeName} readOnly />
              <Field
                label="الحالة"
                value={statusLabels[selected.status]}
                readOnly
              />
              <Field
                label="النقاط"
                value={pointsText(selected.points)}
                readOnly
              />
              <Field
                label="قيمة النقطة وقت الطلب"
                value={`${selected.pointValue} ${selected.currencyCode}`}
                readOnly
              />
              <Field
                label="المبلغ"
                value={`${formatMoney(selected.amount)} ${selected.currencyCode}`}
                readOnly
              />
              <Field
                label="وقت الطلب"
                value={time(selected.createdAt)}
                readOnly
              />
              <Field
                label="حساب الموظف"
                value={`${selected.accountCode} — ${selected.accountName}`}
                readOnly
              />
              <Field
                label="حساب المصروف"
                value={`${selected.expenseAccountCode} — ${selected.expenseAccountName}`}
                readOnly
              />
            </div>
            {selected.financialDocumentId !== null && canViewJournal && (
              <Link
                to={`${base}/financial-documents/${selected.financialDocumentId}`}
              >
                فتح القيد{" "}
                {selected.financialDocumentNumber ??
                  `#${selected.financialDocumentId}`}
              </Link>
            )}
            {selected.decidedAt && (
              <Notice>
                {selected.decidedByName} — {time(selected.decidedAt)}
                {selected.decisionReason && <p>{selected.decisionReason}</p>}
              </Notice>
            )}
            {error && <Notice tone="error">{error}</Notice>}
            {decision ? (
              <form className="form-stack" onSubmit={save}>
                <Notice tone="warning">
                  {decision.submitted && !saving
                    ? "لم نتأكد من نتيجة القرار. أعد تأكيد القرار نفسه دون تغيير بياناته."
                    : decision.action === "approve"
                      ? "سيُرحّل المبلغ والحسابات المحفوظة وقت الطلب، وتُخصم نقاطه المحجوزة."
                      : "ستعود النقاط المحجوزة إلى الرصيد المتاح دون إنشاء قيد محاسبي."}
                </Notice>
                <Field
                  label="سبب القرار"
                  required
                  maxLength={500}
                  value={decision.payload.reason}
                  disabled={saving || decision.submitted}
                  onChange={(event) =>
                    setDecision({
                      ...decision,
                      payload: {
                        ...decision.payload,
                        reason: event.target.value,
                      },
                    })
                  }
                />
                <div className="form-actions">
                  <Button type="submit" disabled={saving}>
                    {saving
                      ? "جارٍ تأكيد القرار…"
                      : decision.submitted
                        ? "إعادة تأكيد القرار"
                        : actionLabels[decision.action]}
                  </Button>
                  {!decision.submitted && (
                    <Button
                      variant="secondary"
                      disabled={saving}
                      onClick={() => setDecision(null)}
                    >
                      رجوع
                    </Button>
                  )}
                </div>
              </form>
            ) : (
              selected.status === "pending" && (
                <div className="form-actions">
                  {canManage && (
                    <>
                      {selected.employeeId !== context.employee?.id && (
                        <Button onClick={() => choose("approve")}>
                          اعتماد التحويل
                        </Button>
                      )}
                      <Button
                        variant="secondary"
                        onClick={() => choose("reject")}
                      >
                        رفض الطلب
                      </Button>
                    </>
                  )}
                  {canCancel &&
                    selected.employeeId === context.employee?.id && (
                      <Button
                        variant="secondary"
                        onClick={() => choose("cancel")}
                      >
                        إلغاء طلبي
                      </Button>
                    )}
                </div>
              )
            )}
            <div className="form-actions">
              <Button
                variant="secondary"
                disabled={saving}
                onClick={() => {
                  setSelected(null);
                  setDecision(null);
                  setError("");
                }}
              >
                إغلاق
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
