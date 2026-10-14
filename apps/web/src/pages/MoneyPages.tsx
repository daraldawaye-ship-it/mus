import { useMemo, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
  currencyPatchSchema,
  currencySchema,
  exchangeRateSchema,
  type CompanyContext,
  type CompanyCurrency,
  type ExchangeRate,
  type FinanceSettings,
  type Page,
} from "../../../../packages/contracts/src/index";
import { api, usePagedQuery, useScopeGuard, useSession } from "../api";
import { formatMoney } from "../format-money";
import {
  errorMessage,
  moduleAccess,
  ServerLookup,
  useMasterChanges,
} from "../phase2";
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

const currencyLabel = (currency: CompanyCurrency) =>
  `${currency.code} — ${currency.name}`;
const dateTime = (value: string) =>
  new Intl.DateTimeFormat("ar", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value)) + " UTC";
const rateDirection = (rate: ExchangeRate) =>
  `1 ${rate.currencyCode} = ${formatMoney(rate.rate)} ${rate.baseCurrencyCode}`;

function useFinanceSettings(companyId: number) {
  const { user } = useSession();
  return useQuery({
    queryKey: ["company", user?.id, companyId, "finance-settings"],
    queryFn: ({ signal }) =>
      api<{ settings: FinanceSettings | null }>(
        `/companies/${companyId}/finance-settings`,
        { signal },
      ),
    enabled: !!user,
  });
}

function useBaseCurrency(
  companyId: number,
  settings: FinanceSettings | null | undefined,
) {
  const { user } = useSession();
  return useQuery({
    queryKey: [
      "company",
      user?.id,
      companyId,
      "currency",
      settings?.baseCurrencyId,
    ],
    queryFn: ({ signal }) =>
      api<{ currency: CompanyCurrency }>(
        `/companies/${companyId}/currencies/${settings!.baseCurrencyId}`,
        { signal },
      ),
    enabled: !!user && !!settings,
  });
}

function FinanceSettingsCard({
  context,
  onSaved,
}: {
  context: CompanyContext;
  onSaved: (message: string) => void;
}) {
  const companyId = context.company.id;
  const { user } = useSession();
  const guard = useScopeGuard(`company:${companyId}:finance-settings`);
  const settings = useFinanceSettings(companyId);
  const base = useBaseCurrency(companyId, settings.data?.settings);
  const mayManage = moduleAccess(context, "currencies", true);
  const history = useQuery({
    queryKey: ["company", user?.id, companyId, "exchange-rate-history"],
    queryFn: ({ signal }) =>
      api<Page<ExchangeRate>>(
        `/companies/${companyId}/exchange-rates?page=1&pageSize=10&sort=id:asc`,
        { signal },
      ),
    enabled: !!user && mayManage,
  });
  const [chosen, setChosen] = useState<CompanyCurrency | null | undefined>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const value = chosen === undefined ? (base.data?.currency ?? null) : chosen;
  const locked = (history.data?.total ?? 0) > 0;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!value || saving || locked || !history.data || settings.error) return;
    setSaving(true);
    setError("");
    try {
      await api<{ settings: FinanceSettings }>(
        `/companies/${companyId}/finance-settings`,
        {
          method: "PATCH",
          body: { baseCurrencyId: value.id },
          signal: guard.signal,
        },
      );
      if (guard.isCurrent()) {
        setChosen(undefined);
        onSaved("تم حفظ العملة الأساسية.");
      }
    } catch (reason) {
      if (guard.isCurrent()) setError(errorMessage(reason));
    } finally {
      if (guard.isCurrent()) setSaving(false);
    }
  }
  return (
    <Card
      title="العملة الأساسية"
      description="وحدة واحدة من العملة الأجنبية تساوي سعر الصرف من العملة الأساسية."
    >
      {settings.isPending && <Notice>جارٍ تحميل إعدادات العملات…</Notice>}
      {settings.error && (
        <Notice tone="error">
          {errorMessage(settings.error)}{" "}
          <Button variant="ghost" onClick={() => void settings.refetch()}>
            إعادة المحاولة
          </Button>
        </Notice>
      )}
      {settings.data && (
        <p>
          {settings.data.settings ? (
            <>
              العملة الأساسية الحالية:{" "}
              <bdi>{settings.data.settings.baseCurrencyCode}</bdi>
              {" — "}
              {settings.data.settings.baseCurrencyName}. سعرها التعريفي 1.
            </>
          ) : (
            "لم تُحدد عملة أساسية بعد. إذا كان لديك عملات فعالة، يمكنك اختيار العملة الأساسية."
          )}
        </p>
      )}
      {mayManage && locked && (
        <Notice>
          يوجد تاريخ لأسعار الصرف؛ أصبحت العملة الأساسية ثابتة لحفظ معنى الأسعار
          المسجلة.
        </Notice>
      )}
      {mayManage && !locked && settings.data && (
        <form className="form-stack" onSubmit={submit}>
          <ServerLookup<CompanyCurrency>
            companyId={companyId}
            resource={`/companies/${companyId}/currencies?active=true`}
            label="اختيار العملة الأساسية"
            value={value}
            onChange={setChosen}
            display={currencyLabel}
            disabled={saving || history.isPending || !!history.error}
            required
          />
          {base.error && (
            <Notice tone="error">{errorMessage(base.error)}</Notice>
          )}
          {history.error && (
            <Notice tone="error">
              {errorMessage(history.error)}{" "}
              <Button variant="ghost" onClick={() => void history.refetch()}>
                إعادة تحميل تاريخ الأسعار
              </Button>
            </Notice>
          )}
          {error && <Notice tone="error">{error}</Notice>}
          <div className="form-actions">
            <Button
              type="submit"
              disabled={
                saving ||
                history.isFetching ||
                !!history.error ||
                !history.data ||
                !value ||
                value.id === settings.data.settings?.baseCurrencyId
              }
            >
              {saving ? "جارٍ الحفظ…" : "حفظ العملة الأساسية"}
            </Button>
          </div>
          <p className="muted">
            يمكن تغيير العملة الأساسية قبل تسجيل أي سعر صرف فقط.
          </p>
        </form>
      )}
    </Card>
  );
}

export function CurrenciesPage({ context }: { context: CompanyContext }) {
  if (!moduleAccess(context, "currencies"))
    return (
      <Notice tone="warning">ليس لديك صلاحية عرض عملات هذه الشركة.</Notice>
    );
  return <CurrenciesContent context={context} />;
}

function CurrenciesContent({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const scope = `company:${companyId}:currencies`;
  const guard = useScopeGuard(scope);
  const refresh = useMasterChanges(companyId);
  const settings = useFinanceSettings(companyId);
  const mayManage = moduleAccess(context, "currencies", true);
  const [params, setParams] = useSearchParams();
  const activeFilter = params.get("active") ?? "";
  const filters = new URLSearchParams();
  if (activeFilter) filters.set("active", activeFilter);
  const list = usePagedQuery<CompanyCurrency>(
    `/companies/${companyId}/currencies?${filters}`,
    scope,
  );
  const [editor, setEditor] = useState<CompanyCurrency | "new" | null>(null);
  const [opening, setOpening] = useState<number | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const openVersion = useRef(0);
  async function openEditor(id: number) {
    const version = ++openVersion.current;
    setOpening(id);
    setError("");
    try {
      const result = await api<{ currency: CompanyCurrency }>(
        `/companies/${companyId}/currencies/${id}`,
        { signal: guard.signal },
      );
      if (guard.isCurrent() && version === openVersion.current)
        setEditor(result.currency);
    } catch (reason) {
      if (guard.isCurrent() && version === openVersion.current)
        setError(errorMessage(reason));
    } finally {
      if (guard.isCurrent() && version === openVersion.current)
        setOpening(null);
    }
  }
  function changed(message: string) {
    if (!guard.isCurrent()) return;
    setEditor(null);
    setNotice(message);
    setError("");
    void refresh();
  }
  const columns = useMemo<ColumnDef<CompanyCurrency, unknown>[]>(
    () => [
      {
        accessorKey: "code",
        header: "كود العملة",
        cell: ({ row }) => (
          <ValueCell>
            {`${row.original.code}${row.original.id === settings.data?.settings?.baseCurrencyId ? " (الأساسية)" : ""}`}
          </ValueCell>
        ),
      },
      {
        accessorKey: "name",
        header: "اسم العملة",
        cell: ({ row }) => <ValueCell>{row.original.name}</ValueCell>,
      },
      { accessorKey: "decimalPlaces", header: "المنازل العشرية" },
      {
        accessorKey: "active",
        header: "الحالة",
        cell: ({ row }) => (row.original.active ? "فعالة" : "غير فعالة"),
      },
      {
        id: "actions",
        header: "الإجراءات",
        enableSorting: false,
        cell: ({ row }) =>
          mayManage ? (
            <Button
              size="compact"
              variant="ghost"
              disabled={opening !== null}
              aria-label={`تعديل ${row.original.code}`}
              onClick={() => void openEditor(row.original.id)}
            >
              {opening === row.original.id ? "جارٍ التحميل…" : "تعديل"}
            </Button>
          ) : (
            "—"
          ),
      },
    ],
    [mayManage, opening, settings.data?.settings?.baseCurrencyId],
  );
  return (
    <>
      <PageHeader
        title="العملات"
        description="عملات الشركة ودقة عرضها؛ الكود والدقة ثابتان بعد الإنشاء."
        actions={
          mayManage && (
            <>
              <Button
                disabled={opening !== null}
                onClick={() => setEditor("new")}
              >
                إضافة عملة
              </Button>
            </>
          )
        }
      />
      {notice && <Notice tone="success">{notice}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <FinanceSettingsCard context={context} onSaved={changed} />
      <Card title="عملات الشركة">
        <div className="table-filters">
          <Field
            label="بحث في العملات"
            type="search"
            value={list.query}
            onChange={(event) => list.setQuery(event.target.value)}
            placeholder="الكود أو الاسم"
          />
          <Select
            label="الحالة"
            value={activeFilter}
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
            <option value="true">فعالة</option>
            <option value="false">غير فعالة</option>
          </Select>
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
          getRowId={(row) => String(row.id)}
          selectionMode="os"
          ariaLabel="قائمة عملات الشركة"
        />
      </Card>
      {mayManage && editor !== null && (
        <CurrencyEditor
          key={editor === "new" ? "new" : editor.id}
          companyId={companyId}
          currency={editor === "new" ? null : editor}
          isBase={
            editor !== "new" &&
            editor.id === settings.data?.settings?.baseCurrencyId
          }
          onClose={() => setEditor(null)}
          onSaved={changed}
        />
      )}
    </>
  );
}

function CurrencyEditor({
  companyId,
  currency,
  isBase,
  onClose,
  onSaved,
}: {
  companyId: number;
  currency: CompanyCurrency | null;
  isBase: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const guard = useScopeGuard(
    `company:${companyId}:currency:${currency?.id ?? "new"}`,
  );
  const [code, setCode] = useState(currency?.code ?? "");
  const [name, setName] = useState(currency?.name ?? "");
  const [decimalPlaces, setDecimalPlaces] = useState(
    currency?.decimalPlaces ?? 2,
  );
  const [active, setActive] = useState(currency?.active ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    const body = currency ? { name, active } : { code, name, decimalPlaces };
    const parsed = currency
      ? currencyPatchSchema.safeParse(body)
      : currencySchema.safeParse(body);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "تحقق من بيانات العملة.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await api<{ currency: CompanyCurrency }>(
        `/companies/${companyId}/currencies${currency ? `/${currency.id}` : ""}`,
        {
          method: currency ? "PATCH" : "POST",
          body: parsed.data,
          signal: guard.signal,
        },
      );
      if (guard.isCurrent())
        onSaved(currency ? "تم حفظ العملة." : "تمت إضافة العملة.");
    } catch (reason) {
      if (guard.isCurrent()) setError(errorMessage(reason));
    } finally {
      if (guard.isCurrent()) setSaving(false);
    }
  }
  return (
    <Dialog
      open
      title={currency ? "تعديل العملة" : "إضافة عملة"}
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <form onSubmit={submit} className="form-stack">
        {error && <Notice tone="error">{error}</Notice>}
        <Field
          label="كود العملة"
          dir="ltr"
          value={code}
          onChange={(event) => setCode(event.target.value.toUpperCase())}
          required
          minLength={3}
          maxLength={3}
          pattern="[A-Z]{3}"
          readOnly={!!currency}
          disabled={saving}
          autoFocus={!currency}
          hint={
            currency
              ? "الكود ثابت بعد الإنشاء."
              : "ثلاثة أحرف لاتينية كبيرة، مثل YER."
          }
        />
        <Field
          label="اسم العملة"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={120}
          disabled={saving}
          autoFocus={!!currency}
        />
        <Select
          label="المنازل العشرية"
          value={decimalPlaces}
          onChange={(event) => setDecimalPlaces(Number(event.target.value))}
          disabled={saving || !!currency}
        >
          {[0, 1, 2, 3, 4, 5, 6].map((digits) => (
            <option key={digits} value={digits}>
              {digits}
            </option>
          ))}
        </Select>
        <p className="muted">
          دقة العرض ثابتة بعد الإنشاء، ولا تُستخدم لتحويل مبالغ في هذه المرحلة.
        </p>
        {currency && (
          <label className="check-label">
            <input
              type="checkbox"
              checked={active}
              onChange={(event) => setActive(event.target.checked)}
              disabled={saving || isBase}
            />
            عملة فعالة
          </label>
        )}
        {isBase && <Notice>لا يمكن إيقاف العملة الأساسية.</Notice>}
        <div className="form-actions">
          <Button type="submit" disabled={saving}>
            {saving ? "جارٍ الحفظ…" : currency ? "حفظ العملة" : "إضافة العملة"}
          </Button>
          <Button variant="secondary" disabled={saving} onClick={onClose}>
            إلغاء
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function ExchangeRatesPage({ context }: { context: CompanyContext }) {
  if (!moduleAccess(context, "currencies"))
    return (
      <Notice tone="warning">
        ليس لديك صلاحية عرض أسعار الصرف لهذه الشركة.
      </Notice>
    );
  return <ExchangeRatesContent context={context} />;
}

function ExchangeRatesContent({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const { user } = useSession();
  const guard = useScopeGuard(`company:${companyId}:exchange-rates`);
  const refresh = useMasterChanges(companyId);
  const settings = useFinanceSettings(companyId);
  const mayManage = moduleAccess(context, "currencies", true);
  const [params, setParams] = useSearchParams();
  const activeFilter = params.get("active") ?? "";
  const currencyId = params.get("currencyId") ?? "";
  const currencyFilter = useQuery({
    queryKey: ["company", user?.id, companyId, "currency", currencyId],
    queryFn: ({ signal }) =>
      api<{ currency: CompanyCurrency }>(
        `/companies/${companyId}/currencies/${currencyId}`,
        { signal },
      ),
    enabled: !!user && /^[1-9]\d*$/.test(currencyId),
  });
  const filters = new URLSearchParams();
  if (activeFilter) filters.set("active", activeFilter);
  if (currencyId) filters.set("currencyId", currencyId);
  const list = usePagedQuery<ExchangeRate>(
    `/companies/${companyId}/exchange-rates?${filters}`,
    `company:${companyId}:exchange-rates`,
  );
  const [creating, setCreating] = useState(false);
  const [target, setTarget] = useState<ExchangeRate | null>(null);
  const [opening, setOpening] = useState<number | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const openVersion = useRef(0);
  function setFilter(key: string, value: string) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      value ? next.set(key, value) : next.delete(key);
      next.delete("page");
      return next;
    });
  }
  async function openStatus(id: number) {
    const version = ++openVersion.current;
    setOpening(id);
    setError("");
    try {
      const result = await api<{ exchangeRate: ExchangeRate }>(
        `/companies/${companyId}/exchange-rates/${id}`,
        { signal: guard.signal },
      );
      if (guard.isCurrent() && version === openVersion.current)
        setTarget(result.exchangeRate);
    } catch (reason) {
      if (guard.isCurrent() && version === openVersion.current)
        setError(errorMessage(reason));
    } finally {
      if (guard.isCurrent() && version === openVersion.current)
        setOpening(null);
    }
  }
  function changed(message: string) {
    if (!guard.isCurrent()) return;
    setCreating(false);
    setTarget(null);
    setNotice(message);
    setError("");
    void refresh();
  }
  const columns = useMemo<ColumnDef<ExchangeRate, unknown>[]>(
    () => [
      {
        accessorKey: "currencyCode",
        header: "العملة الأجنبية",
        cell: ({ row }) => <bdi>{row.original.currencyCode}</bdi>,
      },
      {
        accessorKey: "baseCurrencyCode",
        header: "العملة الأساسية",
        cell: ({ row }) => <bdi>{row.original.baseCurrencyCode}</bdi>,
      },
      {
        accessorKey: "rate",
        header: "سعر الصرف",
        cell: ({ row }) => (
          <ValueCell value={rateDirection(row.original)}>
            <span dir="ltr">{rateDirection(row.original)}</span>
          </ValueCell>
        ),
      },
      {
        accessorKey: "effectiveAt",
        header: "وقت السريان",
        cell: ({ row }) => (
          <ValueCell
            value={`${dateTime(row.original.effectiveAt)}\n${row.original.effectiveAt}`}
          >
            {dateTime(row.original.effectiveAt)}
          </ValueCell>
        ),
      },
      {
        accessorKey: "source",
        header: "مصدر السعر",
        cell: ({ row }) => <ValueCell>{row.original.source}</ValueCell>,
      },
      {
        accessorKey: "active",
        header: "الحالة",
        cell: ({ row }) => (row.original.active ? "فعال" : "غير فعال"),
      },
      {
        id: "actions",
        header: "الإجراءات",
        enableSorting: false,
        cell: ({ row }) =>
          mayManage ? (
            <Button
              size="compact"
              variant={row.original.active ? "danger" : "secondary"}
              disabled={opening !== null}
              aria-label={`${row.original.active ? "إيقاف" : "تفعيل"} سعر ${row.original.currencyCode} رقم ${row.original.id}`}
              onClick={() => void openStatus(row.original.id)}
            >
              {opening === row.original.id
                ? "جارٍ التحميل…"
                : row.original.active
                  ? "إيقاف"
                  : "تفعيل"}
            </Button>
          ) : (
            "—"
          ),
      },
    ],
    [mayManage, opening],
  );
  return (
    <>
      <PageHeader
        title="أسعار الصرف"
        description="تاريخ الأسعار اليدوية: وحدة واحدة أجنبية تساوي السعر من العملة الأساسية."
        actions={
          mayManage && (
            <Button
              disabled={
                !settings.data?.settings || !!settings.error || opening !== null
              }
              onClick={() => setCreating(true)}
            >
              إضافة سعر صرف
            </Button>
          )
        }
      />
      {notice && <Notice tone="success">{notice}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <FinanceSettingsCard context={context} onSaved={changed} />
      <Card
        title="تاريخ أسعار الصرف"
        description="تبقى السجلات محفوظة؛ يمكن إيقاف سعر خاطئ وإضافة سجل صحيح بتاريخ مختلف."
      >
        <div className="table-filters">
          <Field
            label="بحث في أسعار الصرف"
            type="search"
            value={list.query}
            onChange={(event) => list.setQuery(event.target.value)}
            placeholder="العملة أو المصدر"
          />
          <Select
            label="الحالة"
            value={activeFilter}
            onChange={(event) => setFilter("active", event.target.value)}
          >
            <option value="">كل الحالات</option>
            <option value="true">فعال</option>
            <option value="false">غير فعال</option>
          </Select>
        </div>
        <ServerLookup<CompanyCurrency>
          companyId={companyId}
          resource={`/companies/${companyId}/currencies`}
          label="تصفية حسب العملة"
          value={currencyFilter.data?.currency ?? null}
          onChange={(currency) =>
            setFilter("currencyId", currency ? String(currency.id) : "")
          }
          display={currencyLabel}
          emptyLabel="كل العملات"
        />
        {currencyFilter.error && (
          <Notice tone="error">{errorMessage(currencyFilter.error)}</Notice>
        )}
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
          getRowId={(row) => String(row.id)}
          selectionMode="os"
          ariaLabel="قائمة أسعار الصرف"
        />
      </Card>
      {mayManage && creating && settings.data?.settings && (
        <ExchangeRateEditor
          companyId={companyId}
          settings={settings.data.settings}
          onClose={() => setCreating(false)}
          onSaved={changed}
        />
      )}
      {mayManage && target && (
        <ExchangeRateStatusDialog
          key={target.id}
          companyId={companyId}
          rate={target}
          onClose={() => setTarget(null)}
          onSaved={changed}
        />
      )}
    </>
  );
}

function localDateTime() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function ExchangeRateEditor({
  companyId,
  settings,
  onClose,
  onSaved,
}: {
  companyId: number;
  settings: FinanceSettings;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const guard = useScopeGuard(`company:${companyId}:exchange-rate:new`);
  const [currency, setCurrency] = useState<CompanyCurrency | null>(null);
  const [rate, setRate] = useState("");
  const [effectiveAt, setEffectiveAt] = useState(localDateTime);
  const [source, setSource] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving || !currency) return;
    const date = new Date(effectiveAt);
    if (!effectiveAt || Number.isNaN(date.getTime())) {
      setError("حدد تاريخًا ووقتًا صالحين لسريان السعر.");
      return;
    }
    const parsed = exchangeRateSchema.safeParse({
      currencyId: currency.id,
      rate,
      effectiveAt: date.toISOString(),
      source,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "تحقق من بيانات سعر الصرف.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await api<{ exchangeRate: ExchangeRate }>(
        `/companies/${companyId}/exchange-rates`,
        { method: "POST", body: parsed.data, signal: guard.signal },
      );
      if (guard.isCurrent()) onSaved("تمت إضافة سعر الصرف إلى التاريخ.");
    } catch (reason) {
      if (guard.isCurrent()) setError(errorMessage(reason));
    } finally {
      if (guard.isCurrent()) setSaving(false);
    }
  }
  return (
    <Dialog
      open
      title="إضافة سعر صرف"
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <form className="form-stack" onSubmit={submit}>
        {error && <Notice tone="error">{error}</Notice>}
        <ServerLookup<CompanyCurrency>
          companyId={companyId}
          resource={`/companies/${companyId}/currencies?active=true`}
          label="العملة الأجنبية"
          value={currency}
          onChange={setCurrency}
          display={currencyLabel}
          accept={(item) => item.id !== settings.baseCurrencyId}
          required
          disabled={saving}
        />
        <Notice>
          وحدة واحدة من <bdi>{currency?.code ?? "العملة الأجنبية"}</bdi> ={" "}
          <bdi>
            {rate || "السعر"} {settings.baseCurrencyCode}
          </bdi>
          .
        </Notice>
        <Field
          label="سعر الصرف"
          type="text"
          inputMode="decimal"
          dir="ltr"
          value={rate}
          onChange={(event) => setRate(event.target.value)}
          required
          maxLength={40}
          disabled={saving}
          placeholder="مثال: 530.25"
          hint="قيمة موجبة؛ حتى 16 رقمًا صحيحًا و12 رقمًا كسريًا."
        />
        <Field
          label="وقت سريان السعر"
          type="datetime-local"
          dir="ltr"
          step={1}
          value={effectiveAt}
          onChange={(event) => setEffectiveAt(event.target.value)}
          required
          disabled={saving}
          hint={`وقت الجهاز (${Intl.DateTimeFormat().resolvedOptions().timeZone})؛ يُحفظ بتوقيت UTC. يمكن إدخال سعر مستقبلي.`}
        />
        <Field
          label="مصدر السعر اليدوي"
          value={source}
          onChange={(event) => setSource(event.target.value)}
          required
          maxLength={200}
          disabled={saving}
          placeholder="مثال: نشرة البنك بتاريخ اليوم"
        />
        <div className="form-actions">
          <Button type="submit" disabled={saving || !currency}>
            {saving ? "جارٍ الحفظ…" : "حفظ سعر الصرف"}
          </Button>
          <Button variant="secondary" disabled={saving} onClick={onClose}>
            إلغاء
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ExchangeRateStatusDialog({
  companyId,
  rate,
  onClose,
  onSaved,
}: {
  companyId: number;
  rate: ExchangeRate;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const guard = useScopeGuard(`company:${companyId}:exchange-rate:${rate.id}`);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      await api<{ exchangeRate: ExchangeRate }>(
        `/companies/${companyId}/exchange-rates/${rate.id}`,
        {
          method: "PATCH",
          body: { active: !rate.active },
          signal: guard.signal,
        },
      );
      if (guard.isCurrent())
        onSaved(
          rate.active
            ? "تم إيقاف سعر الصرف مع حفظ سجله."
            : "تم تفعيل سعر الصرف.",
        );
    } catch (reason) {
      if (guard.isCurrent()) setError(errorMessage(reason));
    } finally {
      if (guard.isCurrent()) setSaving(false);
    }
  }
  return (
    <Dialog
      open
      title={rate.active ? "إيقاف سعر الصرف" : "تفعيل سعر الصرف"}
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <form className="form-stack" onSubmit={submit}>
        <p dir="ltr">{rateDirection(rate)}</p>
        <p>
          وقت السريان: {dateTime(rate.effectiveAt)} —{" "}
          <bdi>{rate.effectiveAt}</bdi>
        </p>
        <p>المصدر: {rate.source}</p>
        <Notice>
          قيمة السعر ووقته ومصدره محفوظة في التاريخ. لتصحيحها أوقف السجل وأضف
          سعرًا صحيحًا بتاريخ مختلف.
        </Notice>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="form-actions">
          <Button
            type="submit"
            variant={rate.active ? "danger" : "primary"}
            disabled={saving}
          >
            {saving
              ? "جارٍ الحفظ…"
              : rate.active
                ? "تأكيد إيقاف السعر"
                : "تأكيد تفعيل السعر"}
          </Button>
          <Button variant="secondary" disabled={saving} onClick={onClose}>
            إلغاء
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
