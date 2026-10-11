import { useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
  employeeRoleLabels,
  auditActionLabels,
  companyAuditActions,
  auditTargetLabels,
  employeeRoles,
  permissionKeys,
  permissionLabels,
  rolePermissionTemplates,
  type AuditEvent,
  type Company,
  type CompanyContext,
  type CompanyPage,
  type Employee,
  type EmployeeRole,
  type Permission,
  type User,
} from "../../../../packages/contracts/src/index";
import { api, usePagedQuery, useScopeGuard, useSession } from "../api";
import { moduleAccess } from "../phase2";
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
        اختيار الدور يطبق القالب، ويمكن تعديل الصلاحيات قبل الحفظ.
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
  const companyId = context.company.id;
  const scope = `company:${companyId}:employees`;
  const guard = useScopeGuard(scope);
  const [urlParams, setUrlParams] = useSearchParams();
  const roleFilter = urlParams.get("role") ?? "";
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
  if (roleFilter) filters.set("role", roleFilter);
  if (activeFilter) filters.set("active", activeFilter);
  const list = usePagedQuery<Employee>(
    `/companies/${companyId}/employees?${filters}`,
    scope,
  );
  const [editor, setEditor] = useState<Employee | "new" | null>(null);
  const [managerTarget, setManagerTarget] = useState<Employee | null>(null);
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
        accessorKey: "role",
        header: "الدور",
        cell: ({ row }) => employeeRoleLabels[row.original.role],
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
      <Card title="موظفو الشركة">
        <div className="filter-bar">
          <Field
            label="بحث في الموظفين"
            type="search"
            value={list.query}
            onChange={(event) => list.setQuery(event.target.value)}
            placeholder="الاسم أو البريد أو الهاتف"
          />
          <Select
            label="الدور"
            value={roleFilter}
            onChange={(event) => setFilter("role", event.target.value)}
          >
            <option value="">كل الأدوار</option>
            {employeeRoles.map((role) => (
              <option key={role} value={role}>
                {employeeRoleLabels[role]}
              </option>
            ))}
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

function EmployeeEditor({
  companyId,
  employee,
  onClose,
  onSaved,
}: {
  companyId: number;
  employee: Employee | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const guard = useScopeGuard(
    `company:${companyId}:employee:${employee?.id ?? "new"}`,
  );
  const [lookup, setLookup] = useState("");
  const [matches, setMatches] = useState<User[]>([]);
  const [lookedUp, setLookedUp] = useState(false);
  const [searching, setSearching] = useState(false);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [name, setName] = useState(employee?.name ?? "");
  const [phone, setPhone] = useState(employee?.phone ?? "");
  const [role, setRole] = useState<EmployeeRole>(employee?.role ?? "employee");
  const [active, setActive] = useState(employee?.active ?? true);
  const [permissions, setPermissions] = useState<Permission[]>(
    employee?.permissions ?? [],
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
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
    if (saving || (!employee && !selectedUser)) return;
    setSaving(true);
    setError("");
    try {
      const body = {
        name,
        phone,
        role,
        active,
        permissions,
        ...(employee ? {} : { userId: selectedUser?.id }),
      };
      await api<{ employee: Employee }>(
        `/companies/${companyId}/employees${employee ? `/${employee.id}` : ""}`,
        { method: employee ? "PATCH" : "POST", body, signal: guard.signal },
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
      title={employee ? "تعديل الموظف" : "إضافة موظف مرتبط بحساب"}
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      {error && <Notice tone="error">{error}</Notice>}
      {!employee && (
        <form onSubmit={search} className="form-stack">
          <Field
            label="البريد أو هاتف الحساب العام"
            value={lookup}
            onChange={(event) => changeLookup(event.target.value)}
            required
            disabled={searching || saving}
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
            <fieldset disabled={saving} className="lookup-results">
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
          disabled={saving}
          autoFocus={Boolean(employee)}
        />
        <Field
          label="هاتف الموظف"
          type="tel"
          dir="ltr"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          maxLength={40}
          disabled={saving}
          hint="رقم مستقل للتواصل والبحث؛ لا يمنح العضوية لحساب آخر."
        />
        <Select
          label="الدور"
          value={role}
          disabled={saving}
          onChange={(event) => {
            const next = event.target.value as EmployeeRole;
            setRole(next);
            setPermissions([...rolePermissionTemplates[next]]);
          }}
        >
          {employeeRoles.map((item) => (
            <option key={item} value={item}>
              {employeeRoleLabels[item]}
            </option>
          ))}
        </Select>
        <PermissionFields
          value={permissions}
          onChange={setPermissions}
          disabled={saving}
        />
        <label className="check-label">
          <input
            type="checkbox"
            checked={active}
            onChange={(event) => setActive(event.target.checked)}
            disabled={saving}
          />
          موظف فعال
        </label>
        {employee?.isGeneralManager && (
          <Notice tone="warning">
            هذا الموظف مدير عام. إيقافه يسحب وصوله الفعال إلى الشركة، وتعيين
            الإدارة أو سحبها متاح للمالك فقط.
          </Notice>
        )}
        <div className="form-actions">
          <Button
            type="submit"
            disabled={saving || (!employee && !selectedUser)}
          >
            {saving ? "جارٍ الحفظ…" : employee ? "حفظ الموظف" : "إضافة الموظف"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
            disabled={saving}
          >
            إلغاء
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
