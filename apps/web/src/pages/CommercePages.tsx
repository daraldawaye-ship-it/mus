import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
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
import { Plus, Printer, Trash2 } from "lucide-react";
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
  <bdi className="financial-number">{value}</bdi>
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
  for (const key of ["dateFrom", "dateTo", "branchId", "locationId"])
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
      {
        id: "return",
        header: "العملية",
        size: 90,
        enableSorting: false,
        cell: ({ row }) =>
          row.original.lines.some((line) => line.quantity.startsWith("-"))
            ? "مردود"
            : kind === "sale"
              ? "بيع"
              : "شراء",
      },
      {
        accessorKey: "counterpartyAccountName",
        header: kind === "sale" ? "العميل / الحساب" : "المورد / الحساب",
        size: 190,
        enableSorting: false,
        cell: ({ row }) => (
          <ValueCell>{row.original.counterpartyAccountName}</ValueCell>
        ),
      },
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
        description="حفظ الفاتورة يثبت المخزون والقيد المحاسبي معًا. المردود مرتبط بسطور الفاتورة الأصلية."
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
}: {
  companyId: number;
  id: string;
  value: string;
  selected: boolean;
  disabled: boolean;
  onQueryChange: (value: string) => void;
  onChoose: (item: Item) => void;
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
            if (selected) return;
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
            {invoice.number} — {invoice.documentDate} — {invoice.total}{" "}
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

export function InvoicePage({ context }: { context: CompanyContext }) {
  const { invoiceId } = useParams();
  const [params] = useSearchParams();
  const { user } = useSession();
  const kind = params.get("kind") === "purchase" ? "purchase" : "sale";
  if (!commerceAccess(context))
    return <Notice tone="warning">ليس لديك صلاحية عرض الفواتير.</Notice>;
  if (invoiceId === "new")
    return canPost(context) ? (
      <InvoiceEditor
        key={`${user?.id}:${context.company.id}:${kind}`}
        context={context}
      />
    ) : (
      <Notice tone="warning">
        إنشاء الفاتورة يحتاج صلاحية إدارة الفواتير والترحيل المالي.
      </Notice>
    );
  return <InvoiceViewer context={context} invoiceId={Number(invoiceId)} />;
}
function InvoiceEditor({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const { user } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const kind: InvoiceKind =
    params.get("kind") === "purchase" ? "purchase" : "sale";
  const guard = useScopeGuard(`company:${companyId}:invoice-editor:${kind}`);
  const invalidate = useCommerceChanges(companyId);
  const [documentDate, setDocumentDate] = useState(today);
  const [currency, setCurrency] = useState<CompanyCurrency | null>(null);
  const defaultYer = useDefaultYerCurrency(companyId, "commerce-options");
  const currencyManuallyChosen = useRef(false);
  const automaticCurrencyId = useRef<number | null>(null);
  const [branch, setBranch] = useState<Branch | null>(null);
  const [location, setLocation] = useState<Location | null>(null);
  const [isReturn, setIsReturn] = useState(false);
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
        const exact = page.items.find((item) => item.active && item.code === code);
        if (exact) return exact;
      }
      return null;
    },
  });
  const showroomQuery = useQuery({
    queryKey: ["invoice-default-showroom", user?.id, companyId, branch?.id],
    enabled: !!user && !!branch && !isReturn,
    queryFn: ({ signal }) =>
      api<Page<Location>>(
        `/companies/${companyId}/commerce-options?type=locations&active=true&branchId=${branch!.id}&kind=showroom&pageSize=100`,
        { signal },
      ),
  });
  const [account, setAccount] = useState<Account | null>(null);
  const [description, setDescription] = useState("");
  const [discount, setDiscount] = useState("0");
  useEffect(() => {
    if (isReturn || !defaultYer || currencyManuallyChosen.current) return;
    if (currency === null) {
      automaticCurrencyId.current = defaultYer.id;
      setCurrency(defaultYer);
    }
  }, [defaultYer, currency, isReturn]);
  useEffect(() => {
    const main = mainBranchQuery.data;
    if (isReturn || !main || branchManuallyChosen.current || branch) return;
    automaticBranchId.current = main.id;
    setBranch(main);
  }, [mainBranchQuery.data, branch, isReturn]);
  useEffect(() => {
    if (isReturn || !branch || !showroomQuery.data ||
        locationManuallyChosen.current || location) return;
    const defaultShowroom = showroomQuery.data.items.find(
      (entry) => entry.active && entry.effectiveActive &&
        entry.branchId === branch.id && entry.code === "SHOWROOM" && entry.kind === "showroom",
    ) ?? showroomQuery.data.items.find(
      (entry) => entry.active && entry.effectiveActive &&
        entry.branchId === branch.id && entry.kind === "showroom",
    );
    if (!defaultShowroom) return;
    automaticLocationId.current = defaultShowroom.id;
    setLocation(defaultShowroom);
  }, [showroomQuery.data, branch, location, isReturn]);
  const [original, setOriginal] = useState<Invoice | null>(null);
  const [lines, setLines] = useState<DraftLine[]>(() => [emptyLine()]);
  const selectedLines = lines.filter((line) => line.itemId > 0);
  const pageRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLElement>(null);
  const [footerBounds, setFooterBounds] = useState({
    left: 0,
    width: 0,
    height: 0,
  });
  useLayoutEffect(() => {
    const page = pageRef.current;
    const footer = footerRef.current;
    if (!page || !footer) return;
    const measure = () => {
      const rect = page.getBoundingClientRect();
      const height = footer.getBoundingClientRect().height;
      setFooterBounds((previous) =>
        previous.left === rect.left &&
        previous.width === rect.width &&
        previous.height === height
          ? previous
          : { left: rect.left, width: rect.width, height },
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(page);
    observer.observe(footer);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const pending = useRef<InvoiceInput | null>(null);
  const allowNavigation = useRef(false);
  const dirty =
    lines.some((line) => line.itemId || line.search.trim()) ||
    !!original ||
    !!description ||
    !!account ||
    (!!branch &&
      (branchManuallyChosen.current || branch.id !== automaticBranchId.current)) ||
    (!!location &&
      (locationManuallyChosen.current || location.id !== automaticLocationId.current)) ||
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
  const focus = (id: string) =>
    window.requestAnimationFrame(() => {
      if (guard.isCurrent()) document.getElementById(id)?.focus();
    });
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
  const totals = useMemo(() => {
    try {
      return calculateInvoiceTotals(
        lines
          .filter((line) => line.itemId > 0)
          .map((line) => ({
            quantity: line.quantity,
            unitPrice: line.unitPrice,
          })),
        isReturn ? "0" : discount,
        currency?.decimalPlaces ?? 6,
      );
    } catch {
      return null;
    }
  }, [lines, discount, currency?.decimalPlaces, isReturn]);
  function updateLine(key: string, patch: Partial<DraftLine>) {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  }
  function chooseItem(line: DraftLine, selected: Item) {
    setError("");
    updateLine(line.key, {
      itemId: selected.id,
      itemCode: selected.code,
      itemName: selected.name,
      search: selected.name,
      sourceItem: selected,
      unit: 1,
      unitName: selected.unit1Name,
      quantity: "1",
      unitPrice:
        kind === "sale"
          ? selected.salePrice1
          : currency?.id === selected.currencyId
            ? selected.purchasePrice
            : "0",
      expiryDate: null,
      originalLineId: null,
    });
    focus(lineInputId(line, "quantity"));
  }
  function validateQuantity(line: DraftLine) {
    const normalized = normalizeDigits(line.quantity.trim());
    if (!/^-?\d{1,22}$/.test(normalized) || BigInt(normalized) === 0n) {
      setError("الكمية عدد صحيح غير صفري حتى 22 رقمًا.");
      focus(lineInputId(line, "quantity"));
      return false;
    }
    if (isReturn !== normalized.startsWith("-")) {
      setError(
        isReturn
          ? "أدخل كمية سالبة للمردود."
          : "اختر عملية مردود عند إدخال كمية سالبة.",
      );
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
        !isReturn &&
        line.sourceItem?.currencyId !== currency.id)
    ) {
      setError("اختر عملة الفاتورة؛ عملة سعر البيع يجب أن تطابقها.");
      return false;
    }
    if (isReturn) {
      const source = original?.lines.find(
        (entry) => entry.id === line.originalLineId,
      );
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
        [{ quantity: line.quantity, unitPrice: line.unitPrice }],
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
      focus(lineInputId(next, isReturn ? "original-line" : "item-search"));
      return;
    }
    if (selectedLines.length >= 100) {
      setError("الحد الأقصى 100 سطر للفاتورة.");
      return;
    }
    const created = emptyLine(isReturn);
    setLines((current) => [...current, created]);
    focus(lineInputId(created, isReturn ? "original-line" : "item-search"));
  }
  function deleteLine(line: DraftLine) {
    setError("");
    const remaining = lines.filter((entry) => entry.key !== line.key);
    const replacement = remaining.length ? remaining : [emptyLine(isReturn)];
    setLines(replacement);
    focus(
      lineInputId(
        replacement[Math.min(lines.indexOf(line), replacement.length - 1)],
        isReturn ? "original-line" : "item-search",
      ),
    );
  }
  async function save(event?: FormEvent) {
    event?.preventDefault();
    if (saving || !guard.isCurrent()) return;
    setError("");
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
        description,
        discount: isReturn ? "0" : discount,
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
      await invalidate();
      if (!guard.isCurrent()) return;
      allowNavigation.current = true;
      navigate(listPath(companyId, kind), {
        replace: true,
        state: {
          invoiceSaved: {
            id: response.invoice.id,
            number: response.invoice.number,
          },
        },
      });
    } catch (error) {
      if (!guard.isCurrent()) return;
      const uncertain = !(error instanceof ApiFailure) || error.status >= 500;
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
        void save();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
  return (
    <div
      className="commerce-document-page"
      ref={pageRef}
      style={{ paddingBottom: footerBounds.height + 12 }}
    >
      <PageHeader
        title={`${isReturn ? "مردود " : "إضافة "}${title(kind)}`}
        description={
          kind === "sale"
            ? "اختر الصنف ثم الكمية؛ Enter ينقلك للصنف التالي. سعر البيع من كرت الصنف."
            : "اختر الصنف ثم الكمية والسعر، وتاريخ الانتهاء للأصناف التي تتطلبه."
        }
        actions={
          <Link
            className="button button-secondary"
            to={listPath(companyId, kind)}
          >
            قائمة الفواتير
          </Link>
        }
      />
      <form onSubmit={(event) => void save(event)} className="commerce-editor">
        <Card className="commerce-header-card">
          <fieldset disabled={locked} className="commerce-fieldset">
            <div className="commerce-header-grid">
              <Field
                label="تاريخ الفاتورة"
                type="date"
                required
                value={documentDate}
                onChange={(event) => setDocumentDate(event.target.value)}
              />
              <Select
                label="العملية"
                disabled={selectedLines.length > 0}
                value={isReturn ? "return" : "invoice"}
                onChange={(event) => {
                  const returning = event.target.value === "return";
                  setIsReturn(returning);
                  setLines([emptyLine(returning)]);
                  setOriginal(null);
                  setDiscount("0");
                  if (!returning) {
                    // Switch back to a fresh invoice rather than retain an original
                    // return's branch, showroom and currency.
                    branchManuallyChosen.current = false;
                    locationManuallyChosen.current = false;
                    currencyManuallyChosen.current = false;
                    automaticBranchId.current = null;
                    automaticLocationId.current = null;
                    automaticCurrencyId.current = null;
                    setBranch(null);
                    setLocation(null);
                    setCurrency(null);
                  }
                }}
              >
                <option value="invoice">
                  {kind === "sale" ? "بيع" : "شراء"}
                </option>
                <option value="return">
                  {kind === "sale" ? "مردود مبيعات" : "مردود مشتريات"}
                </option>
              </Select>
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
                disabled={locked || isReturn}
                required
              />
              <ServerLookup<Account>
                companyId={companyId}
                resource={`/companies/${companyId}/commerce-options?type=accounts`}
                label={
                  kind === "sale"
                    ? "حساب العميل / النقد"
                    : "حساب المورد / النقد"
                }
                value={account}
                onChange={setAccount}
                display={itemLabel}
                disabled={locked || isReturn}
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
                disabled={
                  locked || (!!branch && selectedLines.length > 0) || isReturn
                }
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
                  locked ||
                  !branch ||
                  (!!location && selectedLines.length > 0) ||
                  isReturn
                }
                required
              />
            </div>
            {isReturn && (
              <OriginalInvoicePicker
                companyId={companyId}
                kind={kind}
                value={original}
                disabled={locked || selectedLines.length > 0}
                onChange={(value) => {
                  setOriginal(value);
                  setLines([emptyLine(true)]);
                  if (value) {
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
                      normalSide: "debit",
                      active: true,
                      cashOrBank: false,
                      rangeStart: null,
                      rangeEnd: null,
                      createdBy: 0,
                      createdAt: "",
                    });
                  } else {
                    setCurrency(null);
                    setBranch(null);
                    setLocation(null);
                    setAccount(null);
                  }
                }}
              />
            )}
          </fieldset>
        </Card>
        <Card className="commerce-matrix-card">
          <fieldset disabled={locked} className="commerce-fieldset">
            <div
              className="commerce-lines-scroll"
              role="region"
              aria-label="سطور الفاتورة"
            >
              <table
                className={`commerce-lines commerce-matrix ${kind === "purchase" ? "commerce-matrix-purchase" : ""}`}
              >
                <colgroup>
                  <col className="commerce-col-item" />
                  <col className="commerce-col-unit" />
                  <col className="commerce-col-quantity" />
                  <col className="commerce-col-price" />
                  {kind === "purchase" && (
                    <col className="commerce-col-expiry" />
                  )}
                  <col className="commerce-col-total" />
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
                    {kind === "purchase" && <th scope="col">تاريخ الانتهاء</th>}
                    <th scope="col">إجمالي الصنف</th>
                    <th scope="col">
                      <span className="visually-hidden">حذف</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => {
                    let lineTotal = "0";
                    try {
                      if (line.itemId)
                        lineTotal = calculateInvoiceTotals(
                          [
                            {
                              quantity: line.quantity,
                              unitPrice: line.unitPrice,
                            },
                          ],
                          "0",
                          currency?.decimalPlaces ?? 6,
                        ).gross;
                    } catch {
                      lineTotal = "—";
                    }
                    return (
                      <tr
                        key={line.key}
                        data-line-key={line.key}
                        data-selected={!!line.itemId}
                      >
                        <td>
                          {isReturn ? (
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
                                      }
                                    : { ...emptyLine(true), key: line.key },
                                );
                                if (source)
                                  focus(lineInputId(line, "quantity"));
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
                            />
                          )}
                        </td>
                        <td>
                          <Select
                            className="item-cell-field"
                            label={`الوحدة${line.itemName ? ` ${line.itemName}` : ""}`}
                            value={line.unit}
                            disabled={isReturn || !line.itemId}
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
                          >
                            {isReturn ? (
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
                              updateLine(line.key, {
                                quantity: event.target.value,
                              })
                            }
                            onFocus={(event) => event.target.select()}
                            onKeyDown={(event) => {
                              if (event.key !== "Enter") return;
                              event.preventDefault();
                              setError("");
                              if (!validateQuantity(line)) return;
                              if (kind === "purchase" && !isReturn)
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
                            readOnly={kind === "sale" || isReturn}
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
                                !isReturn &&
                                line.sourceItem?.hasExpiry
                              )
                                focus(lineInputId(line, "expiry"));
                              else nextLine(line);
                            }}
                          />
                        </td>
                        {kind === "purchase" && (
                          <td>
                            {isReturn ? (
                              line.expiryDate || "—"
                            ) : line.sourceItem?.hasExpiry ? (
                              <Field
                                id={lineInputId(line, "expiry")}
                                className="item-cell-field"
                                label={`تاريخ انتهاء ${line.itemName}`}
                                type="date"
                                required
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
                        <td>
                          <Button
                            variant="ghost"
                            size="compact"
                            aria-label={`حذف ${line.itemName || "السطر الفارغ"}`}
                            className="commerce-delete-line"
                            onClick={() => deleteLine(line)}
                          >
                            <Trash2 size={15} />
                          </Button>
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
          ref={footerRef}
          className="card commerce-save-footer"
          aria-label="إجمالي الفاتورة والحفظ"
          style={{
            left: footerBounds.left,
            width: footerBounds.width || undefined,
          }}
        >
          {error && <Notice tone="error">{error}</Notice>}
          {!isReturn && selectedLines.length > 0 && totals?.total === "0" && (
            <Notice>
              الصافي صفر؛ سيُحفظ أثر الأصناف والتكلفة، دون مبلغ على الحساب
              المقابل.
            </Notice>
          )}
          <div className="commerce-footer-grid">
            <Field
              label="ملاحظات الفاتورة"
              value={description}
              maxLength={1000}
              disabled={locked}
              onChange={(event) => setDescription(event.target.value)}
            />
            <Field
              label="الخصم"
              value={isReturn ? "0" : discount}
              inputMode="decimal"
              disabled={locked || isReturn}
              hint={
                isReturn
                  ? "خصم المردود مأخوذ من الأصل عند الحفظ."
                  : "مبلغ بعملة الفاتورة"
              }
              onChange={(event) => setDiscount(event.target.value)}
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
            <Button type="submit" disabled={saving || !selectedLines.length}>
              {saving
                ? "جارٍ الحفظ والترحيل…"
                : unknown
                  ? "تأكيد نتيجة الطلب نفسه"
                  : "حفظ وترحيل الفاتورة"}
            </Button>
          </div>
          {isReturn && (
            <small className="muted">
              الصافي المعروض قبل استرداد خصم الأصل؛ المبلغ النهائي يؤكده الخادم.
              لا يسمح بتجاوز الكمية الأصلية.
            </small>
          )}
        </footer>
      </form>
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
  const returning = invoice.lines.some((line) => line.quantity.startsWith("-"));
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
            الحساب: <bdi>{invoice.counterpartyAccountCode}</bdi> —{" "}
            {invoice.counterpartyAccountName}
          </span>
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
