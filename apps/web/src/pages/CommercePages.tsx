import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
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
import { errorMessage, ServerLookup } from "../phase2";
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

function ItemSearch({
  companyId,
  disabled,
  onChoose,
}: {
  companyId: number;
  disabled: boolean;
  onChoose: (item: Item) => void;
}) {
  const { user } = useSession();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [active, setActive] = useState(0);
  const [autoChoose, setAutoChoose] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(query.trim());
      setPage(1);
      setActive(0);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);
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
    setQuery("");
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
    <div className="commerce-item-search">
      <Field
        id="invoice-item-search"
        label="الصنف / الباركود"
        type="search"
        autoComplete="off"
        disabled={disabled}
        value={query}
        placeholder="امسح الباركود أو اكتب الاسم / الرمز"
        role="combobox"
        aria-expanded={!!search}
        aria-controls="invoice-item-results"
        aria-activedescendant={
          items[active] ? `invoice-item-result-${items[active].id}` : undefined
        }
        onChange={(event) => {
          setQuery(event.target.value);
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
            setQuery("");
            setSearch("");
            setAutoChoose("");
          }
          if (event.key === "Enter") {
            event.preventDefault();
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
      {search && (
        <div className="commerce-search-results">
          <ul
            id="invoice-item-results"
            role="listbox"
            aria-label="نتائج الأصناف"
          >
            {items.map((item, index) => (
              <li
                id={`invoice-item-result-${item.id}`}
                key={item.id}
                role="option"
                aria-selected={index === active}
              >
                <Button
                  variant={index === active ? "secondary" : "ghost"}
                  onClick={() => choose(item)}
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
        </div>
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
  const [branch, setBranch] = useState<Branch | null>(null);
  const [location, setLocation] = useState<Location | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [description, setDescription] = useState("");
  const [discount, setDiscount] = useState("0");
  const [isReturn, setIsReturn] = useState(false);
  const [original, setOriginal] = useState<Invoice | null>(null);
  const [originalLine, setOriginalLine] = useState<InvoiceLine | null>(null);
  const [item, setItem] = useState<Item | null>(null);
  const [unit, setUnit] = useState<1 | 2 | 3>(1);
  const [quantity, setQuantity] = useState("1");
  const [price, setPrice] = useState("0");
  const [expiry, setExpiry] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const pending = useRef<InvoiceInput | null>(null);
  const allowNavigation = useRef(false);
  const dirty =
    !!lines.length ||
    !!item ||
    !!original ||
    !!description ||
    !!account ||
    !!branch ||
    !!currency;
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
  const displayedPrice = isReturn
    ? (originalLine?.unitPrice ?? "0")
    : kind === "sale" && item
      ? salePrice(item, unit)
      : price;
  const totals = useMemo(() => {
    try {
      return calculateInvoiceTotals(
        lines.map((line) => ({
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
  function addLine() {
    setError("");
    const normalized = normalizeDigits(quantity.trim());
    if (!/^-?\d{1,22}$/.test(normalized) || BigInt(normalized) === 0n) {
      setError("الكمية عدد صحيح غير صفري حتى 22 رقمًا.");
      focus("invoice-quantity");
      return;
    }
    if (isReturn !== normalized.startsWith("-")) {
      setError(
        isReturn
          ? "أدخل كمية سالبة للمردود."
          : "اختر عملية مردود عند إدخال كمية سالبة.",
      );
      return;
    }
    if (lines.length >= 100) {
      setError("الحد الأقصى 100 سطر للفاتورة.");
      return;
    }
    if (isReturn) {
      if (!original || !originalLine) {
        setError("اختر الفاتورة الأصلية والصنف المرتجع أولًا.");
        return;
      }
      if (lines.some((line) => line.originalLineId === originalLine.id)) {
        setError(
          "سطر الأصل موجود في المردود. عدّل كميته في الجدول بدل إضافته مرتين.",
        );
        return;
      }
      if (
        lines.some(
          (line) =>
            line.originalLineId === originalLine.id &&
            !/^-\d{1,22}$/.test(normalizeDigits(line.quantity.trim())),
        )
      ) {
        setError("صحح كمية المردود في السطور السابقة قبل إضافة سطر آخر.");
        return;
      }
      const previousQuantity = lines
        .filter((line) => line.originalLineId === originalLine.id)
        .reduce(
          (sum, line) => sum + BigInt(normalizeDigits(line.quantity.trim())),
          0n,
        );
      if (
        -BigInt(normalized) - previousQuantity >
        BigInt(originalLine.quantity)
      ) {
        setError(
          "كمية المردود تتجاوز كمية السطر الأصلي. يتحقق الخادم أيضًا من المردودات السابقة.",
        );
        return;
      }
      setLines((current) => [
        ...current,
        {
          key: crypto.randomUUID(),
          itemId: originalLine.itemId,
          itemCode: originalLine.itemCode,
          itemName: originalLine.itemName,
          unit: originalLine.unit,
          unitName: originalLine.unitName,
          quantity: BigInt(normalized).toString(),
          unitPrice: originalLine.unitPrice,
          expiryDate: originalLine.expiryDate,
          originalLineId: originalLine.id,
        },
      ]);
      setOriginalLine(null);
      setQuantity("-1");
      focus("invoice-original-line");
    } else {
      if (!item) {
        setError("اختر صنفًا من نتائج البحث.");
        focus("invoice-item-search");
        return;
      }
      if (!currency || (kind === "sale" && item.currencyId !== currency.id)) {
        setError("اختر عملة الفاتورة؛ عملة سعر البيع يجب أن تطابقها.");
        return;
      }
      if (kind === "purchase" && item.hasExpiry && !expiry) {
        setError("تاريخ الانتهاء مطلوب للصنف المختار.");
        focus("invoice-expiry");
        return;
      }
      try {
        calculateInvoiceTotals(
          [{ quantity: normalized, unitPrice: displayedPrice }],
          "0",
          currency.decimalPlaces,
        );
      } catch (error) {
        setError(errorMessage(error));
        return;
      }
      setLines((current) => [
        ...current,
        {
          key: crypto.randomUUID(),
          itemId: item.id,
          itemCode: item.code,
          itemName: item.name,
          unit,
          unitName: unitName(item, unit),
          quantity: BigInt(normalized).toString(),
          unitPrice: displayedPrice,
          expiryDate: kind === "purchase" && item.hasExpiry ? expiry : null,
          originalLineId: null,
          sourceItem: item,
        },
      ]);
      setItem(null);
      setQuantity("1");
      setPrice("0");
      setExpiry("");
      setUnit(1);
      focus("invoice-item-search");
    }
  }
  function quantityKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (kind === "purchase" && !isReturn) focus("invoice-price");
    else addLine();
  }
  async function save(event?: FormEvent) {
    event?.preventDefault();
    if (saving || !guard.isCurrent()) return;
    setError("");
    let payload = pending.current;
    if (!unknown) {
      if (item || originalLine) {
        setError("أضف الصنف الجاري إلى السطور قبل الحفظ.");
        return;
      }
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
        lines: lines.map((line) => ({
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
    <div className="commerce-document-page">
      <PageHeader
        title={`${isReturn ? "مردود " : "إضافة "}${title(kind)}`}
        description="اختر الصنف ثم الكمية واضغط Enter لإضافة السطر. حفظ الفاتورة يرحّلها فورًا."
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
                disabled={lines.length > 0}
                value={isReturn ? "return" : "invoice"}
                onChange={(event) => {
                  const returning = event.target.value === "return";
                  setIsReturn(returning);
                  setQuantity(returning ? "-1" : "1");
                  setItem(null);
                  setOriginal(null);
                  setOriginalLine(null);
                  setDiscount("0");
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
                  setCurrency(value);
                }}
                display={(value) => `${value.code} — ${value.name}`}
                disabled={locked || lines.length > 0 || isReturn}
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
                  setBranch(value);
                  setLocation(null);
                }}
                display={itemLabel}
                disabled={locked || lines.length > 0 || isReturn}
                required
              />
              <ServerLookup<Location>
                companyId={companyId}
                resource={`/companies/${companyId}/commerce-options?type=locations${branch ? `&branchId=${branch.id}` : ""}${kind === "sale" ? "&kind=showroom" : ""}`}
                label="المعرض / المخزن"
                value={location}
                onChange={setLocation}
                display={itemLabel}
                accept={(value) => kind !== "sale" || value.kind === "showroom"}
                disabled={locked || !branch || lines.length > 0 || isReturn}
                required
              />
            </div>
            {isReturn && (
              <OriginalInvoicePicker
                companyId={companyId}
                kind={kind}
                value={original}
                disabled={locked || lines.length > 0}
                onChange={(value) => {
                  setOriginal(value);
                  setOriginalLine(null);
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
        <Card title="سطور الفاتورة">
          <fieldset disabled={locked} className="commerce-fieldset">
            <div className="commerce-add-grid">
              {isReturn ? (
                <Select
                  id="invoice-original-line"
                  label="الصنف المرتجع من الأصل"
                  value={originalLine?.id ?? ""}
                  disabled={!original}
                  onChange={(event) => {
                    const selected =
                      original?.lines.find(
                        (line) => line.id === Number(event.target.value),
                      ) ?? null;
                    setOriginalLine(selected);
                    setQuantity("-1");
                    if (selected) focus("invoice-quantity");
                  }}
                >
                  <option value="">اختر سطر الأصل</option>
                  {original?.lines
                    .filter((line) => !line.quantity.startsWith("-"))
                    .map((line) => (
                      <option key={line.id} value={line.id}>
                        {line.itemCode} — {line.itemName} — {line.quantity}{" "}
                        {line.unitName}
                      </option>
                    ))}
                </Select>
              ) : (
                <ItemSearch
                  companyId={companyId}
                  disabled={locked}
                  onChoose={(selected) => {
                    setItem(selected);
                    setUnit(1);
                    setQuantity("1");
                    setPrice(
                      currency && currency.id === selected.currencyId
                        ? selected.purchasePrice
                        : "0",
                    );
                    setExpiry("");
                    focus("invoice-quantity");
                  }}
                />
              )}
              <Select
                label="الوحدة"
                value={isReturn ? (originalLine?.unit ?? 1) : unit}
                disabled={locked || isReturn || !item}
                onChange={(event) =>
                  setUnit(Number(event.target.value) as 1 | 2 | 3)
                }
              >
                {isReturn ? (
                  <option value={originalLine?.unit ?? 1}>
                    {originalLine?.unitName ?? "—"}
                  </option>
                ) : (
                  <>
                    <option value="1">
                      {item?.unit1Name || "الوحدة الأولى"}
                    </option>
                    {item && item.factor2 > 1 && (
                      <option value="2">{item.unit2Name}</option>
                    )}
                    {item && item.factor3 > 1 && (
                      <option value="3">{item.unit3Name}</option>
                    )}
                  </>
                )}
              </Select>
              <Field
                id="invoice-quantity"
                label={isReturn ? "الكمية المرتجعة (سالبة)" : "الكمية"}
                inputMode="text"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                onKeyDown={quantityKey}
              />
              <Field
                id="invoice-price"
                label="سعر الوحدة"
                inputMode="decimal"
                value={displayedPrice}
                readOnly={kind === "sale" || isReturn}
                onChange={(event) => setPrice(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    if (kind === "purchase" && !isReturn && item?.hasExpiry)
                      focus("invoice-expiry");
                    else addLine();
                  }
                }}
              />
              {kind === "purchase" && !isReturn && (
                <Field
                  id="invoice-expiry"
                  label="تاريخ الانتهاء"
                  type="date"
                  disabled={!item?.hasExpiry}
                  value={expiry}
                  required={!!item?.hasExpiry}
                  onChange={(event) => setExpiry(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addLine();
                    }
                  }}
                />
              )}
              <Button
                onClick={addLine}
                disabled={locked || (isReturn ? !originalLine : !item)}
              >
                <Plus size={15} />
                إضافة السطر
              </Button>
            </div>
            {item && (
              <div className="commerce-selected-item">
                <strong>{itemLabel(item)}</strong>
                <span>{item.currencyCode}</span>
                {kind === "purchase" && item.purchaseNotes && (
                  <ValueCell>{item.purchaseNotes}</ValueCell>
                )}
                {kind === "sale" && (
                  <span className="muted">
                    السعر من كرت الصنف، ويتحقق منه الخادم عند الحفظ.
                  </span>
                )}
              </div>
            )}
            <div className="commerce-lines-scroll">
              <table className="commerce-lines">
                <thead>
                  <tr>
                    <th>الرمز</th>
                    <th>الصنف</th>
                    <th>الوحدة</th>
                    <th>الكمية</th>
                    <th>سعر الوحدة</th>
                    {kind === "purchase" && <th>الانتهاء</th>}
                    <th>الإجمالي</th>
                    <th>حذف</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, index) => (
                    <tr key={line.key}>
                      <td>
                        <bdi>{line.itemCode}</bdi>
                      </td>
                      <td>
                        <ValueCell>{line.itemName}</ValueCell>
                      </td>
                      <td>{line.unitName}</td>
                      <td>
                        <Field
                          className="item-cell-field"
                          label={`كمية ${line.itemName}`}
                          value={line.quantity}
                          inputMode="text"
                          onChange={(event) =>
                            setLines((current) =>
                              current.map((entry) =>
                                entry.key === line.key
                                  ? { ...entry, quantity: event.target.value }
                                  : entry,
                              ),
                            )
                          }
                        />
                      </td>
                      <td>
                        {kind === "purchase" && !isReturn ? (
                          <Field
                            className="item-cell-field"
                            label={`سعر ${line.itemName}`}
                            value={line.unitPrice}
                            inputMode="decimal"
                            onChange={(event) =>
                              setLines((current) =>
                                current.map((entry) =>
                                  entry.key === line.key
                                    ? {
                                        ...entry,
                                        unitPrice: event.target.value,
                                      }
                                    : entry,
                                ),
                              )
                            }
                          />
                        ) : (
                          amount(line.unitPrice)
                        )}
                      </td>
                      {kind === "purchase" && <td>{line.expiryDate || "—"}</td>}
                      <td>{amount(totals?.lineTotals[index] ?? "—")}</td>
                      <td>
                        <Button
                          variant="ghost"
                          size="compact"
                          aria-label={`حذف ${line.itemName}`}
                          onClick={() =>
                            setLines((current) =>
                              current.filter((entry) => entry.key !== line.key),
                            )
                          }
                        >
                          <Trash2 size={15} />
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {!lines.length && (
                    <tr>
                      <td colSpan={kind === "purchase" ? 8 : 7}>
                        أضف الأصناف إلى الفاتورة.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </fieldset>
        </Card>
        <Card className="commerce-save-footer">
          {error && <Notice tone="error">{error}</Notice>}
          {!isReturn && lines.length > 0 && totals?.total === "0" && (
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
            <Button type="submit" disabled={saving || !lines.length}>
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
        </Card>
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
