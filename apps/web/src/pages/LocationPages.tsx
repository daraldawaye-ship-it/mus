import { useMemo, useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { useSearchParams } from "react-router-dom";
import {
  locationKindLabels,
  locationKinds,
  type Branch,
  type CompanyContext,
  type Location,
  type LocationKind,
} from "../../../../packages/contracts/src/index";
import { api, usePagedQuery, useScopeGuard, useSession } from "../api";
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

export function BranchesPage({ context }: { context: CompanyContext }) {
  if (!moduleAccess(context, "locations"))
    return <Notice tone="warning">ليس لديك صلاحية عرض الفروع والمواقع.</Notice>;
  return <BranchesContent context={context} />;
}

function BranchesContent({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const canManage = moduleAccess(context, "locations", true);
  const guard = useScopeGuard(`company:${companyId}:branches`);
  const changed = useMasterChanges(companyId);
  const [params, setParams] = useSearchParams();
  const activeFilter = params.get("active") ?? "";
  const filters = new URLSearchParams();
  if (activeFilter) filters.set("active", activeFilter);
  const list = usePagedQuery<Branch>(
    `/companies/${companyId}/branches?${filters}`,
    `company:${companyId}:branches`,
  );
  const [editor, setEditor] = useState<{ branch: Branch | null } | null>(null);
  const [loadingId, setLoadingId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const detailVersion = useRef(0);

  async function edit(branchId: number) {
    if (loadingId !== null) return;
    const request = ++detailVersion.current;
    setLoadingId(branchId);
    setError("");
    try {
      const result = await api<{ branch: Branch }>(
        `/companies/${companyId}/branches/${branchId}`,
        { signal: guard.signal },
      );
      if (guard.isCurrent() && request === detailVersion.current)
        setEditor({ branch: result.branch });
    } catch (reason) {
      if (guard.isCurrent() && request === detailVersion.current)
        setError(errorMessage(reason));
    } finally {
      if (guard.isCurrent() && request === detailVersion.current)
        setLoadingId(null);
    }
  }

  const columns = useMemo<ColumnDef<Branch, unknown>[]>(
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
        header: "اسم الفرع",
        cell: ({ row }) => <ValueCell>{row.original.name}</ValueCell>,
      },
      {
        accessorKey: "phone",
        header: "الهاتف",
        cell: ({ row }) => (
          <ValueCell value={row.original.phone || "غير محدد"}>
            <bdi>{row.original.phone || "—"}</bdi>
          </ValueCell>
        ),
      },
      {
        accessorKey: "address",
        header: "العنوان",
        cell: ({ row }) => <ValueCell>{row.original.address || "—"}</ValueCell>,
      },
      {
        accessorKey: "active",
        header: "حالة الفرع",
        cell: ({ row }) => (row.original.active ? "فعال" : "متوقف"),
      },
      ...(canManage
        ? [
            {
              id: "actions",
              header: "الإجراءات",
              enableSorting: false,
              cell: ({ row }) => (
                <Button
                  variant="ghost"
                  size="compact"
                  disabled={loadingId !== null}
                  onClick={() => void edit(row.original.id)}
                  aria-label={`تعديل الفرع ${row.original.name}`}
                >
                  {loadingId === row.original.id ? "جارٍ التحميل…" : "تعديل"}
                </Button>
              ),
            } satisfies ColumnDef<Branch, unknown>,
          ]
        : []),
    ],
    [canManage, loadingId, companyId],
  );

  return (
    <>
      <PageHeader
        title="الفروع"
        description="بيانات الفروع وحالتها؛ ينشأ معرض واحد تلقائيًا مع كل فرع."
        actions={
          canManage ? (
            <Button
              disabled={loadingId !== null}
              onClick={() => {
                setError("");
                setEditor({ branch: null });
              }}
            >
              إضافة فرع
            </Button>
          ) : undefined
        }
      />
      {notice && <Notice tone="success">{notice}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <Notice>
        إيقاف الفرع يوقف الإتاحة الفعلية لمعرضه ومخازنه مع الاحتفاظ بتفعيل كل
        موقع. عند إعادة تفعيل الفرع تتاح المواقع التي لم توقف منفردة.
      </Notice>
      <Card title="قائمة الفروع">
        <div className="table-filters">
          <Field
            label="بحث في الفروع"
            type="search"
            value={list.query}
            onChange={(event) => list.setQuery(event.target.value)}
            placeholder="الاسم أو الكود أو الهاتف أو العنوان"
          />
          <Select
            label="حالة الفرع"
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
            <option value="">كل الفروع</option>
            <option value="true">الفروع الفعالة</option>
            <option value="false">الفروع المتوقفة</option>
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
          ariaLabel="قائمة الفروع"
        />
      </Card>
      {canManage && editor && (
        <BranchEditor
          key={`${companyId}:${editor.branch?.id ?? "new"}`}
          companyId={companyId}
          branch={editor.branch}
          onClose={() => setEditor(null)}
          onSaved={async (branch) => {
            if (!guard.isCurrent()) return;
            const creating = !editor.branch;
            // The save has succeeded; dismiss before refreshing the table.
            setEditor(null);
            await changed();
            if (!guard.isCurrent()) return;
            setNotice(
              creating
                ? `تم إنشاء الفرع «${branch.name}» ومعرضه تلقائيًا.`
                : branch.active
                  ? `تم حفظ الفرع «${branch.name}». مواقعه الفعالة متاحة للاستخدام.`
                  : `تم حفظ الفرع «${branch.name}» متوقفًا. مواقعه غير متاحة حتى إعادة تفعيل الفرع.`,
            );
          }}
        />
      )}
    </>
  );
}

function BranchEditor({
  companyId,
  branch,
  onClose,
  onSaved,
}: {
  companyId: number;
  branch: Branch | null;
  onClose: () => void;
  onSaved: (branch: Branch) => Promise<void>;
}) {
  const guard = useScopeGuard(
    `company:${companyId}:branch:${branch?.id ?? "new"}`,
  );

  const [name, setName] = useState(branch?.name ?? "");
  const [phone, setPhone] = useState(branch?.phone ?? "");
  const [address, setAddress] = useState(branch?.address ?? "");
  const [active, setActive] = useState(branch?.active ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const result = await api<{ branch: Branch }>(
        `/companies/${companyId}/branches${branch ? `/${branch.id}` : ""}`,
        {
          method: branch ? "PATCH" : "POST",
          body: { name, phone, address, active },
          signal: guard.signal,
        },
      );
      if (!guard.isCurrent()) return;
      setName(result.branch.name);
      setPhone(result.branch.phone);
      setAddress(result.branch.address);
      setActive(result.branch.active);
      await onSaved(result.branch);
    } catch (reason) {
      if (guard.isCurrent()) setError(errorMessage(reason));
    } finally {
      if (guard.isCurrent()) setSaving(false);
    }
  }

  return (
    <Dialog
      open
      title={branch ? "تعديل الفرع" : "إضافة فرع"}
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <form onSubmit={submit} className="form-stack">
        {error && <Notice tone="error">{error}</Notice>}
        {!branch && (
          <Notice>
            ينشأ معرض باسم «المعرض» وكود SHOWROOM تلقائيًا مع الفرع. يمكن إضافة
            مخازنه من شاشة المعارض والمخازن.
          </Notice>
        )}
        {branch ? (
          <Field label="كود الفرع" value={branch.code} dir="ltr"
            readOnly disabled={saving} hint="الكود ثابت بعد الإنشاء." />
        ) : (
          <Notice>يُنشئ النظام كود الفرع تلقائيًا عند الحفظ؛ لا يلزم إدخاله.</Notice>
        )}
        <Field
          label="اسم الفرع"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={120}
          disabled={saving}
          autoFocus
        />
        <Field
          label="هاتف الفرع"
          type="tel"
          dir="ltr"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          maxLength={40}
          disabled={saving}
        />
        <Field
          label="عنوان الفرع"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          maxLength={500}
          disabled={saving}
        />
        <label className="check-label">
          <input
            type="checkbox"
            checked={active}
            onChange={(event) => setActive(event.target.checked)}
            disabled={saving}
          />
          فرع فعال
        </label>
        {!active && (
          <Notice tone="warning">
            إيقاف الفرع يمنع استخدام جميع مواقعه وإنشاء موقع جديد فيه. يبقى
            تفعيل كل موقع محفوظًا لإتاحته عند إعادة تفعيل الفرع.
          </Notice>
        )}
        <div className="form-actions">
          <Button type="submit" disabled={saving}>
            {saving ? "جارٍ الحفظ…" : branch ? "حفظ الفرع" : "إضافة الفرع"}
          </Button>
          <Button variant="secondary" disabled={saving} onClick={onClose}>
            إلغاء
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function LocationsPage({ context }: { context: CompanyContext }) {
  if (!moduleAccess(context, "locations"))
    return <Notice tone="warning">ليس لديك صلاحية عرض الفروع والمواقع.</Notice>;
  return <LocationsContent context={context} />;
}

function LocationsContent({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const { user } = useSession();
  const canManage = moduleAccess(context, "locations", true);
  const guard = useScopeGuard(`company:${companyId}:locations`);
  const changed = useMasterChanges(companyId);
  const [params, setParams] = useSearchParams();
  const activeFilter = params.get("active") ?? "";
  const kindFilter = params.get("kind") ?? "";
  const branchId = Number(params.get("branchId")) || null;
  const filters = new URLSearchParams();
  if (activeFilter) filters.set("active", activeFilter);
  if (kindFilter) filters.set("kind", kindFilter);
  if (branchId) filters.set("branchId", String(branchId));
  const list = usePagedQuery<Location>(
    `/companies/${companyId}/locations?${filters}`,
    `company:${companyId}:locations`,
  );
  const selectedBranch = useQuery({
    queryKey: ["master", user?.id, companyId, "branch-filter", branchId],
    queryFn: ({ signal }) =>
      api<{ branch: Branch }>(`/companies/${companyId}/branches/${branchId}`, {
        signal,
      }),
    enabled: !!user && !!branchId,
  });
  const [editor, setEditor] = useState<{ location: Location | null } | null>(
    null,
  );
  const [loadingId, setLoadingId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const detailVersion = useRef(0);

  function setFilter(key: string, value: string) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      value ? next.set(key, value) : next.delete(key);
      next.delete("page");
      return next;
    });
  }

  async function edit(locationId: number) {
    if (loadingId !== null) return;
    const request = ++detailVersion.current;
    setLoadingId(locationId);
    setError("");
    try {
      const result = await api<{ location: Location }>(
        `/companies/${companyId}/locations/${locationId}`,
        { signal: guard.signal },
      );
      if (guard.isCurrent() && request === detailVersion.current)
        setEditor({ location: result.location });
    } catch (reason) {
      if (guard.isCurrent() && request === detailVersion.current)
        setError(errorMessage(reason));
    } finally {
      if (guard.isCurrent() && request === detailVersion.current)
        setLoadingId(null);
    }
  }

  const columns = useMemo<ColumnDef<Location, unknown>[]>(
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
        header: "اسم الموقع",
        cell: ({ row }) => <ValueCell>{row.original.name}</ValueCell>,
      },
      {
        accessorKey: "branchName",
        header: "الفرع",
        cell: ({ row }) => <ValueCell>{row.original.branchName}</ValueCell>,
      },
      {
        accessorKey: "kind",
        header: "النوع",
        cell: ({ row }) => locationKindLabels[row.original.kind],
      },
      {
        accessorKey: "active",
        header: "تفعيل الموقع",
        cell: ({ row }) => (row.original.active ? "فعال" : "متوقف"),
      },
      {
        accessorKey: "branchActive",
        header: "حالة الفرع",
        cell: ({ row }) => (row.original.branchActive ? "فعال" : "متوقف"),
      },
      {
        accessorKey: "effectiveActive",
        header: "الإتاحة الفعلية",
        cell: ({ row }) => (
          <ValueCell
            value={
              row.original.effectiveActive
                ? "متاح: الموقع والفرع فعالان"
                : !row.original.branchActive
                  ? "غير متاح بسبب إيقاف الفرع؛ يبقى تفعيل الموقع محفوظًا"
                  : "غير متاح بسبب إيقاف الموقع"
            }
          >
            {row.original.effectiveActive
              ? "متاح"
              : !row.original.branchActive
                ? "متوقف بسبب إيقاف الفرع"
                : "الموقع متوقف"}
          </ValueCell>
        ),
      },
      ...(canManage
        ? [
            {
              id: "actions",
              header: "الإجراءات",
              enableSorting: false,
              cell: ({ row }) => (
                <Button
                  variant="ghost"
                  size="compact"
                  disabled={loadingId !== null}
                  onClick={() => void edit(row.original.id)}
                  aria-label={`تعديل الموقع ${row.original.name}`}
                >
                  {loadingId === row.original.id ? "جارٍ التحميل…" : "تعديل"}
                </Button>
              ),
            } satisfies ColumnDef<Location, unknown>,
          ]
        : []),
    ],
    [canManage, loadingId, companyId],
  );

  return (
    <>
      <PageHeader
        title="المعارض والمخازن"
        description="معرض واحد لكل فرع ومخازن متعددة، مع إظهار تفعيل الموقع وإتاحته الفعلية."
        actions={
          canManage ? (
            <Button
              disabled={loadingId !== null}
              onClick={() => {
                setError("");
                setEditor({ location: null });
              }}
            >
              إضافة موقع
            </Button>
          ) : undefined
        }
      />
      {notice && <Notice tone="success">{notice}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <Notice>
        الإتاحة الفعلية تتطلب تفعيل الموقع والفرع معًا. إيقاف الفرع يحفظ إعداد
        تفعيل الموقع؛ إعادة تفعيل الفرع تعيد إتاحة المواقع التي لم توقف منفردة.
      </Notice>
      <Card title="قائمة المواقع">
        <div className="table-filters">
          <Field
            label="بحث في المواقع"
            type="search"
            value={list.query}
            onChange={(event) => list.setQuery(event.target.value)}
            placeholder="الاسم أو الكود أو اسم الفرع"
          />
          <Select
            label="نوع الموقع"
            value={kindFilter}
            onChange={(event) => setFilter("kind", event.target.value)}
          >
            <option value="">كل الأنواع</option>
            {locationKinds.map((kind) => (
              <option key={kind} value={kind}>
                {locationKindLabels[kind]}
              </option>
            ))}
          </Select>
          <Select
            label="تفعيل الموقع"
            value={activeFilter}
            onChange={(event) => setFilter("active", event.target.value)}
          >
            <option value="">كل المواقع</option>
            <option value="true">المواقع الفعالة</option>
            <option value="false">المواقع المتوقفة</option>
          </Select>
        </div>
        <ServerLookup<Branch>
          companyId={companyId}
          resource={`/companies/${companyId}/branches`}
          label="فرع المواقع"
          value={branchId ? (selectedBranch.data?.branch ?? null) : null}
          onChange={(branch) =>
            setFilter("branchId", branch ? String(branch.id) : "")
          }
          display={(branch) =>
            `${branch.code} — ${branch.name}${branch.active ? "" : " (متوقف)"}`
          }
          emptyLabel="كل الفروع"
        />
        {branchId && (
          <Button
            variant="ghost"
            size="compact"
            onClick={() => setFilter("branchId", "")}
          >
            مسح مرشح الفرع
          </Button>
        )}
        {selectedBranch.error && branchId && (
          <Notice tone="error">{errorMessage(selectedBranch.error)}</Notice>
        )}
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
          ariaLabel="قائمة المواقع"
        />
      </Card>
      {canManage && editor && (
        <LocationEditor
          key={`${companyId}:${editor.location?.id ?? "new"}`}
          companyId={companyId}
          location={editor.location}
          onClose={() => setEditor(null)}
          onSaved={async (location) => {
            if (!guard.isCurrent()) return;
            const creating = !editor.location;
            // The save has succeeded; dismiss before refreshing the table.
            setEditor(null);
            await changed();
            if (!guard.isCurrent()) return;
            setNotice(
              `${creating ? "تم إنشاء" : "تم حفظ"} ${locationKindLabels[location.kind]} «${location.name}»${location.effectiveActive ? "." : "؛ غير متاح فعليًا حتى تفعيل الموقع والفرع معًا."}`,
            );
          }}
        />
      )}
    </>
  );
}

function LocationEditor({
  companyId,
  location,
  onClose,
  onSaved,
}: {
  companyId: number;
  location: Location | null;
  onClose: () => void;
  onSaved: (location: Location) => Promise<void>;
}) {
  const guard = useScopeGuard(
    `company:${companyId}:location:${location?.id ?? "new"}`,
  );
  const [branch, setBranch] = useState<Branch | null>(null);

  const [name, setName] = useState(location?.name ?? "");
  const [kind, setKind] = useState<LocationKind>(location?.kind ?? "warehouse");
  const [active, setActive] = useState(location?.active ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving || (!location && !branch)) return;
    setSaving(true);
    setError("");
    try {
      const body = location
        ? { name, ...(active !== location.active ? { active } : {}) }
        : { branchId: branch?.id, name, kind };
      const result = await api<{ location: Location }>(
        `/companies/${companyId}/locations${location ? `/${location.id}` : ""}`,
        {
          method: location ? "PATCH" : "POST",
          body,
          signal: guard.signal,
        },
      );
      if (!guard.isCurrent()) return;
      setName(result.location.name);
      setKind(result.location.kind);
      setActive(result.location.active);
      await onSaved(result.location);
    } catch (reason) {
      if (guard.isCurrent()) setError(errorMessage(reason));
    } finally {
      if (guard.isCurrent()) setSaving(false);
    }
  }

  return (
    <Dialog
      open
      title={location ? "تعديل الموقع" : "إضافة موقع"}
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <form onSubmit={submit} className="form-stack">
        {error && <Notice tone="error">{error}</Notice>}
        {location ? (
          <Field
            label="الفرع"
            value={location.branchName}
            readOnly
            disabled={saving}
            hint="الفرع ثابت بعد إنشاء الموقع."
          />
        ) : (
          <ServerLookup<Branch>
            companyId={companyId}
            resource={`/companies/${companyId}/branches?active=true`}
            label="الفرع"
            value={branch}
            onChange={setBranch}
            display={(item) => `${item.code} — ${item.name}`}
            accept={(item) => item.active}
            required
            disabled={saving}
          />
        )}
        {location ? (
          <Field label="كود الموقع" value={location.code} dir="ltr"
            readOnly disabled={saving} hint="الكود ثابت بعد الإنشاء." />
        ) : (
          <Notice>يُنشئ النظام كود الموقع تلقائيًا بعد اختيار الفرع وحفظ الكرت.</Notice>
        )}
        <Field
          label="اسم الموقع"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={120}
          disabled={saving}
          autoFocus
        />
        <Select
          label="نوع الموقع"
          value={kind}
          onChange={(event) => setKind(event.target.value as LocationKind)}
          disabled={saving || Boolean(location)}
        >
          {locationKinds.map((value) => (
            <option key={value} value={value}>
              {locationKindLabels[value]}
            </option>
          ))}
        </Select>
        {!location && (
          <Notice>
            ينشأ المعرض تلقائيًا مع الفرع، ولا يقبل الفرع أكثر من معرض واحد.
            يمكن إضافة مخازن متعددة إلى فرع فعال. الموقع الجديد يكون فعالًا.
          </Notice>
        )}
        {location && (
          <>
            <label className="check-label">
              <input
                type="checkbox"
                checked={active}
                onChange={(event) => setActive(event.target.checked)}
                disabled={
                  saving || (!location.branchActive && !location.active)
                }
              />
              موقع فعال
            </label>
            <Notice tone={location.branchActive ? "info" : "warning"}>
              {location.branchActive
                ? active
                  ? "الإتاحة الفعلية: متاح لأن الموقع والفرع فعالان."
                  : "الإتاحة الفعلية: الموقع متوقف رغم تفعيل الفرع."
                : "الإتاحة الفعلية: متوقف بسبب إيقاف الفرع. يبقى تفعيل الموقع محفوظًا، ويمكن تعديل اسمه أو إيقافه؛ تفعيله يتطلب إعادة تفعيل الفرع أولًا."}
            </Notice>
            <p className="muted">نوع الموقع ثابت بعد الإنشاء.</p>
          </>
        )}
        <div className="form-actions">
          <Button type="submit" disabled={saving || (!location && !branch)}>
            {saving ? "جارٍ الحفظ…" : location ? "حفظ الموقع" : "إضافة الموقع"}
          </Button>
          <Button variant="secondary" disabled={saving} onClick={onClose}>
            إلغاء
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
