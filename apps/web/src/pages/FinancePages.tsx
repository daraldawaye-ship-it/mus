import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Link,
  useNavigate,
  useBlocker,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Plus, Printer, Trash2 } from "lucide-react";
import {
  documentKindLabels,
  documentStatusLabels,
  documentKinds,
  documentStatuses,
  financialDocumentSchema,
  financialDocumentPatchSchema,
  normalizeDigits,
  type Account,
  type AccountBalance,
  type AccountLedgerLine,
  type AccountLedgerTotals,
  type Branch,
  type CompanyContext,
  type CompanyCurrency,
  type FinancialDocument,
  type FinancialDocumentKind,
  type FinancialDocumentInput,
  type Page,
} from "../../../../packages/contracts/src/index";
import {
  api,
  ApiFailure,
  usePagedQuery,
  useScopeGuard,
  useSession,
} from "../api";
import { errorMessage, ServerLookup, useDefaultYerCurrency } from "../phase2";
import { useControls } from "../control";
import { formatMoney } from "../format-money";
import { CompanyPrintHeader } from "../CompanyPrintHeader";
import { useEmployeeCashbox } from "../employee-cashbox";
import { queueOfflineOperation } from "../offline-storage";
import {
  Button,
  Card,
  DataTable,
  Dialog,
  Field,
  Notice,
  PageHeader,
  Select,
  ValueCell,
} from "../ui";

export function financeAccess(
  context: CompanyContext,
  action: "view" | "manage" | "post" = "view",
) {
  return (
    context.general ||
    context.permissions.some(
      (permission) =>
        permission === `finance.${action}` ||
        (action === "view" &&
          (permission === "finance.manage" || permission === "finance.post")),
    )
  );
}
const documentPath = (companyId: number, id: number | "new") =>
  `/companies/${companyId}/financial-documents/${id}`;
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Aden" });
const listPaths: Record<FinancialDocumentKind, string> = {
  journal: "journals",
  receipt: "receipts",
  payment: "payments",
};
const listTitles: Record<FinancialDocumentKind, string> = {
  journal: "قيود اليومية",
  receipt: "سندات القبض",
  payment: "سندات الصرف",
};
const accountLabel = (account: { code: string; name: string }) =>
  `${account.code} — ${account.name}`;
const money = (value: string | null) => (
  <bdi className="financial-number">{formatMoney(value)}</bdi>
);

// Six decimal places match the amount contract; arithmetic never uses Number.
function exactUnits(value: string): bigint | null {
  const normalized = normalizeDigits(value.trim()).replace(/٫/g, ".");
  if (!/^\d{1,22}(?:\.\d{1,6})?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}
function exactText(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const fraction = String(absolute % 1_000_000n)
    .padStart(6, "0")
    .replace(/0+$/, "");
  return `${sign}${absolute / 1_000_000n}${fraction ? `.${fraction}` : ""}`;
}
function balanceText(value: string) {
  if (/^-?0(?:\.0+)?$/.test(value)) return "0";
  return value.startsWith("-") ? `${formatMoney(value.slice(1))} دائن` : `${formatMoney(value)} مدين`;
}
function updateFilter(
  setParams: ReturnType<typeof useSearchParams>[1],
  key: string,
  value: string,
) {
  setParams((previous) => {
    const next = new URLSearchParams(previous);
    value ? next.set(key, value) : next.delete(key);
    next.delete("page");
    return next;
  });
}
function useFinanceChanges(companyId: number) {
  const client = useQueryClient();
  const { user } = useSession();
  return () =>
    client.invalidateQueries({
      predicate: ({ queryKey }) =>
        queryKey[1] === user?.id &&
        ((queryKey[0] === "finance" && queryKey[2] === companyId) ||
          (queryKey[0] === "list" &&
            String(queryKey[2]).startsWith(`company:${companyId}:`))),
    });
}

export function FinancialDocumentsPage({
  context,
  kind,
}: {
  context: CompanyContext;
  kind?: FinancialDocumentKind;
}) {
  if (!financeAccess(context))
    return (
      <Notice tone="warning">ليس لديك صلاحية عرض العمليات المالية.</Notice>
    );
  return <DocumentList context={context} kind={kind} />;
}
function DocumentList({
  context,
  kind,
}: {
  context: CompanyContext;
  kind?: FinancialDocumentKind;
}) {
  const companyId = context.company.id;
  const [params, setParams] = useSearchParams();
  const filters = new URLSearchParams();
  if (kind) filters.set("kind", kind);
  else if (params.get("kind")) filters.set("kind", params.get("kind")!);
  for (const key of ["status", "dateFrom", "dateTo"])
    if (params.get(key)) filters.set(key, params.get(key)!);
  const list = usePagedQuery<FinancialDocument>(
    `/companies/${companyId}/financial-documents?${filters}`,
    `company:${companyId}:finance:${kind ?? "all"}`,
  );
  const columns = useMemo<ColumnDef<FinancialDocument, unknown>[]>(
    () => [
      {
        accessorKey: "number",
        header: "الرقم",
        size: 155,
        cell: ({ row }) => (
          <Link to={documentPath(companyId, row.original.id)}>
            {row.original.number}
          </Link>
        ),
      },
      { accessorKey: "documentDate", header: "التاريخ", size: 120 },
      ...(kind === "payment" ? [{
        accessorKey: "supplierReceiptNumber", header: "رقم الوصل", enableSorting: false, size: 145,
        cell: ({ row }) => <ValueCell>{row.original.supplierReceiptNumber || "—"}</ValueCell>,
      } satisfies ColumnDef<FinancialDocument, unknown>] : []),
      {
        accessorKey: "kind",
        header: "النوع",
        cell: ({ row }) => documentKindLabels[row.original.kind],
      },
      {
        accessorKey: "status",
        header: "الحالة",
        size: 100,
        cell: ({ row }) => (
          <span
            className={`financial-status financial-status-${row.original.status}`}
          >
            {documentStatusLabels[row.original.status]}
          </span>
        ),
      },
      {
        accessorKey: "currencyCode",
        header: "العملة",
        enableSorting: false,
        size: 85,
      },
      {
        accessorKey: "totalDebit",
        header: "المبلغ",
        size: 160,
        cell: ({ row }) => money(row.original.totalDebit),
      },
      {
        accessorKey: "description",
        header: "البيان",
        enableSorting: false,
        size: 230,
        cell: ({ row }) => (
          <ValueCell>{row.original.description || "—"}</ValueCell>
        ),
      },
      { accessorKey: "createdByName", header: "المنشئ", enableSorting: false },
      {
        id: "actions",
        header: "فتح",
        size: 75,
        enableSorting: false,
        cell: ({ row }) => (
          <Link to={documentPath(companyId, row.original.id)}>عرض</Link>
        ),
      },
    ],
    [companyId],
  );
  return (
    <>
      <PageHeader
        title={kind ? listTitles[kind] : "العمليات المالية"}
        description="المسودات لا تؤثر على الأرصدة؛ الترحيل يثبت الحركة والعكس يحفظ تاريخها."
        actions={
          financeAccess(context, "manage") && (
            <Link
              className="button button-primary"
              to={`${documentPath(companyId, "new")}?kind=${kind ?? "journal"}`}
            >
              <Plus size={16} />
              {kind ? `إضافة ${documentKindLabels[kind]}` : "إضافة مستند"}
            </Link>
          )
        }
      />
      <Card>
        <div className="table-filters">
          <Field
            label="بحث في المستندات"
            type="search"
            value={list.query}
            onChange={(event) => list.setQuery(event.target.value)}
            placeholder="الرقم أو البيان"
          />
          {!kind && (
            <Select
              label="نوع المستند"
              value={params.get("kind") ?? ""}
              onChange={(event) =>
                updateFilter(setParams, "kind", event.target.value)
              }
            >
              <option value="">كل الأنواع</option>
              {documentKinds.map((item) => (
                <option key={item} value={item}>
                  {documentKindLabels[item]}
                </option>
              ))}
            </Select>
          )}
          <Select
            label="حالة المستند"
            value={params.get("status") ?? ""}
            onChange={(event) =>
              updateFilter(setParams, "status", event.target.value)
            }
          >
            <option value="">كل الحالات</option>
            {documentStatuses.map((item) => (
              <option key={item} value={item}>
                {documentStatusLabels[item]}
              </option>
            ))}
          </Select>
          <Field
            label="من تاريخ"
            type="date"
            value={params.get("dateFrom") ?? ""}
            onChange={(event) =>
              updateFilter(setParams, "dateFrom", event.target.value)
            }
          />
          <Field
            label="إلى تاريخ"
            type="date"
            value={params.get("dateTo") ?? ""}
            onChange={(event) =>
              updateFilter(setParams, "dateTo", event.target.value)
            }
          />
        </div>
        {list.error && (
          <Notice tone="error">
            {errorMessage(list.error)}{" "}
            <Button variant="ghost" onClick={() => void list.refetch()}>
              إعادة المحاولة
            </Button>
          </Notice>
        )}
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
          ariaLabel={kind ? listTitles[kind] : "العمليات المالية"}
        />
      </Card>
    </>
  );
}

export function FinanceDocumentPage({ context }: { context: CompanyContext }) {
  const { documentId = "new" } = useParams();
  const [params] = useSearchParams();
  const kind = documentKinds.includes(
    params.get("kind") as FinancialDocumentKind,
  )
    ? (params.get("kind") as FinancialDocumentKind)
    : "journal";
  if (!financeAccess(context))
    return <Notice tone="warning">ليس لديك صلاحية عرض المستند المالي.</Notice>;
  if (documentId === "new" && !financeAccess(context, "manage"))
    return <Notice tone="warning">ليس لديك صلاحية إنشاء مستند مالي.</Notice>;
  return (
    <DocumentDetail
      key={`${context.company.id}:${documentId}:${kind}`}
      context={context}
      documentId={documentId}
      newKind={kind}
    />
  );
}
function DocumentDetail({
  context,
  documentId,
  newKind,
}: {
  context: CompanyContext;
  documentId: string;
  newKind: FinancialDocumentKind;
}) {
  const { user } = useSession();
  const companyId = context.company.id;
  const [notice, setNotice] = useState("");
  const [editorEpoch, setEditorEpoch] = useState(0);
  const client = useQueryClient();
  const queryKey = ["finance", user?.id, companyId, "document", documentId];
  const result = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      api<{ document: FinancialDocument }>(
        `/companies/${companyId}/financial-documents/${documentId}`,
        { signal },
      ),
    enabled: documentId !== "new",
    // Reopening obtains a fresh record; background focus must not replace edits.
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  if (documentId !== "new" && result.isPending)
    return <Notice>جارٍ تحميل المستند…</Notice>;
  if (result.error)
    return (
      <Card>
        <Notice tone="error">
          {errorMessage(result.error)}{" "}
          <Button variant="ghost" onClick={() => void result.refetch()}>
            إعادة المحاولة
          </Button>
        </Notice>
      </Card>
    );
  return (
    <>
      {notice && (
        <div className="financial-no-print">
          <Notice tone="success">{notice}</Notice>
        </div>
      )}
      <DocumentEditor
        key={
          result.data
            ? `${result.data.document.id}:${result.data.document.revision}:${result.data.document.status}:${editorEpoch}`
            : "new"
        }
        context={context}
        document={result.data?.document ?? null}
        newKind={newKind}
        onSaved={(document, message) => {
          client.setQueryData(queryKey, { document });
          setNotice(message);
          setEditorEpoch((value) => value + 1);
        }}
      />
    </>
  );
}

type PickAccount = Pick<Account, "id" | "code" | "name">;
type EditorStatus = { dirty: boolean; saving: boolean; unknownCreation: boolean };
type PickCurrency = Pick<
  CompanyCurrency,
  "id" | "code" | "name" | "decimalPlaces"
>;
type PickBranch = Pick<Branch, "id" | "code" | "name">;
type EditorLine = {
  key: string;
  account: PickAccount | null;
  debit: string;
  credit: string;
  description: string;
};
type Picker =
  | { type: "account"; row: number }
  | { type: "cash" }
  | { type: "counterparty" }
  | { type: "currency" }
  | { type: "branch" };
const emptyLine = (): EditorLine => ({
  key: crypto.randomUUID(),
  account: null,
  debit: "0",
  credit: "0",
  description: "",
});

function DocumentEditor({
  context,
  document,
  newKind,
  onSaved,
  embedded = false,
  lockedCashAccount,
  onEditorStateChange,
  onDismiss,
}: {
  context: CompanyContext;
  document: FinancialDocument | null;
  newKind: FinancialDocumentKind;
  onSaved: (document: FinancialDocument, message: string) => void;
  embedded?: boolean;
  lockedCashAccount?: PickAccount;
  onEditorStateChange?: (status: EditorStatus) => void;
  onDismiss?: () => void;
}) {
  const companyId = context.company.id;
  const queryClient = useQueryClient();
  const { user: sessionUser } = useSession();
  const navigate = useNavigate();
  const guard = useScopeGuard(
    `company:${companyId}:financial-document:${document?.id ?? "new"}`,
  );
  const changed = useFinanceChanges(companyId);
  const kind = document?.kind ?? newKind;
  const controls = useControls(companyId, context.employee?.id ?? null);
  const showCurrency = controls.value("show_currency") !== false;
  const editDateKey = kind === "receipt" ? "edit_receipts_date" : kind === "payment" ? "edit_payments_date" : "edit_journals_date";
  const allowDateEdit = controls.value(editDateKey) !== false;
  // Hide the field (rather than just disabling it) when the control forbids edits.
  const voucherDateVisible = controls.isSuccess && allowDateEdit;
  const showVoucherBranch = controls.value("show_voucher_branch") === true;
  const hasManageAccess =
    financeAccess(context, "manage") &&
    (!document || document.status === "draft");
  const [documentDate, setDate] = useState(document?.documentDate ?? today());
  const [description, setDescription] = useState(document?.description ?? "");
  const [supplierReceiptNumber, setSupplierReceiptNumber] = useState(document?.supplierReceiptNumber ?? "");
  const [currency, setCurrency] = useState<PickCurrency | null>(
    document
      ? {
          id: document.currencyId,
          code: document.currencyCode,
          name: document.currencyName,
          decimalPlaces: document.decimalPlaces,
        }
      : null,
  );
  const defaultYer = useDefaultYerCurrency(companyId, "financial-options");
  const currencyManuallyChosen = useRef(false);
  useEffect(() => {
    if (document || !defaultYer || currencyManuallyChosen.current) return;
    if (currency === null) setCurrency(defaultYer);
  }, [document, defaultYer, currency]);
  useEffect(() => {
    if (!document && !showCurrency && defaultYer && currency?.code !== "YER") {
      currencyManuallyChosen.current = false;
      setCurrency(defaultYer);
    }
  }, [document, showCurrency, defaultYer, currency]);
  const [branch, setBranch] = useState<PickBranch | null>(
    document?.branchId
      ? {
          id: document.branchId,
          code: "",
          name: document.branchName ?? "الفرع",
        }
      : null,
  );
  const [lines, setLines] = useState<EditorLine[]>(
    document?.lines.map((line) => ({
      key: String(line.id),
      account: {
        id: line.accountId,
        code: line.accountCode,
        name: line.accountName,
      },
      debit: line.debit,
      credit: line.credit,
      description: line.description,
    })) ?? [emptyLine(), emptyLine()],
  );
  const cashLine = document?.lines.find(
    (line) => line.accountId === document.cashAccountId,
  );
  const otherLine = document?.lines.find(
    (line) => line.accountId !== document.cashAccountId,
  );
  const defaultCashbox = useEmployeeCashbox(context);
  const cashManuallyChosen = useRef(false);
  const [cash, setCash] = useState<PickAccount | null>(
    lockedCashAccount ?? (cashLine
      ? {
          id: cashLine.accountId,
          code: cashLine.accountCode,
          name: cashLine.accountName,
        }
      : null),
  );
  useEffect(() => {
    if (
      document || kind === "journal" || !defaultCashbox ||
      cashManuallyChosen.current || cash
    ) return;
    setCash(defaultCashbox);
  }, [document, kind, defaultCashbox, cash]);
  const [counterparty, setCounterparty] = useState<PickAccount | null>(
    otherLine
      ? {
          id: otherLine.accountId,
          code: otherLine.accountCode,
          name: otherLine.accountName,
        }
      : null,
  );
  const [voucherAmount, setVoucherAmount] = useState(
    cashLine ? (kind === "receipt" ? cashLine.debit : cashLine.credit) : "",
  );
  const [counterpartyDescription, setCounterpartyDescription] = useState(
    otherLine?.description ?? "",
  );
  const [picker, setPicker] = useState<Picker | null>(null);
  const [saving, setSaving] = useState(false);
  const [unknownCreation, setUnknownCreation] = useState(false);
  const [localQueued, setLocalQueued] = useState(false);
  const [localMessage, setLocalMessage] = useState("");
  const submittedCreate = useRef<FinancialDocumentInput | null>(null);
  const canEdit = hasManageAccess && !unknownCreation && !localQueued;
  const allowNavigation = useRef(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState<
    "post" | "reverse" | "reload" | null
  >(null);
  const [reverseReason, setReverseReason] = useState("");
  const [reverseDate, setReverseDate] = useState(today());
  const [createKey] = useState(() => crypto.randomUUID());
  const [reverseKey] = useState(() => crypto.randomUUID());
  useEffect(() => {
    onEditorStateChange?.({ dirty, saving, unknownCreation });
  }, [dirty, saving, unknownCreation, onEditorStateChange]);
  useEffect(() => {
    if (!dirty && !saving && !unknownCreation) return;
    const leaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", leaving);
    return () => window.removeEventListener("beforeunload", leaving);
  }, [dirty, saving, unknownCreation]);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      !allowNavigation.current &&
      (dirty || saving || unknownCreation) &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search),
  );
  const totals = useMemo(() => {
    if (kind !== "journal") {
      const value = exactUnits(voucherAmount);
      return value === null ? null : { debit: value, credit: value };
    }
    let debit = 0n,
      credit = 0n;
    for (const line of lines) {
      const d = exactUnits(line.debit),
        c = exactUnits(line.credit);
      if (d === null || c === null) return null;
      debit += d;
      credit += c;
    }
    return { debit, credit };
  }, [kind, lines, voucherAmount]);
  const touch = () => setDirty(true);
  const editLine = (index: number, values: Partial<EditorLine>) => {
    touch();
    setLines((previous) =>
      previous.map((line, row) =>
        row === index ? { ...line, ...values } : line,
      ),
    );
  };
  const pickerDisabled = !canEdit || saving;
  const back = () => navigate(`/companies/${companyId}/${listPaths[kind]}`);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving || !hasManageAccess || localQueued) return;
    setError("");
    // The personal-cashbox modal cannot submit a different cash account.
    const effectiveCash = lockedCashAccount ?? cash;
    const voucherLines =
      effectiveCash && counterparty
        ? [
            {
              accountId: effectiveCash.id,
              debit: kind === "receipt" ? voucherAmount : "0",
              credit: kind === "payment" ? voucherAmount : "0",
              description,
            },
            {
              accountId: counterparty.id,
              debit: kind === "payment" ? voucherAmount : "0",
              credit: kind === "receipt" ? voucherAmount : "0",
              description: counterpartyDescription,
            },
          ]
        : [];
    const fields = {
      kind,
      documentDate,
      currencyId: currency?.id ?? 0,
      branchId: branch?.id ?? null,
      cashAccountId: kind === "journal" ? null : (effectiveCash?.id ?? null),
      supplierReceiptNumber: kind === "payment" ? supplierReceiptNumber : "",
      description,
      lines:
        kind === "journal"
          ? lines.map((line) => ({
              accountId: line.account?.id ?? 0,
              debit: line.debit,
              credit: line.credit,
              description: line.description,
            }))
          : voucherLines,
    };
    const parsed = document
      ? financialDocumentPatchSchema.safeParse({
          ...fields,
          revision: document.revision,
        })
      : financialDocumentSchema.safeParse(
          unknownCreation
            ? submittedCreate.current
            : {
                ...fields,
                idempotencyKey: createKey,
              },
        );
    if (!parsed.success) {
      setError(
        parsed.error.issues[0]?.message ?? "تحقق من الحسابات والمبالغ والعملة.",
      );
      return;
    }
    // Saving a journal draft does not require balance; posting validates it.
    if (!document)
      submittedCreate.current = parsed.data as FinancialDocumentInput;
    async function saveOnDevice(): Promise<boolean> {
      if (document || (kind !== "receipt" && kind !== "payment") || !sessionUser?.id) return false;
      try {
        await queueOfflineOperation(sessionUser.id, companyId, "voucher",
          "/companies/" + companyId + "/financial-documents",
          parsed.data as FinancialDocumentInput);
        setLocalQueued(true);
        setDirty(false);
        setUnknownCreation(false);
        setLocalMessage("تم حفظ مسودة السند محليًا فقط. لن تؤثر على الحسابات قبل المزامنة ثم الترحيل على الخادم.");
        return true;
      } catch (reason) {
        setError("تعذر حفظ المسودة محليًا: " + errorMessage(reason));
        return false;
      }
    }
    if (!navigator.onLine && !document && (kind === "receipt" || kind === "payment")) {
      await saveOnDevice();
      return;
    }
    setSaving(true);
    try {
      const result = await api<{ document: FinancialDocument }>(
        `/companies/${companyId}/financial-documents${document ? `/${document.id}` : ""}`,
        {
          method: document ? "PATCH" : "POST",
          body: parsed.data,
          signal: guard.signal,
        },
      );
      if (!guard.isCurrent()) return;
      setDirty(false);
      setUnknownCreation(false);
      if (document || embedded) {
        onSaved(result.document, document
          ? "تم حفظ المسودة. يمكنك الآن ترحيلها."
          : "تم حفظ المسودة. رحّل السند لتظهر حركته في كشف حساب صندوقي.");
      } else {
        allowNavigation.current = true;
        navigate(documentPath(companyId, result.document.id), {
          replace: true,
        });
      }
      void changed();
    } catch (reason) {
      if (guard.isCurrent()) {
        const uncertain = !(reason instanceof ApiFailure) || reason.status >= 500;
        if (uncertain && await saveOnDevice()) return;
        if (!document && uncertain)
          setUnknownCreation(true);
        setError(errorMessage(reason));
      }
    } finally {
      if (guard.isCurrent()) setSaving(false);
    }
  }
  async function confirm() {
    if (saving || !document) return;
    if (confirmation === "reload") {
      setSaving(true);
      try {
        const result = await api<{ document: FinancialDocument }>(
          `/companies/${companyId}/financial-documents/${document.id}`,
          { signal: guard.signal },
        );
        if (guard.isCurrent()) {
          setDirty(false);
          setConfirmation(null);
          onSaved(result.document, "تم تحميل النسخة الحالية.");
        }
      } catch (reason) {
        if (guard.isCurrent()) setError(errorMessage(reason));
      } finally {
        if (guard.isCurrent()) setSaving(false);
      }
      return;
    }
    if (confirmation === "reverse" && !reverseReason.trim()) {
      setError("سبب العكس مطلوب.");
      return;
    }
    setSaving(true);
    setError("");
    const action = confirmation;
    try {
      const result = await api<{
        document: FinancialDocument;
        reversalDocument?: FinancialDocument;
      }>(
        `/companies/${companyId}/financial-documents/${document.id}/${action}`,
        {
          method: "POST",
          body:
            action === "post"
              ? { revision: document.revision }
              : {
                  reason: reverseReason,
                  documentDate: reverseDate,
                  idempotencyKey: reverseKey,
                },
          signal: guard.signal,
        },
      );
      if (!guard.isCurrent()) return;
      setConfirmation(null);
      onSaved(
        result.document,
        action === "post"
          ? "تم ترحيل المستند وتحديث الأرصدة."
          : `تم عكس المستند بالقيد ${result.reversalDocument?.number ?? "العكسي"}.`,
      );
      void changed();
    } catch (reason) {
      if (guard.isCurrent()) setError(errorMessage(reason));
    } finally {
      if (guard.isCurrent()) setSaving(false);
    }
  }
  function requestPrint() {
    if (!document) return;
    // Keep window.print() in the direct click handler so popup blockers do not
    // suppress the browser's native print dialog.
    if (document.status === "posted" && (kind === "receipt" || kind === "payment")) {
      const request = api<{ rewarded: boolean }>(
        `/companies/${companyId}/financial-documents/${document.id}/print-request`,
        { method: "POST" },
      );
      void request.then((result) => {
        if (guard.isCurrent() && result.rewarded)
          void queryClient.invalidateQueries({ queryKey: ["wallet-summary", sessionUser?.id, companyId] });
      }).catch((reason) => {
        if (guard.isCurrent())
          setError("فُتح طلب الطباعة لكن تعذر تسجيل مكافأته: " + errorMessage(reason));
      });
    }
    window.print();
  }
  function pickerButton(
    label: string,
    value: string,
    target: Picker,
    optional = false,
  ) {
    return (
      <div className="field financial-floating-picker">
        <span className="financial-field-label">{label}</span>
        <Button
          variant="secondary"
          className="financial-picker"
          disabled={pickerDisabled}
          onClick={() => setPicker(target)}
        >
          {value || (optional ? "كل الشركة" : "اختر الحساب")}
        </Button>
        {optional && branch && canEdit && (
          <Button
            variant="ghost"
            size="compact"
            disabled={!canEdit || saving}
            onClick={() => {
              touch();
              setBranch(null);
            }}
          >
            إزالة تخصيص الفرع
          </Button>
        )}
      </div>
    );
  }

  // These shared controls appear in the compact cashbox modal and in the full
  // editor. Only their placement changes; voucher validation and posting do not.
  const dateControl = (
    <Field
      label="تاريخ المستند"
      type="date"
      required
      value={documentDate}
      disabled={!canEdit || saving || !allowDateEdit}
      onChange={(event) => { touch(); setDate(event.target.value); }}
    />
  );
  const receiptNumberControl = kind === "payment" ? (
    <Field
      label="رقم الوصل"
      placeholder="رقم سند قبض المورد"
      maxLength={100}
      value={supplierReceiptNumber}
      disabled={!canEdit || saving}
      onChange={(event) => { touch(); setSupplierReceiptNumber(event.target.value); }}
    />
  ) : null;
  const currencyControl = pickerButton(
    "عملة المستند", currency ? `${currency.code} — ${currency.name}` : "اختر العملة",
    { type: "currency" },
  );
  const branchControl = pickerButton("الفرع — اختياري", branch?.name ?? "",
    { type: "branch" }, true);
  const descriptionControl = (
    <Field
      label={embedded && kind !== "journal" ? "البيان" : "البيان العام"}
      value={description}
      maxLength={1000}
      disabled={!canEdit || saving}
      onChange={(event) => { touch(); setDescription(event.target.value); }}
    />
  );
  const cashControl = lockedCashAccount ? (
    <Field label="حساب الصندوق" value={accountLabel(lockedCashAccount)} readOnly />
  ) : (
    <ServerLookup<Account>
      companyId={companyId}
      resource={`/companies/${companyId}/financial-options?type=accounts&kind=posting&active=true&cashOrBank=true`}
      label="حساب الصندوق أو البنك"
      singleInput pageSize={50} sort="name:asc"
      value={cash as Account | null}
      display={accountLabel}
      disabled={pickerDisabled}
      required
      onChange={(item) => {
        touch(); cashManuallyChosen.current = true; setCash(item);
      }}
    />
  );
  const counterpartyControl = (
    <ServerLookup<Account>
      companyId={companyId}
      resource={`/companies/${companyId}/financial-options?type=accounts&kind=posting&active=true`}
      label={kind === "receipt" ? "الحساب المقبوض منه" : "الحساب المصروف إليه"}
      singleInput pageSize={50} sort="name:asc"
      value={counterparty as Account | null}
      display={accountLabel}
      disabled={pickerDisabled}
      required
      onChange={(item) => { touch(); setCounterparty(item); }}
    />
  );
  const amountControl = (
    <Field
      label={`المبلغ${showCurrency && currency ? ` (${currency.code})` : ""}`}
      money dir="ltr" inputMode="decimal" required
      value={voucherAmount}
      disabled={!canEdit || saving}
      onChange={(event) => { touch(); setVoucherAmount(event.target.value); }}
    />
  );
  const counterpartyDescriptionControl = (
    <Field
      label="بيان الطرف الآخر"
      value={counterpartyDescription}
      maxLength={500}
      disabled={!canEdit || saving}
      onChange={(event) => { touch(); setCounterpartyDescription(event.target.value); }}
    />
  );

  return (
    <div className="financial-document-page">
      {!embedded && <div className="financial-no-print">
        <PageHeader
          title={
            document
              ? `${documentKindLabels[kind]} ${document.number}`
              : `إضافة ${documentKindLabels[kind]}`
          }
          actions={
            <>
              <Button variant="secondary" disabled={saving} onClick={back}>
                العودة للقائمة
              </Button>
              {document && (
                <Button
                  variant="secondary"
                  onClick={requestPrint}
                  disabled={saving || dirty}
                >
                  <Printer size={16} />
                  طباعة
                </Button>
              )}
            </>
          }
        />
      </div>}
      <Card className="financial-document">
        <div className="financial-print-heading">
          <CompanyPrintHeader context={context} />
          <h2>
            {documentKindLabels[kind]} {document?.number ?? "مسودة جديدة"}
          </h2>
          {kind === "payment" && (
            <span>رقم الوصل: <bdi>{(document?.supplierReceiptNumber ?? supplierReceiptNumber) || "—"}</bdi></span>
          )}
        </div>
        {localMessage && <Notice>{localMessage}</Notice>}
        {error && (
          <div className="financial-no-print">
            <Notice tone="error">{error}</Notice>
          </div>
        )}
        {unknownCreation && (
          <div className="financial-no-print">
            <Notice tone="warning">
              لم يصل تأكيد الحفظ. قد يكون المستند حُفظ بالفعل؛ المدخلات ثابتة
              مؤقتًا. أعد إرسال طلب الحفظ نفسه لمعرفة النتيجة دون إنشاء نسخة
              ثانية.
            </Notice>
          </div>
        )}
        {document && (
          <div className="financial-document-meta">
            <span
              className={`financial-status financial-status-${document.status}`}
            >
              {documentStatusLabels[document.status]}
            </span>
            <span>المنشئ: {document.createdByName}</span>
            <time dateTime={document.createdAt}>
              {new Date(document.createdAt).toLocaleString("ar", {
                timeZone: "UTC",
              })}{" "}
              UTC
            </time>
            {document.reversalDocumentId && (
              <Link to={documentPath(companyId, document.reversalDocumentId)}>
                القيد العكسي
              </Link>
            )}
            {document.reversesDocumentId && (
              <Link to={documentPath(companyId, document.reversesDocumentId)}>
                المستند الأصلي
              </Link>
            )}
          </div>
        )}
        <form onSubmit={save}>
          {embedded && kind !== "journal" ? (
            <>
              <details className="financial-voucher-extras financial-no-print">
                <summary>خيارات إضافية</summary>
                <div className="financial-voucher-extra-fields">
                  {cashControl}
                  {receiptNumberControl}
                  {voucherDateVisible && dateControl}
                  {showCurrency && currencyControl}
                  {showVoucherBranch && branchControl}
                  {counterpartyDescriptionControl}
                </div>
              </details>
              <div className="financial-voucher-primary">
                {counterpartyControl}
                {amountControl}
                {descriptionControl}
              </div>
            </>
          ) : (
            <>
              <div className="financial-header-grid">
                {(kind === "journal" || voucherDateVisible) && dateControl}
                {receiptNumberControl}
                {showCurrency && currencyControl}
                {(kind === "journal" || showVoucherBranch) && branchControl}
                {descriptionControl}
              </div>
              {kind !== "journal" && (
                <div className="financial-voucher-grid">
                  {cashControl}
                  {counterpartyControl}
                  {amountControl}
                  {counterpartyDescriptionControl}
                </div>
              )}
            </>
          )}
          {kind === "journal" ? (
            <div className="financial-lines-scroll">
              <table className="financial-lines" aria-label="سطور القيد">
                <colgroup>
                  <col style={{ width: "36%" }} />
                  <col style={{ width: "17%" }} />
                  <col style={{ width: "17%" }} />
                  <col style={{ width: "25%" }} />
                  <col style={{ width: "5%" }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>الحساب</th>
                    <th>مدين</th>
                    <th>دائن</th>
                    <th>بيان السطر</th>
                    <th className="financial-no-print">حذف</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, index) => (
                    <tr key={line.key}>
                      <td>
                        <ServerLookup<Account>
                          companyId={companyId}
                          resource={`/companies/${companyId}/financial-options?type=accounts&kind=posting&active=true`}
                          label={`حساب السطر ${index + 1}`}
                          singleInput
                          pageSize={50}
                          sort="name:asc"
                          value={line.account as Account | null}
                          disabled={pickerDisabled}
                          required
                          display={accountLabel}
                          onChange={item=>editLine(index, {account:item})}
                        />
                      </td>
                      <td>
                        <Field
                          label={`مدين السطر ${index + 1}`}
                          money
                          className="financial-cell-field"
                          dir="ltr"
                          inputMode="decimal"
                          value={line.debit}
                          disabled={!canEdit || saving}
                          onChange={(event) =>
                            editLine(index, { debit: event.target.value })
                          }
                        />
                      </td>
                      <td>
                        <Field
                          label={`دائن السطر ${index + 1}`}
                          money
                          className="financial-cell-field"
                          dir="ltr"
                          inputMode="decimal"
                          value={line.credit}
                          disabled={!canEdit || saving}
                          onChange={(event) =>
                            editLine(index, { credit: event.target.value })
                          }
                        />
                      </td>
                      <td>
                        <Field
                          label={`بيان السطر ${index + 1}`}
                          className="financial-cell-field"
                          value={line.description}
                          maxLength={500}
                          disabled={!canEdit || saving}
                          onChange={(event) =>
                            editLine(index, { description: event.target.value })
                          }
                        />
                      </td>
                      <td className="financial-no-print">
                        <Button
                          variant="ghost"
                          size="compact"
                          aria-label={`حذف السطر ${index + 1}`}
                          disabled={!canEdit || saving || lines.length <= 2}
                          onClick={() => {
                            touch();
                            setLines((previous) =>
                              previous.filter((_, row) => row !== index),
                            );
                          }}
                        >
                          <Trash2 size={15} />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            document &&
            document.status !== "draft" && (
              <div className="financial-lines-scroll">
                <table
                  className="financial-lines"
                  aria-label="سطور السند المرحل"
                >
                  <thead>
                    <tr>
                      <th>الحساب</th>
                      <th>مدين</th>
                      <th>دائن</th>
                      <th>البيان</th>
                    </tr>
                  </thead>
                  <tbody>
                    {document.lines.map((line) => (
                      <tr key={line.id}>
                        <td>
                          {line.accountCode} — {line.accountName}
                        </td>
                        <td>{money(line.debit)}</td>
                        <td>{money(line.credit)}</td>
                        <td>{line.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}
          {kind === "journal" && canEdit && (
            <div className="financial-add-line financial-no-print">
              <Button
                variant="secondary"
                size="compact"
                disabled={saving || lines.length >= 100}
                onClick={() => {
                  touch();
                  setLines((previous) => [...previous, emptyLine()]);
                }}
              >
                <Plus size={15} />
                إضافة سطر
              </Button>
            </div>
          )}
          <div className="financial-totals" aria-live="polite">
            <span>
              إجمالي المدين: {money(totals ? exactText(totals.debit) : null)}{" "}
              {currency?.code}
            </span>
            <span>
              إجمالي الدائن: {money(totals ? exactText(totals.credit) : null)}{" "}
              {currency?.code}
            </span>
            <strong>
              الفرق:{" "}
              {money(totals ? exactText(totals.debit - totals.credit) : null)}
            </strong>
          </div>
          {document?.exchangeRate && (
            <div className="financial-rate-snapshot">
              <span>
                الصرف المثبت: 1 {document.currencyCode} ={" "}
                {money(document.exchangeRate)} {document.baseCurrencyCode}
              </span>
              <span>
                الإجمالي بالأساسية: {money(document.totalBaseDebit)}{" "}
                {document.baseCurrencyCode}
              </span>
              {document.exchangeRateSource && (
                <span>المصدر: {document.exchangeRateSource}</span>
              )}
            </div>
          )}
          <div className="form-actions financial-document-actions financial-no-print">
            {(canEdit || unknownCreation || localQueued) && (
              <Button type="submit" disabled={saving || localQueued || !currency}>
                {saving
                  ? "جارٍ الحفظ…"
                  : localQueued
                    ? "محفوظ محليًا — بانتظار المزامنة"
                  : unknownCreation
                    ? "إعادة إرسال طلب الحفظ نفسه"
                    : "حفظ المسودة"}
              </Button>
            )}
            {document?.status === "draft" && financeAccess(context, "post") && (
              <Button
                disabled={saving || dirty}
                onClick={() => setConfirmation("post")}
              >
                ترحيل المستند
              </Button>
            )}
            {document?.status === "posted" &&
              !document.reversesDocumentId &&
              financeAccess(context, "post") && (
                <Button
                  variant="danger"
                  disabled={saving}
                  onClick={() => setConfirmation("reverse")}
                >
                  عكس المستند
                </Button>
              )}
            {document && (
              <Button
                variant="secondary"
                disabled={saving}
                onClick={() => setConfirmation("reload")}
              >
                تحميل النسخة الحالية
              </Button>
            )}
            {dirty && (
              <span className="muted">
                توجد تعديلات غير محفوظة؛ احفظها قبل الترحيل والطباعة.
              </span>
            )}
            {embedded && onDismiss && (
              <Button variant="secondary" disabled={saving}
                onClick={onDismiss}>إغلاق النافذة</Button>
            )}
          </div>
        </form>
      </Card>
      <Dialog
        open={!!picker}
        title={
          picker?.type === "currency"
            ? "اختيار العملة"
            : picker?.type === "branch"
              ? "اختيار الفرع"
              : "اختيار الحساب"
        }
        onClose={() => setPicker(null)}
      >
        {picker?.type === "currency" ? (
          <ServerLookup<CompanyCurrency>
            companyId={companyId}
            resource={`/companies/${companyId}/financial-options?type=currencies&active=true`}
            label="العملة"
            value={currency as CompanyCurrency | null}
            display={(item) => `${item.code} — ${item.name}`}
            onChange={(item) => {
              if (item) {
                currencyManuallyChosen.current = true;
                touch();
                setCurrency(item);
                setPicker(null);
              }
            }}
          />
        ) : picker?.type === "branch" ? (
          <ServerLookup<Branch>
            companyId={companyId}
            resource={`/companies/${companyId}/financial-options?type=branches&active=true`}
            label="الفرع"
            value={branch as Branch | null}
            display={(item) => `${item.code} — ${item.name}`}
            onChange={(item) => {
              if (item) {
                touch();
                setBranch(item);
                setPicker(null);
              }
            }}
          />
        ) : (
          picker && (
            <ServerLookup<Account>
              companyId={companyId}
              resource={`/companies/${companyId}/financial-options?type=accounts&kind=posting&active=true${picker.type === "cash" ? "&cashOrBank=true" : ""}`}
              label={picker.type === "cash" ? "الصندوق أو البنك" : "الحساب"}
              value={
                (picker.type === "cash"
                  ? cash
                  : picker.type === "counterparty"
                    ? counterparty
                    : picker.type === "account"
                      ? lines[picker.row]?.account
                      : null) as Account | null
              }
              display={accountLabel}
              onChange={(item) => {
                if (!item) return;
                touch();
                if (picker.type === "cash") {
                  cashManuallyChosen.current = true;
                  setCash(item);
                }
                else if (picker.type === "counterparty") setCounterparty(item);
                else if (picker.type === "account")
                  editLine(picker.row, { account: item });
                setPicker(null);
              }}
            />
          )
        )}
      </Dialog>
      <Dialog
        open={!!confirmation}
        title={
          confirmation === "post"
            ? "ترحيل المستند"
            : confirmation === "reverse"
              ? "عكس المستند"
              : confirmation === "reload"
                ? "تحميل النسخة الحالية"
                : "مغادرة المستند"
        }
        onClose={() => {
          if (!saving) {
            setConfirmation(null);
            setError("");
          }
        }}
      >
        {confirmation === "post" && (
          <p>
            سيثبت الترحيل القيد وسعر الصرف ويحدث الأرصدة. بعد الترحيل تُجرى
            التصحيحات بقيد عكسي موثق.
          </p>
        )}
        {confirmation === "reverse" && (
          <div className="form-stack">
            <p>
              ينشأ قيد معاكس بالمبالغ وسعر الصرف المثبتين، مع الاحتفاظ بالمستند
              الأصلي.
            </p>
            <Field
              label="تاريخ القيد العكسي"
              type="date"
              value={reverseDate}
              required
              disabled={saving}
              onChange={(event) => setReverseDate(event.target.value)}
            />
            <Field
              label="سبب العكس"
              value={reverseReason}
              maxLength={1000}
              required
              disabled={saving}
              onChange={(event) => setReverseReason(event.target.value)}
            />
          </div>
        )}
        {confirmation === "reload" && (
          <p>
            {dirty
              ? "توجد تغييرات غير محفوظة. المتابعة ستترك هذه التغييرات."
              : "سيُحمّل آخر إصدار محفوظ من المستند."}
          </p>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        <div className="form-actions">
          <Button
            variant={confirmation === "reverse" ? "danger" : "primary"}
            disabled={
              saving || (confirmation === "reverse" && !reverseReason.trim())
            }
            onClick={() => void confirm()}
          >
            {saving ? "جارٍ التنفيذ…" : "تأكيد"}
          </Button>
          <Button
            variant="secondary"
            disabled={saving}
            onClick={() => {
              setConfirmation(null);
              setError("");
            }}
          >
            إلغاء
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={blocker.state === "blocked"}
        title="مغادرة المستند"
        onClose={() => {
          if (blocker.state === "blocked") blocker.reset();
        }}
      >
        <p>
          {unknownCreation
            ? "لم تُعرف نتيجة الحفظ بعد. قد يكون المستند موجودًا؛ تحقق من قائمة المستندات قبل إنشاء مستند آخر."
            : saving
              ? "جارٍ حفظ المستند. انتظر تأكيد النتيجة قبل المغادرة."
              : "توجد تعديلات غير محفوظة. المغادرة ستترك هذه التعديلات."}
        </p>
        <div className="form-actions">
          <Button
            variant="secondary"
            onClick={() => {
              if (blocker.state === "blocked") blocker.reset();
            }}
          >
            البقاء في المستند
          </Button>
          <Button
            variant="danger"
            disabled={saving}
            onClick={() => {
              if (blocker.state === "blocked") blocker.proceed();
            }}
          >
            مغادرة دون حفظ
          </Button>
        </div>
      </Dialog>
    </div>
  );
}


/** Reuses the financial document editor without navigating away from the employee's own ledger. */
export function CashboxVoucherModal({
  context, kind, account, onClose,
}: {
  context: CompanyContext;
  kind: "receipt" | "payment";
  account: PickAccount;
  onClose: () => void;
}) {
  const [record, setRecord] = useState<FinancialDocument | null>(null);
  const [notice, setNotice] = useState("");
  const [editorStatus, setEditorStatus] = useState<EditorStatus>({
    dirty: false, saving: false, unknownCreation: false,
  });
  const [confirmClose, setConfirmClose] = useState(false);
  const requestClose = () => {
    if (editorStatus.saving) return;
    if (editorStatus.dirty || editorStatus.unknownCreation) {
      setConfirmClose(true);
      return;
    }
    onClose();
  };
  return (
    <>
      <Dialog open onClose={requestClose}
        title={record ? `${documentKindLabels[kind]} ${record.number}` : `إضافة ${documentKindLabels[kind]}`}
        className="cashbox-voucher-dialog">
        {notice && <Notice tone="success">{notice}</Notice>}
        <DocumentEditor
          key={record ? `${record.id}:${record.revision}:${record.status}` : "new"}
          context={context}
          document={record}
          newKind={kind}
          embedded
          lockedCashAccount={account}
          onEditorStateChange={setEditorStatus}
          onDismiss={requestClose}
          onSaved={(saved, message) => {
            setRecord(saved);
            setNotice(message);
          }}
        />
      </Dialog>
      <Dialog open={confirmClose} title="إغلاق السند دون حفظ"
        onClose={() => setConfirmClose(false)}>
        <p>{editorStatus.unknownCreation
          ? "نتيجة الحفظ غير مؤكدة؛ ربما تم إنشاء السند. الإغلاق الآن قد يترك مسودة تحتاج مراجعة، فلا تنشئ نسخة أخرى قبل التحقق."
          : "هناك تعديلات غير محفوظة على السند. هل تريد تجاهلها وإغلاق النافذة؟"}</p>
        <div className="form-actions">
          <Button variant="secondary" onClick={() => setConfirmClose(false)}>متابعة التعديل</Button>
          <Button variant="danger" onClick={onClose}>إغلاق دون حفظ</Button>
        </div>
      </Dialog>
    </>
  );
}

export function AccountBalancesPage({ context }: { context: CompanyContext }) {
  if (!financeAccess(context))
    return <Notice tone="warning">ليس لديك صلاحية عرض الأرصدة.</Notice>;
  return <BalancesContent context={context} />;
}
function BalancesContent({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const [params, setParams] = useSearchParams();
  const filters = new URLSearchParams();
  for (const key of ["dateFrom", "dateTo"])
    if (params.get(key)) filters.set(key, params.get(key)!);
  const list = usePagedQuery<AccountBalance>(
    `/companies/${companyId}/account-balances?${filters}`,
    `company:${companyId}:finance:balances`,
  );
  const columns = useMemo<ColumnDef<AccountBalance, unknown>[]>(
    () => [
      { accessorKey: "accountCode", header: "كود الحساب" },
      {
        accessorKey: "accountName",
        header: "الحساب",
        size: 250,
        cell: ({ row }) => <ValueCell>{row.original.accountName}</ValueCell>,
      },
      {
        accessorKey: "debit",
        header: "إجمالي المدين",
        size: 180,
        cell: ({ row }) => money(row.original.debit),
      },
      {
        accessorKey: "credit",
        header: "إجمالي الدائن",
        size: 180,
        cell: ({ row }) => money(row.original.credit),
      },
      {
        accessorKey: "balance",
        header: params.get("dateFrom") ? "صافي الحركة خلال الفترة" : "الرصيد",
        size: 200,
        cell: ({ row }) => <bdi>{balanceText(row.original.balance)}</bdi>,
      },
      {
        accessorKey: "baseCurrencyCode",
        header: "الأساسية",
        enableSorting: false,
        size: 90,
      },
      {
        id: "ledger",
        header: "كشف الحساب",
        enableSorting: false,
        cell: ({ row }) => (
          <Link
            to={`/companies/${companyId}/account-ledger?accountId=${row.original.accountId}`}
          >
            عرض الكشف
          </Link>
        ),
      },
    ],
    [companyId, params.get("dateFrom")],
  );
  return (
    <>
      <PageHeader
        title="أرصدة الحسابات"
        description={
          params.get("dateFrom")
            ? "صافي حركة الفترة بالعملة الأساسية؛ الرصيد الافتتاحي والختامي يظهران في كشف الحساب."
            : "الأرصدة بالعملة الأساسية من الحركات المرحلة والقيد العكسي؛ المسودات مستبعدة."
        }
      />
      <Card>
        <div className="table-filters">
          <Field
            label="بحث في الحسابات"
            type="search"
            value={list.query}
            onChange={(event) => list.setQuery(event.target.value)}
          />
          <Field
            label="من تاريخ"
            type="date"
            value={params.get("dateFrom") ?? ""}
            onChange={(event) =>
              updateFilter(setParams, "dateFrom", event.target.value)
            }
          />
          <Field
            label="إلى تاريخ"
            type="date"
            value={params.get("dateTo") ?? ""}
            onChange={(event) =>
              updateFilter(setParams, "dateTo", event.target.value)
            }
          />
        </div>
        {list.error && <Notice tone="error">{errorMessage(list.error)}</Notice>}
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
          ariaLabel="أرصدة الحسابات"
        />
      </Card>
    </>
  );
}

export function AccountLedgerPage({ context }: { context: CompanyContext }) {
  const [params] = useSearchParams();
  const pledge = params.get("pledge") === "1";
  const allowedPledge = pledge && (context.general ||
    context.permissions.includes("commerce.view") ||
    context.permissions.includes("commerce.manage"));
  if (!financeAccess(context) && !allowedPledge)
    return <Notice tone="warning">ليس لديك صلاحية عرض كشف الحساب.</Notice>;
  return <LedgerContent context={context} pledge={pledge} />;
}
function LedgerContent({ context, pledge }: { context: CompanyContext; pledge: boolean }) {
  const companyId = context.company.id;
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  const accountId = Number(params.get("accountId")) || 0;
  const [selected, setSelected] = useState<Account | null>(null);
  const [choosing, setChoosing] = useState(false);
  const query = new URLSearchParams();
  query.set("accountId", String(accountId));
  for (const key of ["dateFrom", "dateTo"])
    if (params.get(key)) query.set(key, params.get(key)!);
  const page = Math.max(1, Number(params.get("page")) || 1);
  const pageSize = [10, 20, 50, 100].includes(Number(params.get("pageSize")))
    ? Number(params.get("pageSize"))
    : pledge ? 50 : 20;
  query.set("page", String(page));
  query.set("pageSize", String(pageSize));
  const ledgerUrl = pledge
    ? `/companies/${companyId}/pledges/${accountId}/ledger`
    : `/companies/${companyId}/account-ledger`;
  const result = useQuery({
    queryKey: ["finance", user?.id, companyId, "ledger", ledgerUrl, query.toString()],
    queryFn: ({ signal }) =>
      api<
        Page<AccountLedgerLine> & {
          totals: AccountLedgerTotals;
          account: PickAccount;
        }
      >(`${ledgerUrl}?${query}`, { signal }),
    enabled: accountId > 0,
  });
  const [preparePrint, setPreparePrint] = useState(false);
  const printQuery = useQuery({
    queryKey: ["ledger-full-print", user?.id, companyId, ledgerUrl, query.toString(), result.data?.total],
    enabled: preparePrint && !!result.data && accountId > 0,
    queryFn: async ({ signal }) => {
      const total = result.data?.total ?? 0;
      const rows: AccountLedgerLine[] = [];
      for (let printPage = 1; printPage <= Math.ceil(total / 100); printPage++) {
        const printParams = new URLSearchParams(query);
        printParams.set("page", String(printPage));
        printParams.set("pageSize", "100");
        const response = await api<Page<AccountLedgerLine>>(
          `${ledgerUrl}?${printParams}`, { signal },
        );
        rows.push(...response.items);
      }
      return rows;
    },
  });
  useEffect(() => {
    if (!preparePrint || !printQuery.data) return;
    // Print only after the full statement has been placed in the DOM.
    const frame = window.requestAnimationFrame(() => window.print());
    return () => window.cancelAnimationFrame(frame);
  }, [preparePrint, printQuery.data]);
  const columns = useMemo<ColumnDef<AccountLedgerLine, unknown>[]>(
    () => [
      {
        accessorKey: "runningBalance",
        header: "الرصيد",
        enableSorting: false,
        size: 210,
        cell: ({ row }) => (
          <bdi>{balanceText(row.original.runningBalance)}</bdi>
        ),
      },
      {
        accessorKey: "documentDate",
        header: "التاريخ",
        enableSorting: false,
        size: 120,
      },
      {
        accessorKey: "documentNumber",
        header: "المستند",
        enableSorting: false,
        size: 170,
        cell: ({ row }) => (
          <Link to={documentPath(companyId, row.original.documentId)}>
            {row.original.documentNumber}
          </Link>
        ),
      },
      {
        accessorKey: "kind",
        header: "النوع",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.reversesDocumentId
            ? "قيد عكسي"
            : documentKindLabels[row.original.kind],
      },
      {
        accessorKey: "description",
        header: "البيان",
        enableSorting: false,
        size: 240,
        cell: ({ row }) => (
          <ValueCell>{row.original.description || "—"}</ValueCell>
        ),
      },
      {
        accessorKey: "currencyCode",
        header: "عملة المستند",
        enableSorting: false,
        size: 100,
      },
      {
        accessorKey: "debit",
        header: "مدين المستند",
        enableSorting: false,
        size: 160,
        cell: ({ row }) => money(row.original.debit),
      },
      {
        accessorKey: "credit",
        header: "دائن المستند",
        enableSorting: false,
        size: 160,
        cell: ({ row }) => money(row.original.credit),
      },
      {
        accessorKey: "baseDebit",
        header: "مدين بالأساسية",
        enableSorting: false,
        size: 160,
        cell: ({ row }) => money(row.original.baseDebit),
      },
      {
        accessorKey: "baseCredit",
        header: "دائن بالأساسية",
        enableSorting: false,
        size: 160,
        cell: ({ row }) => money(row.original.baseCredit),
      },

    ],
    [companyId],
  );
  return (
    <div className="ledger-page">
      <div className="ledger-print-heading"><CompanyPrintHeader context={context} /><h2>كشف حساب {result.data?.account?.name ?? ""}</h2></div>
      <PageHeader
        title="كشف حساب"
        description="الحركات مرتبة حسب التاريخ والمستند والسطر؛ الإجماليات لكامل الفترة، والرصيد الجاري بالعملة الأساسية."
        actions={<Button variant="secondary" disabled={result.isLoading || preparePrint && printQuery.isFetching}
          onClick={() => { if (printQuery.data) window.print(); else setPreparePrint(true); }}>
          <Printer size={16} /> {preparePrint && printQuery.isFetching ? "جارٍ إعداد جميع الحركات…" : "طباعة كشف الحساب"}
        </Button>}
      />
      <Card>
        <div className="table-filters">
          <div className="field">
            <span className="financial-field-label">الحساب</span>
            <Button variant="secondary" onClick={() => setChoosing(true)}>
              {result.data?.account
                ? accountLabel(result.data.account)
                : selected?.id === accountId
                  ? accountLabel(selected)
                  : accountId > 0
                    ? `اختيار الحساب الحالي #${accountId}`
                    : "اختر حسابًا"}
            </Button>
          </div>
          <Field
            label="من تاريخ"
            type="date"
            value={params.get("dateFrom") ?? ""}
            onChange={(event) =>
              updateFilter(setParams, "dateFrom", event.target.value)
            }
          />
          <Field
            label="إلى تاريخ"
            type="date"
            value={params.get("dateTo") ?? ""}
            onChange={(event) =>
              updateFilter(setParams, "dateTo", event.target.value)
            }
          />
        </div>
        {!accountId && <Notice>اختر حسابًا لعرض حركاته ورصيده.</Notice>}
        {result.error && (
          <Notice tone="error">{errorMessage(result.error)}</Notice>
        )}
        {printQuery.error && <Notice tone="error">{errorMessage(printQuery.error)}</Notice>}
        {result.data && !result.isFetching && result.data.total === 0 && (
          <Notice>لا توجد حركات مالية مرحلة لهذا الحساب خلال الفترة المحددة. إنشاء الرهن وحده لا ينشئ قيدًا ماليًا.</Notice>
        )}
        {result.data && (
          <div className="financial-totals">
            <span>الافتتاحي: {money(result.data.totals.openingBalance)}</span>
            <span>مدين الفترة: {money(result.data.totals.debit)}</span>
            <span>دائن الفترة: {money(result.data.totals.credit)}</span>
            <strong>
              الختامي:{" "}
              <bdi>{balanceText(result.data.totals.closingBalance)}</bdi>{" "}
              {result.data.totals.baseCurrencyCode}
            </strong>
          </div>
        )}
        {accountId > 0 && (
          <DataTable
            columns={columns}
            data={result.data?.items ?? []}
            total={result.data?.total ?? 0}
            page={page}
            pageSize={pageSize}
            onPageChange={(value) =>
              setParams((previous) => {
                const next = new URLSearchParams(previous);
                next.set("page", String(value));
                return next;
              })
            }
            onPageSizeChange={(value) =>
              setParams((previous) => {
                const next = new URLSearchParams(previous);
                next.set("pageSize", String(value));
                next.delete("page");
                return next;
              })
            }
            sorting={[]}
            onSortingChange={() => {}}
            loading={result.isFetching}
            ariaLabel="حركات كشف الحساب"
          />
        )}
      </Card>
      {preparePrint && printQuery.data && (
        <div className="ledger-print-all" aria-label="كشف الحساب الكامل للطباعة">
          <table dir="rtl">
            <thead><tr><th>الرصيد</th><th>مدين</th><th>دائن</th><th>البيان</th><th>النوع</th><th>التاريخ</th><th>المستند</th><th>العملة</th></tr></thead>
            <tbody>{printQuery.data.map((line, index) => (
              <tr key={`${line.documentId}-${line.id}-${index}`}>
                <td>{balanceText(line.runningBalance)}</td>
                <td>{formatMoney(line.baseDebit)}</td>
                <td>{formatMoney(line.baseCredit)}</td>
                <td>{line.description}</td>
                <td>{line.reversesDocumentId ? "قيد عكسي" : documentKindLabels[line.kind]}</td>
                <td>{line.documentDate}</td>
                <td>{line.documentNumber}</td>
                <td>{line.currencyCode}</td>
              </tr>
            ))}</tbody>
          </table>
          {!printQuery.data.length && <p>لا توجد حركات مالية مرحلة للحساب.</p>}
        </div>
      )}
      <Dialog
        open={choosing}
        title="اختيار حساب للكشف"
        onClose={() => setChoosing(false)}
      >
        <ServerLookup<Account>
          companyId={companyId}
          resource={`/companies/${companyId}/financial-options?type=accounts&kind=posting`}
          label="الحساب"
          value={selected}
          display={accountLabel}
          onChange={(item) => {
            if (item) {
              setSelected(item);
              updateFilter(setParams, "accountId", String(item.id));
              setChoosing(false);
            }
          }}
        />
      </Dialog>
    </div>
  );
}
