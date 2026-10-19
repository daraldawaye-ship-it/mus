import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
  employeeRoleLabels,
  employeeAttendanceSettingsSchema,
  auditActionLabels,
  companyAuditActions,
  auditTargetLabels,
  employeePositions,
  employeePositionLabels,
  permissionKeys,
  permissionLabels,
  type AuditEvent,
  type Company,
  type CompanyContext,
  type CompanyPage,
  type Employee,
  type EmployeePosition,
  type EmployeeAttendanceSettings,
  type Permission,
  type User,
} from "../../../../packages/contracts/src/index";
import { api, usePagedQuery, useScopeGuard, useSession } from "../api";
import { moduleAccess } from "../phase2";
import { ImageUpload } from "../ImageUpload";
import { EmployeePositionPicker } from "../EmployeePositionPicker";
import { useCompanyLetterhead } from "../CompanyPrintHeader";
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

const dateTime = (value: string) =>
  new Intl.DateTimeFormat("ar", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "تعذر إكمال الطلب. حاول مجددًا.";
const actionLabels: Record<string, string> = auditActionLabels;
const targetLabels = auditTargetLabels;

function PermissionFields({
  value,
  onChange,
  disabled = false,
}: {
  value: Permission[];
  onChange: (value: Permission[]) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset disabled={disabled} className="permission-fields">
      <legend>صلاحيات الموظف</legend>
      {permissionKeys.map((permission) => (
        <label key={permission} className="check-label">
          <input
            type="checkbox"
            checked={value.includes(permission)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...value, permission]
                  : value.filter((item) => item !== permission),
              )
            }
          />
          {permissionLabels[permission]}
        </label>
      ))}
      <p className="muted">
        صلاحيات النظام السابقة محفوظة حتى اكتمال الربط التدريجي بمركز الصلاحيات.
      </p>
    </fieldset>
  );
}

export function CompaniesPage() {
  const { user } = useSession();
  const scope = "public:companies";
  const guard = useScopeGuard(scope);
  const list = usePagedQuery<Company>("/companies", scope);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState("");
  const lastCompanyId = (list.data as CompanyPage | undefined)?.lastCompanyId;
  const columns = useMemo<ColumnDef<Company, unknown>[]>(
    () => [
      {
        accessorKey: "name",
        header: "اسم الشركة",
        cell: ({ row }) => (
          <Link to={`/companies/${row.original.id}/overview`}>
            {row.original.name}
          </Link>
        ),
      },
      {
        accessorKey: "phone",
        header: "الهاتف",
        cell: ({ row }) => (
          <ValueCell value={row.original.phone || "غير محدد"}>
            <span dir="ltr">{row.original.phone || "—"}</span>
          </ValueCell>
        ),
      },
      {
        accessorKey: "address",
        header: "العنوان",
        cell: ({ row }) => <ValueCell>{row.original.address || "—"}</ValueCell>,
      },
      {
        accessorKey: "createdAt",
        header: "تاريخ الإنشاء",
        cell: ({ row }) => dateTime(row.original.createdAt),
      },
    ],
    [],
  );
  return (
    <>
      <PageHeader
        title="الشركات"
        description={
          user?.owner
            ? "كل الشركات متاحة لك بصفتك مالك المنصة."
            : "الشركات التي ترتبط بها بموظف فعال."
        }
        actions={
          user?.owner ? (
            <Button onClick={() => setCreating(true)}>إنشاء شركة</Button>
          ) : undefined
        }
      />
      {notice && <Notice tone="success">{notice}</Notice>}
      {lastCompanyId && (
        <p className="muted">
          <Link to={`/companies/${lastCompanyId}/overview`}>
            العودة إلى آخر شركة
          </Link>
        </p>
      )}
      <Card title="الشركات المتاحة">
        <Field
          label="بحث في الشركات"
          type="search"
          value={list.query}
          onChange={(event) => list.setQuery(event.target.value)}
          placeholder="الاسم أو الهاتف أو العنوان"
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
          getRowId={(row) => String(row.id)}
          ariaLabel="قائمة الشركات"
        />
      </Card>
      {creating && (
        <CreateCompanyDialog
          onClose={() => setCreating(false)}
          onCreated={() => {
            if (!guard.isCurrent()) return;
            setCreating(false);
            setNotice("تم إنشاء الشركة مع الفرع الرئيسي والمعرض تلقائيًا، وكلاهما فعال. يمكنك فتحها وبدء إعداد بياناتها.");
            void list.refetch();
          }}
        />
      )}
    </>
  );
}

function CreateCompanyDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const guard = useScopeGuard("public:companies:create");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setError("");
    setSaving(true);
    try {
      await api<{ company: Company }>("/companies", {
        method: "POST",
        body: { name, phone, address },
        signal: guard.signal,
      });
      if (guard.isCurrent()) onCreated();
    } catch (reason) {
      if (guard.isCurrent()) setError(errorMessage(reason));
    } finally {
      if (guard.isCurrent()) setSaving(false);
    }
  }
  return (
    <Dialog
      open
      title="إنشاء شركة"
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <form onSubmit={submit} className="form-stack">
        <Notice>
          سيُنشأ الفرع الرئيسي (HQ) ومعرضه تلقائيًا مع الشركة، مع نسخ هاتف الشركة
          وعنوانها إلى الفرع الرئيسي. يمكنك تعديل بيانات الفرع لاحقًا.
        </Notice>
        {error && <Notice tone="error">{error}</Notice>}
        <Field
          label="اسم الشركة"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={120}
          required
          disabled={saving}
          autoFocus
        />
        <Field
          label="هاتف الشركة"
          type="tel"
          dir="ltr"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          maxLength={40}
          disabled={saving}
        />
        <Field
          label="العنوان"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          maxLength={500}
          disabled={saving}
        />
        <div className="form-actions">
          <Button type="submit" disabled={saving}>
            {saving ? "جارٍ الإنشاء…" : "إنشاء الشركة"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={saving}
            onClick={onClose}
          >
            إلغاء
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function CompanyOverviewPage({ context }: { context: CompanyContext }) {
  const { user } = useSession();
  const { company, employee, general, permissions } = context;
  return (
    <>
      <PageHeader
        title={company.name}
        description="بيانات الشركة وصلاحيات وصولك الحالية."
      />
      <div className="card-grid">
        <Card title="بيانات الشركة">
          <dl className="details-list">
            <dt>اسم الشركة</dt>
            <dd>{company.name}</dd>
            <dt>الهاتف</dt>
            <dd dir="ltr">{company.phone || "غير محدد"}</dd>
            <dt>العنوان</dt>
            <dd>{company.address || "غير محدد"}</dd>
            <dt>تاريخ الإنشاء</dt>
            <dd>{dateTime(company.createdAt)}</dd>
          </dl>
        </Card>
        <Card title="وصولك إلى الشركة">
          <p>
            {user?.owner
              ? "مالك المنصة: الوصول الكامل إلى الشركة دون اشتراط سجل موظف."
              : general
                ? "مدير عام: جميع صلاحيات الشركة."
                : "موظف فعال: الوصول وفق الصلاحيات الممنوحة لك."}
          </p>
          {employee && (
            <dl className="details-list">
              <dt>اسم الموظف</dt>
              <dd>{employee.name}</dd>
              <dt>الدور</dt>
              <dd>{employeeRoleLabels[employee.role]}</dd>
              <dt>الحساب المرتبط</dt>
              <dd>{employee.displayName || employee.email}</dd>
            </dl>
          )}
          {!general && (
            <>
              <p className="muted">الصلاحيات الحالية</p>
              {permissions.length ? (
                <ul>
                  {permissions.map((permission) => (
                    <li key={permission}>{permissionLabels[permission]}</li>
                  ))}
                </ul>
              ) : (
                <p>لا توجد صلاحيات إضافية ممنوحة.</p>
              )}
            </>
          )}
        </Card>
      </div>
      <Card title="إدارة الشركة">
        <div className="form-actions">
          <Link className="button button-secondary" to={`/companies/${company.id}/letterhead`}>ترويسة الشركة للطباعة</Link>
          {moduleAccess(context, "accounts") && <Link className="button button-secondary" to={`/companies/${company.id}/accounts`}>دليل الحسابات</Link>}
          {moduleAccess(context, "currencies") && <>
            <Link className="button button-secondary" to={`/companies/${company.id}/currencies`}>العملات</Link>
            <Link className="button button-secondary" to={`/companies/${company.id}/exchange-rates`}>أسعار الصرف</Link>
          </>}
          {moduleAccess(context, "locations") && <>
            <Link className="button button-secondary" to={`/companies/${company.id}/branches`}>الفروع</Link>
            <Link className="button button-secondary" to={`/companies/${company.id}/locations`}>المعارض والمخازن</Link>
          </>}
          {(general || permissions.includes("employees.view")) && (
            <Link
              className="button secondary"
              to={`/companies/${company.id}/employees`}
            >
              الموظفون
            </Link>
          )}
          {(general || permissions.includes("company.edit")) && (
            <Link
              className="button secondary"
              to={`/companies/${company.id}/settings`}
            >
              بيانات الشركة
            </Link>
          )}
          {(general || permissions.includes("audit.view")) && (
            <Link
              className="button secondary"
              to={`/companies/${company.id}/audit`}
            >
              سجل الشركة
            </Link>
          )}
        </div>
      </Card>
    </>
  );
}

export function EmployeesPage({ context }: { context: CompanyContext }) {
  const { user } = useSession();
  return <EmployeesContent key={`${user?.id}:${context.company.id}`} context={context} />;
}
function EmployeesContent({ context }: { context: CompanyContext }) {
  const { user } = useSession();
  const companyId = context.company.id;
  const scope = `company:${companyId}:employees`;
  const guard = useScopeGuard(scope);
  const [urlParams, setUrlParams] = useSearchParams();
  const positionFilter = urlParams.get("position") ?? "";
  const activeFilter = urlParams.get("active") ?? "";
  function setFilter(key: string, value: string) {
    setUrlParams((previous) => {
      const next = new URLSearchParams(previous);
      value ? next.set(key, value) : next.delete(key);
      next.delete("page");
      return next;
    });
  }
  const filters = new URLSearchParams();
  if (positionFilter) filters.set("position", positionFilter);
  if (activeFilter) filters.set("active", activeFilter);
  const list = usePagedQuery<Employee>(
    `/companies/${companyId}/employees?${filters}`,
    scope,
  );
  const [editor, setEditor] = useState<Employee | "new" | null>(null);
  const [managerTarget, setManagerTarget] = useState<Employee | null>(null);
  const [accountTarget, setAccountTarget] = useState<Employee | null>(null);
  const [notice, setNotice] = useState("");
  const allowed =
    context.general || context.permissions.includes("employees.view");
  const mayManage = context.general;
  const columns = useMemo<ColumnDef<Employee, unknown>[]>(
    () => [
      {
        accessorKey: "name",
        header: "اسم الموظف",
        cell: ({ row }) => <ValueCell>{row.original.name}</ValueCell>,
      },
      {
        accessorKey: "displayName",
        header: "الحساب المرتبط",
        cell: ({ row }) => (
          <ValueCell
            value={`${row.original.displayName}\n${row.original.email}`}
          >
            {row.original.displayName || row.original.email}
          </ValueCell>
        ),
      },
      {
        accessorKey: "phone",
        header: "هاتف الموظف",
        cell: ({ row }) => (
          <ValueCell value={row.original.phone || "غير محدد"}>
            <span dir="ltr">{row.original.phone || "—"}</span>
          </ValueCell>
        ),
      },
      {
        accessorKey: "positions",
        header: "صفات الموظف",
        cell: ({ row }) => row.original.positions.map(key=>employeePositionLabels[key]).join("، ")||"غير محدد",
      },
      {
        accessorKey: "active",
        header: "الحالة",
        cell: ({ row }) => (row.original.active ? "فعال" : "غير فعال"),
      },
      {
        accessorKey: "isGeneralManager",
        header: "مدير عام",
        cell: ({ row }) => (row.original.isGeneralManager ? "نعم" : "لا"),
      },
      {
        id: "permissions",
        header: "الصلاحيات",
        enableSorting: false,
        cell: ({ row }) => (
          <ValueCell>
            {row.original.isGeneralManager
              ? "كاملة"
              : row.original.permissions
                  .map((permission) => permissionLabels[permission])
                  .join("، ") || "لا توجد"}
          </ValueCell>
        ),
      },
      {
        id: "actions",
        header: "الإجراءات",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="row-actions">
            <Button
              size="compact"
              variant="secondary"
              onClick={() => setAccountTarget(row.original)}
              aria-label={`عرض حسابات ${row.original.name}`}
            >
              الحسابات
            </Button>
            {mayManage && (user?.owner || !row.original.isGeneralManager) && (
              <Button
                size="compact"
                variant="ghost"
                onClick={() => setEditor(row.original)}
                aria-label={`تعديل ${row.original.name}`}
              >
                تعديل
              </Button>
            )}
            {user?.owner &&
              (row.original.active || row.original.isGeneralManager) && (
                <Button
                  size="compact"
                  variant={
                    row.original.isGeneralManager ? "danger" : "secondary"
                  }
                  onClick={() => setManagerTarget(row.original)}
                  aria-label={`${row.original.isGeneralManager ? "سحب صفة المدير العام من" : "تعيين مدير عام"} ${row.original.name}`}
                >
                  {row.original.isGeneralManager ? "سحب الإدارة" : "تعيين مدير"}
                </Button>
              )}
            {!mayManage && "—"}
          </div>
        ),
      },
    ],
    [mayManage, user?.owner],
  );
  function changed(message: string) {
    if (!guard.isCurrent()) return;
    setEditor(null);
    setManagerTarget(null);
    setNotice(message);
    void list.refetch();
  }
  if (!allowed)
    return (
      <Notice tone="warning">ليس لديك صلاحية عرض موظفي هذه الشركة.</Notice>
    );
  return (
    <>
      <PageHeader
        title="الموظفون"
        description="كل موظف مرتبط بحساب عام موجود. هاتف الموظف مستقل عن هاتف الحساب."
        actions={
          mayManage ? (
            <Button onClick={() => setEditor("new")}>إضافة موظف</Button>
          ) : undefined
        }
      />
      {notice && <Notice tone="success">{notice}</Notice>}
      {user?.owner && (
        <Notice>
          يمكنك تعيين أكثر من مدير عام. التعيين متاح للموظفين الفعالين فقط.
        </Notice>
      )}
      {user?.owner && !context.employee && (
        <Notice>
          حسابك كمالك أو مدير للمنصة ليس مرتبطًا بموظف داخل هذه الشركة. إذا أردت حساب سلفة خاصًا بك، اضغط «إضافة موظف»، ثم «ربط حساب موجود»، وابحث عن بريد حسابك أو هاتفك واختره؛ لا تنشئ مستخدمًا ثانيًا.
        </Notice>
      )}
      <Card title="موظفو الشركة">
        <div className="filter-bar">
          <Field
            label="بحث في الموظفين"
            type="search"
            value={list.query}
            onChange={(event) => list.setQuery(event.target.value)}
            placeholder="الاسم أو البريد أو الهاتف"
          />
          <Select label="صفة الموظف" value={positionFilter}
            onChange={event=>setFilter("position",event.target.value)}>
            <option value="">كل الصفات</option>
            {employeePositions.map(position=>
              <option key={position.key} value={position.key}>{position.label}</option>
            )}
          </Select>
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
          getRowId={(row) => String(row.id)}
          selectionMode="os"
          ariaLabel="قائمة موظفي الشركة"
        />
      </Card>
      {editor !== null && (
        <EmployeeEditor
          key={editor === "new" ? "new" : editor.id}
          companyId={companyId}
          employee={editor === "new" ? null : editor}
          mayManageAttendance={context.general}
          onClose={() => setEditor(null)}
          onSaved={() =>
            changed(
              editor === "new"
                ? "تمت إضافة الموظف وربطه بالحساب."
                : "تم حفظ بيانات الموظف.",
            )
          }
        />
      )}
      {accountTarget && (
        <EmployeeAccountsDialog
          key={accountTarget.id}
          companyId={companyId}
          employee={accountTarget}
          mayManage={mayManage}
          onClose={() => setAccountTarget(null)}
        />
      )}
      {managerTarget && (
        <ManagerDialog
          companyId={companyId}
          employee={managerTarget}
          onClose={() => setManagerTarget(null)}
          onSaved={() =>
            changed(
              managerTarget.isGeneralManager
                ? "تم سحب صفة المدير العام."
                : "تم تعيين المدير العام.",
            )
          }
        />
      )}
    </>
  );
}

type LinkedEmployeeAccount = {
  kind: "advance" | "sales_cash" | "sales_pouch";
  accountId: number;
  code: string;
  name: string;
  active: boolean;
};
type EmployeeAccountDetails = {
  employeeId: number;
  links: LinkedEmployeeAccount[];
  walletAccount: { id: number; code: string; name: string } | null;
};

function EmployeeAccountsDialog({
  companyId, employee, mayManage, onClose,
}: {
  companyId: number;
  employee: Employee;
  mayManage: boolean;
  onClose: () => void;
}) {
  const { user } = useSession();
  const guard = useScopeGuard(`company:${companyId}:employee-accounts:${employee.id}`);
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const path = `/companies/${companyId}/employees/${employee.id}/accounts`;
  const query = useQuery({
    queryKey: ["employee-account-links", user?.id, companyId, employee.id],
    queryFn: ({signal}) => api<{accounts:EmployeeAccountDetails}>(path, {signal}),
  });
  const info = query.data?.accounts;
  const lookup = (kind: LinkedEmployeeAccount["kind"]) =>
    info?.links.find((entry) => entry.kind === kind);
  const advance=lookup("advance");
  const cash=lookup("sales_cash");
  const pouch=lookup("sales_pouch");
  async function complete(createSalesCashbox:boolean) {
    if (!mayManage || saving) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{accounts:EmployeeAccountDetails}>(path,{
        method:"POST",body:{createSalesCashbox},signal:guard.signal,
      });
      if (!guard.isCurrent()) return;
      queryClient.setQueryData(
        ["employee-account-links",user?.id,companyId,employee.id],
        result,
      );
      setNotice("تم استكمال الحسابات الناقصة وحفظ ربطها بالموظف دون تعديل القيود السابقة.");
      await queryClient.invalidateQueries({queryKey:["wallet-settings",user?.id,companyId]});
    } catch (cause) {
      if (guard.isCurrent()) setError(errorMessage(cause));
    } finally {
      if (guard.isCurrent()) setSaving(false);
    }
  }
  const types=[
    {key:"advance" as const,label:"حساب السلفة",linked:advance},
    {key:"sales_cash" as const,label:"صندوق المبيعات",linked:cash},
    {key:"sales_pouch" as const,label:"حافظة المبيعات",linked:pouch},
  ];
  return (
    <Dialog open title={`الحسابات المحاسبية — ${employee.name}`}
      onClose={() => {if (!saving) onClose();}}>
      <p className="muted">
        هذه هي أرقام الحسابات المرتبطة بهذا الموظف فعليًا في دليل الحسابات، وليست أرقامًا مستنتجة من الاسم.
      </p>
      {query.isPending && <Notice>جارٍ تحميل حسابات الموظف…</Notice>}
      {query.error && <Notice tone="error">{errorMessage(query.error)}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice tone="success">{notice}</Notice>}
      {info && (
        <div className="form-stack">
          {types.map((item) => (
            <div key={item.key}>
              <b>{item.label}:</b>{" "}
              {item.linked ? (
                <span>
                  <bdi>{item.linked.code}</bdi> — {item.linked.name}
                  {!item.linked.active && " (موقوف)"}
                </span>
              ) : (
                <span className="muted">لم يُنشأ لهذا الموظف</span>
              )}
            </div>
          ))}
          <div>
            <b>حساب ترحيل النقاط:</b>{" "}
            {info.walletAccount ? (
              <span>
                <bdi>{info.walletAccount.code}</bdi> — {info.walletAccount.name}
                {advance && info.walletAccount.id!==advance.accountId &&
                  " (مرتبط سابقًا بحساب آخر، لم يُغيّر تلقائيًا)"}
              </span>
            ) : (
              <span className="muted">غير مرتبط بعد</span>
            )}
          </div>
          {mayManage && (!advance || !cash || !pouch) && (
            <div className="form-actions">
              {!advance && (
                <Button type="button" variant="secondary" disabled={saving}
                  onClick={() => void complete(false)}>
                  {saving ? "جارٍ الاستكمال…" : "إنشاء السلفة الناقصة"}
                </Button>
              )}
              {(!cash || !pouch) && (
                <Button type="button" variant="secondary" disabled={saving}
                  onClick={() => void complete(true)}>
                  {saving ? "جارٍ الاستكمال…" : "إنشاء صندوق وحافظة المبيعات الناقصين"}
                </Button>
              )}
            </div>
          )}
          <p className="muted">
            تُنشأ الحسابات الناقصة فقط، ولا تُحذف الحسابات الحالية أو تُغيّر روابط المحفظة اليدوية السابقة. يمكنك مراجعة دليل الحسابات لاختيار الصندوق عند إعداد السندات.
          </p>
        </div>
      )}
      <div className="form-actions">
        <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
          إغلاق
        </Button>
      </div>
    </Dialog>
  );
}

function EmployeeEditor({
  companyId,
  employee,
  mayManageAttendance,
  onClose,
  onSaved,
}: {
  companyId: number;
  employee: Employee | null;
  mayManageAttendance: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const guard = useScopeGuard(
    `company:${companyId}:employee:${employee?.id ?? "new"}`,
  );
  const { user: actorUser } = useSession();
  const client = useQueryClient();
  const directory = usePageDirectory(companyId);
  const employeeEntry = directory.data?.find(
    (entry) => entry.key === "company.employees",
  );
  const attendanceEntry = directory.data?.find(
    (entry) => entry.key === "company.attendance",
  );
  const canManageAttendance =
    mayManageAttendance &&
    !!employeeEntry?.enabled &&
    !!employeeEntry.actionAccess.edit &&
    !!attendanceEntry?.enabled &&
    !!attendanceEntry.actionAccess.edit;
  const settingsKey = [
    "employee-attendance-settings",
    actorUser?.id,
    companyId,
    employee?.id,
  ];
  const settingsQuery = useQuery({
    queryKey: settingsKey,
    queryFn: ({ signal }) =>
      api<{ settings: EmployeeAttendanceSettings }>(
        `/companies/${companyId}/employees/${employee!.id}/attendance-settings`,
        { signal },
      ),
    enabled: canManageAttendance && !!employee,
  });
  const [hourlyPoints, setHourlyPoints] = useState("");
  const [dailyHours, setDailyHours] = useState("");
  const [expectedStartTime, setExpectedStartTime] = useState("");
  const [allowOvertime, setAllowOvertime] = useState(false);
  const [settingsRevision, setSettingsRevision] = useState<number | null>(null);
  const settingsHydrated = useRef(false);
  function loadSettings(settings: EmployeeAttendanceSettings) {
    setHourlyPoints(settings.hourlyPoints ?? "");
    setDailyHours(settings.defaultDailyHours ?? "");
    setExpectedStartTime(settings.expectedStartTime ?? "");
    setAllowOvertime(settings.allowOvertime);
    setSettingsRevision(settings.revision);
    settingsHydrated.current = true;
  }
  useEffect(() => {
    if (settingsQuery.data && !settingsHydrated.current)
      loadSettings(settingsQuery.data.settings);
  }, [settingsQuery.data]);
  const [savedBase, setSavedBase] = useState<Employee | null>(null);
  const [pendingCredentials, setPendingCredentials] = useState<{
    phone: string;
    password: string;
  } | null>(null);
  const [profileError, setProfileError] = useState(false);
  const [createMode, setCreateMode] = useState<"phone" | "existing">("phone");
  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [issuedCredentials, setIssuedCredentials] = useState<{
    phone: string;
    password: string;
  } | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetStatus, setResetStatus] = useState("");
  const [resetting, setResetting] = useState(false);
  const [lookup, setLookup] = useState("");
  const [matches, setMatches] = useState<User[]>([]);
  const [lookedUp, setLookedUp] = useState(false);
  const [searching, setSearching] = useState(false);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [name, setName] = useState(employee?.name ?? "");
  const [phone, setPhone] = useState(employee?.phone ?? "");
  // Legacy role is retained invisibly for backwards-compatible server modules.
  const role = employee?.role ?? "employee";
  const [positions,setPositions]=useState<EmployeePosition[]>(employee?.positions??[]);
  const [active, setActive] = useState(employee?.active ?? true);
  const [createSalesCashbox, setCreateSalesCashbox] = useState(false);
  const [permissions, setPermissions] = useState<Permission[]>(
    employee?.permissions ?? [],
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const saveLock = useRef(false);
  const baseLocked = saving || !!savedBase;
  const settingsReady = !employee || !!settingsQuery.data;
  useEffect(() => {
    if (!savedBase || !pendingCredentials) return;
    const preventLeave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", preventLeave);
    return () => window.removeEventListener("beforeunload", preventLeave);
  }, [savedBase, pendingCredentials]);
  async function reloadSettings() {
    const target = savedBase ?? employee;
    if (!target || saving) return;
    setSaving(true);
    setError("");
    try {
      const result = await api<{ settings: EmployeeAttendanceSettings }>(
        `/companies/${companyId}/employees/${target.id}/attendance-settings`,
        { signal: guard.signal },
      );
      if (!guard.isCurrent()) return;
      loadSettings(result.settings);
      client.setQueryData(
        ["employee-attendance-settings", actorUser?.id, companyId, target.id],
        result,
      );
    } catch (cause) {
      if (guard.isCurrent()) setError(errorMessage(cause));
    } finally {
      if (guard.isCurrent()) setSaving(false);
    }
  }
  function closeEditor() {
    if (saving) return;
    if (savedBase) {
      if (pendingCredentials) setIssuedCredentials(pendingCredentials);
      else onSaved();
    } else onClose();
  }
  const lookupVersion = useRef(0);
  function changeLookup(value: string) {
    ++lookupVersion.current;
    setLookup(value);
    setMatches([]);
    setLookedUp(false);
    setSelectedUser(null);
  }
  async function search(event: FormEvent) {
    event.preventDefault();
    if (searching || saving) return;
    setSearching(true);
    setError("");
    setSelectedUser(null);
    setMatches([]);
    setLookedUp(false);
    const version = ++lookupVersion.current;
    const searched = lookup.trim();
    try {
      const result = await api<{ items: User[] }>(
        `/companies/${companyId}/users/search?q=${encodeURIComponent(searched)}`,
        { signal: guard.signal },
      );
      if (!guard.isCurrent() || lookupVersion.current !== version) return;
      setMatches(result.items);
      setLookedUp(true);
    } catch (reason) {
      if (guard.isCurrent() && lookupVersion.current === version)
        setError(errorMessage(reason));
    } finally {
      if (guard.isCurrent() && lookupVersion.current === version)
        setSearching(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      saveLock.current ||
      (!savedBase && !employee && createMode === "existing" && !selectedUser) ||
      (!savedBase &&
        !employee &&
        createMode === "phone" &&
        (!actorUser?.owner || !phone || newUserPassword.length < 12))
    )
      return;
    const includeSettings = canManageAttendance || !!savedBase;
    if (includeSettings && !settingsReady) {
      setError("انتظر تحميل إعدادات الحضور والنقاط قبل الحفظ.");
      return;
    }
    const parsedSettings = includeSettings
      ? employeeAttendanceSettingsSchema.safeParse({
          hourlyPoints: hourlyPoints.trim() || null,
          defaultDailyHours: dailyHours.trim() || null,
          expectedStartTime: expectedStartTime || null,
          allowOvertime,
          revision: settingsRevision,
        })
      : null;
    if (parsedSettings && !parsedSettings.success) {
      setError(
        parsedSettings.error.issues.map((issue) => issue.message).join(" · "),
      );
      return;
    }
    saveLock.current = true;
    setSaving(true);
    setError("");
    let target = savedBase;
    let credentials = pendingCredentials;
    try {
      if (!target) {
        const body = {
          name,
          phone,
          role,
          active,
          positions,
          permissions,
          ...(employee
            ? {}
            : {
                createSalesCashbox,
                ...(createMode === "phone"
                  ? {
                      newUser: {
                        name,
                        displayName: name,
                        phone,
                        email: newUserEmail,
                        password: newUserPassword,
                      },
                    }
                  : { userId: selectedUser?.id }),
              }),
        };
        const result = await api<{ employee: Employee }>(
          `/companies/${companyId}/employees${employee ? `/${employee.id}` : ""}`,
          { method: employee ? "PATCH" : "POST", body, signal: guard.signal },
        );
        if (!guard.isCurrent()) return;
        target = result.employee;
        if (!employee && createMode === "phone") {
          credentials = { phone, password: newUserPassword };
          setPendingCredentials(credentials);
          setNewUserPassword("");
        }
        if (includeSettings) setSavedBase(target);
      }
      if (parsedSettings?.success) {
        const result = await api<{ settings: EmployeeAttendanceSettings }>(
          `/companies/${companyId}/employees/${target.id}/attendance-settings`,
          {
            method: "PUT",
            body: parsedSettings.data,
            signal: guard.signal,
          },
        );
        if (!guard.isCurrent()) return;
        client.setQueryData(
          ["employee-attendance-settings", actorUser?.id, companyId, target.id],
          result,
        );
        setSettingsRevision(result.settings.revision);
        setProfileError(false);
        void client.invalidateQueries({
          queryKey: ["list", actorUser?.id, `company:${companyId}:attendance`],
        });
      }
      if (guard.isCurrent()) {
        if (credentials) setIssuedCredentials(credentials);
        else onSaved();
      }
    } catch (reason) {
      if (guard.isCurrent()) {
        if (target && includeSettings) {
          setProfileError(true);
          setError(
            `تم حفظ الموظف، لكن تعذر حفظ إعدادات الحضور والنقاط: ${errorMessage(reason)}. إعادة الحفظ ستعدل الإعدادات فقط.`,
          );
        } else setError(errorMessage(reason));
      }
    } finally {
      saveLock.current = false;
      if (guard.isCurrent()) setSaving(false);
    }
  }
  async function changeEmployeePassword() {
    if (
      !employee ||
      !actorUser?.owner ||
      resetting ||
      resetPassword.length < 12
    )
      return;
    setResetting(true);
    setResetStatus("");
    try {
      await api(`/users/${employee.userId}/password`, {
        method: "POST",
        body: { newPassword: resetPassword },
        signal: guard.signal,
      });
      if (guard.isCurrent())
        setResetStatus(
          "تم تعيين كلمة المرور الجديدة وإلغاء جلسات الدخول السابقة. سلّمها للموظف.",
        );
    } catch (cause) {
      if (guard.isCurrent()) setResetStatus(errorMessage(cause));
    } finally {
      if (guard.isCurrent()) setResetting(false);
    }
  }
  if (issuedCredentials)
    return (
      <Dialog
        open
        title="تم إنشاء المستخدم والموظف"
        onClose={() => {
          setIssuedCredentials(null);
          onSaved();
        }}
      >
        <p>
          بيانات الدخول التالية تظهر الآن فقط. سلّمها لصاحب الحساب عبر وسيلة
          آمنة.
        </p>
        {profileError && (
          <Notice tone="warning">
            حُفظ المستخدم والموظف، ولم تُحفظ إعدادات الحضور والنقاط. يمكنك
            استكمالها من تعديل الموظف.
          </Notice>
        )}
        <Field
          label="رقم الهاتف"
          readOnly
          value={issuedCredentials.phone}
          dir="ltr"
        />
        <Field
          label="كلمة المرور الأولية"
          readOnly
          value={issuedCredentials.password}
          dir="ltr"
        />
        <p className="muted">
          يمكن للمالك تعيين كلمة مرور جديدة لاحقًا، ولا يمكن استرجاع كلمة المرور
          الحالية من قاعدة البيانات.
        </p>
        <div className="form-actions">
          <Button
            onClick={() => {
              setIssuedCredentials(null);
              onSaved();
            }}
          >
            تم تسليم بيانات الدخول
          </Button>
        </div>
      </Dialog>
    );
  return (
    <Dialog
      open
      title={employee ? "تعديل الموظف" : "إضافة موظف"}
      onClose={() => {
        closeEditor();
      }}
    >
      {error && <Notice tone="error">{error}</Notice>}
      {!employee && actorUser?.owner && (
        <div className="form-actions">
          <Button
            type="button"
            variant="secondary"
            disabled={baseLocked}
            onClick={() => setCreateMode("phone")}
          >
            مستخدم جديد برقم الهاتف {createMode === "phone" ? "✓" : ""}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={baseLocked}
            onClick={() => setCreateMode("existing")}
          >
            ربط حساب موجود {createMode === "existing" ? "✓" : ""}
          </Button>
        </div>
      )}
      {!employee && (!actorUser?.owner || createMode === "existing") && (
        <form onSubmit={search} className="form-stack">
          <Field
            label="رقم الهاتف أو البريد لحساب موجود"
            value={lookup}
            onChange={(event) => changeLookup(event.target.value)}
            required
            disabled={searching || baseLocked}
            autoFocus
            hint="أدخل البريد أو الهاتف كاملًا للبحث عن حساب موجود، ثم اختره."
          />
          <Button
            type="submit"
            variant="secondary"
            disabled={searching || saving || !lookup.trim()}
          >
            {searching ? "جارٍ البحث…" : "البحث عن حساب"}
          </Button>
          {lookedUp && !matches.length && (
            <Notice tone="warning">
              لم يُعثر على حساب مطابق. يجب أن ينشئ المستخدم حسابه العام أولًا.
            </Notice>
          )}
          {matches.length > 0 && (
            <fieldset disabled={baseLocked} className="lookup-results">
              <legend>اختر الحساب المرتبط</legend>
              {matches.map((candidate) => (
                <label key={candidate.id} className="check-label">
                  <input
                    type="radio"
                    name="linked-user"
                    value={candidate.id}
                    checked={selectedUser?.id === candidate.id}
                    onChange={() => {
                      setSelectedUser(candidate);
                      if (!name) setName(candidate.name);
                    }}
                  />
                  <span>
                    {candidate.displayName} — <bdi>{candidate.email}</bdi>
                    {candidate.phone && (
                      <>
                        {" "}
                        — <bdi>{candidate.phone}</bdi>
                      </>
                    )}
                  </span>
                </label>
              ))}
            </fieldset>
          )}
        </form>
      )}
      {employee && (
        <p className="muted">
          الحساب المرتبط: {employee.displayName} — <bdi>{employee.email}</bdi>
        </p>
      )}
      <form onSubmit={submit} className="form-stack">
        <Field
          label="اسم الموظف"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={120}
          disabled={baseLocked}
          autoFocus={Boolean(employee)}
        />
        <Field
          label={
            employee || createMode === "existing"
              ? "هاتف الموظف"
              : "رقم الهاتف الأساسي للمستخدم"
          }
          type="tel"
          dir="ltr"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          maxLength={40}
          disabled={baseLocked}
          hint={
            employee || createMode === "existing"
              ? "رقم مستقل للتواصل والبحث؛ لا يمنح العضوية لحساب آخر."
              : "يستخدم هذا الرقم لتسجيل الدخول. سيضاف التحقق برسالة SMS لاحقًا."
          }
          required={!employee && createMode === "phone"}
        />
        {!employee && createMode === "phone" && actorUser?.owner && (
          <>
            <Field
              label="البريد الإلكتروني (اختياري)"
              type="email"
              dir="ltr"
              value={newUserEmail}
              onChange={(event) => setNewUserEmail(event.target.value)}
              disabled={baseLocked}
              maxLength={254}
            />
            <Field
              label="كلمة المرور الأولية"
              type={passwordVisible ? "text" : "password"}
              dir="ltr"
              autoComplete="new-password"
              value={newUserPassword}
              onChange={(event) => setNewUserPassword(event.target.value)}
              disabled={baseLocked}
              required
              minLength={12}
              maxLength={128}
              hint="12 حرفًا على الأقل. ستُعرض لك مرة واحدة بعد الحفظ لتسليمها للمستخدم."
            />
            <label className="check-label">
              <input
                type="checkbox"
                checked={passwordVisible}
                onChange={(event) => setPasswordVisible(event.target.checked)}
                disabled={baseLocked}
              />
              إظهار كلمة المرور أثناء الإدخال
            </label>
          </>
        )}
        <EmployeePositionPicker value={positions} onChange={setPositions}
          disabled={baseLocked}/>
        <details className="employee-legacy-permissions">
          <summary>الصلاحيات المباشرة القديمة (للتوافق مع النظام الحالي)</summary>
          <PermissionFields value={permissions} onChange={setPermissions}
            disabled={baseLocked}/>
        </details>
        <label className="check-label">
          <input
            type="checkbox"
            checked={active}
            onChange={(event) => setActive(event.target.checked)}
            disabled={baseLocked}
          />
          موظف فعال
        </label>
        {!employee && (
          <label className="check-label">
            <input
              type="checkbox"
              checked={createSalesCashbox}
              onChange={(event) => setCreateSalesCashbox(event.target.checked)}
              disabled={baseLocked}
            />
            إضافة صندوق مبيعات (ينشئ صندوق مبيعات وحافظة مبيعات باسم الموظف)
          </label>
        )}
        {!employee && (
          <small className="muted">
            ينشأ حساب «سلفة اسم الموظف» تلقائيًا لكل موظف جديد، سواء فُعّل خيار
            الصندوق أم لا.
          </small>
        )}
        {employee && actorUser?.owner && (
          <div className="form-stack">
            <Field
              label="تعيين كلمة مرور جديدة للمستخدم"
              type={passwordVisible ? "text" : "password"}
              value={resetPassword}
              onChange={(event) => {
                setResetPassword(event.target.value);
                setResetStatus("");
              }}
              disabled={baseLocked || resetting}
              minLength={12}
              maxLength={128}
              autoComplete="new-password"
              hint="لا يمكن عرض كلمة المرور السابقة. سيُخرج النظام المستخدم من جلساته الحالية عند تغييرها."
            />
            <label className="check-label">
              <input
                type="checkbox"
                checked={passwordVisible}
                onChange={(event) => setPasswordVisible(event.target.checked)}
                disabled={baseLocked || resetting}
              />
              إظهار كلمة المرور الجديدة
            </label>
            <Button
              type="button"
              variant="secondary"
              disabled={resetting || baseLocked || resetPassword.length < 12}
              onClick={() => void changeEmployeePassword()}
            >
              {resetting ? "جارٍ التعيين…" : "حفظ كلمة المرور الجديدة"}
            </Button>
            {resetStatus && <Notice>{resetStatus}</Notice>}
          </div>
        )}
        {employee?.isGeneralManager && (
          <Notice tone="warning">
            هذا الموظف مدير عام. إيقافه يسحب وصوله الفعال إلى الشركة، وتعيين
            الإدارة أو سحبها متاح للمالك فقط.
          </Notice>
        )}
        {(canManageAttendance || savedBase) && (
          <Card title="الحضور والنقاط">
            {employee && settingsQuery.isPending && (
              <Notice>جارٍ تحميل إعدادات الحضور والنقاط…</Notice>
            )}
            {settingsQuery.error && (
              <Notice tone="error">
                {errorMessage(settingsQuery.error)}{" "}
                <Button
                  variant="ghost"
                  onClick={() => void settingsQuery.refetch()}
                >
                  إعادة المحاولة
                </Button>
              </Notice>
            )}
            {profileError && (
              <Notice tone="warning">
                بيانات الموظف محفوظة. يمكنك إعادة حفظ إعدادات الحضور والنقاط دون
                إنشاء موظف آخر.{" "}
                <Button
                  variant="ghost"
                  disabled={saving}
                  onClick={() => void reloadSettings()}
                >
                  تحميل الإعدادات الحالية
                </Button>
              </Notice>
            )}
            <div className="form-grid">
              <Field
                label="قيمة الساعة (نقاط)"
                inputMode="numeric"
                value={hourlyPoints}
                onChange={(event) => setHourlyPoints(event.target.value)}
                disabled={saving || !settingsReady || !canManageAttendance}
                maxLength={12}
                placeholder="غير محددة"
                hint="اتركها فارغة حتى تحددها، أو أدخل صفرًا لإيقاف نقاط الساعات."
              />
              <Field
                label="ساعات الدوام اليومية الافتراضية"
                type="number"
                min="0.01"
                max="24"
                step="0.01"
                value={dailyHours}
                onChange={(event) => setDailyHours(event.target.value)}
                disabled={saving || !settingsReady || !canManageAttendance}
                placeholder="غير محددة"
                hint="مجموع جلسات اليوم، وليس مدة كل جلسة. يلزم تحديدها عند تعيين قيمة ساعة موجبة."
              />
              <Field
                label="ساعة الحضور الافتراضية (اختياري)"
                type="time"
                value={expectedStartTime}
                onChange={(event) => setExpectedStartTime(event.target.value)}
                disabled={saving || !settingsReady || !canManageAttendance}
                hint="للمتابعة فقط؛ يمكن تسجيل الحضور في أي وقت."
              />
            </div>
            <label className="check-label">
              <input
                type="checkbox"
                checked={allowOvertime}
                onChange={(event) => setAllowOvertime(event.target.checked)}
                disabled={saving || !settingsReady || !canManageAttendance}
              />
              قابل للدوام فوق الافتراضي
            </label>
            <p className="muted">
              تثبت الساعات اليومية والسماح بالإضافي عند أول جلسة مهيأة في اليوم.
              تغيير قيمة الساعة يطبق على الجلسات الجديدة.
            </p>
          </Card>
        )}
        <div className="form-actions">
          <Button
            type="submit"
            disabled={
              saving ||
              (mayManageAttendance && directory.isLoading) ||
              (canManageAttendance && !settingsReady) ||
              (!!savedBase && !canManageAttendance) ||
              (!savedBase &&
                !employee &&
                (createMode === "existing"
                  ? !selectedUser
                  : !actorUser?.owner || !phone || newUserPassword.length < 12))
            }
          >
            {saving
              ? "جارٍ الحفظ…"
              : savedBase
                ? "إعادة حفظ إعدادات الحضور والنقاط"
                : employee
                  ? "حفظ الموظف"
                  : "إضافة الموظف"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={closeEditor}
            disabled={saving}
          >
            {savedBase ? "إغلاق" : "إلغاء"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ManagerDialog({
  companyId,
  employee,
  onClose,
  onSaved,
}: {
  companyId: number;
  employee: Employee;
  onClose: () => void;
  onSaved: () => void;
}) {
  const guard = useScopeGuard(`company:${companyId}:manager:${employee.id}`);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const appointing = !employee.isGeneralManager;
  async function save() {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      await api<{ employee: Employee }>(
        `/companies/${companyId}/employees/${employee.id}/manager`,
        {
          method: "PATCH",
          body: { isGeneralManager: appointing },
          signal: guard.signal,
        },
      );
      if (guard.isCurrent()) onSaved();
    } catch (reason) {
      if (guard.isCurrent()) setError(errorMessage(reason));
    } finally {
      if (guard.isCurrent()) setSaving(false);
    }
  }
  return (
    <Dialog
      open
      title={appointing ? "تعيين مدير عام" : "سحب صفة المدير العام"}
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      {error && <Notice tone="error">{error}</Notice>}
      <p>
        {appointing
          ? `سيحصل ${employee.name} على جميع صلاحيات الشركة، مع بقاء المديرين العامين الآخرين.`
          : `ستُسحب صلاحيات الإدارة الكاملة من ${employee.name}، وتصبح صلاحياته وفق دوره والصلاحيات المحفوظة.`}
      </p>
      <div className="form-actions">
        <Button
          variant={appointing ? "primary" : "danger"}
          disabled={saving}
          onClick={() => void save()}
        >
          {saving
            ? "جارٍ الحفظ…"
            : appointing
              ? "تأكيد التعيين"
              : "تأكيد السحب"}
        </Button>
        <Button variant="secondary" disabled={saving} onClick={onClose}>
          إلغاء
        </Button>
      </div>
    </Dialog>
  );
}

export function CompanySettingsPage({ context }: { context: CompanyContext }) {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const company = context.company;
  const guard = useScopeGuard(`company:${company.id}:settings`);
  const canManageLetterhead = !!user && (user.owner || company.createdBy === user.id);
  const letterhead = useCompanyLetterhead(company.id);
  const [pendingMediaId, setPendingMediaId] = useState<string | null | undefined>(undefined);
  const [pendingImageUrl, setPendingImageUrl] = useState<string | null>(null);
  const [savingHeader, setSavingHeader] = useState(false);
  const [headerError, setHeaderError] = useState("");
  const [headerSuccess, setHeaderSuccess] = useState("");
  const selectedMediaId = pendingMediaId === undefined
    ? (letterhead.data?.mediaId ?? null)
    : pendingMediaId;
  const headerPreview = pendingMediaId === undefined
    ? letterhead.data?.imageUrl
    : pendingMediaId === null ? null : pendingImageUrl;
  async function saveLetterhead() {
    if (savingHeader || !canManageLetterhead) return;
    setSavingHeader(true);
    setHeaderError("");
    setHeaderSuccess("");
    try {
      await api(`/companies/${company.id}/letterhead`, {
        method: "PUT",
        body: { mediaId: selectedMediaId },
        signal: guard.signal,
      });
      if (!guard.isCurrent()) return;
      await queryClient.invalidateQueries({
        queryKey: ["company-letterhead", user?.id, company.id],
      });
      if (!guard.isCurrent()) return;
      setPendingMediaId(undefined);
      setPendingImageUrl(null);
      setHeaderSuccess("تم حفظ ترويسة الشركة، وستظهر في الطباعة.");
    } catch (reason) {
      if (guard.isCurrent()) setHeaderError(errorMessage(reason));
    } finally {
      if (guard.isCurrent()) setSavingHeader(false);
    }
  }
  const [name, setName] = useState(company.name);
  const [phone, setPhone] = useState(company.phone);
  const [address, setAddress] = useState(company.address);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const canEdit =
    context.general || context.permissions.includes("company.edit");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const result = await api<CompanyContext>(`/companies/${company.id}`, {
        method: "PATCH",
        body: { name, phone, address },
        signal: guard.signal,
      });
      if (!guard.isCurrent()) return;
      setName(result.company.name);
      setPhone(result.company.phone);
      setAddress(result.company.address);
      await queryClient.invalidateQueries({
        queryKey: ["company", user?.id, company.id],
      });
      if (guard.isCurrent()) setSuccess("تم حفظ بيانات الشركة.");
    } catch (reason) {
      if (guard.isCurrent()) setError(errorMessage(reason));
    } finally {
      if (guard.isCurrent()) setSaving(false);
    }
  }
  if (!canEdit)
    return (
      <Notice tone="warning">ليس لديك صلاحية تعديل بيانات هذه الشركة.</Notice>
    );
  return (
    <>
      <PageHeader
        title="بيانات الشركة"
        description="تعديل الاسم ومعلومات التواصل والعنوان."
      />
      <div className="form-actions">
        <Link className="button button-secondary" to={`/companies/${company.id}/letterhead`}>فتح صفحة ترويسة الشركة للطباعة</Link>
      </div>
      <Card title="المعلومات الأساسية">
        <form onSubmit={submit} className="form-stack">
          {error && <Notice tone="error">{error}</Notice>}
          {success && <Notice tone="success">{success}</Notice>}
          <Field
            label="اسم الشركة"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setSuccess("");
            }}
            required
            maxLength={120}
            disabled={saving}
          />
          <Field
            label="هاتف الشركة"
            value={phone}
            type="tel"
            dir="ltr"
            onChange={(event) => {
              setPhone(event.target.value);
              setSuccess("");
            }}
            maxLength={40}
            disabled={saving}
          />
          <Field
            label="العنوان"
            value={address}
            onChange={(event) => {
              setAddress(event.target.value);
              setSuccess("");
            }}
            maxLength={500}
            disabled={saving}
          />
          <div className="form-actions">
            <Button type="submit" disabled={saving}>
              {saving ? "جارٍ الحفظ…" : "حفظ البيانات"}
            </Button>
          </div>
        </form>
      </Card>
      {canManageLetterhead && (
        <Card title="ترويسة الشركة للطباعة">
          <p className="muted">
            يحدد المالك ترويسة مستقلة لهذه الشركة، وتظهر في فواتيرها وسنداتها والتقارير عند الطباعة.
            ارفع صورة أفقية عريضة مثل المثال، ثم احفظ الاختيار.
          </p>
          {letterhead.isLoading && <Notice>جارٍ تحميل الترويسة…</Notice>}
          {letterhead.error && <Notice tone="error">{errorMessage(letterhead.error)}</Notice>}
          {headerError && <Notice tone="error">{headerError}</Notice>}
          {headerSuccess && <Notice tone="success">{headerSuccess}</Notice>}
          <ImageUpload
            purpose="letterhead"
            companyId={company.id}
            preview={headerPreview}
            disabled={savingHeader}
            onUploaded={(asset) => {
              setPendingMediaId(asset.id);
              setPendingImageUrl(asset.fullUrl);
              setHeaderError("");
              setHeaderSuccess("");
            }}
            onClear={() => {
              setPendingMediaId(null);
              setPendingImageUrl(null);
              setHeaderSuccess("");
            }}
          />
          <div className="form-actions">
            <Button
              type="button"
              disabled={savingHeader || letterhead.isLoading || pendingMediaId === undefined}
              onClick={() => void saveLetterhead()}
            >
              {savingHeader ? "جارٍ حفظ الترويسة…" : "حفظ الترويسة"}
            </Button>
          </div>
        </Card>
      )}
    </>
  );
}

export function CompanyAuditPage({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const [urlParams, setUrlParams] = useSearchParams();
  const action = urlParams.get("action") ?? "";
  const filters = new URLSearchParams();
  if (action) filters.set("action", action);
  const list = usePagedQuery<AuditEvent>(
    `/companies/${companyId}/audit?${filters}`,
    `company:${companyId}:audit`,
  );
  const [inspected, setInspected] = useState<AuditEvent | null>(null);
  const columns = useMemo<ColumnDef<AuditEvent, unknown>[]>(
    () => [
      {
        accessorKey: "createdAt",
        header: "الوقت",
        cell: ({ row }) => dateTime(row.original.createdAt),
      },
      {
        accessorKey: "actorName",
        header: "الفاعل",
        cell: ({ row }) => (
          <ValueCell>{row.original.actorName || "النظام"}</ValueCell>
        ),
      },
      {
        accessorKey: "action",
        header: "الحدث",
        cell: ({ row }) => (
          <ValueCell
            value={`${actionLabels[row.original.action] ?? "حدث مسجل"}\n${row.original.action}`}
          >
            {actionLabels[row.original.action] ?? "حدث مسجل"}
          </ValueCell>
        ),
      },
      {
        accessorKey: "targetType",
        header: "نوع السجل",
        cell: ({ row }) => targetLabels[row.original.targetType] ?? "سجل",
      },
      {
        accessorKey: "targetId",
        header: "معرف السجل",
        cell: ({ row }) => row.original.targetId ?? "—",
      },
      {
        id: "details",
        header: "التفاصيل",
        enableSorting: false,
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="compact"
            onClick={() => setInspected(row.original)}
            aria-label={`فحص الحدث ${row.original.id}`}
          >
            فحص القيم
          </Button>
        ),
      },
    ],
    [],
  );
  if (!context.general && !context.permissions.includes("audit.view"))
    return <Notice tone="warning">ليس لديك صلاحية عرض سجل هذه الشركة.</Notice>;
  return (
    <>
      <PageHeader
        title="سجل الشركة"
        description="الأحداث المسجلة مع الفاعل والقيم الفعلية قبل التغيير وبعده."
      />
      <Card title="أحداث التدقيق">
        <div className="filter-bar">
          <Field
            label="بحث في سجل الشركة"
            type="search"
            value={list.query}
            onChange={(event) => list.setQuery(event.target.value)}
            placeholder="الحدث أو الفاعل أو نوع السجل"
          />
          <Select
            label="نوع الحدث"
            value={action}
            onChange={(event) =>
              setUrlParams((previous) => {
                const next = new URLSearchParams(previous);
                event.target.value
                  ? next.set("action", event.target.value)
                  : next.delete("action");
                next.delete("page");
                return next;
              })
            }
          >
            <option value="">كل الأحداث</option>
            {companyAuditActions.map((value) => (
              <option value={value} key={value}>
                {actionLabels[value]}
              </option>
            ))}
          </Select>
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
          getRowId={(row) => String(row.id)}
          ariaLabel="سجل تدقيق الشركة"
        />
      </Card>
      {inspected && (
        <Dialog
          open
          title={`تفاصيل الحدث ${inspected.id}`}
          onClose={() => setInspected(null)}
        >
          <dl className="details-list">
            <dt>الحدث</dt>
            <dd>
              {actionLabels[inspected.action] ?? "حدث مسجل"}{" "}
              <bdi>({inspected.action})</bdi>
            </dd>
            <dt>الفاعل</dt>
            <dd>{inspected.actorName || "النظام"}</dd>
            <dt>الوقت</dt>
            <dd>{dateTime(inspected.createdAt)}</dd>
            <dt>السجل</dt>
            <dd>
              {targetLabels[inspected.targetType] ?? inspected.targetType} /{" "}
              {inspected.targetId ?? "—"}
            </dd>
          </dl>
          <div className="audit-values">
            <Card title="قبل التغيير">
              <pre className="json-value" dir="ltr" tabIndex={0}>
                {JSON.stringify(inspected.before, null, 2)}
              </pre>
            </Card>
            <Card title="بعد التغيير">
              <pre className="json-value" dir="ltr" tabIndex={0}>
                {JSON.stringify(inspected.after, null, 2)}
              </pre>
            </Card>
          </div>
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setInspected(null)}>
              إغلاق
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
