import { useMemo, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
  accountCategories,
  accountCategoryLabels,
  accountChoices,
  accountChoiceLabels,
  type AccountChoice,
  accountKinds,
  accountKindLabels,
  accountLinkCategories,
  accountLinkLabels,
  accountSchema,
  type Account,
  type AccountCategory,
  type AccountKind,
  type AccountLink,
  type CompanyContext,
  type Page,
  type OptionListMetadata,
  type OptionListRecord,
} from "../../../../packages/contracts/src/index";
import { api, usePagedQuery, useScopeGuard, useSession } from "../api";
import {
  errorMessage,
  moduleAccess,
  ServerLookup,
  useMasterChanges,
} from "../phase2";
import { RecordOptionCard } from "../RecordOptionCard";
import { formatMoney } from "../format-money";
import {
  OptionListTools,
  optionFilterKeys,
  optionListColumns,
} from "../OptionListTools";
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

export function AccountsPage({ context }: { context: CompanyContext }) {
  if (!moduleAccess(context, "accounts"))
    return <Notice tone="warning">ليس لديك صلاحية عرض دليل الحسابات.</Notice>;
  return <AccountsManager context={context} />;
}

function AccountsManager({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const { user } = useSession();
  const guard = useScopeGuard(`company:${companyId}:accounts`);
  const changed = useMasterChanges(companyId);
  const canManage = moduleAccess(context, "accounts", true);
  const [params, setParams] = useSearchParams();
  const filters = new URLSearchParams();
  for (const key of ["kind", "category", "accountChoice", "active", ...optionFilterKeys])
    if (params.get(key)) filters.set(key, params.get(key)!);
  const list = usePagedQuery<OptionListRecord<Account>, OptionListMetadata & {baseCurrencyCode?: string|null}>(
    `/companies/${companyId}/accounts?${filters}`,
    `company:${companyId}:accounts`,
  );
  const links = useQuery({
    queryKey: ["master", user?.id, companyId, "account-links"],
    queryFn: ({ signal }) =>
      api<{ items: AccountLink[] }>(`/companies/${companyId}/account-links`, {
        signal,
      }),
  });
  const presence = useQuery({
    queryKey: ["master", user?.id, companyId, "account-presence"],
    queryFn: ({ signal }) =>
      api<Page<Account>>(`/companies/${companyId}/accounts?pageSize=1`, {
        signal,
      }),
    enabled: canManage,
  });
  const [editor, setEditor] = useState<{ account: Account | null } | null>(
    null,
  );
  const [linkEditor, setLinkEditor] = useState<{
    link: AccountLink;
    account: Account | null;
  } | null>(null);
  const [initializing, setInitializing] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  function filter(key: string, value: string) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      value ? next.set(key, value) : next.delete(key);
      next.delete("page");
      return next;
    });
  }
  async function edit(account: Account) {
    if (loadingDetail) return;
    setLoadingDetail(true);
    setError("");
    try {
      const result = await api<{ account: Account }>(
        `/companies/${companyId}/accounts/${account.id}`,
        { signal: guard.signal },
      );
      if (guard.isCurrent()) setEditor({ account: result.account });
    } catch (reason) {
      if (guard.isCurrent()) setError(errorMessage(reason));
    } finally {
      if (guard.isCurrent()) setLoadingDetail(false);
    }
  }
  async function editLink(link: AccountLink) {
    if (loadingDetail) return;
    setLoadingDetail(true);
    setError("");
    try {
      const current = await api<{ items: AccountLink[] }>(
        `/companies/${companyId}/account-links`,
        { signal: guard.signal },
      );
      const fresh = current.items.find((item) => item.purpose === link.purpose);
      if (!fresh) throw new Error("تعذر العثور على وظيفة الربط.");
      const result = fresh.accountId
        ? await api<{ account: Account }>(
            `/companies/${companyId}/accounts/${fresh.accountId}`,
            { signal: guard.signal },
          )
        : null;
      if (guard.isCurrent())
        setLinkEditor({ link: fresh, account: result?.account ?? null });
    } catch (reason) {
      if (guard.isCurrent()) setError(errorMessage(reason));
    } finally {
      if (guard.isCurrent()) setLoadingDetail(false);
    }
  }
  async function saved(account: Account) {
    if (!guard.isCurrent()) return;
    setEditor(null);
    await changed();
    if (guard.isCurrent())
      setNotice(`تم حفظ الحساب ${account.code} — ${account.name}.`);
  }
  const columns = useMemo<ColumnDef<OptionListRecord<Account>, unknown>[]>(
    () => [
      {
        accessorKey: "code",
        header: "الكود",
        cell: ({ row }) => (
          <ValueCell value={row.original.code}>
            <bdi>{row.original.code}</bdi>
          </ValueCell>
        ),
      },
      {
        accessorKey: "name",
        header: "اسم الحساب",
        cell: ({ row }) => <ValueCell>{row.original.name}</ValueCell>,
      },
      {
        accessorKey: "parentName",
        header: "المجموعة الأم",
        enableSorting: false,
        cell: ({ row }) => (
          <ValueCell>
            {row.original.parentName
              ? `${row.original.parentCode} — ${row.original.parentName}`
              : "حساب رئيسي"}
          </ValueCell>
        ),
      },
      {
        accessorKey: "kind",
        header: "النوع",
        cell: ({ row }) => accountKindLabels[row.original.kind],
      },
      {
        accessorKey: "category",
        header: "التصنيف",
        cell: ({ row }) => accountCategoryLabels[row.original.category],
      },
      {
        accessorKey: "accountChoice",
        header: "خيار الحساب",
        cell: ({ row }) => row.original.accountChoice
          ? accountChoiceLabels[row.original.accountChoice] : "—",
      },
      {
        id: "actualBalance",
        header: "الرصيد الفعلي",
        enableSorting: false,
        cell: ({ row }) => {
          const amount = row.original.balanceAmount;
          const direction = row.original.balanceDirection;
          if (!amount || !direction) return "—";
          if (direction === "zero") return "صفر";
          const grouped = formatMoney(amount);
          return (
            <ValueCell value={formatMoney(amount)}>
              <bdi>{grouped}</bdi>{" "}
              {direction === "credit" ? "له" : "عليه"}
              {list.data?.baseCurrencyCode ? ` (${list.data.baseCurrencyCode})` : ""}
            </ValueCell>
          );
        },
      },
      {
        accessorKey: "active",
        header: "الحالة",
        cell: ({ row }) => (row.original.active ? "فعال" : "موقف"),
      },
      {
        id: "range",
        header: "مجال الترقيم",
        enableSorting: false,
        cell: ({ row }) => (
          <ValueCell>
            {row.original.rangeStart
              ? `${row.original.rangeStart} – ${row.original.rangeEnd}`
              : "—"}
          </ValueCell>
        ),
      },
      ...optionListColumns<Account>(list.data?.optionDefinitions ?? []),
      ...(canManage
        ? [
            {
              id: "actions",
              header: "الإجراء",
              enableSorting: false,
              cell: ({ row }: { row: { original: Account } }) => (
                <Button
                  variant="ghost"
                  size="compact"
                  disabled={loadingDetail}
                  aria-label={`تعديل الحساب ${row.original.code}`}
                  onClick={() => void edit(row.original)}
                >
                  تعديل
                </Button>
              ),
            } satisfies ColumnDef<OptionListRecord<Account>, unknown>,
          ]
        : []),
    ],
    [canManage, loadingDetail, companyId, list.data?.optionDefinitions],
  );
  return (
    <>
      <PageHeader
        title="دليل الحسابات"
        description="الحسابات بأكواد من عشرة أرقام، ورصيد كل حساب حركي يتحدد من القيود المرحّلة: له أو عليه."
        actions={
          canManage && (
            <>
              <Button
                disabled={loadingDetail}
                onClick={() => {
                  setNotice("");
                  setEditor({ account: null });
                }}
              >
                إضافة حساب
              </Button>
            </>
          )
        }
      />
      {notice && <Notice tone="success">{notice}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {loadingDetail && <Notice>جارٍ تحميل السجل الحالي…</Notice>}
      {presence.error && (
        <Notice tone="error">{errorMessage(presence.error)}</Notice>
      )}
      <Card title="الحسابات">
        <div className="table-filters">
          <Field
            label="بحث في الحسابات"
            type="search"
            value={list.query}
            onChange={(event) => list.setQuery(event.target.value)}
            placeholder="الاسم أو الكود أو الخيارات القابلة للبحث"
          />
          <Select
            label="نوع الحساب"
            value={params.get("kind") ?? ""}
            onChange={(event) => filter("kind", event.target.value)}
          >
            <option value="">كل الأنواع</option>
            {accountKinds.map((kind) => (
              <option key={kind} value={kind}>
                {accountKindLabels[kind]}
              </option>
            ))}
          </Select>
          <Select
            label="تصنيف الحساب"
            value={params.get("category") ?? ""}
            onChange={(event) => filter("category", event.target.value)}
          >
            <option value="">كل التصنيفات</option>
            {accountCategories.map((category) => (
              <option key={category} value={category}>
                {accountCategoryLabels[category]}
              </option>
            ))}
          </Select>
          <Select
            label="خيار الحساب"
            value={params.get("accountChoice") ?? ""}
            onChange={(event) => filter("accountChoice", event.target.value)}
          >
            <option value="">جميع الخيارات</option>
            {accountChoices.map((choice) => (
              <option key={choice} value={choice}>{accountChoiceLabels[choice]}</option>
            ))}
          </Select>
          <Select
            label="حالة الحساب"
            value={params.get("active") ?? ""}
            onChange={(event) => filter("active", event.target.value)}
          >
            <option value="">كل الحالات</option>
            <option value="true">فعال</option>
            <option value="false">موقف</option>
          </Select>
        </div>
        <OptionListTools
          definitions={list.data?.optionDefinitions ?? []}
          query={list.query}
          onClearSearch={() => list.setQuery("")}
        />
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
          getRowId={(account) => String(account.id)}
          ariaLabel="دليل الحسابات"
        />
      </Card>
      <Card
        title="ربط الحسابات النظامية"
        description="اختر حسابًا حركيًا فعالًا يناسب وظيفة الربط. يمكن ترك الربط فارغًا الآن."
      >
        {links.error && (
          <Notice tone="error">{errorMessage(links.error)}</Notice>
        )}
        {links.isLoading && <Notice>جارٍ تحميل الربط…</Notice>}
        <div className="system-links">
          {links.data?.items.map((link) => (
            <div className="system-link" key={link.purpose}>
              <div>
                <strong>{accountLinkLabels[link.purpose]}</strong>
                <small className="muted">
                  {accountCategoryLabels[accountLinkCategories[link.purpose]]}
                </small>
              </div>
              <ValueCell>
                {link.accountCode
                  ? `${link.accountCode} — ${link.accountName}`
                  : "غير مربوط"}
              </ValueCell>
              {canManage && (
                <Button
                  variant="secondary"
                  size="compact"
                  disabled={loadingDetail}
                  aria-label={`ربط ${accountLinkLabels[link.purpose]}`}
                  onClick={() => void editLink(link)}
                >
                  تغيير الربط
                </Button>
              )}
            </div>
          ))}
        </div>
      </Card>
      {canManage && editor && (
        <AccountEditor
          key={`${companyId}:${editor.account?.id ?? "new"}`}
          companyId={companyId}
          account={editor.account}
          onClose={() => setEditor(null)}
          onSaved={(account) => void saved(account)}
        />
      )}
      {canManage && initializing && (
        <InitializeAccounts
          companyId={companyId}
          onClose={() => setInitializing(false)}
          onSaved={async (created) => {
            if (!guard.isCurrent()) return;
            setInitializing(false);
            await changed();
            if (guard.isCurrent())
              setNotice(`تمت تهيئة الدليل المقترح وإضافة ${created} حسابًا.`);
          }}
        />
      )}
      {canManage && linkEditor && (
        <AccountLinkEditor
          key={`${companyId}:${linkEditor.link.purpose}`}
          companyId={companyId}
          link={linkEditor.link}
          account={linkEditor.account}
          onClose={() => setLinkEditor(null)}
          onSaved={async (link) => {
            if (!guard.isCurrent()) return;
            setLinkEditor(null);
            await changed();
            if (guard.isCurrent())
              setNotice(
                link.accountId
                  ? `تم ربط ${accountLinkLabels[link.purpose]} بالحساب ${link.accountCode} — ${link.accountName}.`
                  : `تمت إزالة ربط ${accountLinkLabels[link.purpose]}.`,
              );
          }}
        />
      )}
    </>
  );
}

function AccountEditor({
  companyId,
  account,
  onClose,
  onSaved,
}: {
  companyId: number;
  account: Account | null;
  onClose: () => void;
  onSaved: (account: Account) => void;
}) {
  const guard = useScopeGuard(
    `company:${companyId}:account:${account?.id ?? "new"}`,
  );
  const [name, setName] = useState(account?.name ?? "");
  const [active, setActive] = useState(account?.active ?? true);
  const [accountChoice, setAccountChoice] = useState<AccountChoice | "">(account?.accountChoice ?? "administrative");
  const [cashOrBank, setCashOrBank] = useState(account?.cashOrBank ?? false);
  const [extra, setExtra] = useState({
    accountLimit: account?.accountLimit ?? "",
    dailyLimit: account?.dailyLimit ?? "",
    weeklyLimit: account?.weeklyLimit ?? "",
    monthlyLimit: account?.monthlyLimit ?? "",
    privacyLevel: String(account?.privacyLevel ?? 1),
    lastApprovalDate: account?.lastApprovalDate ?? "",
    ownerPhone: account?.ownerPhone ?? "",
    dailyDefault: account?.dailyDefault ?? "",
    weeklyDefault: account?.weeklyDefault ?? "",
    monthlyDefault: account?.monthlyDefault ?? "",
  });
  const [goodsTouched, setGoodsTouched] = useState(false);
  const [goodsSelected, setGoodsSelected] = useState<Account | null>(null);
  const goodsValue = useQuery({
    queryKey: ["account-goods-value", companyId, account?.goodsValueAccountId],
    enabled: !!account?.goodsValueAccountId,
    queryFn: ({ signal }) => api<{account: Account}>(
      `/companies/${companyId}/accounts/${account!.goodsValueAccountId}`, { signal }
    ),
  });
  function changeExtra(key: keyof typeof extra, value: string) {
    setExtra(previous => ({...previous, [key]: value}));
  }
  const extras = {
    accountLimit: extra.accountLimit.trim() || null,
    dailyLimit: extra.dailyLimit.trim() || null,
    weeklyLimit: extra.weeklyLimit.trim() || null,
    monthlyLimit: extra.monthlyLimit.trim() || null,
    privacyLevel: Number(extra.privacyLevel),
    lastApprovalDate: extra.lastApprovalDate || null,
    ownerPhone: extra.ownerPhone,
    dailyDefault: extra.dailyDefault.trim() || null,
    weeklyDefault: extra.weeklyDefault.trim() || null,
    monthlyDefault: extra.monthlyDefault.trim() || null,
    goodsValueAccountId: goodsTouched ? goodsSelected?.id ?? null : account?.goodsValueAccountId ?? null,
  };
  const [parent, setParent] = useState<Account | null>(null);
  const [kind, setKind] = useState<AccountKind>("posting");
  const [category, setCategory] = useState<AccountCategory>("asset");
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setError("");
    let body: unknown = { name, active, cashOrBank, accountChoice: accountChoice || null, ...extras };
    if (!account) {
      const parsed = accountSchema.safeParse({
        name,
        active,
        kind,
        category,
        accountChoice: accountChoice || null,
        ...extras,
        cashOrBank: kind === "posting" && category === "asset" && cashOrBank,
        parentId: parent?.id ?? null,
        rangeStart: kind === "group" && rangeStart ? rangeStart : null,
        rangeEnd: kind === "group" && rangeEnd ? rangeEnd : null,
      });
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? "تحقق من بيانات الحساب.");
        return;
      }
      body = parsed.data;
    }
    setSaving(true);
    try {
      const result = await api<{ account: Account }>(
        `/companies/${companyId}/accounts${account ? `/${account.id}` : ""}`,
        { method: account ? "PATCH" : "POST", body, signal: guard.signal },
      );
      if (guard.isCurrent()) onSaved(result.account);
    } catch (reason) {
      if (guard.isCurrent()) setError(errorMessage(reason));
    } finally {
      if (guard.isCurrent()) setSaving(false);
    }
  }
  return (
    <Dialog
      open
      title={account ? "تعديل الحساب" : "إضافة حساب"}
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <form className="form-stack" onSubmit={submit}>
        {error && <Notice tone="error">{error}</Notice>}
        {account && (
          <>
            <dl className="details-list">
              <dt>الكود</dt>
              <dd>
                <bdi>{account.code}</bdi>
              </dd>
              <dt>المجموعة الأم</dt>
              <dd>{account.parentName ?? "حساب رئيسي"}</dd>
              <dt>النوع / التصنيف</dt>
              <dd>
                {accountKindLabels[account.kind]} /{" "}
                {accountCategoryLabels[account.category]}
              </dd>
              <dt>مجال الترقيم</dt>
              <dd>
                <bdi>
                  {account.rangeStart
                    ? `${account.rangeStart} – ${account.rangeEnd}`
                    : "—"}
                </bdi>
              </dd>
            </dl>
            <p className="muted">
              هوية الحساب ونطاقه ثابتان؛ يمكن تغيير الاسم والتفعيل وصفة النقد أو
              البنك.
            </p>
          </>
        )}
        <Field
          label="اسم الحساب"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={240}
          disabled={saving}
          autoFocus
        />
        <Select
          label="خيار الحساب"
          value={accountChoice}
          disabled={saving}
          onChange={(event) => setAccountChoice(event.target.value as AccountChoice | "")}
        >
          <option value="">بدون خيار</option>
          {accountChoices.map((choice) => (
            <option key={choice} value={choice}>{accountChoiceLabels[choice]}</option>
          ))}
        </Select>
        {!account && (
          <>
            <Select
              label="نوع الحساب"
              value={kind}
              disabled={saving}
              onChange={(event) => {
                const next = event.target.value as AccountKind;
                setKind(next);
                if (next === "group") {
                  setCashOrBank(false);
                }
              }}
            >
              {accountKinds.map((item) => (
                <option key={item} value={item}>
                  {accountKindLabels[item]}
                </option>
              ))}
            </Select>
            <ServerLookup<Account>
              companyId={companyId}
              resource={`/companies/${companyId}/accounts?kind=group&active=true`}
              label="المجموعة الأم"
              value={parent}
              onChange={(next) => {
                setParent(next);
                if (next) {
                  setCategory(next.category);
                  if (next.category !== "asset") setCashOrBank(false);
                }
              }}
              display={(item) =>
                `${item.code} — ${item.name}${item.rangeStart ? ` (${item.rangeStart} – ${item.rangeEnd})` : ""}`
              }
              disabled={saving}
              emptyLabel="دون مجموعة أم"
            />
            <div className="form-grid">
              <Select
                label="تصنيف الحساب"
                value={category}
                disabled={saving || !!parent}
                onChange={(event) => {
                  const next = event.target.value as AccountCategory;
                  setCategory(next);
                  if (next !== "asset") setCashOrBank(false);
                }}
              >
                {accountCategories.map((item) => (
                  <option key={item} value={item}>
                    {accountCategoryLabels[item]}
                  </option>
                ))}
              </Select>
            </div>
            <Field
              label="كود الحساب"
              value="تلقائي عند الحفظ"
              readOnly
              hint="يُولّد النظام كودًا فريدًا من عشرة أرقام."
            />
            {kind === "group" && (
              <fieldset disabled={saving}>
                <legend>مجال ترقيم الأبناء — اختياري</legend>
                <div className="form-grid">
                  <Field
                    label="بداية مجال الترقيم"
                    dir="ltr"
                    inputMode="numeric"
                    value={rangeStart}
                    onChange={(event) => setRangeStart(event.target.value)}
                    maxLength={10}
                  />
                  <Field
                    label="نهاية مجال الترقيم"
                    dir="ltr"
                    inputMode="numeric"
                    value={rangeEnd}
                    onChange={(event) => setRangeEnd(event.target.value)}
                    maxLength={10}
                  />
                </div>
                <small className="muted">
                  يستخدم للحسابات الحركية المباشرة عند اختيار الترقيم التلقائي.
                </small>
              </fieldset>
            )}
          </>
        )}
        {(account
          ? account.kind === "posting" && account.category === "asset"
          : kind === "posting" && category === "asset") && (
          <label className="check-label">
            <input
              type="checkbox"
              checked={cashOrBank}
              disabled={saving}
              onChange={(event) => setCashOrBank(event.target.checked)}
            />
            حساب نقدي أو بنكي — متاح لسندات القبض والصرف
          </label>
        )}
        <fieldset disabled={saving}>
          <legend>السقوف والبيانات الإضافية</legend>
          <div className="form-grid">
          <Field label="سقف الحساب" money inputMode="decimal" value={extra.accountLimit} onChange={event => changeExtra("accountLimit",event.target.value)} disabled={saving} />
          <Field label="سقف يومي" money inputMode="decimal" value={extra.dailyLimit} onChange={event => changeExtra("dailyLimit",event.target.value)} disabled={saving} />
          <Field label="سقف أسبوعي" money inputMode="decimal" value={extra.weeklyLimit} onChange={event => changeExtra("weeklyLimit",event.target.value)} disabled={saving} />
          <Field label="سقف شهري" money inputMode="decimal" value={extra.monthlyLimit} onChange={event => changeExtra("monthlyLimit",event.target.value)} disabled={saving} />
          <Field label="افتراضي يومي" money inputMode="decimal" value={extra.dailyDefault} onChange={event => changeExtra("dailyDefault",event.target.value)} disabled={saving} />
          <Field label="افتراضي أسبوعي" money inputMode="decimal" value={extra.weeklyDefault} onChange={event => changeExtra("weeklyDefault",event.target.value)} disabled={saving} />
          <Field label="افتراضي شهري" money inputMode="decimal" value={extra.monthlyDefault} onChange={event => changeExtra("monthlyDefault",event.target.value)} disabled={saving} />
          <Select label="خصوصية الحساب" value={extra.privacyLevel} onChange={event => changeExtra("privacyLevel",event.target.value)}>
            {[1,2,3,4,5].map(level => <option key={level} value={level}>{level}</option>)}
          </Select>
          <Field label="آخر مصادقة للحساب" type="date" value={extra.lastApprovalDate} onChange={event => changeExtra("lastApprovalDate",event.target.value)} />
          <Field label="رقم هاتف صاحب الحساب" inputMode="tel" value={extra.ownerPhone} onChange={event => changeExtra("ownerPhone",event.target.value)} />
          </div>
          <ServerLookup<Account>
            companyId={companyId}
            resource={`/companies/${companyId}/commerce-options?type=accounts`}
            label="قيمة البضاعة تحسب لـ"
            value={goodsTouched ? goodsSelected : goodsValue.data?.account ?? null}
            onChange={next => {setGoodsTouched(true);setGoodsSelected(next);}}
            display={value => `${value.code} — ${value.name}`}
            emptyLabel="دون حساب"
            disabled={saving}
          />
          <small className="muted">حقل ربط فقط؛ لا ينفذ احتسابًا حتى تحديد قواعده.</small>
        </fieldset>
        <label className="check-label">
          <input
            type="checkbox"
            checked={active}
            disabled={saving}
            onChange={(event) => setActive(event.target.checked)}
          />
          حساب فعال
        </label>
        {account && (
          <p className="muted">
            أوقف أبناء المجموعة أولًا، وأزل أي ربط نظامي قبل إيقاف الحساب.
          </p>
        )}
        <div className="form-actions">
          <Button type="submit" disabled={saving}>
            {saving ? "جارٍ الحفظ…" : "حفظ الحساب"}
          </Button>
          <Button variant="secondary" disabled={saving} onClick={onClose}>
            إلغاء
          </Button>
        </div>
      </form>
      {account && (
        <RecordOptionCard
          companyId={companyId}
          recordKind="account"
          recordId={account.id}
          canEdit
        />
      )}
    </Dialog>
  );
}

function InitializeAccounts({
  companyId,
  onClose,
  onSaved,
}: {
  companyId: number;
  onClose: () => void;
  onSaved: (created: number) => void;
}) {
  const guard = useScopeGuard(`company:${companyId}:accounts:initialize`);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const result = await api<{ created: number }>(
        `/companies/${companyId}/accounts/initialize`,
        { method: "POST", body: {}, signal: guard.signal },
      );
      if (guard.isCurrent()) onSaved(result.created);
    } catch (reason) {
      if (guard.isCurrent()) setError(errorMessage(reason));
    } finally {
      if (guard.isCurrent()) setSaving(false);
    }
  }
  return (
    <Dialog
      open
      title="تهيئة دليل مقترح"
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      {error && <Notice tone="error">{error}</Notice>}
      <div className="form-stack">
        <p>
          ستضاف مجموعات الأصول والالتزامات وحقوق الملكية والإيرادات والمصروفات،
          ومجموعات الصناديق والبنوك والعملاء والموردين والمخزون، وحسابات حركية
          مقترحة. التهيئة اختيارية ومتاحة لدليل فارغ فقط.
        </p>
        <dl className="details-list">
          <dt>الصناديق</dt>
          <dd>
            <bdi>1111000001 – 1111999999</bdi>
          </dd>
          <dt>البنوك</dt>
          <dd>
            <bdi>1112000001 – 1112999999</bdi>
          </dd>
          <dt>العملاء</dt>
          <dd>
            <bdi>1120000001 – 1129999999</bdi>
          </dd>
          <dt>الموردون</dt>
          <dd>
            <bdi>2110000001 – 2119999999</bdi>
          </dd>
        </dl>
        <Notice>
          ستُربط وظائف النظام بالحسابات الحركية المقترحة، ويمكن تغيير الربط أو
          إزالته لاحقًا. يمكنك أيضًا إنشاء دليلك يدويًا بدل التهيئة.
        </Notice>
        <div className="form-actions">
          <Button disabled={saving} onClick={() => void save()}>
            {saving ? "جارٍ التهيئة…" : "تأكيد تهيئة الدليل"}
          </Button>
          <Button variant="secondary" disabled={saving} onClick={onClose}>
            إلغاء
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function AccountLinkEditor({
  companyId,
  link,
  account,
  onClose,
  onSaved,
}: {
  companyId: number;
  link: AccountLink;
  account: Account | null;
  onClose: () => void;
  onSaved: (link: AccountLink) => void;
}) {
  const guard = useScopeGuard(
    `company:${companyId}:account-link:${link.purpose}`,
  );
  const [selected, setSelected] = useState<Account | null>(account);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const result = await api<{ link: AccountLink }>(
        `/companies/${companyId}/account-links/${link.purpose}`,
        {
          method: "PUT",
          body: { accountId: selected?.id ?? null },
          signal: guard.signal,
        },
      );
      if (guard.isCurrent()) onSaved(result.link);
    } catch (reason) {
      if (guard.isCurrent()) setError(errorMessage(reason));
    } finally {
      if (guard.isCurrent()) setSaving(false);
    }
  }
  return (
    <Dialog
      open
      title={`ربط ${accountLinkLabels[link.purpose]}`}
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <form className="form-stack" onSubmit={submit}>
        {error && <Notice tone="error">{error}</Notice>}
        <p className="muted">
          اختر حسابًا حركيًا فعالًا من تصنيف{" "}
          {accountCategoryLabels[accountLinkCategories[link.purpose]]}، أو أزل
          الربط.
        </p>
        <ServerLookup<Account>
          companyId={companyId}
          resource={`/companies/${companyId}/accounts?kind=posting&active=true&category=${accountLinkCategories[link.purpose]}`}
          label="حساب الربط"
          value={selected}
          onChange={setSelected}
          display={(item) => `${item.code} — ${item.name}`}
          disabled={saving}
          emptyLabel="دون ربط"
        />
        <div className="form-actions">
          <Button type="submit" disabled={saving}>
            {saving ? "جارٍ الحفظ…" : "حفظ الربط"}
          </Button>
          <Button
            variant="secondary"
            disabled={saving}
            onClick={() => setSelected(null)}
          >
            إزالة الربط
          </Button>
          <Button variant="secondary" disabled={saving} onClick={onClose}>
            إلغاء
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
