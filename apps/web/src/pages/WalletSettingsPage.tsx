import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Coins, RefreshCw } from "lucide-react";
import {
  employeeWalletAccountSchema,
  walletPolicySchema,
  type CompanyContext,
  type EmployeeWalletAccount,
  type WalletAccount,
  type WalletPolicy,
  type WalletPolicyDirectory,
} from "../../../../packages/contracts/src/index";
import { api, useScopeGuard, useSession } from "../api";
import { usePageDirectory } from "../page-directory";
import { PageActionsDropdown } from "../SalesHeaderActionsDropdown";
import { errorMessage, ServerLookup } from "../phase2";
import { Button, Card, Field, Notice, PageHeader, Select } from "../ui";

const accountLabel = (account: WalletAccount) =>
  `${account.code} — ${account.name}${account.active ? "" : " (موقوف)"}`;

export function WalletSettingsPage({ context }: { context: CompanyContext }) {
  const { user } = useSession();
  return (
    <WalletSettingsContent
      key={`${user?.id}:${context.company.id}`}
      context={context}
    />
  );
}

function WalletSettingsContent({ context }: { context: CompanyContext }) {
  const companyId = context.company.id,
    base = `/companies/${companyId}`;
  const { user } = useSession(),
    client = useQueryClient(),
    guard = useScopeGuard(`company:${companyId}:wallet-settings`);
  const queryKey = ["wallet-settings", user?.id, companyId];
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      api<WalletPolicyDirectory>(`${base}/wallet-settings`, { signal }),
    enabled: !!user,
  });
  const directory = usePageDirectory(companyId);
  const settingsPage = directory.data?.find(
    (page) => page.key === "company.wallet-settings",
  );
  const walletPage = directory.data?.find(
    (page) => page.key === "company.wallet",
  );
  const canEdit = !!settingsPage?.enabled && !!settingsPage.actionAccess.edit;
  const [draft, setDraft] = useState<WalletPolicy | null>(null),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [chosenEmployeeId, setChosenEmployeeId] = useState<number | null>(null),
    [bindingDraft, setBindingDraft] = useState<EmployeeWalletAccount | null>(
      null,
    ),
    [bindingSaving, setBindingSaving] = useState(false),
    [bindingError, setBindingError] = useState(""),
    [bindingNotice, setBindingNotice] = useState("");
  const employees = query.data?.employees ?? [];
  const employeeId = chosenEmployeeId ?? employees[0]?.id ?? 0;
  const bindingKey = [
    "wallet-employee-account",
    user?.id,
    companyId,
    employeeId,
  ];
  const bindingQuery = useQuery({
    queryKey: bindingKey,
    queryFn: ({ signal }) =>
      api<{ binding: EmployeeWalletAccount }>(
        `${base}/wallet-settings/employee-accounts/${employeeId}`,
        { signal },
      ),
    enabled: !!user && employeeId > 0,
  });
  const policy = draft ?? query.data?.policy,
    binding =
      bindingDraft?.employeeId === employeeId
        ? bindingDraft
        : bindingQuery.data?.binding;
  function changePolicy(changes: Partial<WalletPolicy>) {
    if (!policy || !canEdit || saving) return;
    setDraft({ ...policy, ...changes });
    setNotice("");
  }
  async function savePolicy(event: FormEvent) {
    event.preventDefault();
    if (!draft || saving || !canEdit) return;
    const parsed = walletPolicySchema.safeParse({
      pointValue: "1",
      currencyId: draft.currencyId,
      expenseAccountId: draft.expenseAccountId,
      approvalMode: draft.approvalMode,
      revision: draft.revision,
    });
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join(" · "));
      return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ policy: WalletPolicy }>(
        `${base}/wallet-settings`,
        { method: "PUT", body: parsed.data, signal: guard.signal },
      );
      if (!guard.isCurrent()) return;
      client.setQueryData<WalletPolicyDirectory>(queryKey, (previous) =>
        previous ? { ...previous, policy: result.policy } : previous,
      );
      setDraft(null);
      setNotice(
        "تم حفظ إعدادات التحويل. يمكن مراجعة نتيجتها من معاينة المحفظة.",
      );
      await client.invalidateQueries({
        queryKey: ["wallet-conversion-preview", user?.id, companyId],
      });
    } catch (cause) {
      if (guard.isCurrent()) setError(errorMessage(cause));
    } finally {
      if (guard.isCurrent()) setSaving(false);
    }
  }
  async function saveBinding(event: FormEvent) {
    event.preventDefault();
    if (
      !bindingDraft ||
      bindingDraft.employeeId !== employeeId ||
      bindingSaving ||
      !canEdit
    )
      return;
    const parsed = employeeWalletAccountSchema.safeParse({
      accountId: bindingDraft.accountId,
      revision: bindingDraft.revision,
    });
    if (!parsed.success) {
      setBindingError(
        parsed.error.issues.map((issue) => issue.message).join(" · "),
      );
      return;
    }
    setBindingSaving(true);
    setBindingError("");
    setBindingNotice("");
    try {
      const result = await api<{ binding: EmployeeWalletAccount }>(
        `${base}/wallet-settings/employee-accounts/${employeeId}`,
        { method: "PUT", body: parsed.data, signal: guard.signal },
      );
      if (!guard.isCurrent()) return;
      client.setQueryData(bindingKey, result);
      setBindingDraft(null);
      setBindingNotice("تم حفظ ربط حساب الموظف.");
      await client.invalidateQueries({
        queryKey: [
          "wallet-conversion-preview",
          user?.id,
          companyId,
          employeeId,
        ],
      });
    } catch (cause) {
      if (guard.isCurrent()) setBindingError(errorMessage(cause));
    } finally {
      if (guard.isCurrent()) setBindingSaving(false);
    }
  }
  return (
    <div className="wallet-page">
      <PageHeader
        title="إعدادات المحفظة"
        description="قيمة النقطة، سياسة الاعتماد، وحساب الموظف داخل الشركة."
        actions={<PageActionsDropdown actions={[
          ...(walletPage?.enabled && walletPage.actionAccess.view
            ? [{label:"النقاط والمحفظة",to:`${base}/wallet`}] : []),
          {label:"تحديث",disabled:saving || bindingSaving || query.isFetching,
           onClick:()=>{
             void query.refetch();
             if(employeeId)void bindingQuery.refetch();
           }},
        ]}/>}
      />
      <Notice>
        رصيد واحد: كل نقطة تساوي ريالًا يمنيًا واحدًا. تضيف المحفظة تلقائيًا نقاط
        المكافآت والحضور وعمولات التصريف بعد تحويل العملة بسعر الفاتورة.
        تختار الإدارة حسابات وسياسة اعتماد الترحيل فقط؛ لا يوجد سعر متغير للنقطة.
        عند تحويل النقاط إلى مبلغ، يُرحّل إلى حساب «سلفة الموظف» المنشأ تلقائيًا، وطلب الاعتماد يحجز النقاط
        حتى قرار الإدارة. تبقى قيمة الطلب وحساباته ثابتة بعد إرساله.
      </Notice>
      {query.isPending && <Notice>جارٍ تحميل إعدادات المحفظة…</Notice>}
      {query.error && <Notice tone="error">{errorMessage(query.error)}</Notice>}
      {policy && (
        <Card title="سياسة تحويل النقاط">
          <form className="form-grid" onSubmit={savePolicy}>
            {notice && <Notice tone="success">{notice}</Notice>}
            {error && <Notice tone="error">{error}</Notice>}
            <Field
              label="قيمة النقطة الواحدة"
              value="1 نقطة = 1 ريال يمني (ثابتة)"
              readOnly
            />
            <Select
              label="عملة التحويل"
              value={policy.currencyId ?? ""}
              disabled={!canEdit || saving}
              onChange={(event) => {
                const currency =
                  event.target.value &&
                  Number(event.target.value) === query.data?.baseCurrency?.id
                    ? query.data.baseCurrency
                    : null;
                changePolicy({ currencyId: currency?.id ?? null, currency });
              }}
            >
              <option value="">لم تحدد بعد</option>
              {query.data?.baseCurrency && (
                <option
                  value={query.data.baseCurrency.id}
                  disabled={!query.data.baseCurrency.active}
                >
                  {query.data.baseCurrency.code} —{" "}
                  {query.data.baseCurrency.name}
                  {!query.data.baseCurrency.active && " (موقوفة)"}
                </option>
              )}
              {policy.currency &&
                policy.currency.id !== query.data?.baseCurrency?.id && (
                  <option value={policy.currency.id} disabled>
                    {policy.currency.code} — {policy.currency.name} (تحتاج
                    مراجعة)
                  </option>
                )}
            </Select>
            <div className="form-full">
              <ServerLookup<WalletAccount>
                companyId={companyId}
                resource={`${base}/accounts?kind=posting&category=expense&active=true`}
                label="حساب مصروف مكافآت النقاط"
                value={policy.expenseAccount}
                display={accountLabel}
                accept={(account) =>
                  account.active &&
                  account.kind === "posting" &&
                  account.category === "expense"
                }
                disabled={!canEdit || saving}
                onChange={(account) =>
                  changePolicy({
                    expenseAccountId: account?.id ?? null,
                    expenseAccount: account,
                  })
                }
                emptyLabel="لم يحدد بعد"
              />
            </div>
            <Select
              label="طريقة اعتماد التحويل"
              value={policy.approvalMode ?? ""}
              disabled={!canEdit || saving}
              onChange={(event) =>
                changePolicy({
                  approvalMode:
                    event.target.value === "direct"
                      ? "direct"
                      : event.target.value === "approval"
                        ? "approval"
                        : null,
                })
              }
            >
              <option value="">لم تحدد بعد</option>
              <option value="direct">تحويل مباشر إلى حساب الموظف</option>
              <option value="approval">يتطلب اعتماد الإدارة</option>
            </Select>
            {canEdit && (
              <div className="form-actions form-full">
                <Button type="submit" disabled={saving || !draft}>
                  {saving ? "جارٍ الحفظ…" : "حفظ إعدادات التحويل"}
                </Button>
                <Button
                  variant="secondary"
                  disabled={saving || !draft}
                  onClick={() => {
                    setDraft(null);
                    setError("");
                  }}
                >
                  إلغاء التعديل
                </Button>
              </div>
            )}
          </form>
        </Card>
      )}
      {query.data && (
        <Card
          title="حساب تحويل نقاط الموظف"
          description="يُربط تلقائيًا بحساب «سلفة اسم الموظف» عند إضافته. تظل حسابات الموظفين السابقة وربطها اليدوي محفوظة."
        >
          {!employees.length ? (
            <Notice>لا يوجد موظفون فعّالون لربط حساباتهم.</Notice>
          ) : (
            <form className="form-stack" onSubmit={saveBinding}>
              <Select
                label="الموظف"
                value={employeeId || ""}
                disabled={bindingSaving}
                onChange={(event) => {
                  setChosenEmployeeId(Number(event.target.value));
                  setBindingDraft(null);
                  setBindingError("");
                  setBindingNotice("");
                }}
              >
                {employees.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.name}
                  </option>
                ))}
              </Select>
              {bindingQuery.isPending && (
                <Notice>جارٍ تحميل حساب الموظف…</Notice>
              )}
              {bindingQuery.error && (
                <Notice tone="error">{errorMessage(bindingQuery.error)}</Notice>
              )}
              {bindingNotice && <Notice tone="success">{bindingNotice}</Notice>}
              {bindingError && <Notice tone="error">{bindingError}</Notice>}
              {binding && (
                <ServerLookup<WalletAccount>
                  key={employeeId}
                  companyId={companyId}
                  resource={`${base}/accounts?kind=posting&active=true`}
                  label="الحساب المحاسبي لتحويل النقاط إلى مبلغ"
                  value={binding.account}
                  display={accountLabel}
                  accept={(account) =>
                    account.active && account.kind === "posting"
                  }
                  disabled={!canEdit || bindingSaving || !binding.active}
                  emptyLabel="لا يوجد حساب مرتبط"
                  onChange={(account) => {
                    setBindingDraft({
                      ...binding,
                      accountId: account?.id ?? null,
                      account,
                    });
                    setBindingNotice("");
                  }}
                />
              )}
              {canEdit && binding && (
                <div className="form-actions">
                  <Button
                    type="submit"
                    disabled={
                      bindingSaving ||
                      bindingDraft?.employeeId !== employeeId ||
                      !binding.active
                    }
                  >
                    {bindingSaving ? "جارٍ الحفظ…" : "حفظ حساب الموظف"}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={bindingSaving || !bindingDraft}
                    onClick={() => {
                      setBindingDraft(null);
                      setBindingError("");
                    }}
                  >
                    إلغاء التعديل
                  </Button>
                </div>
              )}
            </form>
          )}
        </Card>
      )}
    </div>
  );
}
