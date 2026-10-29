import { canSearchInvoiceItem } from "../../../../packages/contracts/src/invoice-item-search.ts";
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
import { CompanyPrintHeader } from "../CompanyPrintHeader";
import { StagedInvoicesPanel } from "../StagedInvoiceViews";
import { InvoicePrintSheet } from "../InvoicePrintSheet";
import { InvoiceSaleAlerts } from "../InvoiceSaleAlerts";
import { InvoiceItemActionsDropdown, type InvoiceItemAction } from "../InvoiceItemActionsDropdown";
import { InvoiceItemAdjustmentSheet, InvoiceItemTransferSheet, InvoiceItemReportSheet } from "../InvoiceItemActionSheets";
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
  type Doctor,
  type SaleCustomer,
  type Invoice,
  type InvoiceInput,
  type InvoiceKind,
  type InvoiceLine,
  type Item,
  type ItemCompositionPeers,
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
import { useControls, isMobileDevice } from "../control";
import { ExpiryMonthField } from "../ExpiryMonthField";
import { useEmployeeCashbox } from "../employee-cashbox";
import { rememberRecentEntity } from "../recent-entities";
import { initialInvoiceAccount } from "../invoice-account-default";
import { SalesHeaderActionsDropdown } from "../SalesHeaderActionsDropdown";
import { PledgeDialogs } from "../PledgeDialogs";
import { invoiceSearchStock, saleStockQuantity } from "../sale-stock-quantity";
import { saleClearanceRate } from "../invoice-clearance-label";
import { formatMoney, formatWholeMoney } from "../format-money";
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
          // Purchase receipts and sales returns can advance nearest expiry on
          // the item card: refresh cached cards and sale alerts after posting.
          (queryKey[0] === "items" && queryKey[2] === companyId) ||
          (queryKey[0] === "master" && queryKey[2] === companyId) ||
          (queryKey[0] === "invoice-sale-alerts" && queryKey[2] === companyId) ||
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
  // Only query the selected day on opening Sales; "allDates" deliberately
  // distinguishes requesting history from the initial, date-free URL.
  const salesAllDates = kind === "sale" && params.get("allDates") === "1";
  const salesDefaultToday = kind === "sale" && !salesAllDates &&
    !params.has("dateFrom") && !params.has("dateTo");
  const dateFrom = params.get("dateFrom") ?? (salesDefaultToday ? today() : "");
  const dateTo = params.get("dateTo") ?? (salesDefaultToday ? today() : "");
  const filters = new URLSearchParams({ kind });
  if (dateFrom) filters.set("dateFrom", dateFrom);
  if (dateTo) filters.set("dateTo", dateTo);
  for (const key of ["branchId", "locationId", "supplierQ", "payerQ"])
    if (params.get(key)) filters.set(key, params.get(key)!);
  const list = usePagedQuery<Invoice>(
    `/companies/${companyId}/invoices?${filters}`,
    `company:${companyId}:invoices:${kind}`,
    kind === "sale" ? "id:desc" : "id:asc",
  );
  function setSaleDate(key: "dateFrom" | "dateTo", value: string) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      const from = previous.get("dateFrom") ?? (previous.get("allDates") === "1" ? "" : today());
      const to = previous.get("dateTo") ?? (previous.get("allDates") === "1" ? "" : today());
      next.delete("allDates");
      const updatedFrom = key === "dateFrom" ? value : from;
      const updatedTo = key === "dateTo" ? value : to;
      updatedFrom ? next.set("dateFrom", updatedFrom) : next.delete("dateFrom");
      updatedTo ? next.set("dateTo", updatedTo) : next.delete("dateTo");
      next.delete("page");
      return next;
    });
  }
  function setSalesDateMode(mode: "today" | "all") {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (mode === "today") {
        next.delete("allDates");
        next.set("dateFrom", today());
        next.set("dateTo", today());
      } else {
        next.set("allDates", "1");
        next.delete("dateFrom");
        next.delete("dateTo");
      }
      next.delete("page");
      return next;
    });
  }
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
      ...(kind === "sale" ? [{
        accessorKey: "doctorName",
        header: "الطبيب أو الجهة",
        size: 175,
        enableSorting: false,
        cell: ({row}) => row.original.doctorName && row.original.doctorId
          ? <Link to={`/companies/${companyId}/doctors?focus=${row.original.doctorId}`}>{row.original.doctorName}</Link>
          : <ValueCell>{row.original.doctorName || "—"}</ValueCell>,
      } satisfies ColumnDef<Invoice,unknown>,{
        id:"saleCustomer",
        header:"العميل",
        size:170,
        enableSorting:false,
        cell:({row})=>row.original.saleCustomerId
          ? <Link to={`/companies/${companyId}/sale-customers?focus=${row.original.saleCustomerId}`}>
              {row.original.saleCustomerNumber} — {row.original.saleCustomerName}
            </Link> : "—",
      } satisfies ColumnDef<Invoice,unknown>] : []),
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
        <div className={`table-filters invoice-kind-${kind}`} aria-label={`تصفية فواتير ${kind === "sale" ? "المبيعات" : "المشتريات"}`}>
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
            value={dateFrom}
            onChange={(event) =>
              kind === "sale" ? setSaleDate("dateFrom", event.target.value)
                : filter(setParams, "dateFrom", event.target.value)
            }
          />
          <Field
            label="إلى تاريخ"
            type="date"
            value={dateTo}
            onChange={(event) =>
              kind === "sale" ? setSaleDate("dateTo", event.target.value)
                : filter(setParams, "dateTo", event.target.value)
            }
          />
          {kind === "sale" && (
            <div className="form-actions">
              <Button variant="secondary" size="compact" onClick={() => setSalesDateMode("today")}>
                فواتير اليوم
              </Button>
              <Button variant="secondary" size="compact" onClick={() => setSalesDateMode("all")}>
                جميع التواريخ
              </Button>
            </div>
          )}
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
      <StagedInvoicesPanel companyId={companyId} kind={kind} q={list.query}
        dateFrom={dateFrom} dateTo={dateTo}
        supplierQ={params.get("supplierQ")??""} payerQ={params.get("payerQ")??""}
        branchId={params.get("branchId")??""} locationId={params.get("locationId")??""} />
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
  expiryManuallyEdited: boolean;
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
    expiryManuallyEdited: false,
    originalLineId: null,
    originalSelection: returning,
    originalSource: undefined,
    sourceItem: undefined,
  };
}
/** Suggest a physical return batch from the item's card, never from a previous invoice's batch. */
function suggestedReturnExpiry(item: Item | undefined): string | null {
  return item?.hasExpiry ? item.nearestExpiryDate ?? null : null;
}
const lineInputId = (line: DraftLine, field: string) =>
  `invoice-${field}-${line.key}`;


function ItemSearch({
  companyId,
  id,
  invoiceKind,
  documentDate,
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
  invoiceKind: InvoiceKind;
  documentDate: string;
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
    width: 680,
    maxHeight: 320,
  });
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [active, setActive] = useState(0);
  const [autoChoose, setAutoChoose] = useState("");
  useEffect(() => {
    if (selected || !open || !canSearchInvoiceItem(query)) {
      setSearch("");
      return;
    }
    const timer = window.setTimeout(() => {
      setSearch(query.trim());
      setPage(1);
      setActive(0);
    }, 240);
    return () => window.clearTimeout(timer);
  }, [query, selected, open]);
  // Do not open a dropdown or send a request for the first two characters.
  // Never leave previous-query suggestions visible while typing the next.
  const expanded = open && canSearchInvoiceItem(query) && !selected && !disabled;
  const searchCurrent = search === query.trim();
  useLayoutEffect(() => {
    if (!expanded) return;
    const position = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      // Give Arabic item names room while keeping stock and sale price visible.
      // On narrow screens the dropdown still fits within the viewport.
      const width = Math.min(Math.max(rect.width, 680), window.innerWidth - 16);
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
        `/companies/${companyId}/commerce-options?${new URLSearchParams({ type: "items", q: search, page: String(page), pageSize: "10", sort: "saleTimes:desc,code:asc", fast: "1" })}`,
        { signal },
      ),
    enabled: !!user && expanded && searchCurrent && canSearchInvoiceItem(search),
    staleTime: 30_000,
  });
  // A cached or in-flight result belongs to the *previous* input until the
  // current request finishes. Hide it entirely rather than showing disabled,
  // faded choices that could be mistaken for new matches.
  const resultsReady = searchCurrent && !result.isFetching && result.isSuccess;
  const items = resultsReady ? (result.data?.items ?? []) : [];
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
      searchCurrent &&
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
        placeholder="3 أحرف على الأقل: اسم الصنف بالعربي أو الإنجليزي، التركيب، الرمز، الباركود…"
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
            else if (canSearchInvoiceItem(query)) {
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
            <div className="commerce-search-item-head" aria-hidden="true">
              <span>المتوفر (و1)</span><span>اسم الصنف</span><span>سعر البيع</span>
            </div>
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
                    className="commerce-search-item-row"
                    onClick={() => choose(item)}
                    onMouseDown={(event) => event.preventDefault()}
                    disabled={
                      disabled || result.isFetching || search !== query.trim()
                    }
                  >
                    <bdi className="commerce-search-item-stock"
                      title={item.availableSmallest === null ? "الرصيد غير متاح بحسب الصلاحيات" : "المتوفر بالوحدة الأولى"}>
                      {invoiceSearchStock(item)}
                    </bdi>
                    <span className="commerce-search-item-name" title={item.englishName ? `${item.name} / ${item.englishName}` : item.name}>
                      <span className="commerce-search-item-arabic">
                        {item.name}
                        {invoiceKind === "sale" && (() => {
                          const rate = saleClearanceRate(item, documentDate);
                          return rate ? (
                            <>{" "}<span className="commerce-search-clearance-label">
                              (تصريف {rate}%)
                            </span></>
                          ) : null;
                        })()}
                      </span>
                      {item.englishName && <small className="muted commerce-search-item-english" dir="ltr">{item.englishName}</small>}
                    </span>
                    <bdi className="commerce-search-item-price" title="سعر البيع بالوحدة الأولى">
                      {formatMoney(item.salePrice1)}
                    </bdi>
                  </Button>
                </li>
              ))}
            </ul>
            {!searchCurrent || result.isFetching || result.isPending ? (
              <span className="muted">جارٍ البحث…</span>
            ) : (
              !result.isError && !items.length && <span className="muted">لا توجد نتائج.</span>
            )}
            {searchCurrent && result.error && (
              <Notice tone="error">{errorMessage(result.error)}</Notice>
            )}
            {resultsReady && <div className="lookup-pages">
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
            </div>}
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

type ItemInfoView = "purchase" | "sale" | "adjustment" | "transfer" | "alternatives";
type ItemInfoHistoryRow = {
  lineId: string | number;
  documentId: string | number;
  documentDate: string;
  partyName?: string;
  description?: string;
  quantityFirstUnit: string;
  unitPriceFirstUnit?: string;
  currencyCode?: string;
  isStaged?: boolean;
};
/** Format stock to exactly one displayed decimal, without losing conversion precision. */
function alternativeFirstUnitText(
  row: ItemCompositionPeers["peers"][number],
): string {
  if (row.stockSmallest === null) return "—";
  const quantity = saleStockQuantity(row.stockSmallest, row, 1, 1);
  return quantity.includes(".") ? quantity : quantity + ".0";
}
const itemInfoViews: { value: ItemInfoView; label: string }[] = [
  { value: "purchase", label: "مشتريات الصنف" },
  { value: "sale", label: "مبيعات الصنف" },
  { value: "adjustment", label: "تسويات الصنف" },
  { value: "transfer", label: "مناقلات الصنف" },
  { value: "alternatives", label: "بدائل الصنف" },
];
function isItemInfoView(value: string | null): value is ItemInfoView {
  return itemInfoViews.some(view => view.value === value);
}
function InvoiceItemOptions({ context, kind, selectedItemId, selectedItemName, userId }: {
  context: CompanyContext;
  kind: InvoiceKind;
  selectedItemId: number | null;
  selectedItemName: string | null;
  userId: number | undefined;
}) {
  const companyId = context.company.id;
  const storageKey = `tijara:item-options:${userId ?? 0}:${companyId}:${kind}`;
  const [view, setView] = useState<ItemInfoView>(() => {
    try {
      const saved = window.localStorage.getItem(storageKey);
      return isItemInfoView(saved) ? saved : kind === "purchase" ? "purchase" : "sale";
    } catch {
      return kind === "purchase" ? "purchase" : "sale";
    }
  });
  const menu = useRef<HTMLDetailsElement>(null);
  const client = useQueryClient();
  const [alternateItemId, setAlternateItemId] = useState<number | null>(null);
  const [accountFullName, setAccountFullName] = useState<string | null>(null);
  const [alternateSaving, setAlternateSaving] = useState(false);
  const history = useQuery<{ items: ItemInfoHistoryRow[] }>({
    queryKey: ["invoice-item-options", userId, companyId, selectedItemId, view],
    queryFn: ({ signal }) => api<{ items: ItemInfoHistoryRow[] }>(
      `/companies/${companyId}/item-history/${selectedItemId}?type=${view}`,
      { signal },
    ),
    enabled: !!userId && !!selectedItemId && view !== "alternatives",
    staleTime: 10000,
  });
  const alternatives = useQuery<{ peers: ItemCompositionPeers }>({
    queryKey: ["invoice-item-alternatives", userId, companyId, selectedItemId],
    queryFn: ({ signal }) => api<{ peers: ItemCompositionPeers }>(
      `/companies/${companyId}/items/${selectedItemId}/composition-peers?page=1`,
      { signal },
    ),
    enabled: !!userId && !!selectedItemId && view === "alternatives",
    staleTime: 10000,
  });
  const selectedLabel = itemInfoViews.find(option => option.value === view)?.label;
  function selectView(value: ItemInfoView) {
    setView(value);
    if (menu.current) menu.current.open = false;
    try { window.localStorage.setItem(storageKey, value); } catch { /* Storage may be disabled. */ }
  }
  const isInvoiceView = view === "purchase" || view === "sale";
  const peers = alternatives.data?.peers;
  return (
    <>
    <section className="invoice-empty-panel invoice-item-options" aria-label="خيارات الصنف">
      <details ref={menu} className="invoice-item-options-menu">
        <summary aria-label="اختر خيارات الصنف">
          <span className="invoice-item-options-heading"
            title={selectedItemName ? `${selectedLabel} (${selectedItemName})` : selectedLabel}>
            <span className="invoice-item-options-view">{selectedLabel}</span>
            {selectedItemName && <span className="invoice-item-options-selected-name"> ({selectedItemName})</span>}
          </span><span aria-hidden="true">▾</span>
        </summary>
        <div className="invoice-item-options-choices">
          {itemInfoViews.map(option => (
            <button type="button" key={option.value}
              className={option.value === view ? "is-selected" : ""}
              aria-current={option.value === view ? "true" : undefined}
              onClick={() => selectView(option.value)}>{option.label}</button>
          ))}
        </div>
      </details>
      <div className="invoice-item-options-content">
        {!selectedItemId ? <small>اختر صنفًا في الفاتورة لعرض {selectedLabel}.</small> :
          view === "alternatives" ? (
            <>
              {alternatives.isLoading && <small>جارٍ تحميل الأصناف المرتبطة…</small>}
              {alternatives.isError && <small>تعذر عرض البدائل. تحقق من صلاحية عرض الأصناف.</small>}
              {peers && !peers.composition && <small>لا يوجد تركيب معرّف لهذا الصنف.</small>}
              {peers?.composition && (
                <>
                  <small className="invoice-item-options-relation">
                    {peers.relation === "identicalAlternative" ? "بدائل مطابقة بحسب كرت التركيب" :
                      peers.relation === "nonInterchangeable" ? "تنبيه: هذه الأصناف غير قابلة للتبديل" :
                      "أصناف تشترك في التركيب؛ ليست بدائل معتمدة"}
                  </small>
                  {peers.peers.length === 0 ? <small>لا توجد أصناف أخرى بنفس التركيب.</small> : (
                    <div className="invoice-item-options-scroll" role="region" tabIndex={0} aria-label="جدول بدائل الصنف">
                      <table className="invoice-item-options-table">
                        <colgroup><col style={{width:"30%"}}/><col style={{width:"70%"}}/></colgroup>
                        <thead><tr><th className="invoice-item-options-number">الكمية (و1)</th><th>الصنف</th></tr></thead>
                        <tbody>{peers.peers.map(row => (
                          <tr key={row.id}>
                            <td className="invoice-item-options-number" title={alternativeFirstUnitText(row)}>
                              <bdi>{alternativeFirstUnitText(row)}</bdi>
                            </td>
                            <td title={row.name}>
                              <button type="button" className="invoice-item-options-link"
                                onClick={() => setAlternateItemId(row.id)}
                                aria-label={`فتح كرت الصنف ${row.name}`}>
                                {row.name}{row.active ? "": " (مؤرشف)"}
                              </button>
                            </td>
                          </tr>
                        ))}</tbody>
                      </table>
                    </div>
                  )}
                  {peers.total > peers.pageSize &&
                    <small>تظهر أول {peers.pageSize} أصناف من أصل {peers.total}. استعرض البقية من كرت الصنف.</small>}
                </>
              )}
            </>
          ) : (
            <>
              {history.isLoading && <small>جارٍ تحميل الحركات…</small>}
              {history.isError && <small>تعذر تحميل الحركات؛ تحقق من صلاحية عرض {isInvoiceView ? "الفواتير" : "المخزون"}.</small>}
              {history.data?.items.length === 0 && <small>لا توجد حركات سابقة للصنف في هذا القسم.</small>}
              {history.data && history.data.items.length > 0 && (
                <div className="invoice-item-options-scroll" role="region" tabIndex={0} aria-label={`جدول ${selectedLabel}`}>
                  <table className="invoice-item-options-table">
                    <colgroup>{isInvoiceView ? (
                      <><col style={{width:"25%"}}/><col style={{width:"35%"}}/>
                        <col style={{width:"20%"}}/><col style={{width:"20%"}}/></>
                    ) : (
                      <><col style={{width:"27%"}}/><col style={{width:"46%"}}/>
                        <col style={{width:"27%"}}/></>
                    )}</colgroup>
                    <thead><tr>
                      <th>التاريخ</th>
                      {isInvoiceView ? <><th>{view === "purchase" ? "المورد" : "العميل"}</th><th className="invoice-item-options-number">السعر</th></> : <th>البيان</th>}
                      <th className="invoice-item-options-number">الكمية (و1)</th>
                    </tr></thead>
                    <tbody>{history.data.items.map(row => (
                      <tr key={row.lineId}>
                        <td dir="ltr" title={row.isStaged ? "فاتورة محفوظة أوليًا، دون ترحيل محاسبي أو مخزني" : undefined}>
                          {row.documentDate}
                          {row.isStaged && <small className="muted" style={{display:"block"}}>أوليًا</small>}
                        </td>
                        {isInvoiceView ? <>
                          <td title={row.partyName ?? "—"}><button type="button"
                            className="invoice-item-options-link"
                            onClick={() => setAccountFullName(row.partyName ?? "غير محدد")}
                            aria-label={`عرض اسم الحساب كاملًا: ${row.partyName ?? "غير محدد"}`}>
                            {row.partyName ?? "—"}
                          </button></td>
                          <td className="invoice-item-options-number" title={row.unitPriceFirstUnit == null ? "—" : formatWholeMoney(row.unitPriceFirstUnit)}>
                            <bdi>{formatWholeMoney(row.unitPriceFirstUnit)}</bdi>
                          </td>
                        </> : <td title={row.description || "—"}>{row.description || "—"}</td>}
                        <td className="invoice-item-options-number"><bdi>{row.quantityFirstUnit}</bdi></td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </>
          )}
      </div>
    </section>
    <Dialog open={accountFullName !== null} title="اسم الحساب بالكامل"
      onClose={() => setAccountFullName(null)}>
      <p className="invoice-item-full-account" dir="auto">{accountFullName}</p>
      <div className="form-actions">
        <Button variant="secondary" onClick={() => setAccountFullName(null)}>إغلاق</Button>
      </div>
    </Dialog>
    <Dialog open={alternateItemId !== null} title="كرت الصنف"
      className="invoice-item-sheet" onClose={() => {
        if (!alternateSaving) setAlternateItemId(null);
      }}>
      {alternateItemId !== null && (
        <Suspense fallback={<Notice>جارٍ تحميل كرت الصنف…</Notice>}>
          <InvoiceItemEditor
            key={`${userId}:${companyId}:${alternateItemId}`}
            context={context} itemId={alternateItemId}
            onSaved={() => {
              void client.invalidateQueries({
                queryKey: ["invoice-item-alternatives", userId, companyId, selectedItemId],
              });
              setAlternateItemId(null);
            }}
            onClose={() => { if (!alternateSaving) setAlternateItemId(null); }}
            onSavingChange={setAlternateSaving}
          />
        </Suspense>
      )}
    </Dialog>
    </>
  );
}
function InvoiceWorkspace({ children, context, kind, selectedItemId, selectedItemName }: {
  children: ReactNode;
  context: CompanyContext;
  kind: InvoiceKind;
  selectedItemId: number | null;
  selectedItemName: string | null;
}) {
  const companyId = context.company.id;
  const { user } = useSession();
  const controls = useControls(companyId, context.employee?.id ?? null);
  const showOptions = controls.value(
    kind === "purchase" ? "show_recent_item_purchases" : "show_item_options_sales",
  ) !== false;
  return (
    <div className={showOptions ? "invoice-workspace" : "invoice-workspace invoice-workspace-no-options"}>
      <div className="invoice-workspace-main">{children}</div>
      {showOptions && <aside className="invoice-side-space" aria-label="المساحة الجانبية للفاتورة">
        <InvoiceItemOptions key={`${user?.id ?? 0}:${companyId}:${kind}`}
          context={context} kind={kind} selectedItemId={selectedItemId}
          selectedItemName={selectedItemName} userId={user?.id} />
        {kind === "purchase" && <section className="invoice-empty-panel" aria-label="المساحة الثانية" />}
      </aside>}
    </div>
  );
}

export function InvoicePage({ context }: { context: CompanyContext }) {
  const { invoiceId } = useParams();
  const [params] = useSearchParams();
  const { user } = useSession();
  const kind = params.get("kind") === "purchase" ? "purchase" : "sale";
  const [selectedItem, setSelectedItem] = useState<Pick<Item,"id"|"name"> | null>(null);
  const control = useControls(context.company.id, context.employee?.id ?? null);
  if (!commerceAccess(context))
    return <Notice tone="warning">ليس لديك صلاحية عرض الفواتير.</Notice>;
  if (invoiceId === "new")
    return canPost(context) ? ((isMobileDevice() && control.value(kind === "sale" ? "mobile_sales" : "mobile_purchases") === false) ? (
      <Notice tone="warning">إنشاء هذا النوع من الفواتير من الهاتف غير مسموح في الكنترول.</Notice>
    ) : (
      <InvoiceWorkspace context={context} kind={kind} selectedItemId={selectedItem?.id ?? null}
        selectedItemName={selectedItem?.name ?? null}>
        <InvoiceEditor
          key={`${user?.id}:${context.company.id}:${kind}`}
          context={context} onChooseItem={setSelectedItem}
        />
      </InvoiceWorkspace>
    )) : (
      <Notice tone="warning">
        إنشاء الفاتورة يحتاج صلاحية إدارة الفواتير والترحيل المالي.
      </Notice>
    );
  return (
    <InvoiceWorkspace context={context} kind={kind} selectedItemId={null} selectedItemName={null}>
      <InvoiceViewer context={context} invoiceId={Number(invoiceId)} />
    </InvoiceWorkspace>
  );
}
function InvoiceEditor({ context, onChooseItem }: { context: CompanyContext; onChooseItem: (item: Pick<Item,"id"|"name"> | null) => void }) {
  const companyId = context.company.id;
  const { user } = useSession();
  const client = useQueryClient();
  const controls = useControls(companyId, context.employee?.id ?? null);
  const directory = usePageDirectory(companyId);
  const canEditItem =
    (context.general || context.permissions.includes("items.manage")) &&
    ["company.items", "company.item-card"].every((key) => {
      const page = directory.data?.find((entry) => entry.key === key);
      return page?.enabled && page.actionAccess.view && page.actionAccess.edit;
    });
  const [headerItem,setHeaderItem]=useState<Item|null>(null);
  const [editingItem, setEditingItem] = useState<{
    itemId: number;
    lineKey: string;
  } | null>(null);
  const [editingBusy, setEditingBusy] = useState(false);
  const [adjustingItem, setAdjustingItem] = useState<number|null>(null);
  const [transferringItem, setTransferringItem] = useState<number|null>(null);
  const [reportingItem, setReportingItem] = useState<{itemId:number;itemName:string}|null>(null);
  const [reportSentId, setReportSentId] = useState<number|null>(null);
  const stockPage = directory.data?.find(entry=>entry.key==="company.stock-adjustments");
  const canAdjustItem =
    !!stockPage?.enabled && !!stockPage.actionAccess.view && !!stockPage.actionAccess.create &&
    (context.general || context.permissions.includes("inventory.post")) &&
    (context.general || context.permissions.includes("finance.post"));
  const transferPage = directory.data?.find(entry=>entry.key==="company.stock-operations");
  const canTransferItem =
    !!transferPage?.enabled && !!transferPage.actionAccess.view &&
    (context.general || context.permissions.includes("inventory.post"));
  const memoPage = directory.data?.find(entry=>entry.key==="company.memos");
  const canReportItem = !!memoPage?.enabled && !!memoPage.actionAccess.view &&
    !!memoPage.actionAccess.create;
  const [itemNotice, setItemNotice] = useState("");
  const [memoBlocked,setMemoBlocked]=useState(false);
  const [resetConfirmOpen,setResetConfirmOpen]=useState(false);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const kind: InvoiceKind =
    params.get("kind") === "purchase" ? "purchase" : "sale";
  const allowDateEdit = controls.value(kind === "sale" ? "edit_sales_date" : "edit_purchases_date") !== false;
  const showCurrency = controls.value("show_currency") !== false;
  const receiptRequiredChoices = controls.value("purchase_receipt_required_choices");
  const configuredPurchaseAccountId = controls.value("purchase_default_account");
  const purchaseDefaultId = typeof configuredPurchaseAccountId === "number" ? configuredPurchaseAccountId : 0;
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
  const configuredPurchaseAccountQuery = useQuery({
    queryKey: ["invoice-purchase-default-account",user?.id,companyId,purchaseDefaultId],
    queryFn:({signal})=>api<Page<Account>>(
      `/companies/${companyId}/commerce-options?type=accounts&id=${purchaseDefaultId}&pageSize=1`,
      {signal},
    ),
    enabled:kind==="purchase" && purchaseDefaultId>0 && !!user,
  });
  const configuredPurchaseAccount = configuredPurchaseAccountQuery.data?.items.find(entry=>
    entry.id===purchaseDefaultId && entry.active && entry.kind==="posting" &&
    (entry.category==="asset" || entry.category==="liability"))??null;
  const receiptRequired = kind==="purchase" && !!account?.accountChoice &&
    Array.isArray(receiptRequiredChoices) && receiptRequiredChoices.includes(account.accountChoice);
  const [pledgeMode, setPledgeMode] = useState<"add"|"list"|"pay"|"receive"|null>(null);
  const [supplier, setSupplier] = useState<Account | null>(null);
  const [supplierReceiptNumber, setSupplierReceiptNumber] = useState("");
  const creditPurchase = kind === "purchase" && account?.category === "liability" &&
    !account.cashOrBank;
  const selectedSupplier = creditPurchase ? account : supplier;
  const defaultCashbox = useEmployeeCashbox(context);
  const [cashboxDraft,setCashboxDraft]=useState<{
    kind:"pouch"|"electronic"|"close";
    amount:string;notes:string;idempotencyKey:string;
  }|null>(null);
  const [cashboxBusy,setCashboxBusy]=useState(false);
  const [cashboxUnknown,setCashboxUnknown]=useState(false);
  const [cashboxError,setCashboxError]=useState("");
  const [cashboxNotice,setCashboxNotice]=useState("");
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
    if (!showCurrency && defaultYer && currency?.code !== "YER") {
      currencyManuallyChosen.current = false;
      setCurrency(defaultYer);
    }
  }, [showCurrency, defaultYer, currency]);
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
  // Track the actual invoice row because identical items may appear in several rows.
  const activeLineKey = useRef<string | null>(null);
  const [replacingClearance, setReplacingClearance] = useState(false);
  const selectedLines = lines.filter((line) => line.itemId > 0);
  const hasLinkedLines = selectedLines.some(
    (line) => line.originalLineId !== null,
  );
  // Purchase header account comes ONLY from the company control, not the
  // supplier lookup and never from the salesperson's cashbox.
  useEffect(() => {
    const defaultAccount = initialInvoiceAccount(kind, defaultCashbox, configuredPurchaseAccount);
    if (!defaultAccount || accountManuallyChosen.current || account ||
      original || hasLinkedLines) return;
    setAccount(defaultAccount);
  }, [kind, defaultCashbox, configuredPurchaseAccount, account, original, hasLinkedLines]);
  const hasPositiveLines = selectedLines.some(
    (line) => !normalizeDigits(line.quantity.trim()).startsWith("-"),
  );
  const showExpiry =
    kind === "purchase" ||
    selectedLines.some(
      (line) =>
        normalizeDigits(line.quantity.trim()).startsWith("-") &&
        (line.originalLineId !== null || line.sourceItem?.hasExpiry),
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
  const [doctorPromptOpen,setDoctorPromptOpen]=useState(false);
  const [doctorQuery,setDoctorQuery]=useState("");
  const [doctorSelected,setDoctorSelected]=useState<Doctor|null>(null);
  const [doctorActiveIndex,setDoctorActiveIndex]=useState(-1);
  const doctorOptionsRef=useRef<HTMLDivElement>(null);
  const [doctorError,setDoctorError]=useState("");
  const [saleCustomerQuery,setSaleCustomerQuery]=useState("");
  const [saleCustomerNumber,setSaleCustomerNumber]=useState("");
  const [saleCustomerName,setSaleCustomerName]=useState("");
  const [saleCustomerMatched,setSaleCustomerMatched]=useState(false);
  const customerField=useRef<HTMLInputElement>(null);
  const customerSearch=useQuery<Page<SaleCustomer>>({
    queryKey:["sale-customer-search",user?.id,companyId,saleCustomerQuery],
    enabled:!!user&&doctorPromptOpen&&saleCustomerQuery.trim().length>0,
    queryFn:({signal})=>api<Page<SaleCustomer>>(
      `/companies/${companyId}/sale-customers?q=${encodeURIComponent(saleCustomerQuery)}&page=1&pageSize=10`,{signal}),
  });
  const customerExact=useQuery<{customer:SaleCustomer|null}>({
    queryKey:["sale-customer-number",user?.id,companyId,saleCustomerNumber],
    enabled:!!user&&doctorPromptOpen&&/^\d{1,30}$/.test(saleCustomerNumber),
    queryFn:({signal})=>api<{customer:SaleCustomer|null}>(
      `/companies/${companyId}/sale-customers/lookup?number=${encodeURIComponent(saleCustomerNumber)}`,{signal}),
  });
  useEffect(()=>{
    if(!doctorPromptOpen||!saleCustomerNumber||!customerExact.data)return;
    if(customerExact.data.customer){
      setSaleCustomerName(customerExact.data.customer.name);
      setSaleCustomerMatched(true);
    } else {
      setSaleCustomerMatched(false);
    }
  },[doctorPromptOpen,saleCustomerNumber,customerExact.data]);
  function selectSaleCustomer(customer:SaleCustomer){
    setSaleCustomerNumber(customer.customerNumber);
    setSaleCustomerName(customer.name);
    setSaleCustomerMatched(true);
    setSaleCustomerQuery("");
  }
  const doctorField=useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!doctorPromptOpen) return;
    // showModal() may steal focus from a regular effect; schedule after it opens.
    const frame=requestAnimationFrame(()=>doctorField.current?.focus());
    return ()=>cancelAnimationFrame(frame);
  },[doctorPromptOpen]);
  const doctorChoices=useQuery({
    queryKey:["invoice-doctors",user?.id,companyId,doctorQuery],
    enabled:!!user && kind==="sale" && doctorPromptOpen,
    queryFn:({signal})=>api<Page<Doctor>>(
      `/companies/${companyId}/doctors?active=true&q=${encodeURIComponent(doctorQuery)}&page=1&pageSize=20&sort=name:asc`,
      {signal},
    ),
  });
  const doctorResults = doctorChoices.data?.items ?? [];
  useEffect(() => {
    if(doctorActiveIndex < 0) return;
    doctorOptionsRef.current?.querySelector<HTMLElement>(
      `[data-doctor-index="${doctorActiveIndex}"]`,
    )?.scrollIntoView({block:"nearest"});
  },[doctorActiveIndex,doctorChoices.data]);
  const doctorThreshold = Number(controls.value("sales_doctor_threshold") ?? 1000);

  function openCashboxAction(operation:"pouch"|"electronic"|"close") {
    setCashboxError("");
    setCashboxUnknown(false);
    setCashboxNotice("");
    setCashboxDraft({kind:operation,amount:"",notes:"",
      idempotencyKey:crypto.randomUUID()});
  }
  async function submitCashboxAction(event?:FormEvent) {
    event?.preventDefault();
    if (!cashboxDraft || cashboxBusy || !defaultCashbox || !canPost(context)) return;
    if (!/^-?(?:0|[1-9][0-9]{0,19})(?:\\.[0-9]{1,2})?$/.test(normalizeDigits(cashboxDraft.amount))) {
      setCashboxError("أدخل مبلغًا صالحًا بالريال اليمني حتى منزلتين عشريتين.");
      return;
    }
    if(cashboxDraft.kind==="electronic" && Number(normalizeDigits(cashboxDraft.amount))<0) {
      setCashboxError("لا يُسمح بترحيل مبلغ سالب إلى المحفظة الإلكترونية.");
      return;
    }
    setCashboxBusy(true);
    setCashboxError("");
    try {
      const result=await api<{operationId:number;documentId:number;
        bookBalance:string|null;difference:string|null}>(
        `/companies/${companyId}/sales/cashbox-operations`,{
          method:"POST",
          body:{...cashboxDraft,amount:normalizeDigits(cashboxDraft.amount)},
          signal:guard.signal,
        });
      if(!guard.isCurrent()) return;
      const diff=result.difference?Number(result.difference):0;
      const message=cashboxDraft.kind==="close"
        ? diff>0
          ? `تم إغلاق الصندوق وترحيل العجز ${formatMoney(result.difference!)} ريال.`
          : diff<0
            ? `تم إغلاق الصندوق وترحيل الزيادة ${formatMoney(String(-diff))} ريال.`
            : "تم إغلاق الصندوق وتصفير الرصيد دون فرق."
        : cashboxDraft.kind==="pouch"
          ? cashboxDraft.amount.startsWith("-")
            ? "تم استلام المبلغ من الحافظة وإضافته إلى صندوق البائع."
            : "تم ترحيل المبلغ من صندوق البائع إلى الحافظة."
          : cashboxDraft.amount.startsWith("-")
            ? "تم استلام المبلغ من المحفظة الإلكترونية وإضافته إلى صندوق البائع."
            : "تم ترحيل المبلغ من صندوق البائع إلى المحفظة الإلكترونية.";
      setCashboxNotice(`${message} رقم القيد #${result.documentId}`);
      setCashboxDraft(null);
      setCashboxUnknown(false);
      void invalidate();
      void client.invalidateQueries({predicate:q=>
        q.queryKey.includes(companyId) &&
        ["account-balances","account-ledger","financial-documents"].includes(String(q.queryKey[0]))});
    }catch(cause) {
      if (!guard.isCurrent()) return;
      const uncertain=!(cause instanceof ApiFailure)||cause.status>=500;
      setCashboxUnknown(uncertain);
      setCashboxError(uncertain
        ? "قد تكون العملية قد ترحّلت. أعد التأكيد بنفس الطلب دون تعديل المبلغ لتجنب التكرار. "+errorMessage(cause)
        : errorMessage(cause));
    }finally{
      if(guard.isCurrent())setCashboxBusy(false);
    }
  }
  const allowNavigation = useRef(false);
  const dirty =
    lines.some((line) => line.itemId || line.search.trim()) ||
    !!original ||
    !!description ||
    (kind === "purchase" && (!!supplier || !!supplierReceiptNumber)) ||
    accountManuallyChosen.current ||
    (!!account && account.id !== (kind === "sale" ? defaultCashbox?.id : configuredPurchaseAccount?.id)) ||
    (!!branch &&
      (branchManuallyChosen.current ||
        branch.id !== automaticBranchId.current)) ||
    (!!location &&
      (locationManuallyChosen.current ||
        location.id !== automaticLocationId.current)) ||
    (!!currency &&
      (currencyManuallyChosen.current ||
        currency.id !== automaticCurrencyId.current));
  const locked = saving || unknown || replacingClearance;
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
  const [focusTarget, setFocusTarget] = useState<{ id: string; select?: boolean } | null>(() => ({
    id: lineInputId(lines[0]!, "item-search"),
  }));
  const focus = (id: string, select = false) => setFocusTarget({ id, select });
  useLayoutEffect(() => {
    if (!focusTarget || locked || !guard.isCurrent()) return;
    const element = document.getElementById(focusTarget.id);
    // Selection and a new row must commit before their controls can receive focus.
    if (!element || element.matches(":disabled")) return;
    element.focus();
    if (focusTarget.select && element instanceof HTMLInputElement) element.select();
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
  const doctorNeeded = kind==="sale" && totals !== null &&
    Math.abs(Number(totals.total)) > doctorThreshold;
  function updateLine(key: string, patch: Partial<DraftLine>) {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  }
  function chooseItem(line: DraftLine, selected: Item, preserveQuantity = false) {
    if (user) rememberRecentEntity(user.id, companyId, "item", {id:selected.id,name:selected.name});
    activeLineKey.current=line.key;
    setHeaderItem(selected);
    onChooseItem({id:selected.id,name:selected.name});
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
      quantity: preserveQuantity ? line.quantity : "1",
      unitPrice:
        kind === "sale"
          ? salePrice(selected, selectedUnit)
          : currency?.id === selected.currencyId
            ? selected.purchasePrice
            : "0",
      expiryDate: null,
      expiryManuallyEdited: false,
      originalLineId: null,
      originalSelection: false,
      originalSource: undefined,
    });
    // Select count first, then price, then expiry date (purchase workflow).
    focus(lineInputId(line, "quantity"), kind === "purchase");
  }
  async function replaceWithClearance(itemId: number) {
    if (kind!=="sale" || locked) return;
    const target = lines.find(line => line.key===activeLineKey.current);
    if (!target || !target.itemId || target.originalLineId ||
        target.itemId!==headerItem?.id) {
      setError("اختر سطر مبيعات عاديًا أولًا، ثم اضغط صنف التصريف لاستبداله.");
      return;
    }
    if (target.itemId===itemId) {
      focus(lineInputId(target,"quantity"),true);
      return;
    }
    setReplacingClearance(true);
    setError("");
    try {
      // Fetch the full active item card: clearance alerts contain only short
      // peer details and not its sale unit, conversion factors or unit prices.
      const result=await api<Page<Item>>(
        `/companies/${companyId}/commerce-options?${new URLSearchParams({
          type:"items",id:String(itemId),pageSize:"1",
        })}`,
        {signal:guard.signal},
      );
      if (!guard.isCurrent()) return;
      const selected=result.items.find(row=>row.id===itemId&&row.active);
      if (!selected) {
        setError("صنف التصريف غير متاح أو مؤرشف، ولا يمكن إضافته إلى الفاتورة.");
        return;
      }
      if(activeLineKey.current!==target.key ||
        !lines.some(line=>line.key===target.key && line.itemId===target.itemId)) {
        setError("تغيّر سطر الفاتورة؛ اختر السطر المطلوب وحاول مجددًا.");
        return;
      }
      // Preserve the entered count while replacing item, default unit and price.
      chooseItem(target,selected,true);
      focus(lineInputId(target,"quantity"),true);
    }catch(error){
      if (guard.isCurrent())setError(errorMessage(error));
    }finally{
      if(guard.isCurrent())setReplacingClearance(false);
    }
  }
  function closeItemEditor() {
    if (!editingBusy) setEditingItem(null);
  }
  function itemSaved(item: Item) {
    if (!guard.isCurrent() || item.companyId !== companyId) return;
    setHeaderItem(item);
    onChooseItem({id:item.id,name:item.name});
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
        `/companies/${companyId}/commerce-options?${new URLSearchParams({ type: "items", id: String(source.itemId), pageSize: "1" })}`,
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
            ...(kind === "sale" && line.originalLineId && !line.expiryManuallyEdited
              ? { expiryDate: suggestedReturnExpiry(currentItem) }
              : {}),
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
            expiryDate: kind === "sale" ? null : source.expiryDate,
            expiryManuallyEdited: false,
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
          ? { unitPrice: line.sourceItem.salePrice1, expiryDate: null, expiryManuallyEdited: false }
          : {}),
      });
    } else {
      const wasNegative = /^-\d+$/.test(normalizeDigits(line.quantity.trim()));
      const nowNegative = /^-\d+$/.test(normalizeDigits(value.trim()));
      updateLine(line.key, {
        quantity: value,
        ...(kind === "sale" && positive
          ? { expiryDate: null, expiryManuallyEdited: false }
          : kind === "sale" && nowNegative && !wasNegative && !line.expiryManuallyEdited
            ? { expiryDate: suggestedReturnExpiry(line.sourceItem) }
            : {}),
      });
    }
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
    setResetConfirmOpen(false);
    // Reset only this unsaved editor; posted invoices are never changed.
    const first = emptyLine();
    pending.current = null;
    setHeaderItem(null);
    onChooseItem(null);
    setLines([first]);
    setAccount(initialInvoiceAccount(kind, defaultCashbox, configuredPurchaseAccount));
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
    setDoctorSelected(null);
    setDoctorActiveIndex(-1);
    setDoctorQuery("");
    setDoctorPromptOpen(false);
    setDoctorError("");
    setSaleCustomerQuery("");
    setSaleCustomerNumber("");
    setSaleCustomerName("");
    setSaleCustomerMatched(false);
    setError("");
    setSavedInvoice(null);
    setItemNotice("");
    focus(lineInputId(first, "item-search"));
  }
  async function save(event?: FormEvent, selectedDoctorId?: number, freeTextDoctorName = "") {
    event?.preventDefault();
    if (saving || editingItem || !guard.isCurrent()) return;
    const enteredDoctorName = freeTextDoctorName.trim();
    if (doctorPromptOpen && !selectedDoctorId && !enteredDoctorName) {
      setDoctorError("اكتب اسم الطبيب أو الجهة، أو اختره من النتائج.");
      doctorField.current?.focus();
      return;
    }
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
      if (kind === "purchase" && receiptRequired && !supplierReceiptNumber.trim()) {
        setError("رقم الوصل إلزامي لنوع الحساب المحدد في الكنترول.");
        focus("purchase-supplier-receipt");
        return;
      }
      if (selectedLines.some((line) => !validateLine(line))) return;
      if (doctorNeeded && !selectedDoctorId && !enteredDoctorName) {
        setDoctorSelected(null);
        setDoctorActiveIndex(-1);
        setDoctorQuery("");
        setDoctorError("");
        setDoctorPromptOpen(true);
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
        supplierAccountId: kind === "purchase" ? selectedSupplier?.id ?? null : null,
        doctorId: kind === "sale" ? selectedDoctorId ?? null : null,
        doctorName: kind === "sale" ? enteredDoctorName : "",
        saleCustomerNumber: kind === "sale" ? saleCustomerNumber : "",
        saleCustomerName: kind === "sale" && saleCustomerNumber ? saleCustomerName.trim() : "",
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
      setHeaderItem(null);
      onChooseItem(null);
      setLines([next]);
      setAccount(initialInvoiceAccount(kind, defaultCashbox, configuredPurchaseAccount));
      setSupplier(null);
      setSupplierReceiptNumber("");
      accountManuallyChosen.current = false;
      setOriginal(null);
      setShowOriginalPicker(false);
      setDocumentDate(today());
      setDescription("");
      setDiscount("0");
      setDoctorPromptOpen(false);
      setDoctorSelected(null);
      setDoctorActiveIndex(-1);
      setDoctorQuery("");
      setDoctorError("");
      setSaleCustomerQuery("");
      setSaleCustomerNumber("");
      setSaleCustomerName("");
      setSaleCustomerMatched(false);
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
      if (error instanceof ApiFailure && error.code === "doctor_required") {
        setDoctorPromptOpen(true);
        setDoctorError("يلزم اختيار الطبيب أو الجهة قبل حفظ هذه الفاتورة.");
      }
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
        <Card className={`commerce-header-card invoice-kind-${kind}`}>
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
                  pageSize={100}
                  sort="name:asc"
                  singleInput
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
                    pageSize={100}
                    sort="name:asc"
                    singleInput
                    disabled={locked || hasLinkedLines || creditPurchase}
                  />
                )}
                {kind === "purchase" && (
                  <Field
                    id="purchase-supplier-receipt"
                    label={receiptRequired ? "رقم الوصل (إلزامي)" : "رقم الوصل"}
                    required={receiptRequired}
                    placeholder="رقم فاتورة المورد"
                    maxLength={100}
                    value={supplierReceiptNumber}
                    disabled={locked}
                    onChange={(event) => setSupplierReceiptNumber(event.target.value)}
                  />
                )}
                {kind === "sale" ? (
                  <SalesHeaderActionsDropdown
                    listUrl={listPath(companyId, kind)}
                    purchaseUrl={`${invoicePath(companyId,"new")}?kind=purchase`}
                    canOpenPurchase={commerceAccess(context)}
                    canTransfer={!locked && !!defaultCashbox && canPost(context) && !cashboxBusy}
                    canManagePledges={!locked && commerceAccess(context, true)}
                    canOperatePledges={!locked && !!defaultCashbox && canPost(context) && (context.general || context.permissions.includes("finance.manage")) && !cashboxBusy}
                    canEdit={!locked}
                    originalVisible={showOriginalPicker}
                    onAction={action => {
                      if(action === "pouch" || action === "electronic" || action === "close")
                        openCashboxAction(action);
                      else if(action === "addPledge") setPledgeMode("add");
                      else if(action === "listPledges") setPledgeMode("list");
                      else if(action === "payPledge") setPledgeMode("pay");
                      else if(action === "receivePledge") setPledgeMode("receive");
                      else setShowOriginalPicker(shown => !shown);
                    }}
                  />
                ) : (
                  <Link className="button button-secondary commerce-list-link"
                    to={listPath(companyId, kind)}>قائمة الفواتير</Link>
                )}
                <Field
                  label="تاريخ الفاتورة"
                  type="date"
                  required
                  value={documentDate}
                  disabled={locked || !allowDateEdit}
                  onChange={(event) => setDocumentDate(event.target.value)}
                />
                {kind !== "sale" && <Button
                  variant="secondary"
                  disabled={locked}
                  onClick={() => setShowOriginalPicker(shown => !shown)}
                >
                  {showOriginalPicker ? "إخفاء ربط الأصل" : "ربط مردود بأصل"}
                </Button>}
                {showCurrency && <ServerLookup<CompanyCurrency>
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
                />}
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
              <div className="commerce-header-blank commerce-sale-info-panel">
                {kind==="sale"&&<>
                  <InvoiceSaleAlerts companyId={companyId} userId={user?.id}
                    itemId={headerItem?.id??null}
                    currentClearanceRate={headerItem?saleClearanceRate(headerItem,documentDate):null}
                    onChooseClearance={replaceWithClearance}
                    disableSelection={locked || !activeLineKey.current}/>
                </>}
              </div>
            </div>
          </fieldset>
          {kind === "sale" && locked && <Link
            className="button button-secondary commerce-list-link"
            to={listPath(companyId, kind)}>
            قائمة الفواتير
          </Link>}
        </Card>
        {itemNotice && <Notice tone="success">{itemNotice}</Notice>}
        {memoImpact.data?.matches.filter(rule=>rule.effect!=="monitor").map(rule=>
          <Notice key={rule.ruleId} tone={rule.effect==="block"?"error":"warning"}>
            {rule.message} ({rule.count} تكليفات).
            {" "}<Link to={`/companies/${companyId}/memos?box=required`}>مطلوب مني</Link>
          </Notice>)}
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
                        onFocusCapture={() => {
                          activeLineKey.current=line.key;
                          if (!line.sourceItem) return;
                          setHeaderItem(line.sourceItem);
                          onChooseItem({id:line.sourceItem.id,name:line.sourceItem.name});
                          if (user) rememberRecentEntity(user.id, companyId, "item",
                            {id:line.sourceItem.id,name:line.sourceItem.name});
                        }}
                        onClickCapture={() => {
                          activeLineKey.current=line.key;
                          if (!line.sourceItem) return;
                          setHeaderItem(line.sourceItem);
                          onChooseItem({id:line.sourceItem.id,name:line.sourceItem.name});
                          if (user) rememberRecentEntity(user.id, companyId, "item",
                            {id:line.sourceItem.id,name:line.sourceItem.name});
                        }}
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
                              invoiceKind={kind}
                              documentDate={documentDate}
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
                                focus(lineInputId(line, "quantity"), kind === "purchase")
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
                            {kind === "purchase" && line.originalLineId ? (
                              line.expiryDate || "—"
                            ) : (line.sourceItem?.hasExpiry &&
                              (kind === "purchase" ||
                                normalizeDigits(line.quantity.trim()).startsWith("-"))) ||
                              (kind === "sale" && line.originalLineId !== null &&
                                line.sourceItem?.hasExpiry !== false) ? (
                              <ExpiryMonthField
                                id={lineInputId(line, "expiry")}
                                className="item-cell-field"
                                label={`شهر وسنة انتهاء ${line.itemName}`}
                                required={kind === "purchase"}
                                value={line.expiryDate}
                                onChange={(date) =>
                                  updateLine(line.key, {
                                    expiryDate: date,
                                    expiryManuallyEdited: true,
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
                            <InvoiceItemActionsDropdown
                              itemName={line.itemName || "الصنف"}
                              disabled={!line.itemId || locked}
                              canEdit={canEditItem}
                              canAdjust={canAdjustItem}
                              canTransfer={canTransferItem}
                              canReport={canReportItem}
                              onAction={(action: InvoiceItemAction) => {
                                if (!line.itemId || locked) return;
                                if (action === "edit" && canEditItem) {
                                  setEditingBusy(false);
                                  setEditingItem({itemId:line.itemId,lineKey:line.key});
                                } else if(action === "adjust" && canAdjustItem) {
                                  setAdjustingItem(line.itemId);
                                } else if(action === "transfer" && canTransferItem) {
                                  setTransferringItem(line.itemId);
                                } else if(action === "report" && canReportItem) {
                                  setReportSentId(null);
                                  setReportingItem({itemId:line.itemId,itemName:line.itemName});
                                }
                              }}
                            />
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
                  {amount(totals?.total ?? "—")} {showCurrency ? currency?.code : ""}
                </strong>
              </span>
            </div>
            <div className="commerce-save-actions">
              <Button
                variant="secondary"
                onClick={() => setResetConfirmOpen(true)}
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
        {savedInvoice && (
          <div className="commerce-saved-confirmation">
            <Notice tone="success">
            تم حفظ وترحيل الفاتورة رقم <bdi>{savedInvoice.number}</bdi> بنجاح.{" "}
            <Link to={invoicePath(companyId, savedInvoice.id)}>
              عرض الفاتورة المحفوظة
            </Link>
            . يمكنك إدخال الفاتورة التالية مباشرة.
            </Notice>
          </div>
        )}
      </form>
      {cashboxNotice && <Notice tone="success">{cashboxNotice}</Notice>}
      <Dialog open={cashboxDraft!==null}
        title={cashboxDraft?.kind==="pouch"?"ترحيل إلى الحافظة":cashboxDraft?.kind==="electronic"?
          "ترحيل إلى المحفظة الإلكترونية":"إغلاق الصندوق"}
        onClose={()=>{if(!cashboxBusy && !cashboxUnknown)setCashboxDraft(null);}}>
        {cashboxDraft && (
          <form className="form-stack" onSubmit={event=>void submitCashboxAction(event)}>
            <Field
              label={cashboxDraft.kind==="close"?"المبلغ النقدي الفعلي":"المبلغ"}
              money inputMode="decimal" autoFocus required
              value={cashboxDraft.amount}
              disabled={cashboxBusy||cashboxUnknown}
              onChange={event=>setCashboxDraft(previous=>previous?
                {...previous,amount:normalizeDigits(event.target.value)}:previous)}
            />
            <Field label="ملاحظات" maxLength={1000}
              value={cashboxDraft.notes} disabled={cashboxBusy||cashboxUnknown}
              onChange={event=>setCashboxDraft(previous=>previous?
                {...previous,notes:event.target.value}:previous)}
            />
            {cashboxDraft.kind==="pouch" && <small className="muted">
              المبلغ السالب يعني استلام مبلغ من الحافظة وإعادته للصندوق.
              يُسمح بالترحيل حتى لو أصبح رصيد أحد الحسابين سالبًا.
            </small>}
            {cashboxDraft.kind==="electronic" && <small className="muted">
              يُسمح فقط بترحيل مبلغ موجب من صندوقك إلى محفظة الشركة الإلكترونية.
              لاستلام مبالغ من المحفظة استخدم صفحة استلام المحفظة الإلكترونية.
            </small>}
            {cashboxDraft.kind==="close" && <small className="muted">
              هذا حقل جرد النقد الفعلي وليس تحويلًا باتجاهين، لذلك لا يقبل السالب.
              سيتم تحويل النقد المعدود للحافظة، وترحيل أي عجز أو زيادة تلقائيًا ثم تصفير الصندوق،
              حتى لو كان رصيد الصندوق الدفتري سالبًا.
            </small>}
            {cashboxError && <Notice tone="error">{cashboxError}</Notice>}
            <div className="form-actions">
              <Button type="submit" disabled={cashboxBusy}>
                {cashboxBusy?"جارٍ الترحيل…":cashboxUnknown?"إعادة تأكيد الطلب نفسه":"حفظ وترحيل"}
              </Button>
              <Button variant="secondary" type="button" disabled={cashboxBusy||cashboxUnknown}
                onClick={()=>setCashboxDraft(null)}>إلغاء</Button>
            </div>
          </form>
        )}
      </Dialog>
      <Dialog open={resetConfirmOpen}
        title="تأكيد تصفير الفاتورة"
        onClose={() => setResetConfirmOpen(false)}>
        <p>هل تريد تصفير هذه الفاتورة؟ ستُحذف جميع السطور والبيانات المدخلة غير المحفوظة، ولن يمكن استعادتها.</p>
        <div className="form-actions">
          <Button variant="secondary" onClick={() => setResetConfirmOpen(false)}>
            العودة إلى الفاتورة
          </Button>
          <Button variant="danger" disabled={locked || !!editingItem}
            onClick={resetInvoice}>
            نعم، تصفير الفاتورة
          </Button>
        </div>
      </Dialog>
      <Dialog open={doctorPromptOpen}
        title=""
        onClose={() => {
          // Choosing a doctor is mandatory; use the explicit Back button
          // to return to the unsaved invoice instead of silently dismissing.
          doctorField.current?.focus();
        }}>
        <div className="form-stack">
          <div className="field floating-ready" data-label-raised="true">
            <label htmlFor="invoice-sale-customer-search">بحث عن عميل بالرقم أو الاسم (اختياري)</label>
            <input id="invoice-sale-customer-search" type="search"
              value={saleCustomerQuery} autoComplete="off"
              placeholder="اكتب رقم العميل أو اسمه للبحث"
              onChange={event=>{
                const text=event.target.value;
                setSaleCustomerQuery(text);
                const normalized=normalizeDigits(text.trim());
                if (/^\d{1,30}$/.test(normalized)) {
                  // Pure numeric search: reuse the number on a new card and
                  // resolve its saved name from the exact-number lookup.
                  setSaleCustomerNumber(normalized);
                  setSaleCustomerName("");
                } else if (text.trim()) {
                  // Searching by a name also seeds the name field when
                  // no matching customer exists. Selecting a result still
                  // fills both fields from the existing customer card.
                  setSaleCustomerName(text.trim());
                  setSaleCustomerNumber("");
                } else {
                  setSaleCustomerNumber("");
                  setSaleCustomerName("");
                }
                setSaleCustomerMatched(false);
                setDoctorError("");
              }}/>
          </div>
          {saleCustomerQuery.trim()&&(
            <div className="invoice-doctor-options" role="listbox" aria-label="نتائج البحث عن العملاء">
              {customerSearch.isLoading&&<small>جارٍ البحث عن العميل…</small>}
              {customerSearch.isError&&<small>تعذر البحث؛ يمكنك إدخال الرقم والاسم يدويًا.</small>}
              {customerSearch.data?.items.map(customer=><button key={customer.id}
                type="button" role="option" aria-selected={saleCustomerNumber===customer.customerNumber}
                onClick={()=>selectSaleCustomer(customer)}>
                <strong>{customer.customerNumber} — {customer.name}</strong>
              </button>)}
              {customerSearch.data?.items.length===0&&<small>لم يُعثر على عميل مطابق. أدخل رقمًا جديدًا، ويمكن ترك الاسم ليُحفظ «بدون».</small>}
            </div>
          )}
          <div className="field floating-ready" data-label-raised="true">
            <label htmlFor="invoice-sale-customer-number">رقم العميل (اختياري)</label>
            <input id="invoice-sale-customer-number" type="text" inputMode="numeric"
              ref={customerField} maxLength={30} autoComplete="off"
              value={saleCustomerNumber} placeholder="رقم العميل"
              onChange={event=>{
                setSaleCustomerNumber(normalizeDigits(event.target.value).replace(/[^0-9]/g,""));
                setSaleCustomerName("");
                setSaleCustomerMatched(false);
                setDoctorError("");
              }}/>
          </div>
          <div className="field floating-ready" data-label-raised="true">
            <label htmlFor="invoice-sale-customer-name">اسم العميل (اختياري)</label>
            <input id="invoice-sale-customer-name" type="text" maxLength={240}
              value={saleCustomerName} placeholder="يظهر للرقم الموجود؛ وللرقم الجديد بدون اسم يُحفظ «بدون»"
              readOnly={saleCustomerMatched} onChange={event=>setSaleCustomerName(event.target.value)}/>
          </div>
          {doctorError&&<Notice tone="error">{doctorError}</Notice>}
          <div className="field floating-ready" data-label-raised="true">
            <label htmlFor="invoice-doctor-name">اسم الطبيب أو الجهة</label>
            <input id="invoice-doctor-name" type="search" required autoFocus
            ref={doctorField} value={doctorQuery} autoComplete="off"
            role="combobox" aria-autocomplete="list" aria-expanded={doctorPromptOpen}
            aria-controls="invoice-doctor-options"
            aria-activedescendant={doctorActiveIndex >= 0 && doctorResults[doctorActiveIndex]
              ? `invoice-doctor-option-${doctorResults[doctorActiveIndex]!.id}` : undefined}
            maxLength={240}
            placeholder="ابحث أو اكتب اسمًا جديدًا لإضافته تلقائيًا للكروت"
            onChange={event=>{
              setDoctorQuery(event.target.value);
              setDoctorSelected(null);
              setDoctorActiveIndex(-1);
              setDoctorError("");
            }}
            onKeyDown={event=>{
              if(event.key==="ArrowDown" || event.key==="ArrowUp"){
                event.preventDefault();
                if(doctorResults.length){
                  setDoctorActiveIndex(old => event.key==="ArrowDown"
                    ? (old + 1) % doctorResults.length
                    : (old < 0 ? doctorResults.length - 1
                        : (old - 1 + doctorResults.length) % doctorResults.length));
                }
                return;
              }
              if(event.key==="Escape"){
                event.preventDefault();
                setDoctorActiveIndex(-1);
                return;
              }
              if(event.key==="Enter"){
                event.preventDefault();
                const highlighted=doctorActiveIndex>=0 ? doctorResults[doctorActiveIndex] : null;
                if(highlighted){
                  setDoctorSelected(highlighted);
                  setDoctorQuery(highlighted.name);
                  setDoctorActiveIndex(-1);
                  setDoctorError("");
                  return;
                }
                if(doctorSelected){
                  void save(undefined,doctorSelected.id);
                }else if(doctorQuery.trim()){
                  void save(undefined,undefined,doctorQuery);
                }else{
                  setDoctorError("اكتب اسم الطبيب أو الجهة أولًا.");
                  doctorField.current?.focus();
                }
              }
            }}/>
          </div>
          <small>السهمان ↑ ↓ للتنقل، وEnter للاختيار. يمكنك أيضًا كتابة اسم غير مسجل؛ عند حفظ الفاتورة يُنشأ كرت دون فئة ويُرسل تنبيه للمتابعة.</small>
          <div id="invoice-doctor-options" ref={doctorOptionsRef} className="invoice-doctor-options"
            role="listbox" aria-label="نتائج الأطباء والجهات">
            {doctorChoices.isLoading&&<small>جارٍ البحث…</small>}
            {doctorChoices.isError&&<Notice tone="error">{errorMessage(doctorChoices.error)}</Notice>}
            {doctorResults.map((doctor,index)=><button type="button" key={doctor.id}
              id={`invoice-doctor-option-${doctor.id}`} data-doctor-index={index}
              className={doctorSelected?.id===doctor.id || doctorActiveIndex===index?"invoice-doctor-selected":""}
              role="option" aria-selected={doctorSelected?.id===doctor.id || doctorActiveIndex===index}
              onClick={()=>{
                setDoctorSelected(doctor);
                setDoctorActiveIndex(-1);
                setDoctorQuery(doctor.name);
                setDoctorError("");
                doctorField.current?.focus();
              }}>
              <strong>{doctor.name}</strong>
              <small>{doctor.kind==="doctor"?"طبيب":doctor.kind==="nurse"?"ممرض":doctor.kind==="entity"?"جهة":"بدون فئة"}{doctor.department?" · "+doctor.department:""}</small>
            </button>)}
            {!doctorChoices.isLoading&&doctorChoices.data?.items.length===0&&<small>
              لا يوجد اسم مطابق في الكروت. يمكنك حفظ الاسم المكتوب، وسيُنشأ كرت جديد تلقائيًا دون فئة.
            </small>}
          </div>
          <div className="form-actions">
            <Button disabled={saving} onClick={()=>{
              if(doctorSelected) {
                void save(undefined,doctorSelected.id);
              } else if(doctorQuery.trim()) {
                void save(undefined,undefined,doctorQuery);
              } else {
                setDoctorError("اكتب اسم الطبيب أو الجهة أولًا.");
                doctorField.current?.focus();
              }
            }}>حفظ وترحيل الفاتورة</Button>
            <Button variant="secondary" disabled={saving} onClick={()=>{
              setDoctorPromptOpen(false);
              setDoctorError("");
              setDoctorSelected(null);
              setDoctorActiveIndex(-1);
            }}>العودة إلى الفاتورة دون حفظ</Button>
          </div>
        </div>
      </Dialog>
      {adjustingItem!==null && (
        <InvoiceItemAdjustmentSheet context={context} itemId={adjustingItem}
          onClose={()=>setAdjustingItem(null)}
          onSaved={(itemId,date,shelf)=>{
            setLines(current=>current.map(line=>
              line.itemId===itemId&&line.sourceItem
                ? {...line,sourceItem:{...line.sourceItem,
                    nearestExpiryDate:date,shelf:shelf.shelf,shelfId:shelf.shelfId}}
                : line,
            ));
            void client.invalidateQueries({queryKey:["sale-stock-preview",user?.id,companyId]});
          }}/>
      )}
      {transferringItem!==null && (
        <InvoiceItemTransferSheet context={context} itemId={transferringItem}
          onClose={()=>setTransferringItem(null)}
          onPosted={()=>{
            void client.invalidateQueries({queryKey:["sale-stock-preview",user?.id,companyId]});
            void client.invalidateQueries({queryKey:["inventory",user?.id,companyId]});
          }}/>
      )}
      {reportingItem && (
        <InvoiceItemReportSheet key={`${companyId}:${reportingItem.itemId}`}
          context={context} itemId={reportingItem.itemId} itemName={reportingItem.itemName}
          onClose={()=>setReportingItem(null)}
          onCreated={memoId=>{
            setReportingItem(null);
            setReportSentId(memoId);
          }}/>
      )}
      {reportSentId!==null && <Notice tone="success">
        تم إرسال التقرير المرتبط بالصنف.{" "}
        <Link to={`/companies/${companyId}/memos/${reportSentId}`}>فتح التقرير</Link>
      </Notice>}
      {kind === "sale" && <PledgeDialogs
        companyId={companyId}
        mode={pledgeMode}
        cashbox={defaultCashbox}
        yerCurrencyId={defaultYer?.id ?? null}
        onClose={() => setPledgeMode(null)}
        onCreated={(newAccount, points) => {
          accountManuallyChosen.current = true;
          setAccount(newAccount);
          setError("");
          setItemNotice(points ? `تم إنشاء الرهن ومنح ${points} نقطة.` : "تم إنشاء حساب الرهن.");
          void client.invalidateQueries({queryKey:["master",user?.id,companyId]});
        }}
        onSelect={accountId => {
          void api<Page<Account>>(`/companies/${companyId}/commerce-options?type=accounts&id=${accountId}&pageSize=1`)
            .then(result => {
              const selected = result.items.find(value => value.id === accountId);
              if (!selected) throw new Error("حساب الرهن غير متاح.");
              accountManuallyChosen.current = true;
              setAccount(selected);
            })
            .catch(reason => setError(errorMessage(reason)));
        }}
      />}
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
        <InvoicePrintSheet context={context} invoice={invoice} returning={returning} />
        <div className="commerce-print-heading">
          <CompanyPrintHeader context={context} />
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
          {invoice.kind === "sale" && invoice.doctorName && (
            <span>الطبيب أو الجهة: {invoice.doctorId
              ? <Link to={`/companies/${companyId}/doctors?focus=${invoice.doctorId}`}>{invoice.doctorName}</Link>
              : invoice.doctorName}</span>
          )}
          {invoice.kind === "sale" && invoice.saleCustomerNumber && (
            <span>العميل: {invoice.saleCustomerId
              ? <Link to={`/companies/${companyId}/sale-customers?focus=${invoice.saleCustomerId}`}>
                  <bdi>{invoice.saleCustomerNumber}</bdi> — {invoice.saleCustomerName}
                </Link>
              : <><bdi>{invoice.saleCustomerNumber}</bdi> — {invoice.saleCustomerName}</>}</span>
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
                      {line.commissionAmount.startsWith("-")
                        ? `مراجعة مرتجع: ${amount(line.commissionAmount.slice(1))} — دون خصم`
                        : `${amount(line.commissionAmount)} (${line.commissionRate}%)`}
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
              تُثبت عمولة التصريف بحسب إعداد الصنف وتاريخ الفاتورة.
              المبيعات الجديدة المؤهلة تُسجل كمستحق للموظف الذي رحّلها إذا كان موظفًا فعالًا،
              ولا تُدفع نقدًا تلقائيًا. أي مبلغ مرتبط بمرتجع مخصص لمراجعة الإدارة فقط؛
              لا يُخصم من عمولة الموظف.
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
