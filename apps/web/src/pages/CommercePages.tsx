import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  Link,
  useBlocker,
  useNavigate,
  useLocation,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Pencil, Plus, Printer, Trash2 } from "lucide-react";
import {
  calculateInvoiceTotals,
  invoiceSchema,
  normalizeDigits,
  type Account,
  type Branch,
  type CompanyContext,
  type CompanyCurrency,
  type Invoice,
  type InvoiceInput,
  type InvoiceKind,
  type InvoiceLine,
  type Item,
  type Location,
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
import { useEmployeeCashbox } from "../employee-cashbox";
import { initialInvoiceAccount } from "../invoice-account-default";
import { saleStockQuantity } from "../sale-stock-quantity";
import { formatMoney } from "../format-money";
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
  ValueCell,
} from "../ui";

const InvoiceItemEditor = lazy(() =>
  import("./ItemsPages").then((module) => ({
    default: module.InvoiceItemEditor,
  })),
);

export function commerceAccess(context: CompanyContext, manage = false) {
  return (
    context.general ||
    context.permissions.some(
      (permission) =>
        permission === "commerce.manage" ||
        (!manage && permission === "commerce.view"),
    )
  );
}
const canPost = (context: CompanyContext) =>
  commerceAccess(context, true) &&
  (context.general || context.permissions.includes("finance.post"));
const title = (kind: InvoiceKind) =>
  kind === "sale" ? "فاتورة مبيعات" : "فاتورة مشتريات";
const listPath = (companyId: number, kind: InvoiceKind) =>
  `/companies/${companyId}/${kind === "sale" ? "sales" : "purchases"}`;
const invoicePath = (companyId: number, id: number | "new") =>
  `/companies/${companyId}/invoices/${id}`;
const itemLabel = (item: { code: string; name: string }) =>
  `${item.code} — ${item.name}`;
const amount = (value: string) => (
  <bdi className="financial-number">{formatMoney(value)}</bdi>
);
const today = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Aden" });
function filter(
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
function useCommerceChanges(companyId: number) {
  const client = useQueryClient();
  const { user } = useSession();
  return () =>
    client.invalidateQueries({
      predicate: ({ queryKey }) =>
        queryKey[1] === user?.id &&
        ((queryKey[0] === "commerce" && queryKey[2] === companyId) ||
          (queryKey[0] === "inventory" && queryKey[2] === companyId) ||
          (queryKey[0] === "finance" && queryKey[2] === companyId) ||
          (queryKey[0] === "wallet-summary" && queryKey[2] === companyId) ||
          (queryKey[0] === "list" &&
            String(queryKey[2]).startsWith(`company:${companyId}:`))),
    });
}

export function InvoicesPage({
  context,
  kind,
}: {
  context: CompanyContext;
  kind: InvoiceKind;
}) {
  if (!commerceAccess(context))
    return <Notice tone="warning">ليس لديك صلاحية عرض الفواتير.</Notice>;
  return <InvoiceList context={context} kind={kind} />;
}
function InvoiceList({
  context,
  kind,
}: {
  context: CompanyContext;
  kind: InvoiceKind;
}) {
  const companyId = context.company.id;
  const [params, setParams] = useSearchParams();
  const navigation = useNavigate();
  const route = useLocation();
  const [saved] = useState(
    () =>
      (route.state as { invoiceSaved?: { id: number; number: string } } | null)
        ?.invoiceSaved ?? null,
  );
  const [showSaved, setShowSaved] = useState(!!saved);
  useEffect(() => {
    if (!saved) return;
    navigation(route.pathname + route.search, { replace: true, state: null });
    const timer = window.setTimeout(() => setShowSaved(false), 4000);
    return () => window.clearTimeout(timer);
  }, [saved, navigation]);
  const filters = new URLSearchParams({ kind });
  for (const key of ["dateFrom", "dateTo", "branchId", "locationId", "supplierQ", "payerQ"])
    if (params.get(key)) filters.set(key, params.get(key)!);
  const list = usePagedQuery<Invoice>(
    `/companies/${companyId}/invoices?${filters}`,
    `company:${companyId}:invoices:${kind}`,
  );
  const columns = useMemo<ColumnDef<Invoice, unknown>[]>(
    () => [
      {
        accessorKey: "number",
        header: "رقم الفاتورة",
        size: 145,
        cell: ({ row }) => (
          <Link to={invoicePath(companyId, row.original.id)}>
            {row.original.number}
          </Link>
        ),
      },
      { accessorKey: "documentDate", header: "التاريخ", size: 110 },
      ...(kind === "purchase" ? [{
        accessorKey: "supplierReceiptNumber",
        header: "رقم الوصل",
        size: 140,
        enableSorting: false,
        cell: ({ row }) => <ValueCell>{row.original.supplierReceiptNumber || "—"}</ValueCell>,
      } satisfies ColumnDef<Invoice, unknown>] : []),
      {
        id: "return",
        header: "العملية",
        size: 90,
        enableSorting: false,
        cell: ({ row }) =>
          row.original.lines.length > 0 &&
          row.original.lines.every((line) => line.quantity.startsWith("-"))
            ? "مردود"
            : kind === "sale"
              ? "بيع"
              : "شراء",
      },
      {
        accessorKey: "counterpartyAccountName",
        header: kind === "sale" ? "العميل / الحساب" : "حساب السداد / الذمة",
        size: 190,
        enableSorting: false,
        cell: ({ row }) => (
          <ValueCell>{row.original.counterpartyAccountName}</ValueCell>
        ),
      },
      ...(kind === "purchase" ? [{
        accessorKey: "supplierAccountName",
        header: "المورد الفعلي",
        size: 190,
        enableSorting: false,
        cell: ({ row }) => (
          <ValueCell>{row.original.supplierAccountName ?? "—"}</ValueCell>
        ),
      } satisfies ColumnDef<Invoice, unknown>] : []),
      {
        accessorKey: "locationName",
        header: "الموقع",
        size: 150,
        enableSorting: false,
      },
      {
        accessorKey: "currencyCode",
        header: "العملة",
        size: 80,
        enableSorting: false,
      },
      {
        accessorKey: "total",
        header: "الصافي",
        size: 130,
        cell: ({ row }) => amount(row.original.total),
      },
      {
        accessorKey: "description",
        header: "الملاحظات",
        size: 210,
        enableSorting: false,
        cell: ({ row }) => (
          <ValueCell>{row.original.description || "—"}</ValueCell>
        ),
      },
      {
        id: "open",
        header: "عرض",
        size: 65,
        enableSorting: false,
        cell: ({ row }) => (
          <Link to={invoicePath(companyId, row.original.id)}>فتح</Link>
        ),
      },
    ],
    [companyId, kind],
  );
  return (
    <>
      <PageHeader
        title={kind === "sale" ? "فواتير المبيعات" : "فواتير المشتريات"}
        description="الموجب بيع أو شراء، والسالب مردود في السطر نفسه؛ يمكن جمعهما في فاتورة واحدة."
        actions={
          canPost(context) && (
            <Link
              className="button button-primary"
              to={`${invoicePath(companyId, "new")}?kind=${kind}`}
            >
              <Plus size={16} />
              إضافة {title(kind)}
            </Link>
          )
        }
      />
      {showSaved && saved && (
        <Notice tone="success">
          تم حفظ الفاتورة وترحيل المخزون والقيد بنجاح.{" "}
          <Link to={invoicePath(companyId, saved.id)}>عرض {saved.number}</Link>
        </Notice>
      )}
      <Card>
        <div className="table-filters">
          <Field
            label="بحث الفواتير"
            type="search"
            value={list.query}
            onChange={(event) => list.setQuery(event.target.value)}
            placeholder="الرقم أو البيان"
          />
          {kind === "purchase" && (
            <>
              <Field
                label="بحث المورد الفعلي"
                type="search"
                value={params.get("supplierQ") ?? ""}
                onChange={(event) => filter(setParams, "supplierQ", event.target.value)}
                placeholder="اسم المورد أو رمزه"
              />
              <Field
                label="بحث حساب السداد / الذمة"
                type="search"
                value={params.get("payerQ") ?? ""}
                onChange={(event) => filter(setParams, "payerQ", event.target.value)}
                placeholder="اسم الصندوق أو رمز الحساب"
              />
            </>
          )}
          <Field
            label="من تاريخ"
            type="date"
            value={params.get("dateFrom") ?? ""}
            onChange={(event) =>
              filter(setParams, "dateFrom", event.target.value)
            }
          />
          <Field
            label="إلى تاريخ"
            type="date"
            value={params.get("dateTo") ?? ""}
            onChange={(event) =>
              filter(setParams, "dateTo", event.target.value)
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
          loading={list.loading}
          total={list.data?.total ?? 0}
          page={list.page}
          pageSize={list.pageSize}
          sorting={list.sorting}
          onSortingChange={list.setSorting}
          onPageChange={list.setPage}
          onPageSizeChange={list.setPageSize}
          selectionMode="single"
        />
      </Card>
    </>
  );
}

interface DraftLine {
  key: string;
  search: string;
  itemId: number;
  itemCode: string;
  itemName: string;
  unit: 1 | 2 | 3;
  unitName: string;
  quantity: string;
  unitPrice: string;
  expiryDate: string | null;
  originalLineId: number | null;
  originalSelection: boolean;
  originalSource?: InvoiceLine;
  sourceItem?: Item;
}

function emptyLine(returning = false): DraftLine {
  return {
    key: crypto.randomUUID(),
    search: "",
    itemId: 0,
    itemCode: "",
    itemName: "",
    unit: 1,
    unitName: "",
    quantity: returning ? "-1" : "1",
    unitPrice: "0",
    expiryDate: null,
    originalLineId: null,
    originalSelection: returning,
    originalSource: undefined,
    sourceItem: undefined,
  };
}
const lineInputId = (line: DraftLine, field: string) =>
  `invoice-${field}-${line.key}`;

function ItemSearch({
  companyId,
  id,
  value,
  selected,
  disabled,
  onQueryChange,
  onChoose,
  onConfirmSelected,
  onFinishEntry,
}: {
  companyId: number;
  id: string;
  value: string;
  selected: boolean;
  disabled: boolean;
  onQueryChange: (value: string) => void;
  onChoose: (item: Item) => void;
  onConfirmSelected: () => void;
  onFinishEntry?: () => void;
}) {
  const { user } = useSession();
  const query = value;
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState({
    left: 0,
    top: 0,
    width: 310,
    maxHeight: 320,
  });
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [active, setActive] = useState(0);
  const [autoChoose, setAutoChoose] = useState("");
  useEffect(() => {
    if (selected || !open) {
      setSearch("");
      return;
    }
    const timer = window.setTimeout(() => {
      setSearch(query.trim());
      setPage(1);
      setActive(0);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, selected, open]);
  const expanded = open && !!search && !selected && !disabled;
  useLayoutEffect(() => {
    if (!expanded) return;
    const position = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(Math.max(rect.width, 310), window.innerWidth - 16);
      const below = window.innerHeight - rect.bottom - 8;
      const above = rect.top - 8;
      const down = below >= Math.min(240, above);
      const maxHeight = Math.max(80, Math.min(320, down ? below : above));
      const height = Math.min(popup.current?.scrollHeight ?? 240, maxHeight);
      setPlacement({
        left: Math.max(
          8,
          Math.min(rect.right - width, window.innerWidth - width - 8),
        ),
        top: down ? rect.bottom : Math.max(8, rect.top - height),
        width,
        maxHeight,
      });
    };
    position();
    const observer = new ResizeObserver(position);
    if (popup.current) observer.observe(popup.current);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [expanded, page]);
  const result = useQuery({
    queryKey: ["commerce", user?.id, companyId, "item-search", search, page],
    queryFn: ({ signal }) =>
      api<Page<Item>>(
        `/companies/${companyId}/commerce-options?${new URLSearchParams({ type: "items", q: search, page: String(page), pageSize: "10", sort: "code:asc" })}`,
        { signal },
      ),
    enabled: !!user && !!search && !disabled,
  });
  const items = result.data?.items ?? [];
  function choose(item: Item) {
    onChoose(item);
    setOpen(false);
    setSearch("");
    setActive(0);
    setAutoChoose("");
  }
  useEffect(() => {
    if (
      !disabled &&
      autoChoose &&
      autoChoose === search &&
      !result.isFetching &&
      result.data
    ) {
      const match =
        items.find(
          (candidate) =>
            candidate.barcode &&
            normalizeDigits(candidate.barcode) === normalizeDigits(autoChoose),
        ) ?? items[0];
      if (match) choose(match);
      else setAutoChoose("");
    }
  }, [autoChoose, search, result.isFetching, result.data, disabled]);
  return (
    <div
      className="commerce-item-search"
      ref={anchor}
      onBlur={(event) => {
        if (
          !anchor.current?.contains(event.relatedTarget) &&
          !popup.current?.contains(event.relatedTarget)
        ) {
          setOpen(false);
          setAutoChoose("");
        }
      }}
    >
      <Field
        id={id}
        className="item-cell-field"
        label="الصنف / الباركود"
        type="search"
        autoComplete="off"
        disabled={disabled}
        value={query}
        placeholder="اكتب جزءًا من اسم الصنف…"
        role="combobox"
        aria-expanded={expanded}
        aria-controls={expanded ? `${id}-results` : undefined}
        aria-activedescendant={
          expanded && items[active]
            ? `${id}-result-${items[active].id}`
            : undefined
        }
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          onQueryChange(event.target.value);
          setOpen(true);
          setAutoChoose("");
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((index) =>
              Math.max(0, Math.min(index + 1, items.length - 1)),
            );
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((index) => Math.max(index - 1, 0));
          }
          if (event.key === "Escape") {
            setOpen(false);
            setSearch("");
            setAutoChoose("");
          }
          if (event.key === "Enter") {
            event.preventDefault();
            // In sales only, entering exactly zero ends item entry; it must
            // never pick a product, submit the form or leave "0" behind.
            if (
              !selected && onFinishEntry &&
              !event.nativeEvent.isComposing &&
              normalizeDigits(query.trim()) === "0"
            ) {
              setOpen(false);
              setSearch("");
              setAutoChoose("");
              onQueryChange("");
              onFinishEntry();
              return;
            }
            if (selected) {
              onConfirmSelected();
              return;
            }
            if (!result.isFetching && search === query.trim() && items[active])
              choose(items[active]);
            else if (query.trim()) {
              setSearch(query.trim());
              setPage(1);
              setAutoChoose(query.trim());
            }
          }
        }}
      />
      {expanded &&
        createPortal(
          <div
            className="commerce-search-results"
            ref={popup}
            style={placement}
            onBlur={(event) => {
              if (
                !popup.current?.contains(event.relatedTarget) &&
                !anchor.current?.contains(event.relatedTarget)
              )
                setOpen(false);
            }}
          >
            <ul id={`${id}-results`} role="listbox" aria-label="نتائج الأصناف">
              {items.map((item, index) => (
                <li
                  id={`${id}-result-${item.id}`}
                  key={item.id}
                  role="option"
                  aria-selected={index === active}
                >
                  <Button
                    variant={index === active ? "secondary" : "ghost"}
                    onClick={() => choose(item)}
                    onMouseDown={(event) => event.preventDefault()}
                    disabled={
                      disabled || result.isFetching || search !== query.trim()
                    }
                  >
                    <bdi>{item.code}</bdi>
                    <span>{item.name}</span>
                    <bdi>{item.barcode}</bdi>
                  </Button>
                </li>
              ))}
            </ul>
            {result.isFetching ? (
              <span className="muted">جارٍ البحث…</span>
            ) : (
              !items.length && <span className="muted">لا توجد نتائج.</span>
            )}
            {result.error && (
              <Notice tone="error">{errorMessage(result.error)}</Notice>
            )}
            <div className="lookup-pages">
              <Button
                size="compact"
                variant="ghost"
                disabled={page <= 1 || result.isFetching}
                onClick={() => {
                  setPage(page - 1);
                  setActive(0);
                }}
              >
                السابق
              </Button>
              <span>صفحة {page}</span>
              <Button
                size="compact"
                variant="ghost"
                disabled={
                  page * 10 >= (result.data?.total ?? 0) || result.isFetching
                }
                onClick={() => {
                  setPage(page + 1);
                  setActive(0);
                }}
              >
                التالي
              </Button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

function OriginalInvoicePicker({
  companyId,
  kind,
  value,
  onChange,
  disabled,
}: {
  companyId: number;
  kind: InvoiceKind;
  value: Invoice | null;
  onChange: (invoice: Invoice | null) => void;
  disabled: boolean;
}) {
  const { user } = useSession();
  const guard = useScopeGuard(`company:${companyId}:invoice-origin`);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(query);
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  const result = useQuery({
    queryKey: [
      "commerce",
      user?.id,
      companyId,
      "original-invoices",
      kind,
      search,
      page,
    ],
    queryFn: ({ signal }) =>
      api<Page<Invoice>>(
        `/companies/${companyId}/invoices?${new URLSearchParams({ kind, q: search, page: String(page), pageSize: "20", sort: "documentDate:desc" })}`,
        { signal },
      ),
    enabled: !!user && !disabled,
  });
  const invoices = (result.data?.items ?? []).filter((invoice) =>
    invoice.lines.some((line) => !line.quantity.startsWith("-")),
  );
  const options =
    value && !invoices.some((invoice) => invoice.id === value.id)
      ? [value, ...invoices]
      : invoices;
  async function select(id: number) {
    const sequence = ++request.current;
    if (!id) {
      onChange(null);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await api<{ invoice: Invoice }>(
        `/companies/${companyId}/invoices/${id}`,
        { signal: guard.signal },
      );
      if (guard.isCurrent() && sequence === request.current)
        onChange(response.invoice);
    } catch (error) {
      if (guard.isCurrent() && sequence === request.current)
        setError(errorMessage(error));
    } finally {
      if (guard.isCurrent() && sequence === request.current) setLoading(false);
    }
  }
  return (
    <div className="commerce-original-picker">
      <Field
        label="بحث الفاتورة الأصلية"
        type="search"
        disabled={disabled || loading}
        value={query}
        placeholder="رقم الفاتورة أو البيان"
        onChange={(event) => setQuery(event.target.value)}
      />
      <Select
        label="الفاتورة الأصلية"
        disabled={disabled || loading || result.isFetching}
        value={value?.id ?? ""}
        onChange={(event) => void select(Number(event.target.value))}
      >
        <option value="">اختر فاتورة</option>
        {options.map((invoice) => (
          <option key={invoice.id} value={invoice.id}>
            {invoice.number} — {invoice.documentDate} — {formatMoney(invoice.total)}{" "}
            {invoice.currencyCode}
          </option>
        ))}
      </Select>
      <div className="lookup-pages">
        <Button
          size="compact"
          variant="ghost"
          disabled={disabled || loading || page === 1}
          onClick={() => setPage(page - 1)}
        >
          السابق
        </Button>
        <span>{loading ? "جارٍ تحميل الأصل…" : `صفحة ${page}`}</span>
        <Button
          size="compact"
          variant="ghost"
          disabled={
            disabled || loading || page * 20 >= (result.data?.total ?? 0)
          }
          onClick={() => setPage(page + 1)}
        >
          التالي
        </Button>
      </div>
      {(error || result.error) && (
        <Notice tone="error">{error || errorMessage(result.error)}</Notice>
      )}
    </div>
  );
}

function InvoiceWorkspace({ children }: { children: ReactNode }) {
  return (
    <div className="invoice-workspace">
      <div className="invoice-workspace-main">{children}</div>
      <aside
        className="invoice-side-space"
        aria-label="المساحة الجانبية للفاتورة"
        tabIndex={0}
      >
        <section className="invoice-empty-panel" aria-label="المساحة الأولى" />
        <section className="invoice-empty-panel" aria-label="المساحة الثانية" />
      </aside>
    </div>
  );
}

export function InvoicePage({ context }: { context: CompanyContext }) {
  const { invoiceId } = useParams();
  const [params] = useSearchParams();
  const { user } = useSession();
  const kind = params.get("kind") === "purchase" ? "purchase" : "sale";
  if (!commerceAccess(context))
    return <Notice tone="warning">ليس لديك صلاحية عرض الفواتير.</Notice>;
  if (invoiceId === "new")
    return canPost(context) ? (
      <InvoiceWorkspace>
        <InvoiceEditor
          key={`${user?.id}:${context.company.id}:${kind}`}
          context={context}
        />
      </InvoiceWorkspace>
    ) : (
      <Notice tone="warning">
        إنشاء الفاتورة يحتاج صلاحية إدارة الفواتير والترحيل المالي.
      </Notice>
    );
  return (
    <InvoiceWorkspace>
      <InvoiceViewer context={context} invoiceId={Number(invoiceId)} />
    </InvoiceWorkspace>
  );
}
function InvoiceEditor({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const { user } = useSession();
  const client = useQueryClient();
  const directory = usePageDirectory(companyId);
  const canEditItem =
    (context.general || context.permissions.includes("items.manage")) &&
    ["company.items", "company.item-card"].every((key) => {
      const page = directory.data?.find((entry) => entry.key === key);
      return page?.enabled && page.actionAccess.view && page.actionAccess.edit;
    });
  const [editingItem, setEditingItem] = useState<{
    itemId: number;
    lineKey: string;
  } | null>(null);
  const [editingBusy, setEditingBusy] = useState(false);
  const [itemNotice, setItemNotice] = useState("");
  const [memoBlocked,setMemoBlocked]=useState(false);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const kind: InvoiceKind =
    params.get("kind") === "purchase" ? "purchase" : "sale";
  const guard = useScopeGuard(`company:${companyId}:invoice-editor:${kind}`);
  const memoImpact=useQuery({
    queryKey:["memo-feature-impact",user?.id,companyId,kind],
    queryFn:({signal})=>api<{matches:{
      ruleId:number;ruleName:string;effect:"monitor"|"warn"|"block";
      message:string;count:number;memoIds:number[];
    }[]}>(`/companies/${companyId}/memo-feature-impact?kind=${kind}`,{signal}),
    enabled:!!user,refetchInterval:60000,
  });

  const invalidate = useCommerceChanges(companyId);
  const [documentDate, setDocumentDate] = useState(today);
  const [currency, setCurrency] = useState<CompanyCurrency | null>(null);
  const defaultYer = useDefaultYerCurrency(companyId, "commerce-options");
  const currencyManuallyChosen = useRef(false);
  const automaticCurrencyId = useRef<number | null>(null);
  const [branch, setBranch] = useState<Branch | null>(null);
  const [location, setLocation] = useState<Location | null>(null);
  const [showOriginalPicker, setShowOriginalPicker] = useState(false);
  const branchManuallyChosen = useRef(false);
  const locationManuallyChosen = useRef(false);
  const automaticBranchId = useRef<number | null>(null);
  const automaticLocationId = useRef<number | null>(null);
  const mainBranchQuery = useQuery({
    queryKey: ["invoice-default-branch", user?.id, companyId],
    enabled: !!user,
    queryFn: async ({ signal }) => {
      // HQ is the automatic main branch. Older companies may use MAIN.
      for (const code of ["HQ", "MAIN"]) {
        const page = await api<Page<Branch>>(
          `/companies/${companyId}/commerce-options?type=branches&active=true&q=${code}&pageSize=20`,
          { signal },
        );
        const exact = page.items.find(
          (item) => item.active && item.code === code,
        );
        if (exact) return exact;
      }
      return null;
    },
  });
  const showroomQuery = useQuery({
    queryKey: ["invoice-default-showroom", user?.id, companyId, branch?.id],
    enabled: !!user && !!branch,
    queryFn: ({ signal }) =>
      api<Page<Location>>(
        `/companies/${companyId}/commerce-options?type=locations&active=true&branchId=${branch!.id}&kind=showroom&pageSize=100`,
        { signal },
      ),
  });
  const [account, setAccount] = useState<Account | null>(null);
  const [supplier, setSupplier] = useState<Account | null>(null);
  const [supplierReceiptNumber, setSupplierReceiptNumber] = useState("");
  const creditPurchase = kind === "purchase" && account?.category === "liability" &&
    !account.cashOrBank;
  const selectedSupplier = creditPurchase ? account : supplier;
  const defaultCashbox = useEmployeeCashbox(context);
  const accountManuallyChosen = useRef(false);
  const [description, setDescription] = useState("");
  const [discount, setDiscount] = useState("0");
  useEffect(() => {
    if (!defaultYer || currencyManuallyChosen.current) return;
    if (currency === null) {
      automaticCurrencyId.current = defaultYer.id;
      setCurrency(defaultYer);
    }
  }, [defaultYer, currency]);
  useEffect(() => {
    const main = mainBranchQuery.data;
    if (!main || branchManuallyChosen.current || branch) return;
    automaticBranchId.current = main.id;
    setBranch(main);
  }, [mainBranchQuery.data, branch]);
  useEffect(() => {
    if (
      !branch ||
      !showroomQuery.data ||
      locationManuallyChosen.current ||
      location
    )
      return;
    const defaultShowroom =
      showroomQuery.data.items.find(
        (entry) =>
          entry.active &&
          entry.effectiveActive &&
          entry.branchId === branch.id &&
          entry.code === "SHOWROOM" &&
          entry.kind === "showroom",
      ) ??
      showroomQuery.data.items.find(
        (entry) =>
          entry.active &&
          entry.effectiveActive &&
          entry.branchId === branch.id &&
          entry.kind === "showroom",
      );
    if (!defaultShowroom) return;
    automaticLocationId.current = defaultShowroom.id;
    setLocation(defaultShowroom);
  }, [showroomQuery.data, branch, location]);
  const [original, setOriginal] = useState<Invoice | null>(null);
  const [lines, setLines] = useState<DraftLine[]>(() => [emptyLine()]);
  const selectedLines = lines.filter((line) => line.itemId > 0);
  const hasLinkedLines = selectedLines.some(
    (line) => line.originalLineId !== null,
  );
  // Sales start from the employee's cashbox. Purchases intentionally require
  // choosing the settlement/liability account on every new invoice.
  useEffect(() => {
    if (
      kind !== "sale" || !defaultCashbox || accountManuallyChosen.current ||
      account || original || hasLinkedLines
    ) return;
    setAccount(defaultCashbox);
  }, [kind, defaultCashbox, account, original, hasLinkedLines]);
  const hasPositiveLines = selectedLines.some(
    (line) => !normalizeDigits(line.quantity.trim()).startsWith("-"),
  );
  const showExpiry =
    kind === "purchase" ||
    selectedLines.some(
      (line) =>
        normalizeDigits(line.quantity.trim()).startsWith("-") &&
        !line.originalLineId &&
        line.sourceItem?.hasExpiry,
    );
  const stockItemIds = [...new Set(selectedLines.map((line) => line.itemId))]
    .sort((a, b) => a - b)
    .join(",");
  const stockPreview = useQuery<{
    items: { itemId: number; quantitySmallest: string; shelf: string }[];
  }>({
    queryKey: [
      "sale-stock-preview",
      user?.id,
      companyId,
      location?.id,
      stockItemIds,
    ],
    enabled: kind === "sale" && !!user && !!location && !!stockItemIds,
    queryFn: ({ signal }) =>
      api(
        `/companies/${companyId}/invoice-stock-preview?${new URLSearchParams({
          locationId: String(location!.id),
          itemIds: stockItemIds,
        })}`,
        { signal },
      ),
  });
  const stockByItem = new Map(
    (stockPreview.data?.items ?? []).map((row) => [row.itemId, row]),
  );
  const [error, setError] = useState("");
  const [savedInvoice, setSavedInvoice] = useState<{
    id: number;
    number: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const pending = useRef<InvoiceInput | null>(null);
  const allowNavigation = useRef(false);
  const dirty =
    lines.some((line) => line.itemId || line.search.trim()) ||
    !!original ||
    !!description ||
    (kind === "purchase" && (!!supplier || !!supplierReceiptNumber)) ||
    accountManuallyChosen.current ||
    (!!account && account.id !== defaultCashbox?.id) ||
    (!!branch &&
      (branchManuallyChosen.current ||
        branch.id !== automaticBranchId.current)) ||
    (!!location &&
      (locationManuallyChosen.current ||
        location.id !== automaticLocationId.current)) ||
    (!!currency &&
      (currencyManuallyChosen.current ||
        currency.id !== automaticCurrencyId.current));
  const locked = saving || unknown;
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      !allowNavigation.current &&
      (dirty || saving || unknown) &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search),
  );
  useEffect(() => {
    if (!dirty && !saving && !unknown) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty, saving, unknown]);
  // Start new invoices with the cursor in the first item/barcode search.
  const [focusTarget, setFocusTarget] = useState<{ id: string } | null>(() => ({
    id: lineInputId(lines[0]!, "item-search"),
  }));
  const focus = (id: string) => setFocusTarget({ id });
  useLayoutEffect(() => {
    if (!focusTarget || locked || !guard.isCurrent()) return;
    const element = document.getElementById(focusTarget.id);
    // Selection and a new row must commit before their controls can receive focus.
    if (!element || element.matches(":disabled")) return;
    element.focus();
    setFocusTarget(null);
  }, [focusTarget, lines, locked]);
  const salePrice = (selected: Item, level: 1 | 2 | 3) =>
    level === 1
      ? selected.salePrice1
      : level === 2
        ? selected.salePrice2
        : selected.salePrice3;
  const unitName = (selected: Item, level: 1 | 2 | 3) =>
    level === 1
      ? selected.unit1Name
      : level === 2
        ? selected.unit2Name
        : selected.unit3Name;
  function calculationLine(line: DraftLine) {
    let inheritedDiscount: string | undefined;
    if (
      line.originalLineId &&
      line.originalSource &&
      normalizeDigits(line.quantity.trim()).startsWith("-")
    ) {
      const quantity = -BigInt(normalizeDigits(line.quantity.trim()));
      const [whole, fraction = ""] = line.originalSource.discount.split(".");
      const originalDiscount =
        BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
      const step = 10n ** BigInt(6 - (currency?.decimalPlaces ?? 6));
      const denominator = BigInt(line.originalSource.quantity) * step;
      const numerator = originalDiscount * quantity;
      const value =
        (numerator / denominator +
          ((numerator % denominator) * 2n >= denominator ? 1n : 0n)) *
        step;
      const digits = (value % 1_000_000n)
        .toString()
        .padStart(6, "0")
        .replace(/0+$/, "");
      inheritedDiscount = `${value ? "-" : ""}${value / 1_000_000n}${digits ? `.${digits}` : ""}`;
    }
    return {
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      ...(inheritedDiscount !== undefined
        ? { discount: inheritedDiscount }
        : {}),
    };
  }
  const totals = useMemo(() => {
    try {
      return calculateInvoiceTotals(
        lines.filter((line) => line.itemId > 0).map(calculationLine),
        hasPositiveLines ? discount : "0",
        currency?.decimalPlaces ?? 6,
      );
    } catch {
      return null;
    }
  }, [lines, discount, currency?.decimalPlaces, hasPositiveLines]);
  function updateLine(key: string, patch: Partial<DraftLine>) {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  }
  function chooseItem(line: DraftLine, selected: Item) {
    setError("");
    const selectedUnit = kind === "sale" ? (selected.defaultSaleUnit ?? 1) : 1;
    updateLine(line.key, {
      itemId: selected.id,
      itemCode: selected.code,
      itemName: selected.name,
      search: selected.name,
      sourceItem: selected,
      unit: selectedUnit,
      unitName: unitName(selected, selectedUnit),
      quantity: "1",
      unitPrice:
        kind === "sale"
          ? salePrice(selected, selectedUnit)
          : currency?.id === selected.currencyId
            ? selected.purchasePrice
            : "0",
      expiryDate: null,
      originalLineId: null,
      originalSelection: false,
      originalSource: undefined,
    });
    focus(lineInputId(line, "quantity"));
  }
  function closeItemEditor() {
    if (!editingBusy) setEditingItem(null);
  }
  function itemSaved(item: Item) {
    if (!guard.isCurrent() || item.companyId !== companyId) return;
    setLines((current) =>
      current.map((line) => {
        if (line.itemId !== item.id) return line;
        if (line.originalLineId) return { ...line, sourceItem: item };
        return {
          ...line,
          itemCode: item.code,
          itemName: item.name,
          search: item.name,
          sourceItem: item,
          unitName: unitName(item, line.unit),
          ...(kind === "sale"
            ? { unitPrice: salePrice(item, line.unit) }
            : {}),
        };
      }),
    );
    void client.invalidateQueries({
      queryKey: ["sale-stock-preview", user?.id, companyId],
    });
    setItemNotice(`تم حفظ كرت الصنف ${item.name}.`);
    setEditingItem(null);
    setEditingBusy(false);
  }
  function validateQuantity(line: DraftLine) {
    const normalized = normalizeDigits(line.quantity.trim());
    if (!/^-?\d{1,22}$/.test(normalized) || BigInt(normalized) === 0n) {
      setError("الكمية عدد صحيح غير صفري حتى 22 رقمًا.");
      focus(lineInputId(line, "quantity"));
      return false;
    }
    return true;
  }
  function validateLine(line: DraftLine) {
    if (!line.itemId) {
      setError("اختر صنفًا من نتائج البحث.");
      focus(lineInputId(line, "item-search"));
      return false;
    }
    if (!validateQuantity(line)) return false;
    if (
      !currency ||
      (kind === "sale" &&
        !line.originalLineId &&
        line.sourceItem?.currencyId !== currency.id)
    ) {
      setError("اختر عملة الفاتورة؛ عملة سعر البيع يجب أن تطابقها.");
      return false;
    }
    if (line.originalLineId) {
      const source = line.originalSource;
      if (!source) {
        setError("اختر الصنف المرتجع من الفاتورة الأصلية.");
        return false;
      }
      if (
        selectedLines.some(
          (entry) =>
            entry.key !== line.key &&
            entry.originalLineId === line.originalLineId,
        )
      ) {
        setError("سطر الأصل موجود في المردود. عدّل كميته بدل إضافته مرتين.");
        return false;
      }
      if (
        -BigInt(normalizeDigits(line.quantity.trim())) > BigInt(source.quantity)
      ) {
        setError(
          "كمية المردود تتجاوز كمية السطر الأصلي. يتحقق الخادم أيضًا من المردودات السابقة.",
        );
        focus(lineInputId(line, "quantity"));
        return false;
      }
    } else if (
      kind === "purchase" &&
      line.sourceItem?.hasExpiry &&
      !line.expiryDate
    ) {
      setError("تاريخ الانتهاء مطلوب للصنف المختار.");
      focus(lineInputId(line, "expiry"));
      return false;
    }
    try {
      calculateInvoiceTotals(
        [calculationLine(line)],
        "0",
        currency.decimalPlaces,
      );
    } catch (error) {
      setError(errorMessage(error));
      focus(lineInputId(line, "price"));
      return false;
    }
    return true;
  }
  async function loadOriginalItem(lineKey: string, source: InvoiceLine) {
    try {
      const response = await api<Page<Item>>(
        `/companies/${companyId}/commerce-options?${new URLSearchParams({ type: "items", q: source.itemCode, pageSize: "20" })}`,
        { signal: guard.signal },
      );
      const currentItem = response.items.find(
        (item) => item.id === source.itemId,
      );
      if (!guard.isCurrent() || !currentItem) return;
      setLines((current) =>
        current.map((line) => {
          if (
            line.key !== lineKey ||
            line.itemId !== currentItem.id ||
            line.sourceItem
          )
            return line;
          return {
            ...line,
            sourceItem: currentItem,
            ...(!line.originalLineId
              ? {
                  unit: 1 as const,
                  unitName: currentItem.unit1Name,
                  ...(kind === "sale"
                    ? { unitPrice: currentItem.salePrice1 }
                    : {}),
                }
              : {}),
          };
        }),
      );
    } catch {
      // A historical return remains usable if its archived card is unavailable.
      // Changing it into an ordinary row requires choosing an active item card.
    }
  }
  function chooseOriginalLine(line: DraftLine, source?: InvoiceLine) {
    updateLine(
      line.key,
      source
        ? {
            itemId: source.itemId,
            itemCode: source.itemCode,
            itemName: source.itemName,
            search: source.itemName,
            unit: source.unit,
            unitName: source.unitName,
            quantity: "-1",
            unitPrice: source.unitPrice,
            expiryDate: source.expiryDate,
            originalLineId: source.id,
            originalSelection: true,
            originalSource: source,
            sourceItem: undefined,
          }
        : { ...emptyLine(true), key: line.key },
    );
    if (source) {
      focus(lineInputId(line, "quantity"));
      void loadOriginalItem(line.key, source);
    }
  }
  function addOriginalRow() {
    if (selectedLines.length >= 100) {
      setError("الحد الأقصى 100 سطر للفاتورة.");
      return;
    }
    const empty = lines.find((line) => !line.itemId && !line.search.trim());
    const row = empty
      ? { ...empty, originalSelection: true, quantity: "-1" }
      : emptyLine(true);
    setLines((current) =>
      empty
        ? current.map((line) => (line.key === empty.key ? row : line))
        : [...current, row],
    );
    focus(lineInputId(row, "original-line"));
  }
  function changeQuantity(line: DraftLine, value: string) {
    const positive =
      /^\d+$/.test(normalizeDigits(value.trim())) &&
      BigInt(normalizeDigits(value.trim())) > 0n;
    if (line.originalLineId && positive) {
      if (!line.sourceItem) {
        // Clear the historical item as well when no active card is available;
        // it must be chosen again before this becomes an ordinary sale/purchase.
        updateLine(line.key, {
          ...emptyLine(),
          key: line.key,
          search: line.itemName,
          quantity: value,
        });
        focus(lineInputId(line, "item-search"));
        return;
      }
      updateLine(line.key, {
        quantity: value,
        originalLineId: null,
        originalSelection: false,
        originalSource: undefined,
        unit: 1,
        unitName: line.sourceItem.unit1Name,
        ...(kind === "sale"
          ? { unitPrice: line.sourceItem.salePrice1, expiryDate: null }
          : {}),
      });
    } else
      updateLine(line.key, {
        quantity: value,
        ...(positive && kind === "sale" ? { expiryDate: null } : {}),
      });
  }
  function nextLine(line?: DraftLine) {
    if (locked) return;
    setError("");
    if (line && !validateLine(line)) return;
    const index = line
      ? lines.findIndex((entry) => entry.key === line.key)
      : -1;
    const next =
      (line ? lines[index + 1] : undefined) ??
      lines.find((entry) => !entry.itemId && !entry.search.trim());
    if (next) {
      focus(
        lineInputId(
          next,
          next.originalSelection ? "original-line" : "item-search",
        ),
      );
      return;
    }
    if (selectedLines.length >= 100) {
      setError("الحد الأقصى 100 سطر للفاتورة.");
      return;
    }
    const created = emptyLine();
    setLines((current) => [...current, created]);
    focus(lineInputId(created, "item-search"));
  }
  function deleteLine(line: DraftLine) {
    setError("");
    const remaining = lines.filter((entry) => entry.key !== line.key);
    const replacement = remaining.length ? remaining : [emptyLine()];
    setLines(replacement);
    focus(
      lineInputId(
        replacement[Math.min(lines.indexOf(line), replacement.length - 1)],
        replacement[Math.min(lines.indexOf(line), replacement.length - 1)]
          .originalSelection
          ? "original-line"
          : "item-search",
      ),
    );
  }
  function resetInvoice() {
    if (locked || editingItem) return;
    // Reset only this unsaved editor; posted invoices are never changed.
    const first = emptyLine();
    pending.current = null;
    setLines([first]);
    setAccount(initialInvoiceAccount(kind, defaultCashbox));
    setSupplier(null);
    setSupplierReceiptNumber("");
    accountManuallyChosen.current = false;
    setOriginal(null);
    setShowOriginalPicker(false);
    setDocumentDate(today());
    setCurrency(null);
    setBranch(null);
    setLocation(null);
    currencyManuallyChosen.current = false;
    branchManuallyChosen.current = false;
    locationManuallyChosen.current = false;
    automaticCurrencyId.current = null;
    automaticBranchId.current = null;
    automaticLocationId.current = null;
    setDescription("");
    setDiscount("0");
    setError("");
    setSavedInvoice(null);
    setItemNotice("");
    focus(lineInputId(first, "item-search"));
  }
  async function save(event?: FormEvent) {
    event?.preventDefault();
    if (saving || editingItem || !guard.isCurrent()) return;
    setError("");
    setMemoBlocked(false);
    let payload = pending.current;
    if (!unknown) {
      const unfinished = lines.find(
        (line) => !line.itemId && line.search.trim(),
      );
      if (unfinished) {
        setError("اختر الصنف الجاري من نتائج البحث أو امسح البحث قبل الحفظ.");
        focus(lineInputId(unfinished, "item-search"));
        return;
      }
      if (selectedLines.some((line) => !validateLine(line))) return;
      const parsed = invoiceSchema.safeParse({
        idempotencyKey: crypto.randomUUID(),
        kind,
        documentDate,
        currencyId: currency?.id,
        branchId: branch?.id,
        locationId: location?.id,
        counterpartyAccountId: account?.id,
        supplierAccountId: kind === "purchase" ? selectedSupplier?.id ?? null : null,
        supplierReceiptNumber: kind === "purchase" ? supplierReceiptNumber : "",
        description,
        discount: hasPositiveLines ? discount : "0",
        lines: selectedLines.map((line) => ({
          itemId: line.itemId,
          unit: line.unit,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          expiryDate: line.expiryDate,
          originalLineId: line.originalLineId,
        })),
      });
      if (!parsed.success) {
        setError(parsed.error.issues.map((issue) => issue.message).join(" · "));
        return;
      }
      payload = parsed.data;
      pending.current = payload;
    }
    if (!payload) return;
    setSaving(true);
    try {
      const response = await api<{ invoice: Invoice }>(
        `/companies/${companyId}/invoices`,
        { method: "POST", body: payload, signal: guard.signal },
      );
      if (!guard.isCurrent()) return;
      setUnknown(false);
      // A confirmed posting must not become "unknown" if refreshing a
      // read-only query fails afterwards.
      await invalidate().catch(() => undefined);
      if (!guard.isCurrent()) return;
      const next = emptyLine();
      pending.current = null;
      setLines([next]);
      setAccount(initialInvoiceAccount(kind, defaultCashbox));
      setSupplier(null);
      setSupplierReceiptNumber("");
      accountManuallyChosen.current = false;
      setOriginal(null);
      setShowOriginalPicker(false);
      setDocumentDate(today());
      setDescription("");
      setDiscount("0");
      // Reuse currency, branch and stock location for efficient consecutive
      // invoices, but always clear the old customer/supplier.
      currencyManuallyChosen.current = false;
      branchManuallyChosen.current = false;
      locationManuallyChosen.current = false;
      automaticCurrencyId.current = currency?.id ?? null;
      automaticBranchId.current = branch?.id ?? null;
      automaticLocationId.current = location?.id ?? null;
      setSavedInvoice({
        id: response.invoice.id,
        number: response.invoice.number,
      });
      focus(lineInputId(next, "item-search"));
    } catch (error) {
      if (!guard.isCurrent()) return;
      const uncertain = !(error instanceof ApiFailure) || error.status >= 500;
      setMemoBlocked(error instanceof ApiFailure && error.code==="memo_feature_block");
      setUnknown(uncertain);
      if (!uncertain) pending.current = null;
      setError(
        uncertain
          ? "لم تصل نتيجة مؤكدة للحفظ. أعد تأكيد الطلب نفسه؛ لن تنشأ فاتورة ثانية. " +
              errorMessage(error)
          : errorMessage(error),
      );
    } finally {
      if (guard.isCurrent()) setSaving(false);
    }
  }
  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (editingItem) {
          document
            .querySelector<HTMLFormElement>(".invoice-item-sheet form")
            ?.requestSubmit();
          return;
        }
        void save();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
  return (
    <div className="commerce-document-page">
      <form onSubmit={(event) => void save(event)} className="commerce-editor">
        <Card className="commerce-header-card">
          <fieldset disabled={locked} className="commerce-fieldset">
            <div className="commerce-header-grid">
              <div className="commerce-header-content">
                <ServerLookup<Account>
                  companyId={companyId}
                  resource={`/companies/${companyId}/commerce-options?type=accounts`}
                  label={
                    kind === "sale"
                      ? "حساب العميل / النقد"
                      : "حساب السداد / الذمة"
                  }
                  value={account}
                  onChange={(value) => {
                    accountManuallyChosen.current = true;
                    setAccount(value);
                    if (kind === "purchase" && value?.category === "liability" && !value.cashOrBank)
                      setSupplier(value);
                  }}
                  display={itemLabel}
                  disabled={locked || hasLinkedLines}
                  required
                />
                {kind === "purchase" && (
                  <ServerLookup<Account>
                    companyId={companyId}
                    resource={`/companies/${companyId}/commerce-options?type=accounts`}
                    label="المورد الفعلي"
                    value={selectedSupplier}
                    onChange={setSupplier}
                    display={itemLabel}
                    accept={(value) => (value.category === "asset" || value.category === "liability") && !value.cashOrBank}
                    disabled={locked || hasLinkedLines || creditPurchase}
                  />
                )}
                {kind === "purchase" && (
                  <Field
                    label="رقم الوصل"
                    placeholder="رقم فاتورة المورد"
                    maxLength={100}
                    value={supplierReceiptNumber}
                    disabled={locked}
                    onChange={(event) => setSupplierReceiptNumber(event.target.value)}
                  />
                )}
                <Link
                  className="button button-secondary commerce-list-link"
                  to={listPath(companyId, kind)}
                >
                  قائمة الفواتير
                </Link>
                <Field
                  label="تاريخ الفاتورة"
                  type="date"
                  required
                  value={documentDate}
                  onChange={(event) => setDocumentDate(event.target.value)}
                />
                <Button
                  variant="secondary"
                  disabled={locked}
                  onClick={() => setShowOriginalPicker((shown) => !shown)}
                >
                  {showOriginalPicker ? "إخفاء ربط الأصل" : "ربط مردود بأصل"}
                </Button>
                <ServerLookup<CompanyCurrency>
                  companyId={companyId}
                  resource={`/companies/${companyId}/commerce-options?type=currencies`}
                  label="عملة الفاتورة"
                  value={currency}
                  onChange={(value) => {
                    currencyManuallyChosen.current = true;
                    setCurrency(value);
                  }}
                  display={(value) => `${value.code} — ${value.name}`}
                  disabled={locked || hasLinkedLines}
                  required
                />
                <ServerLookup<Branch>
                  companyId={companyId}
                  resource={`/companies/${companyId}/commerce-options?type=branches`}
                  label="الفرع"
                  value={branch}
                  onChange={(value) => {
                    branchManuallyChosen.current = true;
                    locationManuallyChosen.current = false;
                    automaticLocationId.current = null;
                    setBranch(value);
                    setLocation(null);
                  }}
                  display={itemLabel}
                  disabled={locked || (!!branch && selectedLines.length > 0)}
                  required
                />
                <ServerLookup<Location>
                  companyId={companyId}
                  resource={`/companies/${companyId}/commerce-options?type=locations${branch ? `&branchId=${branch.id}` : ""}${kind === "sale" ? "&kind=showroom" : ""}`}
                  label="المعرض / المخزن"
                  value={location}
                  onChange={(value) => {
                    locationManuallyChosen.current = true;
                    setLocation(value);
                  }}
                  display={itemLabel}
                  accept={(value) => kind !== "sale" || value.kind === "showroom"}
                  disabled={
                    locked || !branch || (!!location && selectedLines.length > 0)
                  }
                  required
                />
              {showOriginalPicker && (
              <>
                <OriginalInvoicePicker
                  companyId={companyId}
                  kind={kind}
                  value={original}
                  disabled={locked || hasLinkedLines}
                  onChange={(value) => {
                    if (
                      value &&
                      selectedLines.length &&
                      ((currency && currency.id !== value.currencyId) ||
                        (account &&
                          account.id !== value.counterpartyAccountId) ||
                        (branch && branch.id !== value.branchId) ||
                        (location && location.id !== value.locationId))
                    ) {
                      setError(
                        "اختر أصلًا يطابق حساب الفاتورة وعملتها وفرعها وموقعها؛ ستبقى السطور الحالية محفوظة.",
                      );
                      return;
                    }
                    setOriginal(value);
                    if (value) {
                      addOriginalRow();
                      setCurrency({
                        id: value.currencyId,
                        companyId,
                        code: value.currencyCode,
                        name: value.currencyCode,
                        decimalPlaces: value.decimalPlaces,
                        active: true,
                        createdBy: user?.id ?? 0,
                        createdAt: "",
                      });
                      setBranch({
                        id: value.branchId,
                        companyId,
                        code: "",
                        name: value.branchName,
                        active: true,
                        phone: "",
                        address: "",
                        createdBy: 0,
                        createdAt: "",
                      });
                      setLocation({
                        id: value.locationId,
                        companyId,
                        branchId: value.branchId,
                        code: "",
                        name: value.locationName,
                        kind: kind === "sale" ? "showroom" : "warehouse",
                        active: true,
                        branchName: value.branchName,
                        branchActive: true,
                        effectiveActive: true,
                        createdBy: 0,
                        createdAt: "",
                      });
                      accountManuallyChosen.current = true;
                      setSupplier(
                        kind === "purchase" && value.supplierAccountId !== null
                          ? {
                              id: value.supplierAccountId,
                              companyId,
                              code: value.supplierAccountCode ?? "",
                              name: value.supplierAccountName ?? "",
                              parentId: null,
                              parentCode: null,
                              parentName: null,
                              kind: "posting",
                              category: "liability",
                              accountChoice: null,
                              normalSide: "credit",
                              active: true,
                              cashOrBank: false,
                              rangeStart: null,
                              rangeEnd: null,
                              createdBy: 0,
                              createdAt: "",
                            }
                          : null,
                      );
                      setAccount({
                        id: value.counterpartyAccountId,
                        companyId,
                        code: value.counterpartyAccountCode,
                        name: value.counterpartyAccountName,
                        parentId: null,
                        parentCode: null,
                        parentName: null,
                        kind: "posting",
                        category: "asset",
                        accountChoice: null,
                        normalSide: "debit",
                        active: true,
                        cashOrBank: false,
                        rangeStart: null,
                        rangeEnd: null,
                        createdBy: 0,
                        createdAt: "",
                      });
                    } else
                      setLines((current) =>
                        current.map((line) =>
                          line.originalSelection && !line.originalLineId
                            ? { ...emptyLine(), key: line.key }
                            : line,
                        ),
                      );
                  }}
                />
                {original && (
                  <Button
                    variant="ghost"
                    size="compact"
                    disabled={locked || selectedLines.length >= 100}
                    onClick={addOriginalRow}
                  >
                    <Plus size={15} /> سطر مردود من الأصل
                  </Button>
                )}
              </>
              )}
              </div>
              <div className="commerce-header-blank" aria-hidden="true" />
            </div>
          </fieldset>
        </Card>
        {itemNotice && <Notice tone="success">{itemNotice}</Notice>}
        {memoImpact.data?.matches.filter(rule=>rule.effect!=="monitor").map(rule=>
          <Notice key={rule.ruleId} tone={rule.effect==="block"?"error":"warning"}>
            {rule.message} ({rule.count} تكليفات).
            {" "}<Link to={`/companies/${companyId}/memos?box=required`}>مطلوب مني</Link>
          </Notice>)}
        {savedInvoice && (
          <Notice tone="success">
            تم حفظ وترحيل الفاتورة رقم <bdi>{savedInvoice.number}</bdi> بنجاح.{" "}
            <Link to={invoicePath(companyId, savedInvoice.id)}>
              عرض الفاتورة المحفوظة
            </Link>
            . يمكنك إدخال الفاتورة التالية مباشرة.
          </Notice>
        )}
        <Card className="commerce-matrix-card">
          <fieldset disabled={locked} className="commerce-fieldset">
            <div
              className="commerce-lines-scroll"
              role="region"
              aria-label="سطور الفاتورة"
            >
              <table
                className={`commerce-lines commerce-matrix ${kind === "purchase" ? "commerce-matrix-purchase" : "commerce-matrix-sale"}`}
              >
                <colgroup>
                  <col className="commerce-col-item" />
                  <col className="commerce-col-unit" />
                  <col className="commerce-col-quantity" />
                  <col className="commerce-col-price" />
                  {showExpiry && <col className="commerce-col-expiry" />}
                  <col className="commerce-col-total" />
                  {kind === "sale" && (
                    <>
                      <col className="commerce-col-available" />
                      <col className="commerce-col-shelf" />
                    </>
                  )}
                  <col className="commerce-col-delete" />
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col">الصنف</th>
                    <th scope="col">الوحدة</th>
                    <th scope="col">الكمية</th>
                    <th scope="col">
                      {kind === "sale" ? "سعر البيع" : "سعر الشراء"}
                    </th>
                    {showExpiry && <th scope="col">تاريخ الانتهاء</th>}
                    <th scope="col">إجمالي</th>
                    {kind === "sale" && (
                      <>
                        <th
                          scope="col"
                          title="الرصيد المتاح في الموقع المختار، بالوحدة الأولى للصنف"
                        >
                          الكمية
                        </th>
                        <th scope="col">الرف</th>
                      </>
                    )}
                    <th scope="col">
                      <span className="visually-hidden">تعديل وحذف</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => {
                    let lineTotal = "0";
                    try {
                      if (line.itemId)
                        lineTotal = calculateInvoiceTotals(
                          [calculationLine(line)],
                          "0",
                          currency?.decimalPlaces ?? 6,
                        ).total;
                    } catch {
                      lineTotal = "—";
                    }
                    return (
                      <tr
                        key={line.key}
                        data-line-key={line.key}
                        data-selected={!!line.itemId}
                        onKeyDownCapture={(event) => {
                          // RTL invoice matrix: right returns to the preceding
                          // control, left advances to the following control.
                          // Skip disabled controls and non-interactive cells
                          // (totals, available stock, shelf) within this row.
                          if (
                            locked ||
                            (event.key !== "ArrowRight" && event.key !== "ArrowLeft") ||
                            event.altKey || event.ctrlKey || event.metaKey ||
                            event.shiftKey || event.nativeEvent.isComposing
                          ) return;
                          const controls = Array.from(
                            event.currentTarget.querySelectorAll<HTMLElement>(
                              'input:not([type="hidden"]):not(:disabled), select:not(:disabled), button:not(:disabled)',
                            ),
                          ).filter((element) => element.getClientRects().length > 0);
                          const position = controls.findIndex(
                            (element) => element === event.target ||
                              element.contains(event.target as Node),
                          );
                          if (position < 0) return;
                          const target = controls[
                            position + (event.key === "ArrowRight" ? -1 : 1)
                          ];
                          if (!target) return;
                          event.preventDefault();
                          event.stopPropagation();
                          target.focus();
                        }}
                      >
                        <td>
                          {line.originalSelection && original ? (
                            <Select
                              id={lineInputId(line, "original-line")}
                              className="item-cell-field"
                              label="الصنف المرتجع من الأصل"
                              value={line.originalLineId ?? ""}
                              disabled={!original}
                              onChange={(event) => {
                                const source = original?.lines.find(
                                  (entry) =>
                                    entry.id === Number(event.target.value),
                                );
                                chooseOriginalLine(line, source);
                              }}
                            >
                              <option value="">اختر سطر الأصل</option>
                              {original?.lines
                                .filter(
                                  (entry) => !entry.quantity.startsWith("-"),
                                )
                                .map((entry) => (
                                  <option
                                    key={entry.id}
                                    value={entry.id}
                                    disabled={selectedLines.some(
                                      (selected) =>
                                        selected.key !== line.key &&
                                        selected.originalLineId === entry.id,
                                    )}
                                  >
                                    {entry.itemCode} — {entry.itemName} —{" "}
                                    {entry.quantity} {entry.unitName}
                                  </option>
                                ))}
                            </Select>
                          ) : (
                            <ItemSearch
                              companyId={companyId}
                              id={lineInputId(line, "item-search")}
                              value={line.search}
                              selected={!!line.itemId}
                              disabled={locked}
                              onQueryChange={(value) =>
                                updateLine(line.key, {
                                  ...emptyLine(),
                                  key: line.key,
                                  search: value,
                                })
                              }
                              onChoose={(selected) =>
                                chooseItem(line, selected)
                              }
                              onConfirmSelected={() =>
                                focus(lineInputId(line, "quantity"))
                              }
                              onFinishEntry={kind === "sale" ? () => focus("invoice-notes") : undefined}
                            />
                          )}
                        </td>
                        <td>
                          <Select
                            className="item-cell-field"
                            label={`الوحدة${line.itemName ? ` ${line.itemName}` : ""}`}
                            value={line.unit}
                            disabled={!!line.originalLineId || !line.itemId}
                            onChange={(event) => {
                              if (!line.sourceItem) return;
                              const level = Number(event.target.value) as
                                1 | 2 | 3;
                              updateLine(line.key, {
                                unit: level,
                                unitName: unitName(line.sourceItem, level),
                                ...(kind === "sale"
                                  ? {
                                      unitPrice: salePrice(
                                        line.sourceItem,
                                        level,
                                      ),
                                    }
                                  : {}),
                              });
                            }}
                            onKeyDown={(event) => {
                              if (
                                event.key !== "Enter" ||
                                !line.sourceItem ||
                                line.originalLineId
                              )
                                return;
                              // The selected native option must be committed without
                              // submitting the invoice form.
                              event.preventDefault();
                              const level = Number(
                                event.currentTarget.value,
                              ) as 1 | 2 | 3;
                              if (![1, 2, 3].includes(level)) return;
                              updateLine(line.key, {
                                unit: level,
                                unitName: unitName(line.sourceItem, level),
                                ...(kind === "sale"
                                  ? {
                                      unitPrice: salePrice(
                                        line.sourceItem,
                                        level,
                                      ),
                                    }
                                  : {}),
                              });
                              focus(lineInputId(line, "quantity"));
                            }}
                          >
                            {line.originalLineId ? (
                              <option value={line.unit}>
                                {line.unitName || "—"}
                              </option>
                            ) : (
                              <>
                                <option value="1">
                                  {line.sourceItem?.unit1Name || "—"}
                                </option>
                                {!!line.sourceItem &&
                                  line.sourceItem.factor2 > 1 && (
                                    <option value="2">
                                      {line.sourceItem.unit2Name}
                                    </option>
                                  )}
                                {!!line.sourceItem &&
                                  line.sourceItem.factor3 > 1 && (
                                    <option value="3">
                                      {line.sourceItem.unit3Name}
                                    </option>
                                  )}
                              </>
                            )}
                          </Select>
                        </td>
                        <td>
                          <Field
                            id={lineInputId(line, "quantity")}
                            className="item-cell-field"
                            label={
                              line.itemName ? `كمية ${line.itemName}` : "الكمية"
                            }
                            inputMode="text"
                            disabled={!line.itemId}
                            value={line.quantity}
                            onChange={(event) =>
                              changeQuantity(line, event.target.value)
                            }
                            onFocus={(event) => event.target.select()}
                            onKeyDown={(event) => {
                              if (event.key !== "Enter") return;
                              event.preventDefault();
                              setError("");
                              if (!validateQuantity(line)) return;
                              if (kind === "purchase" && !line.originalLineId)
                                focus(lineInputId(line, "price"));
                              else nextLine(line);
                            }}
                          />
                        </td>
                        <td>
                          <Field
                            id={lineInputId(line, "price")}
                            className="item-cell-field"
                            label={
                              line.itemName
                                ? `سعر ${line.itemName}`
                                : "سعر الوحدة"
                            }
                            inputMode="decimal"
                            money
                            readOnly={kind === "sale" || !!line.originalLineId}
                            disabled={!line.itemId}
                            value={line.unitPrice}
                            title={
                              kind === "sale"
                                ? "سعر ثابت من كرت الصنف للوحدة المختارة"
                                : line.sourceItem?.purchaseNotes
                            }
                            onChange={(event) =>
                              updateLine(line.key, {
                                unitPrice: event.target.value,
                              })
                            }
                            onFocus={(event) => event.target.select()}
                            onKeyDown={(event) => {
                              if (event.key !== "Enter") return;
                              event.preventDefault();
                              if (
                                kind === "purchase" &&
                                !line.originalLineId &&
                                line.sourceItem?.hasExpiry
                              )
                                focus(lineInputId(line, "expiry"));
                              else nextLine(line);
                            }}
                          />
                        </td>
                        {showExpiry && (
                          <td>
                            {line.originalLineId ? (
                              line.expiryDate || "—"
                            ) : line.sourceItem?.hasExpiry &&
                              (kind === "purchase" ||
                                normalizeDigits(
                                  line.quantity.trim(),
                                ).startsWith("-")) ? (
                              <Field
                                id={lineInputId(line, "expiry")}
                                className="item-cell-field"
                                label={`تاريخ انتهاء ${line.itemName}`}
                                type="date"
                                required={kind === "purchase"}
                                value={line.expiryDate ?? ""}
                                onChange={(event) =>
                                  updateLine(line.key, {
                                    expiryDate: event.target.value || null,
                                  })
                                }
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") {
                                    event.preventDefault();
                                    nextLine(line);
                                  }
                                }}
                              />
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                        )}
                        <td className="commerce-line-total" aria-live="polite">
                          {amount(lineTotal)}
                        </td>
                        {kind === "sale" && (
                          <>
                            <td
                              className="commerce-line-available"
                              title="المتاح في المعرض/المخزن المختار بالوحدة الأولى للصنف"
                            >
                              {line.itemId && location
                                ? stockPreview.isFetching &&
                                  !stockByItem.has(line.itemId)
                                  ? "…"
                                  : stockPreview.isError
                                    ? "—"
                                    : stockByItem.has(line.itemId) &&
                                        line.sourceItem
                                      ? saleStockQuantity(
                                          stockByItem.get(line.itemId)!
                                            .quantitySmallest,
                                          line.sourceItem,
                                          1,
                                          1,
                                        )
                                      : "—"
                                : "—"}
                            </td>
                            <td className="commerce-line-shelf">
                              <span
                                title={
                                  line.sourceItem?.shelf ||
                                  stockByItem.get(line.itemId)?.shelf ||
                                  "الرف غير محدد"
                                }
                              >
                                {line.sourceItem?.shelf ||
                                  stockByItem.get(line.itemId)?.shelf ||
                                  "—"}
                              </span>
                            </td>
                          </>
                        )}
                        <td>
                          <div className="commerce-line-actions">
                            <Button
                              variant="ghost"
                              size="compact"
                              aria-label={`تعديل كرت ${line.itemName || "الصنف"}`}
                              title={
                                !line.itemId
                                  ? "اختر الصنف أولًا"
                                  : canEditItem
                                    ? "تعديل كرت الصنف"
                                    : "تعديل كرت الصنف يحتاج صلاحية تعديل الأصناف"
                              }
                              disabled={!line.itemId || !canEditItem || locked}
                              onClick={() => {
                                setEditingBusy(false);
                                setEditingItem({
                                  itemId: line.itemId,
                                  lineKey: line.key,
                                });
                              }}
                            >
                              <Pencil size={15} />
                            </Button>
                            <Button
                              variant="ghost"
                              size="compact"
                              aria-label={`حذف ${line.itemName || "السطر الفارغ"}`}
                              className="commerce-delete-line"
                              onClick={() => deleteLine(line)}
                            >
                              <Trash2 size={15} />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="commerce-matrix-actions">
              <Button
                variant="ghost"
                size="compact"
                onClick={() => nextLine()}
                disabled={locked || selectedLines.length >= 100}
              >
                <Plus size={15} /> سطر جديد
              </Button>
              <span className="muted">{selectedLines.length} / 100</span>
            </div>
          </fieldset>
        </Card>
        <footer
          className="card commerce-save-footer"
          aria-label="إجمالي الفاتورة والحفظ"
        >
          {error && <Notice tone="error">{error}
            {memoBlocked&&<>{" "}<Link to={`/companies/${companyId}/memos?box=required`}>فتح «مطلوب مني» لمعالجة التكليفات</Link></>}
          </Notice>}
          {selectedLines.length > 0 && totals?.total === "0" && (
            <Notice>
              الصافي صفر؛ سيُحفظ أثر الأصناف والتكلفة، دون مبلغ على الحساب
              المقابل.
            </Notice>
          )}
          <div className="commerce-footer-grid">
            <Field
              id="invoice-notes"
              label="ملاحظات الفاتورة"
              value={description}
              maxLength={1000}
              disabled={locked}
              onChange={(event) => setDescription(event.target.value)}
              onKeyDown={(event) => {
                if (kind !== "sale" || event.key !== "Enter" || event.nativeEvent.isComposing) return;
                event.preventDefault();
                focus("invoice-discount");
              }}
            />
            <Field
              id="invoice-discount"
              label="الخصم"
              money
              value={hasPositiveLines ? discount : "0"}
              inputMode="decimal"
              disabled={locked || !hasPositiveLines}
              onChange={(event) => setDiscount(event.target.value)}
              onKeyDown={(event) => {
                if (kind !== "sale" || event.key !== "Enter" || event.nativeEvent.isComposing) return;
                event.preventDefault();
                focus("invoice-save");
              }}
            />
            <div className="commerce-totals" aria-live="polite">
              <span>
                الإجمالي <strong>{amount(totals?.gross ?? "—")}</strong>
              </span>
              <span>
                الصافي{" "}
                <strong>
                  {amount(totals?.total ?? "—")} {currency?.code}
                </strong>
              </span>
            </div>
            <div className="commerce-save-actions">
              <Button
                variant="secondary"
                onClick={resetInvoice}
                disabled={locked || !!editingItem}
              >
                تصفير الفاتورة
              </Button>
              <Button id="invoice-save" type="submit" disabled={saving || !selectedLines.length}>
                {saving
                  ? "جارٍ الحفظ والترحيل…"
                  : unknown
                    ? "تأكيد نتيجة الطلب نفسه"
                    : "حفظ وترحيل الفاتورة"}
              </Button>
            </div>
          </div>
          {hasLinkedLines && (
            <small className="muted">
              خصم المردود المعروض تقديري من الأصل؛ المبلغ النهائي بعد المردودات
              السابقة يؤكده الخادم. لا يسمح بتجاوز الكمية الأصلية.
            </small>
          )}
        </footer>
      </form>
      <Dialog
        open={editingItem !== null}
        className="invoice-item-sheet"
        title="تعديل كرت الصنف"
        onClose={closeItemEditor}
      >
        {editingItem && (
          <Suspense fallback={<Notice>جارٍ تحميل كرت الصنف…</Notice>}>
            <InvoiceItemEditor
              key={`${user?.id}:${companyId}:${editingItem.itemId}`}
              context={context}
              itemId={editingItem.itemId}
              onSaved={itemSaved}
              onClose={closeItemEditor}
              onSavingChange={setEditingBusy}
            />
          </Suspense>
        )}
      </Dialog>
      <Dialog
        open={blocker.state === "blocked"}
        title="مغادرة الفاتورة"
        onClose={() => {
          if (blocker.state === "blocked") blocker.reset();
        }}
      >
        <p>
          {unknown
            ? "نتيجة الحفظ غير معروفة. أعد تأكيد الطلب نفسه قبل بدء فاتورة أخرى."
            : saving
              ? "جارٍ حفظ الفاتورة. انتظر تأكيد النتيجة."
              : "توجد مدخلات غير محفوظة في الفاتورة."}
        </p>
        <div className="form-actions">
          <Button
            variant="secondary"
            onClick={() => {
              if (blocker.state === "blocked") blocker.reset();
            }}
          >
            البقاء في الفاتورة
          </Button>
          <Button
            variant="danger"
            disabled={saving || unknown}
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

function InvoiceViewer({
  context,
  invoiceId,
}: {
  context: CompanyContext;
  invoiceId: number;
}) {
  const companyId = context.company.id;
  const { user } = useSession();
  const result = useQuery({
    queryKey: ["commerce", user?.id, companyId, "invoice", invoiceId],
    queryFn: ({ signal }) =>
      api<{ invoice: Invoice }>(
        `/companies/${companyId}/invoices/${invoiceId}`,
        { signal },
      ),
    enabled: !!user && Number.isSafeInteger(invoiceId) && invoiceId > 0,
  });
  if (result.isPending) return <Notice>جارٍ تحميل الفاتورة…</Notice>;
  if (result.error)
    return (
      <Notice tone="error">
        {errorMessage(result.error)}{" "}
        <Button variant="ghost" onClick={() => void result.refetch()}>
          إعادة المحاولة
        </Button>
      </Notice>
    );
  const invoice = result.data?.invoice;
  if (!invoice) return <Notice tone="error">الفاتورة غير موجودة.</Notice>;
  const returning =
    invoice.lines.length > 0 &&
    invoice.lines.every((line) => line.quantity.startsWith("-"));
  return (
    <div className="commerce-document-page">
      <div className="commerce-no-print">
        <PageHeader
          title={`${returning ? "مردود " : ""}${title(invoice.kind)} ${invoice.number}`}
          actions={
            <>
              <Link
                className="button button-secondary"
                to={listPath(companyId, invoice.kind)}
              >
                قائمة الفواتير
              </Link>
              <Button variant="secondary" onClick={() => window.print()}>
                <Printer size={16} />
                طباعة
              </Button>
              {canPost(context) && (
                <Link
                  className="button button-primary"
                  to={`${invoicePath(companyId, "new")}?kind=${invoice.kind}`}
                >
                  فاتورة جديدة
                </Link>
              )}
            </>
          }
        />
      </div>
      <Card className="commerce-print-document">
        <div className="commerce-print-heading">
          <strong>{context.company.name}</strong>
          <h2>
            {returning ? "مردود " : ""}
            {title(invoice.kind)}
          </h2>
          <bdi>{invoice.number}</bdi>
        </div>
        <div className="commerce-document-meta">
          <span>
            التاريخ: <bdi>{invoice.documentDate}</bdi>
          </span>
          <span>الفرع: {invoice.branchName}</span>
          <span>الموقع: {invoice.locationName}</span>
          <span>
            {invoice.kind === "purchase" ? "حساب السداد / الذمة" : "الحساب"}:{" "}
            <bdi>{invoice.counterpartyAccountCode}</bdi> —{" "}
            {invoice.counterpartyAccountName}
          </span>
          {invoice.kind === "purchase" && (
            <span>رقم الوصل: <bdi>{invoice.supplierReceiptNumber || "—"}</bdi></span>
          )}
          {invoice.kind === "purchase" && (
            <span>
              المورد:{" "}
              {invoice.supplierAccountId !== null ? (
                <>
                  <bdi>{invoice.supplierAccountCode}</bdi> — {invoice.supplierAccountName}
                </>
              ) : "غير محدد"}
            </span>
          )}
          <span>
            العملة: <bdi>{invoice.currencyCode}</bdi>
          </span>
          <span>أنشأها: {invoice.createdByName}</span>
          <span>
            وقت الإنشاء:{" "}
            <bdi>
              {new Date(invoice.createdAt).toLocaleString("ar-YE", {
                timeZone: "Asia/Aden",
              })}
            </bdi>
          </span>
          <span className="financial-status financial-status-posted">مرحل</span>
        </div>
        <div className="commerce-lines-scroll">
          <table className="commerce-lines">
            <thead>
              <tr>
                <th>#</th>
                <th>الرمز</th>
                <th>الصنف</th>
                <th>الوحدة</th>
                <th>الكمية</th>
                <th>السعر</th>
                {invoice.kind === "purchase" && <th>الانتهاء</th>}
                <th>الخصم</th>
                <th>الصافي</th>
                {invoice.kind === "sale" && context.general && (
                  <th className="commerce-no-print">عمولة التصريف</th>
                )}
              </tr>
            </thead>
            <tbody>
              {invoice.lines.map((line, index) => (
                <tr key={line.id}>
                  <td>{index + 1}</td>
                  <td>
                    <bdi>{line.itemCode}</bdi>
                  </td>
                  <td>
                    <ValueCell>{line.itemName}</ValueCell>
                  </td>
                  <td>{line.unitName}</td>
                  <td>{amount(line.quantity)}</td>
                  <td>{amount(line.unitPrice)}</td>
                  {invoice.kind === "purchase" && (
                    <td>{line.expiryDate || "—"}</td>
                  )}
                  <td>{amount(line.discount)}</td>
                  <td>{amount(line.total)}</td>
                  {invoice.kind === "sale" && context.general && (
                    <td className="commerce-no-print">
                      {amount(line.commissionAmount)} ({line.commissionRate}%)
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {invoice.kind === "sale" &&
          context.general &&
          invoice.lines.some((line) => line.commissionAmount !== "0") && (
            <Notice>
              مبالغ عمولة التصريف محسوبة ومثبتة على سطور هذه الفاتورة حسب فترة
              الصنف. لا تمثل صرفًا نقديًا أو قيدًا على حساب موظف قبل اعتماد
              المستفيد والتسوية.
            </Notice>
          )}
        <div className="commerce-totals">
          <span>
            الإجمالي: <strong>{amount(invoice.gross)}</strong>
          </span>
          <span>
            الخصم: <strong>{amount(invoice.discount)}</strong>
          </span>
          <span>
            الصافي:{" "}
            <strong>
              {amount(invoice.total)} {invoice.currencyCode}
            </strong>
          </span>
        </div>
        {invoice.description && (
          <p className="commerce-invoice-notes">{invoice.description}</p>
        )}
        {invoice.total === "0" && (
          <Notice>
            صافي المستند صفر؛ لا يوجد مبلغ مستحق أو مردود على الحساب المقابل.
          </Notice>
        )}
        <div className="commerce-no-print form-actions">
          {invoice.financialDocumentId !== null && (
            <Link
              to={`/companies/${companyId}/financial-documents/${invoice.financialDocumentId}`}
            >
              القيد المحاسبي
            </Link>
          )}
          {invoice.costDocumentId && (
            <Link
              to={`/companies/${companyId}/financial-documents/${invoice.costDocumentId}`}
            >
              قيد تكلفة المبيعات
            </Link>
          )}
          {invoice.varianceDocumentId && (
            <Link
              to={`/companies/${companyId}/financial-documents/${invoice.varianceDocumentId}`}
            >
              قيد فرق تكلفة المردود
            </Link>
          )}
          <Link
            to={`/companies/${companyId}/stock-movements?invoiceId=${invoice.id}`}
          >
            حركات المخزون
          </Link>
        </div>
      </Card>
    </div>
  );
}
