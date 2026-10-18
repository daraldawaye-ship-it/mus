import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useBlocker, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
  convertItemQuantity,
  type Account,
  type CompanyContext,
  type Item,
  type Location,
  type Page,
} from "../../../../packages/contracts/src/index";
import {
  inventorySettingsSchema,
  stockAdjustmentSchema,
  stockMovementKinds,
  countedStockSmallest,
  stockMovementKindLabels,
  stockTransferSchema,
  type InventorySettings,
  type InventorySettingsInput,
  type StockAdjustmentInput,
  type StockBalance,
  type StockMovement,
  type StockOperation,
  type StockTransferInput,
} from "../../../../packages/contracts/src/inventory";
import {
  api,
  ApiFailure,
  usePagedQuery,
  useScopeGuard,
  useSession,
} from "../api";
import { errorMessage, ServerLookup } from "../phase2";
import { ExpiryMonthField } from "../ExpiryMonthField";
import { formatMoney } from "../format-money";
import { firstUnitStockText } from "../sale-stock-quantity";
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

type Reference = { id: number; code: string; name: string };
type ReferenceType = "accounts" | "items" | "locations";
const referenceLabel = (value: Reference) => `${value.code} — ${value.name}`;
const exact = (value: string | null) => (
  <bdi className="inventory-exact">{value ?? "—"}</bdi>
);
const quantityText = (quantity: StockBalance["quantityUnit1"]) =>
  quantity.decimal ?? `${quantity.numerator}/${quantity.denominator}`;
const today = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Aden" });

export function inventoryAccess(
  context: CompanyContext,
  action: "view" | "manage" | "post" = "view",
) {
  return (
    context.general ||
    context.permissions.some(
      (permission) =>
        permission === `inventory.${action}` ||
        (action === "view" &&
          (permission === "inventory.manage" ||
            permission === "inventory.post")),
    )
  );
}
const adjustmentAccess = (context: CompanyContext) =>
  inventoryAccess(context, "post") &&
  (context.general || context.permissions.includes("finance.post"));

function useInventoryChanges(companyId: number) {
  const client = useQueryClient();
  const { user } = useSession();
  return () =>
    client.invalidateQueries({
      predicate: ({ queryKey }) =>
        queryKey[1] === user?.id &&
        ((["inventory", "finance", "commerce"].includes(String(queryKey[0])) &&
          queryKey[2] === companyId) ||
          (queryKey[0] === "list" &&
            String(queryKey[2]).startsWith(`company:${companyId}:`))),
    });
}

function useInventoryNavigation(
  dirty: boolean,
  saving: boolean,
  unknown: boolean,
) {
  useEffect(() => {
    if (!dirty && !saving && !unknown) return;
    const leaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", leaving);
    return () => window.removeEventListener("beforeunload", leaving);
  }, [dirty, saving, unknown]);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      (dirty || saving || unknown) &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search),
  );
  return (
    <Dialog
      open={blocker.state === "blocked"}
      title="مغادرة عملية المخزون"
      onClose={() => {
        if (blocker.state === "blocked") blocker.reset();
      }}
    >
      <p>
        {unknown
          ? "لم تتأكد نتيجة الترحيل. قد تكون العملية محفوظة؛ أعد تأكيد الطلب نفسه قبل إنشاء عملية جديدة."
          : saving
            ? "جارٍ حفظ العملية. انتظر تأكيد النتيجة."
            : "توجد بيانات غير محفوظة. مغادرة الصفحة ستترك هذه البيانات."}
      </p>
      <div className="form-actions">
        <Button
          variant="secondary"
          onClick={() => {
            if (blocker.state === "blocked") blocker.reset();
          }}
        >
          البقاء
        </Button>
        <Button
          variant="danger"
          disabled={saving}
          onClick={() => {
            if (blocker.state === "blocked") blocker.proceed();
          }}
        >
          مغادرة الصفحة
        </Button>
      </div>
    </Dialog>
  );
}

function ReferenceField<T extends Reference>({
  companyId,
  type,
  label,
  id,
  value,
  onChange,
  disabled = false,
  category,
  nullable = true,
}: {
  companyId: number;
  type: ReferenceType;
  label: string;
  id?: number | null;
  value?: T | null;
  onChange: (value: T | null) => void;
  disabled?: boolean;
  category?: "asset" | "income" | "expense";
  nullable?: boolean;
}) {
  const { user } = useSession();
  const [open, setOpen] = useState(false);
  const selectedId = value?.id ?? id ?? null;
  const resource = `/companies/${companyId}/commerce-options?type=${type}${category ? `&category=${category}` : ""}`;
  const selected = useQuery({
    queryKey: [
      "inventory",
      user?.id,
      companyId,
      "reference",
      type,
      selectedId,
      category,
    ],
    queryFn: ({ signal }) =>
      api<Page<T>>(`${resource}&id=${selectedId}&page=1&pageSize=20`, {
        signal,
      }),
    enabled: !!user && !!selectedId && !value,
  });
  const resolved =
    value ??
    selected.data?.items.find((option) => option.id === selectedId) ??
    null;
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="item-reference-field">
        <Button
          variant="secondary"
          disabled={disabled}
          aria-label={`${label}: ${resolved ? referenceLabel(resolved) : selectedId ? `السجل رقم ${selectedId}` : "اختيار"}`}
          onClick={() => setOpen(true)}
        >
          {resolved
            ? referenceLabel(resolved)
            : selectedId
              ? `السجل رقم ${selectedId}`
              : `اختيار ${label}`}
        </Button>
        {nullable && selectedId && (
          <Button
            variant="ghost"
            disabled={disabled}
            aria-label={`إزالة ${label}`}
            onClick={() => onChange(null)}
          >
            ×
          </Button>
        )}
      </div>
      {selected.error && (
        <small className="text-error">{errorMessage(selected.error)}</small>
      )}
      <Dialog
        open={open}
        title={`اختيار ${label}`}
        onClose={() => setOpen(false)}
      >
        <ServerLookup<T>
          companyId={companyId}
          resource={resource}
          label={label}
          value={resolved}
          display={referenceLabel}
          disabled={disabled}
          onChange={(option) => {
            if (!option) return;
            onChange(option);
            setOpen(false);
          }}
        />
      </Dialog>
    </div>
  );
}

function InventoryLinks({
  companyId,
  operations = false,
}: {
  companyId: number;
  operations?: boolean;
}) {
  return (
    <>
      <Link
        className="button button-secondary"
        to={`/companies/${companyId}/stock-balances`}
      >
        أرصدة المخزون
      </Link>
      <Link
        className="button button-secondary"
        to={`/companies/${companyId}/stock-movements`}
      >
        حركات المخزون
      </Link>
      {operations && (
        <Link
          className="button button-primary"
          to={`/companies/${companyId}/stock-operations`}
        >
          المناقلات
        </Link>
      )}
      {operations && (
        <Link className="button button-primary" to={`/companies/${companyId}/stock-adjustments`}>
          تسوية الأصناف
        </Link>
      )}
    </>
  );
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
function filterId(params: URLSearchParams, key: string) {
  const text = params.get(key) ?? "";
  return /^[1-9][0-9]*$/.test(text) && Number(text) <= 2_147_483_647
    ? Number(text)
    : null;
}
function StockFilters({
  companyId,
  list,
  movements = false,
}: {
  companyId: number;
  list: { query: string; setQuery: (value: string) => void };
  movements?: boolean;
}) {
  const [params, setParams] = useSearchParams();
  return (
    <div className="table-filters">
      <Field
        label="بحث في المخزون"
        type="search"
        value={list.query}
        placeholder="رمز الصنف أو اسمه أو الموقع"
        onChange={(event) => list.setQuery(event.target.value)}
      />
      <ReferenceField<Item>
        companyId={companyId}
        type="items"
        label="الصنف"
        id={filterId(params, "itemId")}
        onChange={(value) =>
          updateFilter(setParams, "itemId", value ? String(value.id) : "")
        }
      />
      <ReferenceField<Location>
        companyId={companyId}
        type="locations"
        label="الموقع"
        id={filterId(params, "locationId")}
        onChange={(value) =>
          updateFilter(setParams, "locationId", value ? String(value.id) : "")
        }
      />
      {movements && (
        <>
          <ReferenceField<Account>
            companyId={companyId}
            type="accounts"
            label="مورد الصنف وقت الحركة"
            id={filterId(params, "supplierAccountId")}
            onChange={(value) =>
              updateFilter(setParams, "supplierAccountId", value ? String(value.id) : "")
            }
          />
          <Select
            label="نوع الحركة"
            value={params.get("kind") ?? ""}
            onChange={(event) =>
              updateFilter(setParams, "kind", event.target.value)
            }
          >
            <option value="">كل الأنواع</option>
            {stockMovementKinds.map((kind) => (
              <option key={kind} value={kind}>
                {stockMovementKindLabels[kind]}
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
        </>
      )}
    </div>
  );
}

export function InventoryBalancesPage({
  context,
}: {
  context: CompanyContext;
}) {
  const { user } = useSession();
  if (!inventoryAccess(context))
    return <Notice tone="warning">ليس لديك صلاحية عرض المخزون.</Notice>;
  return (
    <BalancesList key={`${user?.id}:${context.company.id}`} context={context} />
  );
}
function BalancesList({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const [params] = useSearchParams();
  const filters = new URLSearchParams();
  for (const key of ["itemId", "locationId"])
    if (params.get(key)) filters.set(key, params.get(key)!);
  const list = usePagedQuery<StockBalance>(
    `/companies/${companyId}/stock-balances?${filters}`,
    `company:${companyId}:inventory:balances`,
  );
  const columns = useMemo<ColumnDef<StockBalance, unknown>[]>(
    () => [
      {
        accessorKey: "itemCode",
        header: "رمز الصنف",
        size: 115,
        cell: ({ row }) => exact(row.original.itemCode),
      },
      {
        accessorKey: "itemName",
        header: "الصنف",
        size: 210,
        cell: ({ row }) => <ValueCell>{row.original.itemName}</ValueCell>,
      },
      {
        accessorKey: "branchName",
        header: "الفرع",
        size: 155,
        cell: ({ row }) => <ValueCell>{row.original.branchName}</ValueCell>,
      },
      {
        accessorKey: "locationName",
        header: "الموقع",
        size: 155,
        cell: ({ row }) => <ValueCell>{row.original.locationName}</ValueCell>,
      },
      {
        accessorKey: "expiryDate",
        header: "انتهاء الدفعة",
        size: 125,
        cell: ({ row }) => exact(row.original.expiryDate),
      },
      {
        accessorKey: "quantityUnit1",
        header: "الرصيد بالوحدة الأولى",
        size: 185,
        cell: ({ row }) => (
          <ValueCell
            value={`${quantityText(row.original.quantityUnit1)} ${row.original.unit1Name}`}
          >
            {exact(quantityText(row.original.quantityUnit1))}{" "}
            {row.original.unit1Name}
          </ValueCell>
        ),
      },
      {
        accessorKey: "quantitySmallest",
        header: "الرصيد بأصغر جزء",
        size: 160,
        cell: ({ row }) => exact(row.original.quantitySmallest),
      },
      {
        accessorKey: "pooledQuantityUnit1",
        header: "إجمالي المتوفر بالوحدة الأولى",
        size: 195,
        cell: ({ row }) => <ValueCell>
          <bdi>{firstUnitStockText(row.original.pooledQuantitySmallest, row.original)}</bdi>
        </ValueCell>,
      },
      {
        accessorKey: "pooledQuantitySmallest",
        header: "إجمالي الصنف بأصغر جزء",
        size: 185,
        cell: ({ row }) => exact(row.original.pooledQuantitySmallest),
      },
      {
        accessorKey: "approximateCoverageDays",
        header: "الكفاية التقريبية (يوم)",
        size: 180,
        cell: ({ row }) => <ValueCell><bdi>{row.original.approximateCoverageDays ?? "—"}</bdi></ValueCell>,
      },
      {
        accessorKey: "coverageAfterReserveDays",
        header: "الكفاية بعد الاحتياط (يوم)",
        size: 198,
        cell: ({ row }) => <ValueCell><bdi>{row.original.coverageAfterReserveDays ?? "—"}</bdi></ValueCell>,
      },
      {
        accessorKey: "pooledValueBase",
        header: "إجمالي قيمة الصنف",
        size: 175,
        cell: ({ row }) => (
          <ValueCell
            value={`${formatMoney(row.original.pooledValueBase)} ${row.original.baseCurrencyCode}`}
          >
            {formatMoney(row.original.pooledValueBase)}{" "}
            {row.original.baseCurrencyCode}
          </ValueCell>
        ),
      },
    ],
    [],
  );
  return (
    <>
      <PageHeader
        title="أرصدة المخزون"
        description="الرصيد حسب الصنف والموقع والدفعة، مع إجمالي المتوفر بالوحدة الأولى والكفاية."
        actions={
          <InventoryLinks
            companyId={companyId}
            operations={inventoryAccess(context, "post")}
          />
        }
      />
      <Card>
        <StockFilters companyId={companyId} list={list} />
        <p className="muted">
          إجمالي كمية الصنف وكفايته وقيمته تشمل جميع المواقع والدفعات، وتتكرر للعرض؛
          لا تُجمع هذه القيم بين الصفوف. اضغط عنوان العمود للفرز التصاعدي أو التنازلي.
        </p>
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
          ariaLabel="أرصدة المخزون"
        />
      </Card>
    </>
  );
}

export function InventoryMovementsPage({
  context,
}: {
  context: CompanyContext;
}) {
  const { user } = useSession();
  if (!inventoryAccess(context))
    return <Notice tone="warning">ليس لديك صلاحية عرض حركات المخزون.</Notice>;
  return (
    <MovementsList
      key={`${user?.id}:${context.company.id}`}
      context={context}
    />
  );
}
function MovementsList({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const [params] = useSearchParams();
  const filters = new URLSearchParams();
  for (const key of ["itemId", "locationId", "kind", "supplierAccountId", "dateFrom", "dateTo"])
    if (params.get(key)) filters.set(key, params.get(key)!);
  const list = usePagedQuery<StockMovement>(
    `/companies/${companyId}/stock-movements?${filters}`,
    `company:${companyId}:inventory:movements`,
  );
  const columns = useMemo<ColumnDef<StockMovement, unknown>[]>(
    () => [
      { accessorKey: "id", header: "الحركة", size: 85 },
      { accessorKey: "documentDate", header: "التاريخ", size: 120 },
      {
        accessorKey: "kind",
        header: "نوع الحركة",
        size: 145,
        cell: ({ row }) => stockMovementKindLabels[row.original.kind],
      },
      {
        accessorKey: "itemCode",
        header: "رمز الصنف",
        size: 115,
        cell: ({ row }) => exact(row.original.itemCode),
      },
      {
        accessorKey: "itemName",
        header: "الصنف",
        size: 200,
        cell: ({ row }) => <ValueCell>{row.original.itemName}</ValueCell>,
      },
      {
        accessorKey: "supplierAccountName",
        header: "مورد الصنف وقت الحركة",
        size: 185,
        enableSorting: false,
        cell: ({ row }) => <ValueCell>
          {row.original.supplierAccountName ?? "—"}
          {["prior_purchase","item_estimate"].includes(row.original.supplierInferenceSource ?? "") &&
            <small className="muted"> (تقديري)</small>}
        </ValueCell>,
      },
      {
        accessorKey: "locationName",
        header: "الموقع",
        size: 165,
        cell: ({ row }) => <ValueCell>{row.original.locationName}</ValueCell>,
      },
      {
        accessorKey: "expiryDate",
        header: "انتهاء الدفعة",
        size: 120,
        cell: ({ row }) => exact(row.original.expiryDate),
      },
      {
        accessorKey: "quantitySmallest",
        header: "التغير بأصغر جزء",
        size: 155,
        cell: ({ row }) => exact(row.original.quantitySmallest),
      },
      {
        accessorKey: "costBase",
        header: "تغير القيمة بالأساسية",
        size: 175,
        cell: ({ row }) => <bdi>{formatMoney(row.original.costBase)}</bdi>,
      },
      {
        id: "source",
        header: "المصدر",
        size: 135,
        enableSorting: false,
        cell: ({ row }) =>
          row.original.invoiceId ? (
            <Link
              to={`/companies/${companyId}/invoices/${row.original.invoiceId}`}
            >
              فاتورة {row.original.invoiceId}
            </Link>
          ) : row.original.operationId ? (
            `عملية ${row.original.operationId}`
          ) : (
            "—"
          ),
      },
      {
        accessorKey: "createdAt",
        header: "وقت التسجيل",
        size: 175,
        cell: ({ row }) => (
          <ValueCell>
            {new Date(row.original.createdAt).toLocaleString("ar-YE", {
              timeZone: "Asia/Aden",
            })}
          </ValueCell>
        ),
      },
    ],
    [companyId],
  );
  return (
    <>
      <PageHeader
        title="حركات المخزون"
        description="سجل ثابت للحركات الواردة والصادرة؛ الإشارة السالبة تعني خروج الكمية أو القيمة."
        actions={
          <InventoryLinks
            companyId={companyId}
            operations={inventoryAccess(context, "post")}
          />
        }
      />
      <Card>
        <StockFilters companyId={companyId} list={list} movements />
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
          ariaLabel="حركات المخزون"
        />
      </Card>
    </>
  );
}

const settingsFields = [
  ["inventoryAccountId", "حساب المخزون", "asset"],
  ["salesAccountId", "حساب إيرادات المبيعات", "income"],
  ["cogsAccountId", "حساب تكلفة المبيعات", "expense"],
  ["surplusAccountId", "حساب زيادة الجرد", "income"],
  ["shortageAccountId", "حساب عجز الجرد", "expense"],
] as const;
type AccountFields = Record<(typeof settingsFields)[number][0], number | null>;
function initialAccountFields(
  settings: InventorySettings | null,
): AccountFields {
  return {
    inventoryAccountId: settings?.inventoryAccountId ?? null,
    salesAccountId: settings?.salesAccountId ?? null,
    cogsAccountId: settings?.cogsAccountId ?? null,
    surplusAccountId: settings?.surplusAccountId ?? null,
    shortageAccountId: settings?.shortageAccountId ?? null,
  };
}
export function InventorySettingsPage({
  context,
}: {
  context: CompanyContext;
}) {
  const { user } = useSession();
  if (!inventoryAccess(context))
    return <Notice tone="warning">ليس لديك صلاحية عرض إعدادات المخزون.</Notice>;
  return (
    <SettingsLoader
      key={`${user?.id}:${context.company.id}`}
      context={context}
    />
  );
}
function SettingsLoader({ context }: { context: CompanyContext }) {
  const { user } = useSession();
  const companyId = context.company.id;
  const [loaded, setLoaded] = useState<{
    settings: InventorySettings | null;
  } | null>(null);
  const [message, setMessage] = useState("");
  const query = useQuery({
    queryKey: ["inventory", user?.id, companyId, "settings"],
    queryFn: ({ signal }) =>
      api<{ settings: InventorySettings | null }>(
        `/companies/${companyId}/inventory-settings`,
        { signal },
      ),
  });
  useEffect(() => {
    if (!loaded && query.data) setLoaded(query.data);
  }, [loaded, query.data]);
  if (!loaded)
    return (
      <>
        <PageHeader title="إعدادات المخزون" />
        {query.error ? (
          <Notice tone="error">
            {errorMessage(query.error)}{" "}
            <Button variant="ghost" onClick={() => void query.refetch()}>
              إعادة المحاولة
            </Button>
          </Notice>
        ) : (
          <Notice>جارٍ تحميل الإعدادات…</Notice>
        )}
      </>
    );
  return (
    <>
      {message && <Notice tone="success">{message}</Notice>}
      <SettingsEditor
        key={loaded.settings?.revision ?? "new"}
        context={context}
        settings={loaded.settings}
        onSaved={(settings, text) => {
          setLoaded({ settings });
          setMessage(text);
        }}
      />
    </>
  );
}
function SettingsEditor({
  context,
  settings,
  onSaved,
}: {
  context: CompanyContext;
  settings: InventorySettings | null;
  onSaved: (settings: InventorySettings | null, message: string) => void;
}) {
  const companyId = context.company.id;
  const guard = useScopeGuard(`company:${companyId}:inventory-settings`);
  const changed = useInventoryChanges(companyId);
  const [fields, setFields] = useState(() => initialAccountFields(settings));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const [error, setError] = useState("");
  const submitted = useRef<InventorySettingsInput | null>(null);
  const manage = inventoryAccess(context, "manage");
  const disabled = !manage || saving || unknown;
  const navigation = useInventoryNavigation(dirty, saving, unknown);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!manage || saving || unknown) return;
    setError("");
    const parsed = inventorySettingsSchema.safeParse({
      ...fields,
      revision: settings?.revision ?? null,
      costingMethod: "weighted_average",
      allowNegative: settings?.allowNegative ?? true,
    });
    if (!parsed.success) {
      setError("اختر حسابًا فعالًا لكل وظيفة قبل الحفظ.");
      return;
    }
    submitted.current = parsed.data;
    setSaving(true);
    try {
      const result = await api<{ settings: InventorySettings }>(
        `/companies/${companyId}/inventory-settings`,
        { method: "PUT", body: parsed.data, signal: guard.signal },
      );
      if (!guard.isCurrent()) return;
      setDirty(false);
      onSaved(result.settings, "تم حفظ إعدادات المخزون.");
      void changed();
    } catch (reason) {
      if (guard.isCurrent()) {
        setUnknown(!(reason instanceof ApiFailure) || reason.status >= 500);
        setConflict(reason instanceof ApiFailure && reason.status === 409);
        setError(errorMessage(reason));
      }
    } finally {
      if (guard.isCurrent()) setSaving(false);
    }
  }
  async function verifyOrReload(verify: boolean) {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const result = await api<{ settings: InventorySettings | null }>(
        `/companies/${companyId}/inventory-settings`,
        { signal: guard.signal },
      );
      if (!guard.isCurrent()) return;
      if (verify && submitted.current) {
        const body = submitted.current;
        const matches =
          result.settings &&
          result.settings.revision === (body.revision ?? 0) + 1 &&
          settingsFields.every(([key]) => result.settings![key] === body[key]);
        if (matches) {
          setDirty(false);
          setUnknown(false);
          onSaved(result.settings, "تم تأكيد حفظ إعدادات المخزون.");
          void changed();
        } else if ((result.settings?.revision ?? null) === body.revision) {
          setUnknown(false);
          setError("لم يُحفظ التعديل. بياناتك باقية؛ يمكنك إعادة الحفظ.");
        } else {
          setUnknown(false);
          setConflict(true);
          setError(
            "توجد نسخة مختلفة في الخادم. بياناتك باقية؛ راجع النسخة الحالية قبل الحفظ.",
          );
        }
      } else {
        setDirty(false);
        setUnknown(false);
        setConflict(false);
        setConfirmReload(false);
        setFields(initialAccountFields(result.settings));
        onSaved(result.settings, "تم تحميل الإعدادات الحالية.");
      }
    } catch (reason) {
      if (guard.isCurrent()) setError(errorMessage(reason));
    } finally {
      if (guard.isCurrent()) setSaving(false);
    }
  }
  return (
    <>
      <PageHeader
        title="إعدادات المخزون"
        description="حسابات الترحيل والتكلفة المستخدمة في حركة المخزون والفواتير."
        actions={<InventoryLinks companyId={companyId} />}
      />
      {error && <Notice tone="error">{error}</Notice>}
      {unknown && (
        <Notice tone="warning">
          لم تتأكد نتيجة الحفظ. البيانات مثبتة حتى التحقق.{" "}
          <Button
            variant="ghost"
            disabled={saving}
            onClick={() => void verifyOrReload(true)}
          >
            التحقق من نتيجة الحفظ
          </Button>
        </Notice>
      )}
      {conflict && (
        <Notice tone="warning">
          عدّل شخص آخر الإعدادات. تعديلاتك باقية.{" "}
          <Button
            variant="ghost"
            disabled={saving}
            onClick={() => setConfirmReload(true)}
          >
            تحميل النسخة الحالية
          </Button>
        </Notice>
      )}
      <form onSubmit={(event) => void save(event)}>
        <Card title="حسابات المخزون">
          <div className="form-grid">
            {settingsFields.map(([key, label, category]) => (
              <ReferenceField<Account>
                key={key}
                companyId={companyId}
                type="accounts"
                label={label}
                category={category}
                id={fields[key]}
                nullable={false}
                disabled={disabled}
                onChange={(value) => {
                  setFields((current) => ({
                    ...current,
                    [key]: value?.id ?? null,
                  }));
                  setDirty(true);
                }}
              />
            ))}
            <Field
              label="طريقة التكلفة"
              value="المتوسط المرجح للصنف"
              readOnly
            />
            <Field
              label="سياسة المخزون السالب"
              value="منع الرصيد السالب"
              readOnly
            />
            <Notice>
              حدد حسابات حركية فعالة من دليل شركتك. لا تنشئ هذه الصفحة حسابات
              تلقائية. التكلفة في هذه الدفعة بالعملة الأساسية، والمخزون السالب
              ممنوع.
            </Notice>
          </div>
          {manage && (
            <div className="form-actions">
              <Button
                type="submit"
                disabled={saving || unknown || !dirty || conflict}
              >
                {saving ? "جارٍ الحفظ…" : "حفظ إعدادات المخزون"}
              </Button>
            </div>
          )}
        </Card>
      </form>
      <Dialog
        open={confirmReload}
        title="تحميل إعدادات المخزون الحالية"
        onClose={() => setConfirmReload(false)}
      >
        <p>
          سيستبدل التحميل تعديلاتك غير المحفوظة بالإعدادات الحالية في الخادم.
        </p>
        <div className="form-actions">
          <Button variant="secondary" onClick={() => setConfirmReload(false)}>
            إلغاء
          </Button>
          <Button disabled={saving} onClick={() => void verifyOrReload(false)}>
            تحميل النسخة الحالية
          </Button>
        </div>
      </Dialog>
      {navigation}
    </>
  );
}

type OperationMode = "transfer" | "adjustment";
interface OperationFields {
  documentDate: string;
  quantity: string;
  countedQuantity: string;
  countUnit1: string;
  countUnit2: string;
  countUnit3: string;
  nearestExpiryDate: string;
  unit: 1 | 2 | 3;
  expiryDate: string;
  unitCostBase: string;
  description: string;
}
const initialOperationFields = (): OperationFields => ({
  documentDate: today(),
  quantity: "1",
  countedQuantity: "0",
  countUnit1: "0",
  countUnit2: "0",
  countUnit3: "0",
  nearestExpiryDate: "",
  unit: 1,
  expiryDate: "",
  unitCostBase: "0",
  description: "",
});

export function InventoryOperationsPage({ context }: { context: CompanyContext }) {
  const { user } = useSession();
  if (!inventoryAccess(context, "post"))
    return <Notice tone="warning">ليس لديك صلاحية ترحيل المناقلات.</Notice>;
  return <OperationEditor key={`${user?.id}:${context.company.id}:transfer`}
    context={context} initialMode="transfer" lockedMode />;
}
export function InventoryAdjustmentsPage({ context }: { context: CompanyContext }) {
  const { user } = useSession();
  if (!adjustmentAccess(context))
    return <Notice tone="warning">تسوية الأصناف تحتاج صلاحية ترحيل المخزون والترحيل المالي.</Notice>;
  return <OperationEditor key={`${user?.id}:${context.company.id}:adjustment`}
    context={context} initialMode="adjustment" lockedMode />;
}
export function InventoryAdjustmentSheet({
  context, item, onClose, onSaved,
}: {
  context: CompanyContext;
  item: Item;
  onClose: () => void;
  onSaved?: (nearestExpiryDate: string | null, shelf: {shelfId:number|null;shelf:string}) => void;
}) {
  const { user } = useSession();
  if (!adjustmentAccess(context))
    return <Notice tone="warning">ليس لديك صلاحية تسوية الصنف.</Notice>;
  return <OperationEditor key={`${user?.id}:${context.company.id}:adjust:${item.id}`}
    context={context} initialMode="adjustment" lockedMode preselectedItem={item}
    onClose={onClose} onSaved={onSaved} />;
}
function OperationEditor({
  context, initialMode = "transfer", lockedMode = false,
  preselectedItem = null, onClose, onSaved,
}: {
  context: CompanyContext;
  initialMode?: OperationMode;
  lockedMode?: boolean;
  preselectedItem?: Item | null;
  onClose?: () => void;
  onSaved?: (nearestExpiryDate: string | null, shelf: {shelfId:number|null;shelf:string}) => void;
}) {
  const companyId = context.company.id;
  const { user } = useSession();
  const guard = useScopeGuard(`company:${companyId}:stock-operation`);
  const changed = useInventoryChanges(companyId);
  const [mode, setMode] = useState<OperationMode>(initialMode);
  const [fields, setFields] = useState(() => ({
    ...initialOperationFields(),
    nearestExpiryDate: preselectedItem?.nearestExpiryDate ?? "",
  }));
  const [item, setItem] = useState<Item | null>(preselectedItem);
  const [selectedShelf, setSelectedShelf] = useState<{id:number;name:string}|null>(
    () => preselectedItem?.shelfId
      ? {id:preselectedItem.shelfId,name:preselectedItem.shelf}
      : null,
  );
  const [fromLocation, setFromLocation] = useState<Location | null>(null);
  const [toLocation, setToLocation] = useState<Location | null>(null);
  const [createKey, setCreateKey] = useState(() => crypto.randomUUID());
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<StockOperation | null>(null);
  const submitted = useRef<{
    mode: OperationMode;
    body: StockTransferInput | StockAdjustmentInput;
  } | null>(null);
  const allowed =
    mode === "transfer"
      ? inventoryAccess(context, "post")
      : adjustmentAccess(context);
  const disabled = saving || unknown || !!result || !allowed;
  const navigation = useInventoryNavigation(dirty, saving, unknown);
  const settings = useQuery({
    queryKey: ["inventory", user?.id, companyId, "settings"],
    queryFn: ({ signal }) =>
      api<{ settings: InventorySettings | null }>(
        `/companies/${companyId}/inventory-settings`,
        { signal },
      ),
  });
  const targetReady =
    !!item && !!fromLocation && (!item.hasExpiry || !!fields.expiryDate);
  const batch = useQuery({
    queryKey: [
      "inventory",
      user?.id,
      companyId,
      "count-batch",
      item?.id,
      fromLocation?.id,
      fields.expiryDate,
    ],
    queryFn: ({ signal }) => {
      const filters = new URLSearchParams({
        itemId: String(item!.id),
        locationId: String(fromLocation!.id),
        expiryDate: item!.hasExpiry ? fields.expiryDate : "none",
        page: "1",
        pageSize: "20",
        sort: "id:asc",
      });
      return api<Page<StockBalance>>(
        `/companies/${companyId}/stock-balances?${filters}`,
        { signal },
      );
    },
    enabled: mode === "adjustment" && targetReady && !unknown && !result,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  const batchQuantity =
    batch.data && batch.data.total <= 1
      ? (batch.data.items[0]?.quantitySmallest ?? "0")
      : null;
  function edit<K extends keyof OperationFields>(
    key: K,
    value: OperationFields[K],
  ) {
    setFields((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }
  function selectItem(value: Item | null) {
    setItem(value);
    setSelectedShelf(value?.shelfId ? {id:value.shelfId,name:value.shelf} : null);
    setFields((current) => ({
      ...current, unit: 1, expiryDate: "",
      countUnit1: "0", countUnit2: "0", countUnit3: "0",
      nearestExpiryDate: value?.nearestExpiryDate ?? "",
    }));
    setDirty(true);
  }
  function closeSheet() {
    if (!onClose || saving || unknown) return;
    if (dirty && !window.confirm("توجد بيانات جرد غير محفوظة. هل تريد الإغلاق دون حفظ؟")) return;
    onClose();
  }
  let preview = "";
  if (item) {
    try {
      if (mode === "adjustment") {
        const total = countedStockSmallest({
          unit1: fields.countUnit1 || "0",
          unit2: item.factor2 > 1 ? fields.countUnit2 || "0" : undefined,
          unit3: item.factor3 > 1 ? fields.countUnit3 || "0" : undefined,
        }, item);
        preview = `الإجمالي ${total.toString()} من أصغر جزء`;
      } else {
        const conversion = convertItemQuantity({ quantity: fields.quantity, unit: fields.unit }, item);
        preview = `${quantityText(conversion.unit1)} ${item.unit1Name} · ${conversion.smallestUnits} من أصغر جزء`;
      }
    } catch {
      /* Keep the user's incomplete input intact. */
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!allowed || saving || result) return;
    setError("");
    let body: StockTransferInput | StockAdjustmentInput;
    let action: OperationMode;
    if (unknown && submitted.current) {
      body = submitted.current.body;
      action = submitted.current.mode;
    } else {
      if (!item || !fromLocation || (mode === "transfer" && !toLocation)) {
        setError("اختر الصنف والمواقع المطلوبة.");
        return;
      }
      if (item.hasExpiry && !fields.expiryDate) {
        setError("أدخل تاريخ انتهاء الدفعة لهذا الصنف.");
        return;
      }
      if (
        mode === "adjustment" &&
        (batch.isFetching || batch.error || batchQuantity === null)
      ) {
        setError("انتظر تحميل رصيد الدفعة، أو أعد تحميله قبل الجرد.");
        return;
      }
      const common = {
        documentDate: mode === "adjustment" ? today() : fields.documentDate,
        itemId: item.id,
        unit: fields.unit,
        expiryDate: item.hasExpiry ? fields.expiryDate || null : null,
        description: fields.description,
        idempotencyKey: createKey,
      };
      const parsed =
        mode === "transfer"
          ? stockTransferSchema.safeParse({
              ...common,
              fromLocationId: fromLocation.id,
              toLocationId: toLocation?.id,
              quantity: fields.quantity,
            })
          : stockAdjustmentSchema.safeParse({
              ...common,
              locationId: fromLocation.id,
              unit: 1,
              countedUnits: {
                unit1: fields.countUnit1 || "0",
                ...(item.factor2 > 1 ? { unit2: fields.countUnit2 || "0" } : {}),
                ...(item.factor3 > 1 ? { unit3: fields.countUnit3 || "0" } : {}),
              },
              nearestExpiryDate: item.hasExpiry ? fields.nearestExpiryDate || null : undefined,
              shelfId: selectedShelf?.id ?? null,
              expectedQuantitySmallest: batchQuantity,
            });
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? "تحقق من بيانات العملية.");
        return;
      }
      body = parsed.data;
      action = mode;
      submitted.current = { mode: action, body };
    }
    setSaving(true);
    try {
      const response = await api<{ operation: StockOperation }>(
        `/companies/${companyId}/${action === "transfer" ? "stock-transfers" : "stock-adjustments"}`,
        { method: "POST", body, signal: guard.signal },
      );
      if (!guard.isCurrent()) return;
      setUnknown(false);
      setDirty(false);
      setResult(response.operation);
      if (action === "adjustment")
        onSaved?.(item?.hasExpiry ? (fields.nearestExpiryDate || null) : null,
          {shelfId:selectedShelf?.id??null,shelf:selectedShelf?.name??""});
      void changed();
    } catch (reason) {
      if (guard.isCurrent()) {
        if (!(reason instanceof ApiFailure) || reason.status >= 500)
          setUnknown(true);
        setError(errorMessage(reason));
      }
    } finally {
      if (guard.isCurrent()) setSaving(false);
    }
  }
  function newOperation() {
    if (saving || unknown) return;
    setResult(null);
    setError("");
    setFields({ ...initialOperationFields(), nearestExpiryDate: preselectedItem ? fields.nearestExpiryDate : "" });
    setItem(preselectedItem);
    setSelectedShelf(preselectedItem?.shelfId
      ? {id:preselectedItem.shelfId,name:preselectedItem.shelf} : null);
    setFromLocation(null);
    setToLocation(null);
    setCreateKey(crypto.randomUUID());
    submitted.current = null;
    setDirty(false);
  }
  return (
    <>
      {onClose && <div className="inventory-sheet-backdrop" onClick={closeSheet} aria-hidden="true" />}
      <section className={onClose ? "inventory-sheet-panel" : undefined}
        role={onClose ? "dialog" : undefined} aria-modal={onClose ? true : undefined}
        aria-label={onClose ? `جرد الصنف ${preselectedItem?.name ?? ""}` : undefined}>
      {onClose ? (
        <div className="inventory-sheet-header">
          <strong>جرد وتسوية الصنف: {preselectedItem?.name}</strong>
          <Button variant="secondary" disabled={saving || unknown} onClick={closeSheet}>إغلاق</Button>
        </div>
      ) : <PageHeader
        title={mode === "adjustment" ? "تسوية الأصناف" : "المناقلات"}
        description={mode === "adjustment"
          ? "جرد الصنف بجميع وحداته مع حفظ أقرب تاريخ انتهاء في كرت الصنف."
          : "ترحيل مناقلة المخزون بين موقعين."}
        actions={<InventoryLinks companyId={companyId} />}
      />}
      {error && <Notice tone="error">{error}</Notice>}
      {unknown && (
        <Notice tone="warning">
          لم تتأكد نتيجة الترحيل. الحقول مثبتة؛ أعد تأكيد الطلب نفسه حتى لا
          تتكرر الحركة.
        </Notice>
      )}
      {settings.error && (
        <Notice tone="error">
          {errorMessage(settings.error)}{" "}
          <Button variant="ghost" onClick={() => void settings.refetch()}>
            إعادة تحميل الإعدادات
          </Button>
        </Notice>
      )}
      {settings.data && !settings.data.settings && (
        <Notice tone="warning">
          أكمل{" "}
          <Link to={`/companies/${companyId}/inventory-settings`}>
            إعدادات المخزون
          </Link>{" "}
          قبل الترحيل.
        </Notice>
      )}
      {result && (
        <Card
          title={`تم ترحيل ${result.kind === "transfer" ? "المناقلة" : "تسوية الجرد"} رقم ${result.id}`}
        >
          <p>
            تاريخ المستند: <bdi>{result.documentDate}</bdi> · عدد الحركات:{" "}
            {result.movements.length}
          </p>
          {result.movements.map((movement) => (
            <p key={movement.id}>
              {stockMovementKindLabels[movement.kind]} · {movement.itemName} ·{" "}
              {movement.locationName} · {exact(movement.quantitySmallest)} من
              أصغر جزء · القيمة الأساسية {formatMoney(movement.costBase)}
            </p>
          ))}
          {result.financialDocumentId && (
            <p>
              <Link
                to={`/companies/${companyId}/financial-documents/${result.financialDocumentId}`}
              >
                فتح القيد المحاسبي المرتبط
              </Link>
            </p>
          )}
          <div className="form-actions">
            <Button onClick={newOperation}>بدء عملية جديدة</Button>
            <Link
              className="button button-secondary"
              to={`/companies/${companyId}/stock-movements`}
            >
              عرض حركات المخزون
            </Link>
          </div>
        </Card>
      )}
      <form onSubmit={(event) => void save(event)}>
        <Card title="بيانات العملية">
          <div className="form-grid">
            {!lockedMode && <Select
              label="نوع العملية"
              value={mode}
              disabled={saving || unknown || !!result}
              onChange={(event) => {
                setMode(event.target.value as OperationMode);
                setDirty(true);
              }}
            >
              <option value="transfer">مناقلة بين موقعين</option>
              <option value="adjustment">جرد وتسوية رصيد دفعة</option>
            </Select>}
            {mode === "transfer" && <Field
              label="تاريخ المستند"
              type="date"
              required
              value={fields.documentDate}
              disabled={disabled}
              onChange={(event) => edit("documentDate", event.target.value)}
            />}
            <ReferenceField<Item>
              companyId={companyId}
              type="items"
              label="الصنف"
              value={item}
              disabled={disabled || !!preselectedItem}
              nullable={false}
              onChange={selectItem}
            />
            <ReferenceField<Location>
              companyId={companyId}
              type="locations"
              label={mode === "transfer" ? "موقع الإرسال" : "موقع الجرد"}
              value={fromLocation}
              disabled={disabled}
              nullable={false}
              onChange={(value) => {
                setFromLocation(value);
                setDirty(true);
              }}
            />
            {mode === "transfer" && (
              <ReferenceField<Location>
                companyId={companyId}
                type="locations"
                label="موقع الاستلام"
                value={toLocation}
                disabled={disabled}
                nullable={false}
                onChange={(value) => {
                  setToLocation(value);
                  setDirty(true);
                }}
              />
            )}
            {mode === "transfer" && <Select
              label="الوحدة"
              value={fields.unit}
              disabled={disabled || !item}
              onChange={(event) =>
                edit("unit", Number(event.target.value) as 1 | 2 | 3)
              }
            >
              <option value={1}>{item?.unit1Name ?? "الوحدة الأولى"}</option>
              {item && item.factor2 > 1 && (
                <option value={2}>{item.unit2Name}</option>
              )}
              {item && item.factor3 > 1 && (
                <option value={3}>{item.unit3Name}</option>
              )}
            </Select>}
            {mode === "transfer" ? (
              <Field
                label="كمية المناقلة"
                inputMode="numeric"
                dir="ltr"
                required
                value={fields.quantity}
                maxLength={22}
                disabled={disabled}
                hint="عدد صحيح موجب من الوحدة المختارة"
                onChange={(event) => edit("quantity", event.target.value)}
              />
            ) : (
              <>
                <Field label={`الكمية المعدودة — ${item?.unit1Name || "الوحدة الأولى"}`}
                  inputMode="numeric" dir="ltr" required maxLength={22}
                  value={fields.countUnit1} disabled={disabled}
                  onChange={(event) => edit("countUnit1", event.target.value)}
                  hint="عدد الوحدات الأولى الكاملة" />
                {item && item.factor2 > 1 && (
                  <Field label={`الكمية المعدودة — ${item.unit2Name}`}
                    inputMode="numeric" dir="ltr" required maxLength={22}
                    value={fields.countUnit2} disabled={disabled}
                    onChange={(event) => edit("countUnit2", event.target.value)}
                    hint="عدد الوحدات الثانية الإضافية" />
                )}
                {item && item.factor3 > 1 && (
                  <Field label={`الكمية المعدودة — ${item.unit3Name}`}
                    inputMode="numeric" dir="ltr" required maxLength={22}
                    value={fields.countUnit3} disabled={disabled}
                    onChange={(event) => edit("countUnit3", event.target.value)}
                    hint="عدد الوحدات الثالثة الإضافية" />
                )}
              </>
            )}
            {item?.hasExpiry && (
              <ExpiryMonthField
                label="شهر وسنة انتهاء الدفعة"
                required
                value={fields.expiryDate}
                disabled={disabled}
                onChange={(date) => edit("expiryDate", date ?? "")}
              />
            )}
            {mode === "adjustment" && (
              <ServerLookup<{id:number;name:string}>
                companyId={companyId}
                resource={`/companies/${companyId}/item-options?type=shelves&archived=false`}
                label="رف الصنف في الكرت"
                value={selectedShelf}
                disabled={disabled || !item}
                onChange={option=>{
                  setSelectedShelf(option);
                  setDirty(true);
                }}
                display={option=>option.name}
                emptyLabel="اختر الرف أو اتركه دون رف"
              />
            )}
            {mode === "adjustment" && item?.hasExpiry && (
              <ExpiryMonthField
                label="شهر وسنة أقرب انتهاء في كرت الصنف"
                value={fields.nearestExpiryDate}
                disabled={disabled}
                onChange={(date) => edit("nearestExpiryDate", date ?? "")}
                hint="معلومة كرت الصنف؛ لا تغيّر تاريخ انتهاء دفعة المخزون."
              />
            )}
            <Field
              label="البيان"
              className="form-full"
              value={fields.description}
              maxLength={1000}
              disabled={disabled}
              onChange={(event) => edit("description", event.target.value)}
            />
            {preview && (
              <p className="muted form-full">
                الكمية المعادلة:{" "}
                <bdi className="inventory-exact">{preview}</bdi>
              </p>
            )}
            {mode === "adjustment" && (
              <div className="form-full">
                <Notice tone={batch.error ? "error" : "info"}>
                  {!targetReady ? (
                    "اختر الصنف وموقع الجرد ودفعة الانتهاء لتحميل رصيدها قبل الجرد."
                  ) : batch.isFetching ? (
                    "جارٍ تحميل رصيد الدفعة…"
                  ) : batch.error ? (
                    errorMessage(batch.error)
                  ) : batchQuantity === null ? (
                    "لم يُحدد رصيد الدفعة بدقة. أعد تحميله قبل الحفظ."
                  ) : (
                    <>
                      الرصيد المحمل قبل الجرد: {exact(batchQuantity)} من أصغر
                      جزء. يتوقف الترحيل إذا تغير هذا الرصيد في الخادم.
                    </>
                  )}
                  <Button
                    variant="ghost"
                    disabled={
                      !targetReady ||
                      saving ||
                      unknown ||
                      !!result ||
                      batch.isFetching
                    }
                    onClick={() => void batch.refetch()}
                  >
                    إعادة تحميل الرصيد
                  </Button>
                </Notice>
              </div>
            )}
            {mode === "adjustment" && !adjustmentAccess(context) && (
              <Notice tone="warning">
                تسوية الجرد تحتاج صلاحية ترحيل المخزون وصلاحية الترحيل المالي
                معًا.
              </Notice>
            )}
          </div>
          {!result && (
            <div className="form-actions">
              <Button
                type="submit"
                disabled={
                  saving ||
                  !allowed ||
                  (!unknown &&
                    (!settings.data?.settings ||
                      (mode === "adjustment" &&
                        (!targetReady ||
                          batch.isFetching ||
                          !!batch.error ||
                          batchQuantity === null))))
                }
              >
                {saving
                  ? "جارٍ الترحيل…"
                  : unknown
                    ? "إعادة تأكيد الطلب نفسه"
                    : mode === "transfer"
                      ? "ترحيل المناقلة"
                      : "ترحيل تسوية الجرد"}
              </Button>
            </div>
          )}
        </Card>
      </form>
      {navigation}
      </section>
    </>
  );
}
