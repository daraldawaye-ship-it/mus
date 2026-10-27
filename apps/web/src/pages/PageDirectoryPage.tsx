import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Link, useSearchParams } from "react-router-dom";
import {
  ArrowUpRight,
  Copy,
  ListTree,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import {
  pageActions,
  pageActionLabels,
  permissionLabels,
  pageReferenceHref,
  type CompanyContext,
  type PageAction,
  type PageDirectory,
  type PageEntry,
  type ResolvedPage,
} from "../../../../packages/contracts/src/index";
import { api, usePagedQuery, useScopeGuard, useSession } from "../api";
import { usePageDirectory } from "../page-directory";
import { errorMessage } from "../phase2";
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

const scopeName = (scope: PageEntry["scope"]) =>
  scope === "public" ? "الموقع العام" : "الشركة";
const typeName = (type: PageEntry["type"]) =>
  ({ page: "صفحة", report: "تقرير", form: "إدخال" })[type];
function accessText(entry: PageEntry, action: PageAction) {
  const rule = entry.actions[action];
  if (!rule) return "غير متاح";
  return rule.permissions.length
    ? rule.permissions.map((key) => permissionLabels[key]).join(" + ")
    : rule.label;
}
/** A company-only page cannot be authorized from the public directory.
 * This is not an access denial for the platform owner or any employee. */
function accessStatus(entry: PageEntry, action: PageAction, companyId?: number): string {
  if (!entry.actions[action]) return "—";
  if (!entry.enabled) return "معطلة";
  if (entry.scope === "company" && !companyId) return "اختر شركة";
  return entry.actionAccess[action] ? "مسموح" : "غير مأذون";
}
function accessStatusHelp(entry: PageEntry, action: PageAction, companyId?: number): string {
  const status=accessStatus(entry,action,companyId);
  if (status==="معطلة") return "الصفحة معطلة من إعدادات الصفحات؛ يجب تفعيلها أولًا.";
  if (status==="اختر شركة") return "هذا دليل الموقع العام؛ افتح قائمة صفحات شركة محددة لفحص إذنك فيها، حتى إن كنت المالك.";
  if (status==="غير مأذون") return `يتطلب الإجراء: ${accessText(entry,action)}. يمكن للمالك أو المدير العام مراجعة صلاحيات الموظف من إدارة الخيارات والصلاحيات.`;
  return accessText(entry,action);
}
function State({
  value,
  yes,
  no,
}: {
  value: boolean;
  yes: string;
  no: string;
}) {
  return (
    <span
      className={`page-directory-state ${value ? "is-allowed" : "is-muted"}`}
    >
      {value ? yes : no}
    </span>
  );
}
export function PageDirectoryPage({ context }: { context?: CompanyContext }) {
  const { user: pageUser } = useSession();
  const userOwner = !!pageUser?.owner;
  const companyId = context?.company.id;
  const [params, setParams] = useSearchParams();
  const filters = new URLSearchParams();
  if (companyId) filters.set("companyId", String(companyId));
  for (const key of ["section", "scope", "type", "status"])
    if (params.get(key)) filters.set(key, params.get(key)!);
  const list = usePagedQuery<PageEntry>(
    `/page-catalog?${filters}`,
    "page-directory",
    "order:asc",
  );
  const catalog = usePageDirectory(companyId);
  const data = list.data as PageDirectory | undefined;
  const [search, setSearch] = useState(list.query);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => setSearch(list.query), [list.query]);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (search !== list.query) list.setQuery(search);
    }, 250);
    return () => clearTimeout(timer);
  }, [search, list.query, list.setQuery]);
  const writeFilter = (field: string, value: string) =>
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      value ? next.set(field, value) : next.delete(field);
      next.delete("page");
      return next;
    });
  const columns = useMemo<ColumnDef<PageEntry, unknown>[]>(
    () => [
      {
        accessorKey: "name",
        size: 210,
        header: "الصفحة",
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="compact"
            className="page-directory-name"
            onClick={() => setSelected(row.original.key)}
          >
            <ListTree size={15} />
            <span className="truncate" title={row.original.name}>
              {row.original.name}
            </span>
          </Button>
        ),
      },
      {
        accessorKey: "section",
        size: 110,
        header: "القسم",
        cell: ({ getValue }) => <ValueCell>{String(getValue())}</ValueCell>,
      },
      {
        accessorKey: "type",
        size: 70,
        header: "النوع",
        cell: ({ row }) => typeName(row.original.type),
      },
      {
        accessorKey: "scope",
        size: 90,
        header: "النطاق",
        cell: ({ row }) => scopeName(row.original.scope),
      },
      {
        accessorKey: "visible",
        size: 70,
        header: "الظهور",
        cell: ({ row }) => (
          <State value={row.original.visible} yes="ظاهرة" no="مخفية" />
        ),
      },
      {
        accessorKey: "enabled",
        size: 70,
        header: "التفعيل",
        cell: ({ row }) => (
          <State value={row.original.enabled} yes="مفعلة" no="معطلة" />
        ),
      },
      ...(["view", "create", "edit", "print"] as PageAction[]).map(
        (action) => ({
          id: action,
          size: 70,
          header: pageActionLabels[action],
          enableSorting: false,
          cell: ({ row }: { row: { original: PageEntry } }) => (
            <span
              title={accessStatusHelp(row.original, action, companyId)}
              className={
                row.original.actionAccess[action]
                  ? "page-directory-allowed"
                  : "muted"
              }
            >
              {accessStatus(row.original, action, companyId)}
            </span>
          ),
        }),
      ),
      {
        id: "links",
        size: 70,
        header: "الرابط",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.actionAccess.view && row.original.href ? (
            <Link
              className="button button-ghost button-compact"
              aria-label={`فتح ${row.original.name}`}
              to={pageReferenceHref({
                pageKey: row.original.key,
                companyId:
                  row.original.scope === "company" ? (companyId ?? null) : null,
                recordId: null,
              })}
            >
              <ArrowUpRight size={14} />
              فتح
            </Link>
          ) : (
            <Button
              variant="ghost"
              size="compact"
              title={row.original.record
                ? "حدد السجل المطلوب من تفاصيل الصفحة"
                : "اطلع على سبب عدم توفر فتح الصفحة وما تحتاجه من صلاحيات"}
              aria-label={`فتح ${row.original.name} (التفاصيل)`}
              onClick={() => setSelected(row.original.key)}
            >
              <ArrowUpRight size={14} /> فتح
            </Button>
          ),
      },
    ],
    [companyId],
  );
  const entry = catalog.data?.find((entry) => entry.key === selected);
  return (
    <div className="page-directory-page">
      <PageHeader
        title="قائمة الصفحات"
        description={
          companyId
            ? `دليل الوظائف والتقارير في ${context!.company.name}؛ الصلاحيات المعروضة تخص حسابك.`
            : "دليل مركزي لوظائف الموقع وروابطها وصلاحياتها. افتح دليل الشركة لمعرفة إتاحة صفحاتها لحسابك."
        }
        actions={
          companyId ? (
            <Link className="button button-secondary" to="/pages">
              دليل الموقع العام
            </Link>
          ) : (
            <div className="actions">
              <Link className="button button-secondary" to="/companies">اختيار شركة</Link>
              {userOwner && <Link className="button button-secondary" to="/explanations/access">
                منح صلاحيات صفحات الشروح
              </Link>}
            </div>
          )
        }
      />
      <div className="page-directory-summary" aria-label="ملخص الدليل">
        {[
          ["إجمالي الصفحات", data?.summary.total],
          ["متاحة لحسابك", data?.summary.available],
          ["تقارير", data?.summary.reports],
          ["مخفية", data?.summary.hidden],
          ["معطلة", data?.summary.disabled],
        ].map(([label, count]) => (
          <Card key={String(label)}>
            <span className="muted">{label}</span>
            <strong>{count ?? "—"}</strong>
          </Card>
        ))}
      </div>
      <Card>
        <div className="page-directory-filters">
          <Field
            label="بحث الصفحات"
            type="search"
            placeholder="اسم الصفحة أو وظيفتها أو رابطها…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Select
            label="القسم"
            value={params.get("section") ?? ""}
            onChange={(event) => writeFilter("section", event.target.value)}
          >
            <option value="">كل الأقسام</option>
            {data?.sections.map((section) => (
              <option key={section}>{section}</option>
            ))}
          </Select>
          <Select
            label="نوع الصفحة"
            value={params.get("type") ?? ""}
            onChange={(event) => writeFilter("type", event.target.value)}
          >
            <option value="">كل الأنواع</option>
            <option value="page">صفحات</option>
            <option value="report">تقارير</option>
            <option value="form">إدخال</option>
          </Select>
          <Select
            label="حالة الصفحة"
            value={params.get("status") ?? ""}
            onChange={(event) => writeFilter("status", event.target.value)}
          >
            <option value="">كل الحالات</option>
            <option value="available">متاحة لحسابي</option>
            <option value="restricted">تحتاج صلاحية / شركة</option>
            <option value="visible">ظاهرة</option>
            <option value="hidden">مخفية</option>
            <option value="enabled">مفعلة</option>
            <option value="disabled">معطلة</option>
          </Select>
          <Select
            label="نطاق الصفحة"
            value={params.get("scope") ?? ""}
            onChange={(event) => writeFilter("scope", event.target.value)}
          >
            <option value="">كل النطاقات</option>
            <option value="public">الموقع العام</option>
            <option value="company">الشركة</option>
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
        <div className="page-directory-table">
          <DataTable
            columns={columns}
            data={data?.items ?? []}
            total={data?.total ?? 0}
            page={list.page}
            pageSize={list.pageSize}
            onPageChange={list.setPage}
            onPageSizeChange={list.setPageSize}
            sorting={list.sorting}
            onSortingChange={list.setSorting}
            loading={list.loading}
            selectionMode="single"
            ariaLabel="دليل صفحات الموقع"
          />
        </div>
        <p className="muted page-directory-help">
          <ShieldCheck size={15} /> {companyId
            ? "هذا الدليل يفحص صلاحيات حسابك داخل الشركة الحالية. إظهار الصفحة لا يمنح صلاحية بياناتها؛ افتح التفاصيل لمعرفة المتطلبات."
            : "صفحات الشركات في الدليل العام تظهر بعبارة «اختر شركة» لا «غير مأذون». افتح الشركة أولًا لفحص صلاحياتك فيها، حتى لو كنت المالك."}
        </p>
      </Card>
      <Dialog
        open={!!selected}
        title={entry?.name ?? "تفاصيل الصفحة"}
        onClose={() => setSelected(null)}
      >
        {entry ? (
          <PageDetails
            key={`${companyId ?? "public"}:${entry.key}`}
            entry={entry}
            companyId={companyId}
            canManagePermissions={!!context?.general || !!context?.permissions.includes("pages.manage")}
            onUpdated={() => void list.refetch()}
          />
        ) : (
          <Notice>
            {catalog.error
              ? errorMessage(catalog.error)
              : "جارٍ تحميل تفاصيل الصفحة…"}
          </Notice>
        )}
      </Dialog>
    </div>
  );
}

type PageGrant = {id:number;action:string;principalType:"kind"|"monitor"|"position"|"user";principalValue:string;effect:"allow"|"deny"};
type GrantUser = {id:number;name:string;kind:string;monitor:boolean};
type GrantsResponse = {grants:PageGrant[];users:GrantUser[];positions:string[]};
function PagePermissionCard({entry,companyId}:{entry:PageEntry;companyId?:number}) {
  const {user}=useSession();
  const client=useQueryClient();
  const [principalType,setPrincipalType]=useState<"kind"|"monitor"|"position"|"user">("user");
  const [principalValue,setPrincipalValue]=useState("");
  const [action,setAction]=useState<PageAction>("view");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [message,setMessage]=useState("");
  const grants=useQuery({
    queryKey:["page-grants",user?.id,entry.key,companyId??null],
    queryFn:({signal})=>api<GrantsResponse>(
      `/page-catalog/${encodeURIComponent(entry.key)}/grants${companyId?`?companyId=${companyId}`:""}`,{signal}),
  });
  const chosen=grants.data?.grants.find(g=>g.action===action&&g.principalType===principalType&&g.principalValue===principalValue);
  async function save(effect:"allow"|"deny"|null) {
    if(!principalValue||busy)return;
    setBusy(true);setError("");setMessage("");
    try{
      await api(`/page-catalog/${encodeURIComponent(entry.key)}/grants`,{
        method:"PUT",body:{companyId:companyId??null,action,principalType,principalValue,effect}
      });
      await grants.refetch();
      await client.invalidateQueries({queryKey:["page-directory"]});
      setMessage("حُفظت صلاحية الصفحة للمستفيد المحدد.");
    }catch(e){setError(errorMessage(e));}
    finally{setBusy(false);}
  }
  return <section className="page-directory-settings" aria-label="منح صلاحيات الصفحة">
    <strong><ShieldCheck size={15}/> منح صلاحيات هذه الصفحة</strong>
    <p className="muted">اختر المستفيد والإجراء ثم امنح سماحًا أو منعًا. المنح للمستخدم المحدد أقوى من المنح حسب الصفة أو نوع الحساب. الإذن بالصفحة لا يكشف بيانات قضية أو مستند محمي دون صلاحياته الخاصة.</p>
    {grants.isPending&&<Notice>جارٍ تحميل الأذون…</Notice>}
    {grants.error&&<Notice tone="error">{errorMessage(grants.error)}</Notice>}
    <Select label="طريقة المنح" value={principalType} onChange={e=>{setPrincipalType(e.target.value as typeof principalType);setPrincipalValue("");}}>
      <option value="user">مستخدم محدد بالاسم أو الرقم</option>
      <option value="kind">حسب نوع الحساب</option>
      <option value="monitor">المراقب العام</option>
      {companyId&&<option value="position">حسب صفة الموظف في الشركة</option>}
    </Select>
    {principalType==="user"&&<>
      <Field label="رقم المستخدم" type="number" value={principalValue} onChange={e=>setPrincipalValue(e.target.value)} placeholder="أدخل رقم المستخدم"/>
      {grants.data&&<Select label="أو اختر المستخدم بالاسم" value={principalValue} onChange={e=>setPrincipalValue(e.target.value)}>
        <option value="">اختر مستخدمًا</option>
        {grants.data.users.map(p=><option key={p.id} value={String(p.id)}>{p.name} — {p.id}</option>)}
      </Select>}
    </>}
    {principalType==="kind"&&<Select label="نوع الحساب" value={principalValue} onChange={e=>setPrincipalValue(e.target.value)}>
      <option value="">اختر النوع</option><option value="admin">إداري</option>
      <option value="supervisor">مشرف</option><option value="member">عضو</option>
    </Select>}
    {principalType==="monitor"&&<Select label="المراقب" value={principalValue} onChange={e=>setPrincipalValue(e.target.value)}>
      <option value="">اختر</option><option value="true">الحسابات المعرّفة كمراقب عام</option>
    </Select>}
    {principalType==="position"&&<Select label="الصفة في الشركة" value={principalValue} onChange={e=>setPrincipalValue(e.target.value)}>
      <option value="">اختر الصفة</option>
      {(grants.data?.positions??[]).map(p=><option key={p} value={p}>{p}</option>)}
    </Select>}
    <Select label="الإجراء" value={action} onChange={e=>setAction(e.target.value as PageAction)}>
      {pageActions.filter(a=>entry.actions[a]).map(a=><option key={a} value={a}>{pageActionLabels[a]}</option>)}
    </Select>
    <p className="muted">الحالة المحددة: {chosen?chosen.effect==="allow"?"مسموح صراحة":"ممنوع صراحة":"لا يوجد استثناء — حسب الصلاحيات الأصلية"}</p>
    <div className="actions">
      <Button disabled={!principalValue||busy} onClick={()=>void save("allow")}>سماح</Button>
      <Button variant="secondary" disabled={!principalValue||busy} onClick={()=>void save("deny")}>منع</Button>
      <Button variant="secondary" disabled={!chosen||busy} onClick={()=>void save(null)}>إزالة الاستثناء</Button>
    </div>
    {error&&<Notice tone="error">{error}</Notice>}
    {message&&<Notice tone="success">{message}</Notice>}
  </section>;
}

function PageDetails({
  entry,
  companyId,
  canManagePermissions,
  onUpdated,
}: {
  entry: PageEntry;
  companyId?: number;
  canManagePermissions: boolean;
  onUpdated: () => void;
}) {
  const { user } = useSession(),
    client = useQueryClient();
  const guard = useScopeGuard(
    `page-settings:${companyId ?? "public"}:${entry.key}`,
  );
  const [visible, setVisible] = useState(entry.configuredVisible),
    [enabled, setEnabled] = useState(entry.configuredEnabled),
    [order, setOrder] = useState(String(entry.order));
  const [revision, setRevision] = useState(entry.revision),
    [recordId, setRecordId] = useState("");
  const [saving, setSaving] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  function reference() {
    return {
      pageKey: entry.key,
      companyId: entry.scope === "company" ? (companyId ?? null) : null,
      recordId: entry.record ? Number(recordId) : null,
    };
  }
  async function copyLink() {
    setError("");
    setMessage("");
    try {
      const ref = reference(),
        query = new URLSearchParams();
      if (ref.companyId) query.set("companyId", String(ref.companyId));
      if (ref.recordId) query.set("recordId", String(ref.recordId));
      await api<ResolvedPage>(`/page-catalog/${entry.key}/resolve?${query}`, {
        signal: guard.signal,
      });
      await navigator.clipboard.writeText(
        window.location.origin + pageReferenceHref(ref),
      );
      if (guard.isCurrent())
        setMessage(
          "تم نسخ الرابط الثابت؛ يمكن استخدامه كمرجع في المذكرات والتقارير.",
        );
    } catch (error) {
      if (guard.isCurrent()) setError(errorMessage(error));
    }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const response = await api<{ page: PageEntry }>(
        `/page-catalog/${entry.key}/settings`,
        {
          method: "PUT",
          body: {
            companyId: companyId ?? null,
            visible,
            enabled,
            order: Number(order),
            revision,
          },
          signal: guard.signal,
        },
      );
      if (!guard.isCurrent()) return;
      setRevision(response.page.revision);
      await client.invalidateQueries({
        queryKey: ["page-directory", user?.id],
      });
      if (!guard.isCurrent()) return;
      onUpdated();
      setMessage("تم حفظ إعدادات الصفحة وتحديث الدليل وقائمة التنقل.");
    } catch (error) {
      if (guard.isCurrent()) setError(errorMessage(error));
    } finally {
      if (guard.isCurrent()) setSaving(false);
    }
  }
  async function reloadSettings() {
    setError("");
    try {
      const query = new URLSearchParams({ q: entry.key, pageSize: "100" });
      if (companyId) query.set("companyId", String(companyId));
      const response = await api<PageDirectory>(`/page-catalog?${query}`, {
        signal: guard.signal,
      });
      const latest = response.items.find((page) => page.key === entry.key);
      if (!guard.isCurrent() || !latest) return;
      setVisible(latest.configuredVisible);
      setEnabled(latest.configuredEnabled);
      setOrder(String(latest.order));
      setRevision(latest.revision);
      await client.invalidateQueries({
        queryKey: ["page-directory", user?.id],
      });
      if (guard.isCurrent()) onUpdated();
    } catch (error) {
      if (guard.isCurrent()) setError(errorMessage(error));
    }
  }
  return (
    <div className="page-directory-details">
      <p>{entry.description}</p>
      <dl className="page-directory-meta">
        <dt>القسم</dt>
        <dd>{entry.section}</dd>
        <dt>النطاق / النوع</dt>
        <dd>
          {scopeName(entry.scope)} / {typeName(entry.type)}
        </dd>
        <dt>معرف الصفحة الثابت</dt>
        <dd>
          <bdi>{entry.key}</bdi>
        </dd>
        <dt>الرابط</dt>
        <dd>
          <bdi>{entry.href ?? entry.route}</bdi>
        </dd>
      </dl>
      <table className="page-directory-permissions">
        <thead>
          <tr>
            <th>الإجراء</th>
            <th>الصلاحيات المطلوبة</th>
            <th>حسابك</th>
          </tr>
        </thead>
        <tbody>
          {pageActions.map((action) => (
            <tr key={action}>
              <td>{pageActionLabels[action]}</td>
              <td>{accessText(entry, action)}</td>
              <td>
                {accessStatus(entry, action, companyId) === "—"
                  ? "غير متاح" : accessStatus(entry, action, companyId)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {entry.scope === "company" && !companyId && (
        <Notice>
          لا يوجد منع لصلاحياتك هنا؛ هذا هو دليل الموقع العام، ولم يتم تحديد شركة.
          <div className="actions">
            <Link className="button button-secondary" to="/companies">
              اختيار الشركة لعرض صلاحياتها
            </Link>
          </div>
        </Notice>
      )}
      {!entry.enabled && (
        <Notice tone="warning">
          صفحة «{entry.name}» معطلة من إعدادات الصفحات. تفعيلها مطلوب قبل أي إذن بالعرض.
        </Notice>
      )}
      {companyId && entry.enabled && entry.actions.view && !entry.actionAccess.view && (
        <Notice tone="warning">
          عرض هذه الصفحة يتطلب: {accessText(entry, "view")}.
          {canManagePermissions
            ? " يمكنك مراجعة سماح الدور أو الموظف من إدارة الخيارات والصلاحيات."
            : " اطلب من مالك المنصة أو المدير العام مراجعة صلاحياتك."}
        </Notice>
      )}
      {(user?.owner || (companyId && canManagePermissions)) && (
        <PagePermissionCard entry={entry} companyId={companyId}/>
      )}
      {entry.key==="public.legal-cases" && user?.owner && (
        <Notice>صلاحيات إدارة القضايا تُمنح لكل قضية مستقلة لحماية بقية الملفات. افتح القضية من إدارة قضايا مصطفى ثم تبويب «الصلاحيات» لتفويض المستخدم.</Notice>
      )}
      {companyId && entry.actions.view?.role === "permissions" && canManagePermissions && (
        <Link className="button button-secondary"
          to={`/companies/${companyId}/configuration?tab=permissions&permissionPage=${encodeURIComponent(entry.key)}`}>
          إدارة صلاحيات هذه الصفحة
        </Link>
      )}
      {(entry.record === "invoice" ||
        entry.record === "financial-document") && (
        <small className="muted">
          إتاحة الإجراء تعتمد أيضًا على حالة السجل؛ المستند المرحل لا يُعدّل،
          والمسودة المالية لا تُطبع قبل ترحيلها.
        </small>
      )}
      {entry.scope === "company" && !companyId && (
        <Notice>افتح دليل الشركة لعرض صلاحياتها وفتح صفحاتها.</Notice>
      )}
      {entry.record && (
        <Field
          label="معرف السجل المطلوب"
          inputMode="numeric"
          value={recordId}
          onChange={(event) => setRecordId(event.target.value)}
          hint="يتحقق النظام من وجود السجل في الشركة ومن صلاحية عرضه قبل فتحه."
        />
      )}
      <div className="actions">
        {entry.actionAccess.view &&
        (!entry.record || /^[1-9]\d*$/.test(recordId)) ? (
          <Link
            className="button button-secondary"
            to={pageReferenceHref(reference())}
          >
            <ArrowUpRight size={15} />
            فتح الصفحة
          </Link>
        ) : (
          <Button variant="secondary" disabled>
            <ArrowUpRight size={15} />
            فتح الصفحة
          </Button>
        )}
        <Button
          variant="secondary"
          disabled={
            !entry.actionAccess.view ||
            (!!entry.record && !/^[1-9]\d*$/.test(recordId))
          }
          onClick={() => void copyLink()}
        >
          <Copy size={15} />
          نسخ رابط ثابت
        </Button>
      </div>
      {entry.canConfigure ? (
        <form
          onSubmit={(event) => void save(event)}
          className="page-directory-settings"
        >
          <strong>
            <Settings2 size={15} /> إعدادات{" "}
            {companyId ? "الشركة الحالية" : "الموقع كله"}
          </strong>
          {companyId && (!entry.globalVisible || !entry.globalEnabled) && (
            <Notice tone="warning">
              إعداد عام يخفي أو يعطل هذه الصفحة؛ إعداد الشركة لا يتجاوز الإعداد
              العام.
            </Notice>
          )}
          <fieldset disabled={saving} className="commerce-fieldset">
            <div className="page-directory-settings-fields">
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={visible}
                  onChange={(event) => setVisible(event.target.checked)}
                />
                إظهار في التنقل
              </label>
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(event) => setEnabled(event.target.checked)}
                />
                تفعيل الصفحة
              </label>
              <Field
                label="ترتيب الظهور"
                type="number"
                min="0"
                max="100000"
                required
                value={order}
                onChange={(event) => setOrder(event.target.value)}
              />
            </div>
            <Button type="submit">
              {saving ? "جارٍ الحفظ…" : "حفظ إعدادات الصفحة"}
            </Button>
          </fieldset>
          <small className="muted">
            إخفاء الصفحة يزيل رابطها من التنقل. التعطيل يمنع فتح بياناتها وبدء
            إجراءاتها. الصلاحيات لا تتغير بهذا الإعداد.
          </small>
        </form>
      ) : entry.critical ? (
        <Notice>
          صفحة أساسية محمية للحفاظ على الدخول والتنقل وإدارة الدليل.
        </Notice>
      ) : null}
      {error && (
        <Notice tone="error">
          {error}
          <Button variant="ghost" onClick={() => void reloadSettings()}>
            إعادة تحميل الإعدادات
          </Button>
        </Notice>
      )}
      {message && <Notice tone="success">{message}</Notice>}
    </div>
  );
}
