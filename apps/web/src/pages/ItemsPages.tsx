import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  useBlocker,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
  convertItemQuantity,
  itemSchema,
  itemPatchSchema,
  itemAgentSchema,
  itemAgentPatchSchema,
  itemFactorSchema,
  type CompanyContext,
  type CompanyCurrency,
  type Item,
  type ItemAgent,
  type ItemInput,
  type ItemAgentInput,
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

export function itemsAccess(context: CompanyContext, manage = false) {
  return (
    context.general ||
    context.permissions.some(
      (permission) =>
        permission === "items.manage" ||
        (!manage && permission === "items.view"),
    )
  );
}

function useItemChanges(companyId: number) {
  const client = useQueryClient();
  const { user } = useSession();
  return async () =>
    client.invalidateQueries({
      predicate: ({ queryKey }) =>
        queryKey[1] === user?.id &&
        ((queryKey[0] === "items" && queryKey[2] === companyId) ||
          (queryKey[0] === "master" && queryKey[2] === companyId) ||
          (queryKey[0] === "list" &&
            String(queryKey[2]).startsWith(`company:${companyId}:`))),
    });
}

function useEditorNavigation(
  dirty: boolean,
  saving: boolean,
  unknown: boolean,
  label: string,
) {
  const allowNavigation = useRef(false);
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
      !allowNavigation.current &&
      (dirty || saving || unknown) &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search),
  );
  const prompt = (
    <Dialog
      open={blocker.state === "blocked"}
      title={`مغادرة ${label}`}
      onClose={() => {
        if (blocker.state === "blocked") blocker.reset();
      }}
    >
      <p>
        {unknown
          ? "لم تُعرف نتيجة الحفظ. قد يكون الكرت محفوظًا؛ أعد تأكيد الطلب نفسه قبل إنشاء كرت جديد."
          : saving
            ? "جارٍ حفظ الكرت. انتظر تأكيد النتيجة قبل المغادرة."
            : "توجد تعديلات غير محفوظة. المغادرة ستترك هذه التعديلات."}
      </p>
      <div className="form-actions">
        <Button
          variant="secondary"
          onClick={() => {
            if (blocker.state === "blocked") blocker.reset();
          }}
        >
          البقاء في الكرت
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
  );
  return { allowNavigation, prompt };
}

export function ItemsPage({ context }: { context: CompanyContext }) {
  if (!itemsAccess(context))
    return <Notice tone="warning">ليس لديك صلاحية عرض الأصناف.</Notice>;
  return <ItemsManager context={context} />;
}
function ItemsManager({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const filters = new URLSearchParams();
  for (const key of ["active", "hasExpiry", "agentId"])
    if (params.get(key)) filters.set(key, params.get(key)!);
  const list = usePagedQuery<Item>(
    `/companies/${companyId}/items?${filters}`,
    `company:${companyId}:items`,
  );
  const canManage = itemsAccess(context, true);
  function filter(key: string, value: string) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      value ? next.set(key, value) : next.delete(key);
      next.delete("page");
      return next;
    });
  }
  const columns = useMemo<ColumnDef<Item, unknown>[]>(
    () => [
      {
        accessorKey: "code",
        header: "رمز الصنف",
        size: 115,
        cell: ({ row }) => (
          <ValueCell>
            <bdi>{row.original.code}</bdi>
          </ValueCell>
        ),
      },
      {
        accessorKey: "name",
        header: "اسم الصنف",
        size: 210,
        cell: ({ row }) => <ValueCell>{row.original.name}</ValueCell>,
      },
      {
        accessorKey: "englishName",
        header: "الاسم الإنجليزي",
        size: 175,
        cell: ({ row }) => (
          <ValueCell>{row.original.englishName || "—"}</ValueCell>
        ),
      },
      {
        accessorKey: "barcode",
        header: "الباركود",
        size: 135,
        cell: ({ row }) => (
          <ValueCell>
            <bdi>{row.original.barcode || "—"}</bdi>
          </ValueCell>
        ),
      },
      {
        accessorKey: "agentName",
        header: "وكيل الصنف",
        enableSorting: false,
        size: 165,
        cell: ({ row }) => (
          <ValueCell>{row.original.agentName || "—"}</ValueCell>
        ),
      },
      {
        accessorKey: "unit1Name",
        header: "الوحدة الأولى",
        size: 105,
        cell: ({ row }) => <ValueCell>{row.original.unit1Name}</ValueCell>,
      },
      {
        accessorKey: "salePrice1",
        header: "سعر بيع الأولى",
        size: 120,
        cell: ({ row }) => (
          <ValueCell>
            <bdi>{row.original.salePrice1}</bdi>
          </ValueCell>
        ),
      },
      {
        accessorKey: "currencyCode",
        header: "عملة الأسعار",
        enableSorting: false,
        size: 100,
        cell: ({ row }) => <bdi>{row.original.currencyCode}</bdi>,
      },
      {
        accessorKey: "hasExpiry",
        header: "له انتهاء",
        size: 100,
        cell: ({ row }) => (row.original.hasExpiry ? "نعم" : "لا"),
      },
      {
        accessorKey: "active",
        header: "الحالة",
        size: 95,
        cell: ({ row }) => (row.original.active ? "فعال" : "مؤرشف"),
      },
      {
        accessorKey: "createdAt",
        header: "تاريخ الإنشاء",
        size: 155,
        cell: ({ row }) => (
          <ValueCell>
            <bdi>
              {new Date(row.original.createdAt).toLocaleString("ar-YE")}
            </bdi>
          </ValueCell>
        ),
      },
      {
        id: "actions",
        header: "الإجراء",
        enableSorting: false,
        size: 95,
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="compact"
            aria-label={`${canManage ? "تعديل" : "عرض"} الصنف ${row.original.code}`}
            onClick={() =>
              navigate(`/companies/${companyId}/items/${row.original.id}`)
            }
          >
            {canManage ? "تعديل" : "عرض"}
          </Button>
        ),
      },
    ],
    [companyId, canManage, navigate],
  );
  return (
    <>
      <PageHeader
        title="الأصناف"
        description="كروت الأصناف ووحداتها وأسعارها."
        actions={
          canManage && (
            <Button
              onClick={() => navigate(`/companies/${companyId}/items/new`)}
            >
              صنف جديد
            </Button>
          )
        }
      />
      <Card title="قائمة الأصناف">
        <div className="table-filters">
          <Field
            label="بحث في الأصناف"
            type="search"
            value={list.query}
            placeholder="الاسم أو الرمز أو الباركود أو مفاتيح البحث"
            onChange={(event) => list.setQuery(event.target.value)}
          />
          <Select
            label="حالة الصنف"
            value={params.get("active") ?? ""}
            onChange={(event) => filter("active", event.target.value)}
          >
            <option value="">كل الحالات</option>
            <option value="true">فعال</option>
            <option value="false">مؤرشف</option>
          </Select>
          <Select
            label="انتهاء الصلاحية"
            value={params.get("hasExpiry") ?? ""}
            onChange={(event) => filter("hasExpiry", event.target.value)}
          >
            <option value="">الكل</option>
            <option value="true">له انتهاء</option>
            <option value="false">بدون انتهاء</option>
          </Select>
        </div>
        {list.error && <Notice tone="error">{errorMessage(list.error)}</Notice>}
        <DataTable
          columns={columns}
          data={list.data?.items ?? []}
          total={list.data?.total ?? 0}
          page={list.page}
          pageSize={list.pageSize}
          sorting={list.sorting}
          onSortingChange={list.setSorting}
          onPageChange={list.setPage}
          onPageSizeChange={list.setPageSize}
          loading={list.loading}
          ariaLabel="جدول الأصناف"
        />
      </Card>
    </>
  );
}

export function ItemPage({ context }: { context: CompanyContext }) {
  const { itemId = "new" } = useParams();
  if (!itemsAccess(context))
    return <Notice tone="warning">ليس لديك صلاحية عرض الأصناف.</Notice>;
  if (itemId === "new" && !itemsAccess(context, true))
    return <Notice tone="warning">ليس لديك صلاحية إنشاء صنف.</Notice>;
  return (
    <ItemDetail
      key={`${context.company.id}:${itemId}`}
      context={context}
      itemId={itemId}
    />
  );
}
function ItemDetail({
  context,
  itemId,
}: {
  context: CompanyContext;
  itemId: string;
}) {
  const { user } = useSession();
  const client = useQueryClient();
  const [epoch, setEpoch] = useState(0);
  const [notice, setNotice] = useState("");
  const queryKey = ["items", user?.id, context.company.id, "detail", itemId];
  const result = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      api<{ item: Item }>(`/companies/${context.company.id}/items/${itemId}`, {
        signal,
      }),
    enabled: itemId !== "new",
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  if (itemId !== "new" && result.isPending)
    return <Notice>جارٍ تحميل الصنف…</Notice>;
  if (result.error)
    return (
      <Card>
        <Notice tone="error">{errorMessage(result.error)}</Notice>
        <Button variant="secondary" onClick={() => void result.refetch()}>
          إعادة المحاولة
        </Button>
      </Card>
    );
  return (
    <>
      {notice && <Notice tone="success">{notice}</Notice>}
      <ItemEditor
        key={`${result.data?.item.id ?? "new"}:${result.data?.item.revision ?? 0}:${epoch}`}
        context={context}
        item={result.data?.item ?? null}
        onSaved={(item, message) => {
          client.setQueryData(queryKey, { item });
          setEpoch((value) => value + 1);
          setNotice(message);
        }}
      />
    </>
  );
}

type ItemFields = {
  name: string;
  englishName: string;
  barcode: string;
  unit1Name: string;
  unit2Name: string;
  unit3Name: string;
  factor2: string;
  factor3: string;
  salePrice1: string;
  salePrice2: string;
  salePrice3: string;
  purchasePrice: string;
  purchaseFactor: string;
  reorderLimit: string;
  orderQuantity: string;
  searchKeys: string;
  purchaseNotes: string;
  orderStoppedUntil: string;
  hasExpiry: boolean;
  active: boolean;
};
function initialItemFields(item: Item | null): ItemFields {
  return {
    name: item?.name ?? "",
    englishName: item?.englishName ?? "",
    barcode: item?.barcode ?? "",
    unit1Name: item?.unit1Name ?? "باكت",
    unit2Name: item?.unit2Name ?? "",
    unit3Name: item?.unit3Name ?? "",
    factor2: String(item?.factor2 ?? 1),
    factor3: String(item?.factor3 ?? 1),
    salePrice1: item?.salePrice1 ?? "0",
    salePrice2: item?.salePrice2 ?? "0",
    salePrice3: item?.salePrice3 ?? "0",
    purchasePrice: item?.purchasePrice ?? "0",
    purchaseFactor: String(item?.purchaseFactor ?? 1),
    reorderLimit: item?.reorderLimit ?? "0",
    orderQuantity: item?.orderQuantity ?? "0",
    searchKeys: item?.searchKeys ?? "",
    purchaseNotes: item?.purchaseNotes ?? "",
    orderStoppedUntil: item?.orderStoppedUntil ?? "",
    hasExpiry: item?.hasExpiry ?? true,
    active: item?.active ?? true,
  };
}
type SelectedCurrency = Pick<
  CompanyCurrency,
  "id" | "code" | "name" | "decimalPlaces" | "active"
>;
type SelectedAgent = Pick<ItemAgent, "id" | "name" | "active">;
function ItemEditor({
  context,
  item,
  onSaved,
}: {
  context: CompanyContext;
  item: Item | null;
  onSaved: (item: Item, message: string) => void;
}) {
  const companyId = context.company.id;
  const { user } = useSession();
  const navigate = useNavigate();
  const guard = useScopeGuard(`company:${companyId}:item:${item?.id ?? "new"}`);
  const changed = useItemChanges(companyId);
  const [fields, setFields] = useState(() => initialItemFields(item));
  const [currency, setCurrency] = useState<SelectedCurrency | null>(
    item
      ? {
          id: item.currencyId,
          code: item.currencyCode,
          name: item.currencyName,
          decimalPlaces: item.currencyDecimalPlaces,
          active: item.currencyActive,
        }
      : null,
  );
  const defaultApplied = useRef(false);
  const defaultCurrency = useQuery({
    queryKey: ["company", user?.id, companyId, "item-default-currency", "YER"],
    queryFn: ({ signal }) =>
      api<{ items: SelectedCurrency[] }>(
        `/companies/${companyId}/item-options?type=currencies&q=YER&pageSize=20`,
        { signal },
      ),
    enabled: !!user && !item,
  });
  useEffect(() => {
    if (item || defaultApplied.current) return;
    const yemeni = defaultCurrency.data?.items.find(
      (value) => value.code === "YER" && value.active,
    );
    if (yemeni) {
      defaultApplied.current = true;
      setCurrency((selected) => selected ?? yemeni);
    }
  }, [item, defaultCurrency.data]);
  const [agent, setAgent] = useState<SelectedAgent | null>(
    item?.agentId
      ? {
          id: item.agentId,
          name: item.agentName ?? "وكيل الصنف",
          active: item.agentActive ?? false,
        }
      : null,
  );
  const [picker, setPicker] = useState<"currency" | "agent" | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [unknownCreation, setUnknownCreation] = useState(false);
  const [error, setError] = useState("");
  const [reloadConfirmation, setReloadConfirmation] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [createKey] = useState(() => crypto.randomUUID());
  const submittedCreate = useRef<ItemInput | null>(null);
  const manage = itemsAccess(context, true);
  const disabled = !manage || saving || unknownCreation;
  const navigation = useEditorNavigation(
    dirty,
    saving,
    unknownCreation,
    "كرت الصنف",
  );
  function edit<K extends keyof ItemFields>(key: K, value: ItemFields[K]) {
    setDirty(true);
    setFields((previous) => ({ ...previous, [key]: value }));
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!manage || saving) return;
    setError("");
    const body = {
      ...fields,
      factor2: fields.factor2,
      factor3: fields.factor3,
      purchaseFactor: fields.purchaseFactor,
      currencyId: currency?.id ?? 0,
      agentId: agent?.id ?? null,
      orderStoppedUntil: fields.orderStoppedUntil || null,
    };
    const parsed = item
      ? itemPatchSchema.safeParse({ ...body, revision: item.revision })
      : itemSchema.safeParse(
          unknownCreation
            ? submittedCreate.current
            : { ...body, idempotencyKey: createKey },
        );
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "تحقق من بيانات الصنف.");
      return;
    }
    if (!item) submittedCreate.current = parsed.data as ItemInput;
    setSaving(true);
    try {
      const result = await api<{ item: Item }>(
        `/companies/${companyId}/items${item ? `/${item.id}` : ""}`,
        {
          method: item ? "PATCH" : "POST",
          body: parsed.data,
          signal: guard.signal,
        },
      );
      if (!guard.isCurrent()) return;
      setDirty(false);
      setUnknownCreation(false);
      setConflict(false);
      if (item) onSaved(result.item, `تم حفظ الصنف ${result.item.code}.`);
      else {
        navigation.allowNavigation.current = true;
        navigate(`/companies/${companyId}/items/${result.item.id}`, {
          replace: true,
        });
      }
      void changed();
    } catch (reason) {
      if (guard.isCurrent()) {
        if (!item && (!(reason instanceof ApiFailure) || reason.status >= 500))
          setUnknownCreation(true);
        if (item && reason instanceof ApiFailure && reason.status === 409)
          setConflict(true);
        setError(errorMessage(reason));
      }
    } finally {
      if (guard.isCurrent()) setSaving(false);
    }
  }
  async function reload() {
    if (!item || saving) return;
    setSaving(true);
    setError("");
    try {
      const result = await api<{ item: Item }>(
        `/companies/${companyId}/items/${item.id}`,
        { signal: guard.signal },
      );
      if (!guard.isCurrent()) return;
      setDirty(false);
      setReloadConfirmation(false);
      onSaved(result.item, "تم تحميل النسخة الحالية من الصنف.");
    } catch (reason) {
      if (guard.isCurrent()) setError(errorMessage(reason));
    } finally {
      if (guard.isCurrent()) setSaving(false);
    }
  }
  const parsedFactor2 = itemFactorSchema.safeParse(fields.factor2);
  const parsedFactor3 = itemFactorSchema.safeParse(fields.factor3);
  const factor2 = parsedFactor2.success ? parsedFactor2.data : NaN;
  const factor3 = parsedFactor3.success ? parsedFactor3.data : NaN;
  return (
    <div className="item-editor">
      <PageHeader
        title={
          item ? `${manage ? "تعديل" : "عرض"} الصنف ${item.code}` : "صنف جديد"
        }
        description={
          item
            ? `أُنشئ ${new Date(item.createdAt).toLocaleString("ar-YE")} · الإصدار ${item.revision}`
            : "يُنشأ رمز الصنف تلقائيًا بعد تأكيد الحفظ."
        }
        actions={
          <Button
            variant="secondary"
            onClick={() => navigate(`/companies/${companyId}/items`)}
          >
            العودة للأصناف
          </Button>
        }
      />
      {error && <Notice tone="error">{error}</Notice>}
      {unknownCreation && (
        <Notice tone="warning">
          لم تُعرف نتيجة الحفظ. الحقول مثبتة؛ أعد تأكيد الطلب نفسه حتى لا يتكرر
          الصنف.
        </Notice>
      )}
      {conflict && (
        <Notice tone="warning">
          توجد نسخة أحدث من هذا الصنف. تعديلاتك باقية هنا؛{" "}
          <Button
            variant="ghost"
            disabled={saving}
            onClick={() => setReloadConfirmation(true)}
          >
            تحميل النسخة الحالية
          </Button>
        </Notice>
      )}
      <form onSubmit={(event) => void save(event)}>
        <Card title="بيانات الصنف">
          <div className="item-fields-grid">
            <Field
              label="رمز الصنف"
              value={item?.code ?? "تلقائي عند الحفظ"}
              readOnly
            />
            <Field
              label="اسم الصنف"
              required
              maxLength={120}
              value={fields.name}
              disabled={disabled}
              onChange={(event) => edit("name", event.target.value)}
            />
            <Field
              label="الاسم بالإنجليزية"
              maxLength={120}
              value={fields.englishName}
              disabled={disabled}
              onChange={(event) => edit("englishName", event.target.value)}
            />
            <Field
              label="الباركود"
              maxLength={80}
              dir="ltr"
              value={fields.barcode}
              disabled={disabled}
              onChange={(event) => edit("barcode", event.target.value)}
            />
            <div className="field">
              <label id="item-agent-label">وكيل الصنف</label>
              <div className="item-reference-field">
                <Button
                  variant="secondary"
                  disabled={disabled}
                  aria-labelledby="item-agent-label item-agent-choice"
                  onClick={() => setPicker("agent")}
                >
                  <span id="item-agent-choice">
                    {agent?.name ?? "اختيار وكيل الصنف"}
                  </span>
                </Button>
                {agent && (
                  <Button
                    variant="ghost"
                    disabled={disabled}
                    aria-label="إزالة وكيل الصنف"
                    onClick={() => {
                      setAgent(null);
                      setDirty(true);
                    }}
                  >
                    ×
                  </Button>
                )}
              </div>
              {agent && !agent.active && (
                <small className="muted">الوكيل مؤرشف</small>
              )}
            </div>
            <div className="field">
              <label id="item-currency-label">عملة الأسعار</label>
              <Button
                variant="secondary"
                disabled={disabled}
                aria-labelledby="item-currency-label item-currency-choice"
                onClick={() => setPicker("currency")}
              >
                <span id="item-currency-choice">
                  {currency
                    ? `${currency.code} — ${currency.name}`
                    : "اختيار عملة الأسعار"}
                </span>
              </Button>
              {currency && !currency.active && (
                <small className="muted">العملة موقفة</small>
              )}
            </div>
            <Field
              label="مفاتيح البحث"
              className="item-span-two"
              value={fields.searchKeys}
              maxLength={1000}
              disabled={disabled}
              onChange={(event) => edit("searchKeys", event.target.value)}
              placeholder="كلمات وأسماء أخرى تساعد في البحث"
            />
            <label className="check-label">
              <input
                type="checkbox"
                checked={fields.hasExpiry}
                disabled={disabled}
                onChange={(event) => edit("hasExpiry", event.target.checked)}
              />
              له تاريخ انتهاء
            </label>
            <label className="check-label">
              <input
                type="checkbox"
                checked={!fields.active}
                disabled={disabled}
                onChange={(event) => edit("active", !event.target.checked)}
              />
              مؤرشف
            </label>
          </div>
        </Card>
        <Card
          title="الوحدات وأسعار البيع"
          description="أسعار البيع الثلاثة مستقلة؛ لا تُحسب تلقائيًا من سعر وحدة أخرى."
        >
          <div className="item-units-scroll">
            <table
              className="item-units-table"
              aria-label="الوحدات الثلاث وأسعار البيع"
            >
              <thead>
                <tr>
                  <th>مستوى الوحدة</th>
                  <th>اسم الوحدة</th>
                  <th>عددها داخل السابقة</th>
                  <th>سعر البيع</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th>الأولى</th>
                  <td>
                    <Field
                      label="اسم الوحدة الأولى"
                      required
                      maxLength={120}
                      className="item-cell-field"
                      value={fields.unit1Name}
                      disabled={disabled}
                      onChange={(event) =>
                        edit("unit1Name", event.target.value)
                      }
                    />
                  </td>
                  <td>—</td>
                  <td>
                    <Field
                      label="سعر بيع الوحدة الأولى"
                      className="item-cell-field"
                      inputMode="decimal"
                      dir="ltr"
                      value={fields.salePrice1}
                      disabled={disabled}
                      onChange={(event) =>
                        edit("salePrice1", event.target.value)
                      }
                    />
                  </td>
                </tr>
                <tr>
                  <th>الثانية</th>
                  <td>
                    <Field
                      label="اسم الوحدة الثانية"
                      required={factor2 > 1}
                      maxLength={120}
                      className="item-cell-field"
                      value={fields.unit2Name}
                      disabled={disabled}
                      onChange={(event) =>
                        edit("unit2Name", event.target.value)
                      }
                    />
                  </td>
                  <td>
                    <Field
                      label="عدد الثانية داخل الأولى"
                      className="item-cell-field"
                      inputMode="numeric"
                      dir="ltr"
                      value={fields.factor2}
                      disabled={disabled}
                      onChange={(event) => edit("factor2", event.target.value)}
                    />
                  </td>
                  <td>
                    <Field
                      label="سعر بيع الوحدة الثانية"
                      className="item-cell-field"
                      inputMode="decimal"
                      dir="ltr"
                      value={fields.salePrice2}
                      disabled={disabled}
                      onChange={(event) =>
                        edit("salePrice2", event.target.value)
                      }
                    />
                  </td>
                </tr>
                <tr>
                  <th>الثالثة</th>
                  <td>
                    <Field
                      label="اسم الوحدة الثالثة"
                      required={factor3 > 1}
                      maxLength={120}
                      className="item-cell-field"
                      value={fields.unit3Name}
                      disabled={disabled}
                      onChange={(event) =>
                        edit("unit3Name", event.target.value)
                      }
                    />
                  </td>
                  <td>
                    <Field
                      label="عدد الثالثة داخل الثانية"
                      className="item-cell-field"
                      inputMode="numeric"
                      dir="ltr"
                      value={fields.factor3}
                      disabled={disabled}
                      onChange={(event) => edit("factor3", event.target.value)}
                    />
                  </td>
                  <td>
                    <Field
                      label="سعر بيع الوحدة الثالثة"
                      className="item-cell-field"
                      inputMode="decimal"
                      dir="ltr"
                      value={fields.salePrice3}
                      disabled={disabled}
                      onChange={(event) =>
                        edit("salePrice3", event.target.value)
                      }
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>
        <Card title="إعدادات الشراء والطلب">
          <div className="item-fields-grid">
            <Field
              label="سعر الشراء الافتراضي"
              inputMode="decimal"
              dir="ltr"
              value={fields.purchasePrice}
              disabled={disabled}
              onChange={(event) => edit("purchasePrice", event.target.value)}
            />
            <Field
              label="عامل وحدة الشراء"
              inputMode="numeric"
              dir="ltr"
              value={fields.purchaseFactor}
              disabled={disabled}
              onChange={(event) => edit("purchaseFactor", event.target.value)}
              hint="قيمة محفوظة للشراء، لا تدخل في معاينة تحويل الوحدات."
            />
            <Field
              label="حد الطلب"
              inputMode="numeric"
              dir="ltr"
              value={fields.reorderLimit}
              disabled={disabled}
              onChange={(event) => edit("reorderLimit", event.target.value)}
            />
            <Field
              label="كمية الطلب"
              inputMode="numeric"
              dir="ltr"
              value={fields.orderQuantity}
              disabled={disabled}
              onChange={(event) => edit("orderQuantity", event.target.value)}
            />
            <Field
              label="يتوقف الطلب حتى تاريخ"
              type="date"
              value={fields.orderStoppedUntil}
              disabled={disabled}
              onChange={(event) =>
                edit("orderStoppedUntil", event.target.value)
              }
            />
            <Field
              label="ملاحظات الشراء"
              className="item-span-three"
              maxLength={1000}
              value={fields.purchaseNotes}
              disabled={disabled}
              onChange={(event) => edit("purchaseNotes", event.target.value)}
            />
          </div>
        </Card>
        <UnitPreview
          factor2={factor2}
          factor3={factor3}
          names={[fields.unit1Name, fields.unit2Name, fields.unit3Name]}
          disabled={saving || unknownCreation}
        />
        <div className="form-actions item-save-actions">
          {manage && (
            <Button type="submit" disabled={saving}>
              {saving
                ? "جارٍ الحفظ…"
                : unknownCreation
                  ? "إعادة تأكيد الحفظ"
                  : "حفظ الصنف"}
            </Button>
          )}
          {item && manage && (
            <Button
              variant="secondary"
              disabled={saving || unknownCreation}
              onClick={() => setReloadConfirmation(true)}
            >
              تحميل النسخة الحالية
            </Button>
          )}
          <Button
            variant="secondary"
            disabled={saving}
            onClick={() => navigate(`/companies/${companyId}/items`)}
          >
            العودة للقائمة
          </Button>
        </div>
      </form>
      <Dialog
        open={picker !== null}
        title={
          picker === "currency" ? "اختيار عملة الأسعار" : "اختيار وكيل الصنف"
        }
        onClose={() => setPicker(null)}
      >
        {picker === "currency" ? (
          <ServerLookup<CompanyCurrency>
            companyId={companyId}
            resource={`/companies/${companyId}/item-options?type=currencies&active=true`}
            label="العملة"
            value={currency as CompanyCurrency | null}
            display={(option) => `${option.code} — ${option.name}`}
            disabled={disabled}
            onChange={(option) => {
              if (!option) return;
              setCurrency(option);
              setDirty(true);
              setPicker(null);
            }}
          />
        ) : picker === "agent" ? (
          <ServerLookup<ItemAgent>
            companyId={companyId}
            resource={`/companies/${companyId}/item-options?type=agents&active=true`}
            label="الوكيل"
            value={agent as ItemAgent | null}
            display={(option) => option.name}
            disabled={disabled}
            onChange={(option) => {
              if (!option) return;
              setAgent(option);
              setDirty(true);
              setPicker(null);
            }}
          />
        ) : null}
      </Dialog>
      <Dialog
        open={reloadConfirmation}
        title="تحميل النسخة الحالية"
        onClose={() => {
          if (!saving) setReloadConfirmation(false);
        }}
      >
        <p>
          سيستبدل التحميل الحقول الحالية بأحدث نسخة محفوظة، بما فيها تعديلاتك
          غير المحفوظة.
        </p>
        <div className="form-actions">
          <Button disabled={saving} onClick={() => void reload()}>
            تأكيد التحميل
          </Button>
          <Button
            variant="secondary"
            disabled={saving}
            onClick={() => setReloadConfirmation(false)}
          >
            إلغاء
          </Button>
        </div>
      </Dialog>
      {navigation.prompt}
    </div>
  );
}
function UnitPreview({
  factor2,
  factor3,
  names,
  disabled,
}: {
  factor2: number;
  factor3: number;
  names: string[];
  disabled: boolean;
}) {
  const [quantity, setQuantity] = useState("1");
  const [unit, setUnit] = useState<1 | 2 | 3>(1);
  const chosenUnit =
    (unit === 2 && factor2 <= 1) || (unit === 3 && factor3 <= 1) ? 1 : unit;
  let result: ReturnType<typeof convertItemQuantity> | null = null;
  let error = "";
  try {
    result = convertItemQuantity(
      { quantity, unit: chosenUnit },
      { factor2, factor3 },
    );
  } catch {
    error = "أدخل كمية صحيحة غير سالبة، وعوامل تجزئة صحيحة من 1 إلى 1000000.";
  }
  function exact(value: {
    numerator: string;
    denominator: string;
    decimal: string | null;
  }) {
    return value.decimal ?? `${value.numerator}/${value.denominator}`;
  }
  return (
    <Card
      title="معاينة تحويل الوحدات"
      description="تحويل للمعاينة فقط؛ لا ينشئ حركة مخزون."
    >
      <div className="item-preview-inputs">
        <Field
          label="الكمية للمعاينة"
          inputMode="numeric"
          dir="ltr"
          value={quantity}
          disabled={disabled}
          onChange={(event) => setQuantity(event.target.value)}
        />
        <Select
          label="وحدة المعاينة"
          value={chosenUnit}
          disabled={disabled}
          onChange={(event) => setUnit(Number(event.target.value) as 1 | 2 | 3)}
        >
          <option value="1">{names[0] || "الأولى"}</option>
          {factor2 > 1 && <option value="2">{names[1] || "الثانية"}</option>}
          {factor3 > 1 && <option value="3">{names[2] || "الثالثة"}</option>}
        </Select>
      </div>
      {error && <Notice tone="warning">{error}</Notice>}
      {result && (
        <div className="item-preview-results" aria-live="polite">
          <span>
            بالوحدة الأولى: <bdi>{exact(result.unit1)}</bdi>{" "}
            {names[0] || "الأولى"}
          </span>
          <span>
            بأصغر وحدة: <bdi>{result.smallestUnits}</bdi>{" "}
            {factor3 > 1
              ? names[2] || "الثالثة"
              : factor2 > 1
                ? names[1] || "الثانية"
                : names[0] || "الأولى"}
          </span>
          <span>
            الأجزاء: <bdi>{result.parts.unit1}</bdi> أولى +{" "}
            <bdi>{result.parts.unit2}</bdi> ثانية +{" "}
            <bdi>{result.parts.unit3}</bdi> ثالثة
          </span>
        </div>
      )}
    </Card>
  );
}

export function ItemAgentsPage({ context }: { context: CompanyContext }) {
  if (!itemsAccess(context))
    return <Notice tone="warning">ليس لديك صلاحية عرض وكلاء الأصناف.</Notice>;
  return <AgentsManager context={context} />;
}
function AgentsManager({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const guard = useScopeGuard(`company:${companyId}:item-agents`);
  const changed = useItemChanges(companyId);
  const [params, setParams] = useSearchParams();
  const resource = `/companies/${companyId}/item-agents${params.has("active") ? `?active=${params.get("active")}` : ""}`;
  const list = usePagedQuery<ItemAgent>(
    resource,
    `company:${companyId}:item-agents`,
  );
  const [editor, setEditor] = useState<{ agent: ItemAgent | null } | null>(
    null,
  );
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const manage = itemsAccess(context, true);
  async function edit(agent: ItemAgent) {
    if (loadingDetail) return;
    setLoadingDetail(true);
    setError("");
    try {
      const result = await api<{ agent: ItemAgent }>(
        `/companies/${companyId}/item-agents/${agent.id}`,
        { signal: guard.signal },
      );
      if (guard.isCurrent()) setEditor({ agent: result.agent });
    } catch (reason) {
      if (guard.isCurrent()) setError(errorMessage(reason));
    } finally {
      if (guard.isCurrent()) setLoadingDetail(false);
    }
  }
  const columns = useMemo<ColumnDef<ItemAgent, unknown>[]>(
    () => [
      {
        accessorKey: "id",
        header: "المعرف",
        size: 85,
        cell: ({ row }) => <bdi>{row.original.id}</bdi>,
      },
      {
        accessorKey: "name",
        header: "اسم الوكيل",
        size: 200,
        cell: ({ row }) => <ValueCell>{row.original.name}</ValueCell>,
      },
      {
        accessorKey: "phone",
        header: "الهاتف",
        size: 145,
        cell: ({ row }) => (
          <ValueCell>
            <bdi>{row.original.phone || "—"}</bdi>
          </ValueCell>
        ),
      },
      {
        accessorKey: "address",
        header: "العنوان",
        size: 220,
        cell: ({ row }) => <ValueCell>{row.original.address || "—"}</ValueCell>,
      },
      {
        accessorKey: "active",
        header: "الحالة",
        size: 100,
        cell: ({ row }) => (row.original.active ? "فعال" : "مؤرشف"),
      },
      {
        accessorKey: "createdAt",
        header: "تاريخ الإنشاء",
        size: 170,
        cell: ({ row }) => (
          <ValueCell>
            <bdi>
              {new Date(row.original.createdAt).toLocaleString("ar-YE")}
            </bdi>
          </ValueCell>
        ),
      },
      ...(manage
        ? [
            {
              id: "actions",
              header: "الإجراء",
              enableSorting: false,
              size: 95,
              cell: ({ row }: { row: { original: ItemAgent } }) => (
                <Button
                  variant="ghost"
                  size="compact"
                  disabled={loadingDetail}
                  aria-label={`تعديل الوكيل ${row.original.name}`}
                  onClick={() => void edit(row.original)}
                >
                  تعديل
                </Button>
              ),
            },
          ]
        : []),
    ],
    [manage, loadingDetail],
  );
  return (
    <>
      <PageHeader
        title="وكلاء الأصناف"
        description="دليل وكلاء الأصناف داخل الشركة."
        actions={
          manage && (
            <Button onClick={() => setEditor({ agent: null })}>
              وكيل جديد
            </Button>
          )
        }
      />
      {notice && <Notice tone="success">{notice}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {loadingDetail && <Notice>جارٍ تحميل كرت الوكيل…</Notice>}
      <Card title="قائمة الوكلاء">
        <div className="table-filters">
          <Field
            label="بحث في الوكلاء"
            type="search"
            value={list.query}
            onChange={(event) => list.setQuery(event.target.value)}
            placeholder="الاسم أو الهاتف"
          />
          <Select
            label="حالة الوكيل"
            value={params.get("active") ?? ""}
            onChange={(event) =>
              setParams((previous) => {
                const next = new URLSearchParams(previous);
                event.target.value
                  ? next.set("active", event.target.value)
                  : next.delete("active");
                next.delete("page");
                return next;
              })
            }
          >
            <option value="">كل الحالات</option>
            <option value="true">فعال</option>
            <option value="false">مؤرشف</option>
          </Select>
        </div>
        {list.error && <Notice tone="error">{errorMessage(list.error)}</Notice>}
        <DataTable
          columns={columns}
          data={list.data?.items ?? []}
          total={list.data?.total ?? 0}
          page={list.page}
          pageSize={list.pageSize}
          sorting={list.sorting}
          onSortingChange={list.setSorting}
          onPageChange={list.setPage}
          onPageSizeChange={list.setPageSize}
          loading={list.loading}
          ariaLabel="جدول وكلاء الأصناف"
        />
      </Card>
      {editor && (
        <AgentEditor
          key={editor.agent?.id ?? "new"}
          context={context}
          agent={editor.agent}
          onClose={() => setEditor(null)}
          onSaved={(agent) => {
            if (!guard.isCurrent()) return;
            setEditor(null);
            setNotice(`تم حفظ الوكيل ${agent.name}.`);
            void changed();
          }}
        />
      )}
    </>
  );
}
function AgentEditor({
  context,
  agent,
  onClose,
  onSaved,
}: {
  context: CompanyContext;
  agent: ItemAgent | null;
  onClose: () => void;
  onSaved: (agent: ItemAgent) => void;
}) {
  const companyId = context.company.id;
  const guard = useScopeGuard(
    `company:${companyId}:item-agent:${agent?.id ?? "new"}`,
  );
  const [fields, setFields] = useState({
    name: agent?.name ?? "",
    phone: agent?.phone ?? "",
    address: agent?.address ?? "",
    notes: agent?.notes ?? "",
    active: agent?.active ?? true,
  });
  const [revision, setRevision] = useState(agent?.revision ?? 0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [error, setError] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [createKey] = useState(() => crypto.randomUUID());
  const submittedCreate = useRef<ItemAgentInput | null>(null);
  const navigation = useEditorNavigation(dirty, saving, unknown, "كرت الوكيل");
  const disabled = saving || unknown;
  function edit<K extends keyof typeof fields>(
    key: K,
    value: (typeof fields)[K],
  ) {
    setDirty(true);
    setFields((previous) => ({ ...previous, [key]: value }));
  }
  function close() {
    if (saving) return;
    if (dirty || unknown) setConfirmClose(true);
    else onClose();
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setError("");
    const parsed = agent
      ? itemAgentPatchSchema.safeParse({ ...fields, revision })
      : itemAgentSchema.safeParse(
          unknown
            ? submittedCreate.current
            : { ...fields, idempotencyKey: createKey },
        );
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "تحقق من بيانات الوكيل.");
      return;
    }
    if (!agent) submittedCreate.current = parsed.data as ItemAgentInput;
    setSaving(true);
    try {
      const result = await api<{ agent: ItemAgent }>(
        `/companies/${companyId}/item-agents${agent ? `/${agent.id}` : ""}`,
        {
          method: agent ? "PATCH" : "POST",
          body: parsed.data,
          signal: guard.signal,
        },
      );
      if (guard.isCurrent()) {
        setDirty(false);
        setUnknown(false);
        onSaved(result.agent);
      }
    } catch (reason) {
      if (guard.isCurrent()) {
        if (!agent && (!(reason instanceof ApiFailure) || reason.status >= 500))
          setUnknown(true);
        if (agent && reason instanceof ApiFailure && reason.status === 409)
          setConflict(true);
        setError(errorMessage(reason));
      }
    } finally {
      if (guard.isCurrent()) setSaving(false);
    }
  }
  async function reload() {
    if (!agent || saving) return;
    setSaving(true);
    setError("");
    try {
      const result = await api<{ agent: ItemAgent }>(
        `/companies/${companyId}/item-agents/${agent.id}`,
        { signal: guard.signal },
      );
      if (guard.isCurrent()) {
        const fresh = result.agent;
        setFields({
          name: fresh.name,
          phone: fresh.phone,
          address: fresh.address,
          notes: fresh.notes,
          active: fresh.active,
        });
        setRevision(fresh.revision);
        setDirty(false);
        setConflict(false);
        setConfirmReload(false);
      }
    } catch (reason) {
      if (guard.isCurrent()) setError(errorMessage(reason));
    } finally {
      if (guard.isCurrent()) setSaving(false);
    }
  }
  return (
    <>
      <Dialog
        open
        title={agent ? "تعديل وكيل الصنف" : "وكيل صنف جديد"}
        onClose={close}
      >
        <form onSubmit={(event) => void save(event)} className="form-grid">
          {error && <Notice tone="error">{error}</Notice>}
          {unknown && (
            <Notice tone="warning">
              لم تُعرف نتيجة الحفظ. أعد تأكيد الطلب نفسه؛ تبقى الحقول مثبتة حتى
              التأكيد.
            </Notice>
          )}
          {conflict && (
            <Notice tone="warning">
              توجد نسخة أحدث؛ تعديلاتك محفوظة في هذه النافذة.{" "}
              <Button
                variant="ghost"
                disabled={saving}
                onClick={() => setConfirmReload(true)}
              >
                تحميل النسخة الحالية
              </Button>
            </Notice>
          )}
          <Field
            label="اسم الوكيل"
            required
            maxLength={120}
            value={fields.name}
            disabled={disabled}
            onChange={(event) => edit("name", event.target.value)}
          />
          <Field
            label="هاتف الوكيل"
            inputMode="tel"
            dir="ltr"
            maxLength={40}
            value={fields.phone}
            disabled={disabled}
            onChange={(event) => edit("phone", event.target.value)}
          />
          <Field
            label="عنوان الوكيل"
            maxLength={500}
            value={fields.address}
            disabled={disabled}
            onChange={(event) => edit("address", event.target.value)}
          />
          <Field
            label="ملاحظات الوكيل"
            maxLength={1000}
            value={fields.notes}
            disabled={disabled}
            onChange={(event) => edit("notes", event.target.value)}
          />
          <label className="check-label">
            <input
              type="checkbox"
              checked={!fields.active}
              disabled={disabled}
              onChange={(event) => edit("active", !event.target.checked)}
            />
            مؤرشف
          </label>
          {agent && (
            <p className="muted">
              أُنشئ {new Date(agent.createdAt).toLocaleString("ar-YE")} ·
              الإصدار {revision}
            </p>
          )}
          <div className="form-actions form-full">
            <Button type="submit" disabled={saving}>
              {saving
                ? "جارٍ الحفظ…"
                : unknown
                  ? "إعادة تأكيد الحفظ"
                  : "حفظ الوكيل"}
            </Button>
            <Button variant="secondary" disabled={saving} onClick={close}>
              إغلاق
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={confirmClose}
        title="إغلاق كرت الوكيل"
        onClose={() => setConfirmClose(false)}
      >
        <p>
          {unknown
            ? "قد يكون الوكيل محفوظًا. تحقق من القائمة قبل إنشاء كرت جديد."
            : "توجد تعديلات غير محفوظة. هل تريد إغلاق الكرت؟"}
        </p>
        <div className="form-actions">
          <Button variant="secondary" onClick={() => setConfirmClose(false)}>
            البقاء في الكرت
          </Button>
          <Button variant="danger" disabled={saving} onClick={onClose}>
            إغلاق دون حفظ
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={confirmReload}
        title="تحميل النسخة الحالية"
        onClose={() => {
          if (!saving) setConfirmReload(false);
        }}
      >
        <p>سيستبدل التحميل تعديلاتك بأحدث نسخة محفوظة.</p>
        <div className="form-actions">
          <Button disabled={saving} onClick={() => void reload()}>
            تأكيد التحميل
          </Button>
          <Button
            variant="secondary"
            disabled={saving}
            onClick={() => setConfirmReload(false)}
          >
            إلغاء
          </Button>
        </div>
      </Dialog>
      {navigation.prompt}
    </>
  );
}
