import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  Check,
  CheckCheck,
  Clock3,
  RefreshCw,
  Settings2,
  UserRoundPlus,
} from "lucide-react";
import {
  notificationActionSchema,
  notificationSettingsSchema,
  type CompanyContext,
  type NotificationDirectory,
  type NotificationImportance,
  type NotificationRecord,
  type NotificationRepeat,
  type NotificationTemplate,
  type NotificationTemplateDirectory,
} from "../../../../packages/contracts/src/index";
import { api, usePagedQuery, useScopeGuard, useSession } from "../api";
import { errorMessage } from "../phase2";
import { Button, Card, Dialog, Field, Notice, PageHeader, Select } from "../ui";

const importanceLabels: Record<NotificationImportance, string> = {
  critical: "عالية جدًا",
  high: "عالية",
  medium: "متوسطة",
  low: "منخفضة",
};
const repeatLabels: Record<NotificationRepeat, string> = {
  none: "بدون تكرار",
  day: "كل يوم",
  week: "كل أسبوع",
  month: "كل شهر",
};
const time = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat("ar-YE", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Aden",
      }).format(new Date(value))
    : "—";
function RepeatOptions() {
  return (
    <>
      {Object.entries(repeatLabels).map(([key, label]) => (
        <option key={key} value={key}>
          {label}
        </option>
      ))}
    </>
  );
}
function ImportanceOptions() {
  return (
    <>
      {Object.entries(importanceLabels).map(([key, label]) => (
        <option key={key} value={key}>
          {label}
        </option>
      ))}
    </>
  );
}
function CheckField({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="notification-checkbox">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}
type ActionDraft = {
  record: NotificationRecord;
  action: "snooze" | "repeat" | "assign" | "priority";
  until: string;
  repeatInterval: NotificationRepeat;
  employeeId: number;
  importance: NotificationImportance;
};
export function NotificationsPage({ context }: { context?: CompanyContext }) {
  const companyId = context?.company.id;
  const scope = companyId ? `company:${companyId}` : "public";
  const base = companyId ? `/companies/${companyId}` : "";
  const { user } = useSession(),
    client = useQueryClient(),
    guard = useScopeGuard(`${scope}:notifications`);
  const [params, setParams] = useSearchParams();
  const state = ["active", "snoozed", "done", "all"].includes(
    params.get("state") ?? "",
  )
    ? params.get("state")!
    : "active";
  const grouped=params.get("grouped")!=="0";
  const notificationCode=params.get("code");
  const list = usePagedQuery<NotificationRecord, NotificationDirectory>(
    `${base}/notifications?state=${state}&grouped=${grouped?"1":"0"}${notificationCode?`&code=${encodeURIComponent(notificationCode)}`:""}`,
    `${scope}:notifications`,
    "createdAt:desc,id:desc",
  );
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void list.refetch();
    }, 30000);
    return () => window.clearInterval(timer);
  }, [base, list.refetch]);
  const [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<ActionDraft | null>(null);
  const canManage = context ? context.general : user?.owner;
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / list.pageSize));
  async function refresh() {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["notifications", user?.id] }),
      client.invalidateQueries({
        queryKey: ["list", user?.id, `${scope}:notifications`],
      }),
      ...(companyId
        ? [
            client.invalidateQueries({
              queryKey: ["list", user?.id, "public:notifications"],
            }),
          ]
        : []),
    ]);
  }
  function filter(key: string, value: string) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      value ? next.set(key, value) : next.delete(key);
      next.delete("page");
      return next;
    });
  }
  async function perform(
    record: NotificationRecord,
    body: unknown,
    message: string,
  ) {
    if (pending) return;
    const parsed = notificationActionSchema.safeParse(body);
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join(" · "));
      return;
    }
    setPending(true);
    setError("");
    setNotice("");
    try {
      await api(`${base}/notifications/${record.id}/action`, {
        method: "POST",
        body: parsed.data,
        signal: guard.signal,
      });
      if (!guard.isCurrent()) return;
      await refresh();
      if (guard.isCurrent()) {
        setDraft(null);
        setNotice(message);
      }
    } catch (cause) {
      if (guard.isCurrent()) setError(errorMessage(cause));
    } finally {
      if (guard.isCurrent()) setPending(false);
    }
  }
  function open(record: NotificationRecord, action: ActionDraft["action"]) {
    setError("");
    setDraft({
      record,
      action,
      until: new Date(Date.now() + 27 * 3600000).toISOString().slice(0, 16),
      repeatInterval: record.canRepeat ? record.repeatInterval : "none",
      employeeId: list.data?.employees[0]?.id ?? 0,
      importance: record.importance,
    });
  }
  function saveAction(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    const common = { action: draft.action, revision: draft.record.revision };
    if (draft.action === "snooze") {
      const until = new Date(`${draft.until}:00+03:00`);
      if (Number.isNaN(until.getTime())) {
        setError("اختر تاريخًا ووقتًا صالحين.");
        return;
      }
      void perform(
        draft.record,
        { ...common, until: until.toISOString() },
        "تم تأجيل المتابعة إلى الموعد المحدد.",
      );
    } else if (draft.action === "priority") {
      void perform(
        draft.record,
        { ...common, importance: draft.importance },
        "تم تحديث أهمية التنبيه.",
      );
    } else {
      void perform(
        draft.record,
        {
          ...common,
          repeatInterval: draft.repeatInterval,
          ...(draft.action === "assign"
            ? { employeeId: draft.employeeId }
            : {}),
        },
        draft.action === "assign"
          ? "تم إرسال التنبيه إلى الموظف المحدد للمتابعة."
          : "تم تحديث تكرار التنبيه.",
      );
    }
  }
  const actionTitles = {
    snooze: "تأجيل المتابعة",
    repeat: "تكرار التنبيه",
    assign: "إرسال لمتابع آخر",
    priority: "أهمية التنبيه",
  };
  return (
    <div className="notifications-page">
      <PageHeader
        title="التنبيهات"
        description={
          companyId
            ? `تنبيهاتك العامة وتنبيهات ${context!.company.name}، بحسب صلاحيات المتابعة.`
            : "التنبيهات الآلية العامة الموجهة إليك."
        }
        actions={
          <>
            <Button
              variant="secondary"
              disabled={pending || list.loading}
              onClick={() => void refresh()}
            >
              <RefreshCw size={15} />
              تحديث
            </Button>
            {canManage && (
              <Link
                to={`${base}/notification-templates`}
                className="button button-secondary"
              >
                <Settings2 size={15} />
                أنواع التنبيهات
              </Link>
            )}
          </>
        }
      />
      {error && !draft && <Notice tone="error">{error}</Notice>}
      {notice && <Notice tone="success">{notice}</Notice>}
      {list.error && (
        <Notice tone="error">
          {errorMessage(list.error)}{" "}
          <Button variant="ghost" onClick={() => void list.refetch()}>
            إعادة المحاولة
          </Button>
        </Notice>
      )}
      <Card>
        <div className="notification-filters">
          <Field
            label="البحث"
            placeholder="اسم التنبيه أو تفاصيله أو الكود"
            value={list.query}
            onChange={(event) => list.setQuery(event.target.value)}
          />
          <Select
            label="الحالة"
            value={state}
            onChange={(event) => filter("state", event.target.value)}
          >
            <option value="active">قيد المتابعة</option>
            <option value="snoozed">مؤجل</option>
            <option value="done">منجز</option>
            <option value="all">الكل</option>
          </Select>
          <Select label="طريقة العرض" value={grouped?"1":"0"}
            onChange={event=>filter("grouped",event.target.value==="1"?"":"0")}>
            <option value="1">تجميع حسب نوع الإشعار</option>
            <option value="0">إظهار كل إشعار منفردًا</option>
          </Select>
          {notificationCode&&<button type="button"
            className="button button-secondary button-compact"
            onClick={()=>filter("code","")}>كل أنواع الإشعارات</button>}
          <Select
            label="الترتيب"
            value={params.get("sort") ?? "createdAt:desc,id:desc"}
            onChange={(event) => filter("sort", event.target.value)}
          >
            <option value="createdAt:desc,id:desc">الأحدث أولًا</option>
            <option value="createdAt:asc,id:asc">الأقدم أولًا</option>
            <option value="importance:desc,createdAt:desc,id:desc">
              الأهمية ثم الأحدث
            </option>
          </Select>
        </div>
        <div className="notification-list-meta">
          <span>{(list.data?.total ?? 0).toLocaleString("ar")} {grouped?"نوع إشعار":"إشعار"}</span>
          {grouped&&<span>تُعرض آخر رسالة لكل نوع والعدد الإجمالي</span>}
          <span>{(list.data?.unread ?? 0).toLocaleString("ar")} غير مقروء</span>
        </div>
      </Card>
      <div className="notification-list" aria-busy={list.loading || undefined}>
        {!list.data && list.loading && <Notice>جارٍ تحميل التنبيهات…</Notice>}
        {list.data && list.data.items.length === 0 && (
          <Card className="notification-empty">
            <Bell size={25} />
            <h2>لا توجد تنبيهات في هذه القائمة</h2>
            <p>
              تظهر التنبيهات تلقائيًا عند حدوث أحداث مرتبطة بالأنواع المفعّلة.
            </p>
          </Card>
        )}
        {list.data?.items.map((record) => (
          <article
            key={record.id}
            className={`card notification-record${record.groupUnread>0 ? " is-unread" : ""}`}
            data-notification-id={record.id}
          >
            <div className="notification-heading">
              <h2>{record.title}</h2>
              {grouped&&record.groupCount>1&&<span className="notification-group-count">
                {record.groupCount.toLocaleString("ar")} إشعار
              </span>}
              <span
                className={`notification-importance importance-${record.importance}`}
              >
                {importanceLabels[record.importance]}
              </span>
            </div>
            <p className="notification-message">
              {grouped&&record.groupCount>1&&<strong>آخر إشعار: </strong>}
              {record.message}
            </p>
            {grouped&&record.groupCount>1&&<div className="notification-details">
              <span>{record.groupUnread.toLocaleString("ar")} غير مقروءة من هذا النوع</span>
              <Link to={`${base}/notifications?state=${state}&grouped=0&code=${encodeURIComponent(record.code)}`}>
                عرض جميع إشعارات هذا النوع
              </Link>
            </div>}
            <div className="notification-details">
              <span>{record.companyId ? context?.company.name : "عام"}</span>
              <time dateTime={record.createdAt}>{time(record.createdAt)}</time>
              <bdi>{record.code}</bdi>
            </div>
            <div className="notification-details">
              {record.completedAt ? (
                <span className="notification-finished">
                  <CheckCheck size={14} />
                  منجز: {time(record.completedAt)}
                </span>
              ) : (
                <span>
                  {record.readAt
                    ? "مقروء · قيد المتابعة"
                    : "غير مقروء · قيد المتابعة"}
                </span>
              )}
              {!record.completedAt && record.snoozedUntil && (
                <span>موعد المتابعة: {time(record.snoozedUntil)}</span>
              )}
              {!record.completedAt && (
                <span>
                  {repeatLabels[record.repeatInterval]}
                  {record.reminderCount
                    ? ` · ${record.reminderCount} تذكير`
                    : ""}
                </span>
              )}
            </div>
            {grouped&&record.groupCount>1&&<small className="muted">
              الإجراءات التالية تخص آخر إشعار فقط. لإدارة البقية افتح جميع إشعارات هذا النوع.
            </small>}
            <div className="notification-actions">
              {record.href && (
                <Link to={record.href} className="button button-secondary">
                  فتح السجل المرتبط
                </Link>
              )}
              {!record.completedAt && (
                <>
                  {!record.readAt && (
                    <Button
                      variant="secondary"
                      disabled={pending}
                      onClick={() =>
                        void perform(
                          record,
                          { action: "read", revision: record.revision },
                          "تم تحديد التنبيه كمقروء.",
                        )
                      }
                    >
                      <Check size={14} />
                      مقروء
                    </Button>
                  )}
                  <Button
                    disabled={pending}
                    onClick={() =>
                      void perform(
                        record,
                        { action: "complete", revision: record.revision },
                        "تم إنجاز متابعة التنبيه.",
                      )
                    }
                  >
                    <CheckCheck size={15} />
                    إنجاز
                  </Button>
                  {record.canSnooze && (
                    <Button
                      variant="secondary"
                      disabled={pending}
                      onClick={() => open(record, "snooze")}
                    >
                      <Clock3 size={14} />
                      تأجيل
                    </Button>
                  )}
                  {record.canRepeat && (
                    <Button
                      variant="secondary"
                      disabled={pending}
                      onClick={() => open(record, "repeat")}
                    >
                      <RefreshCw size={14} />
                      التكرار
                    </Button>
                  )}
                  {record.canAssign && (
                    <>
                      <Button
                        variant="secondary"
                        disabled={pending}
                        onClick={() => open(record, "priority")}
                      >
                        الأهمية
                      </Button>
                      <Button
                        variant="secondary"
                        disabled={pending || !list.data?.employees.length}
                        onClick={() => open(record, "assign")}
                      >
                        <UserRoundPlus size={14} />
                        إرسال لموظف
                      </Button>
                    </>
                  )}
                </>
              )}
            </div>
          </article>
        ))}
      </div>
      {list.data && list.data.total > 0 && (
        <div className="notification-pagination">
          <Select
            label="عدد السجلات"
            value={list.pageSize}
            onChange={(event) => list.setPageSize(Number(event.target.value))}
          >
            {[10, 20, 50, 100].map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </Select>
          <span>
            الصفحة {list.page.toLocaleString("ar")} من{" "}
            {pages.toLocaleString("ar")}
          </span>
          <div className="notification-actions">
            <Button
              variant="secondary"
              disabled={list.loading || list.page <= 1}
              onClick={() => list.setPage(list.page - 1)}
            >
              السابق
            </Button>
            <Button
              variant="secondary"
              disabled={list.loading || list.page >= pages}
              onClick={() => list.setPage(list.page + 1)}
            >
              التالي
            </Button>
          </div>
        </div>
      )}
      <Dialog
        open={!!draft}
        title={draft ? actionTitles[draft.action] : "متابعة التنبيه"}
        onClose={() => {
          if (!pending) setDraft(null);
        }}
      >
        {draft && (
          <form className="form-stack" onSubmit={saveAction}>
            <p>{draft.record.title}</p>
            {error && <Notice tone="error">{error}</Notice>}
            {draft.action === "snooze" && (
              <Field
                label="موعد المتابعة بتوقيت عدن"
                type="datetime-local"
                required
                value={draft.until}
                onChange={(event) =>
                  setDraft({ ...draft, until: event.target.value })
                }
                hint="اختر موعدًا لاحقًا خلال سنة؛ يعود التنبيه لقائمة المتابعة عند الموعد."
              />
            )}
            {draft.action === "priority" && (
              <Select
                label="الأهمية"
                value={draft.importance}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    importance: event.target.value as NotificationImportance,
                  })
                }
              >
                <ImportanceOptions />
              </Select>
            )}
            {draft.action === "assign" && (
              <Select
                label="الموظف المتابع"
                required
                value={draft.employeeId || ""}
                onChange={(event) =>
                  setDraft({ ...draft, employeeId: Number(event.target.value) })
                }
              >
                <option value="">اختر الموظف</option>
                {list.data?.employees.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.name}
                  </option>
                ))}
              </Select>
            )}
            {(draft.action === "repeat" || draft.action === "assign") && (
              <>
                <Select
                  label="التكرار إلى حين الإنجاز"
                  disabled={!draft.record.canRepeat}
                  value={draft.record.canRepeat ? draft.repeatInterval : "none"}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      repeatInterval: event.target.value as NotificationRepeat,
                    })
                  }
                >
                  <RepeatOptions />
                </Select>
                <Notice>
                  {draft.record.canRepeat
                    ? "الافتراضي بدون تكرار. يتوقف التذكير عند إنجاز التنبيه."
                    : "كرت هذا النوع لا يسمح بالتكرار؛ يرسل للموظف مرة واحدة."}
                </Notice>
              </>
            )}
            <div className="form-actions">
              <Button type="submit" disabled={pending}>
                {pending ? "جارٍ الحفظ…" : "حفظ"}
              </Button>
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() => setDraft(null)}
              >
                إلغاء
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </div>
  );
}

export function NotificationTemplatesPage({
  context,
}: {
  context?: CompanyContext;
}) {
  const companyId = context?.company.id,
    scope = companyId ? `company:${companyId}` : "public",
    base = companyId ? `/companies/${companyId}` : "";
  const { user } = useSession(),
    client = useQueryClient(),
    guard = useScopeGuard(`${scope}:notification-templates`);
  const query = useQuery({
    queryKey: ["notification-templates", user?.id, scope],
    queryFn: ({ signal }) =>
      api<NotificationTemplateDirectory>(`${base}/notification-templates`, {
        signal,
      }),
    enabled: !!user,
  });
  const [search, setSearch] = useState(""),
    [category, setCategory] = useState(""),
    [state, setState] = useState("");
  const [draft, setDraft] = useState<NotificationTemplate | null>(null),
    [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const templates = query.data?.templates ?? [],
    categories = [...new Set(templates.map((template) => template.category))];
  const filtered = templates.filter(
    (template) =>
      (!category || template.category === category) &&
      (!state ||
        (state === "planned"
          ? !template.implemented
          : template.implemented &&
            (state === "enabled" ? template.enabled : !template.enabled))) &&
      (!search ||
        [template.name, template.code, template.description]
          .join(" ")
          .toLocaleLowerCase("ar")
          .includes(search.toLocaleLowerCase("ar"))),
  );
  function selectId(
    key: "roleIds" | "employeeIds",
    id: number,
    selected: boolean,
  ) {
    if (!draft) return;
    setDraft({
      ...draft,
      [key]: selected
        ? [...draft[key], id]
        : draft[key].filter((entry) => entry !== id),
    });
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || pending) return;
    const {
      importance,
      enabled,
      canSnooze,
      allowRepeat,
      repeatInterval,
      notifyManagers,
      notifySubject,
      roleIds,
      employeeIds,
      revision,
    } = draft;
    const parsed = notificationSettingsSchema.safeParse({
      importance,
      enabled,
      canSnooze,
      allowRepeat,
      repeatInterval: allowRepeat ? repeatInterval : "none",
      notifyManagers,
      notifySubject,
      roleIds,
      employeeIds,
      revision,
    });
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join(" · "));
      return;
    }
    setPending(true);
    setError("");
    setNotice("");
    try {
      await api(
        `${base}/notification-templates/${encodeURIComponent(draft.code)}`,
        { method: "PUT", body: parsed.data, signal: guard.signal },
      );
      if (!guard.isCurrent()) return;
      await Promise.all([
        client.invalidateQueries({
          queryKey: ["notification-templates", user?.id, scope],
        }),
        client.invalidateQueries({ queryKey: ["notifications", user?.id] }),
        client.invalidateQueries({
          queryKey: ["list", user?.id, `${scope}:notifications`],
        }),
      ]);
      if (guard.isCurrent()) {
        setDraft(null);
        setNotice("تم حفظ كرت التنبيه وإعداد متابعيه.");
      }
    } catch (cause) {
      if (guard.isCurrent()) setError(errorMessage(cause));
    } finally {
      if (guard.isCurrent()) setPending(false);
    }
  }
  return (
    <div className="notifications-page">
      <PageHeader
        title="أنواع التنبيهات"
        description="كروت الأنواع الآلية، وأهميتها، وصلاحيات متابعتها والتأجيل والتكرار."
        actions={
          <Link
            to={`${base}/notifications`}
            className="button button-secondary"
          >
            <Bell size={15} />
            قائمة التنبيهات
          </Link>
        }
      />
      {notice && <Notice tone="success">{notice}</Notice>}
      {query.error && (
        <Notice tone="error">
          {errorMessage(query.error)}{" "}
          <Button variant="ghost" onClick={() => void query.refetch()}>
            إعادة المحاولة
          </Button>
        </Notice>
      )}
      <Card>
        <div className="notification-filters">
          <Field
            label="البحث"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="الاسم أو الكود أو الوصف"
          />
          <Select
            label="الفئة"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            <option value="">جميع الفئات</option>
            {categories.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </Select>
          <Select
            label="الحالة"
            value={state}
            onChange={(event) => setState(event.target.value)}
          >
            <option value="">الكل</option>
            <option value="enabled">متاح ومفعّل</option>
            <option value="disabled">متاح وموقوف</option>
            <option value="planned">مخطط للتطوير</option>
          </Select>
        </div>
        <div className="notification-list-meta">
          <span>{filtered.length.toLocaleString("ar")} نوع</span>
          <span>
            {templates
              .filter((template) => template.implemented)
              .length.toLocaleString("ar")}{" "}
            متاح
          </span>
        </div>
      </Card>
      <Notice>
        التنبيهات تنشأ من أحداث النظام تلقائيًا. الأنواع المخططة تظهر هنا لتعريف
        إعداداتها، وتُفعّل عند اكتمال ربطها بحدثها. الإشعارات الخارجية مرحلة
        لاحقة.
      </Notice>
      {query.isLoading && <Notice>جارٍ تحميل كروت التنبيهات…</Notice>}
      {query.data && filtered.length === 0 && (
        <Card>
          <p>لا توجد أنواع تطابق البحث والتصفية.</p>
        </Card>
      )}
      <div className="notification-template-grid">
        {filtered.map((template) => (
          <Card key={template.code} className="notification-template">
            <div className="notification-heading">
              <h2>{template.name}</h2>
              <span
                className={`notification-importance importance-${template.importance}`}
              >
                {importanceLabels[template.importance]}
              </span>
            </div>
            <div className="notification-details">
              <span>{template.category}</span>
              <span
                className={`page-directory-state ${template.implemented && template.enabled ? "is-allowed" : "is-muted"}`}
              >
                {template.implemented
                  ? template.enabled
                    ? "مفعّل"
                    : "موقوف"
                  : "مخطط للتطوير"}
              </span>
            </div>
            <p className="notification-message">{template.description}</p>
            <bdi className="notification-template-code">{template.code}</bdi>
            <div className="notification-details">
              <span>{template.canSnooze ? "يمكن تأجيله" : "لا يؤجّل"}</span>
              <span>
                {template.allowRepeat
                  ? repeatLabels[template.repeatInterval]
                  : "التكرار غير مسموح"}
              </span>
              {!template.canDisable && <span>تنبيه إلزامي</span>}
            </div>
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() => {
                setError("");
                setDraft({
                  ...template,
                  roleIds: [...template.roleIds],
                  employeeIds: [...template.employeeIds],
                });
              }}
            >
              <Settings2 size={15} />
              إعداد الكرت والمتابعين
            </Button>
          </Card>
        ))}
      </div>
      <Dialog
        open={!!draft}
        onClose={() => {
          if (!pending) setDraft(null);
        }}
        title={draft ? draft.name : "كرت التنبيه"}
      >
        {draft && (
          <form className="form-stack" onSubmit={save}>
            <bdi className="notification-template-code">{draft.code}</bdi>
            <p>{draft.description}</p>
            {error && <Notice tone="error">{error}</Notice>}
            {!draft.implemented && (
              <Notice>
                هذا النوع مخطط؛ يمكنك إعداد كرتِه الآن، وسيبقى موقوفًا حتى ربطه
                بحدث النظام.
              </Notice>
            )}
            <div className="form-grid">
              <Select
                label="الأهمية الافتراضية"
                value={draft.importance}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    importance: event.target.value as NotificationImportance,
                  })
                }
              >
                <ImportanceOptions />
              </Select>
              <Select
                label="التكرار الافتراضي"
                disabled={!draft.allowRepeat}
                value={draft.allowRepeat ? draft.repeatInterval : "none"}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    repeatInterval: event.target.value as NotificationRepeat,
                  })
                }
              >
                <RepeatOptions />
              </Select>
              <CheckField
                label="تنبيه مفعّل"
                checked={draft.enabled}
                disabled={!draft.implemented || !draft.canDisable}
                onChange={(enabled) => setDraft({ ...draft, enabled })}
              />
              <CheckField
                label="السماح بتأجيل المتابعة"
                checked={draft.canSnooze}
                onChange={(canSnooze) => setDraft({ ...draft, canSnooze })}
              />
              <CheckField
                label="السماح بالتكرار حتى الإنجاز"
                checked={draft.allowRepeat}
                onChange={(allowRepeat) =>
                  setDraft({
                    ...draft,
                    allowRepeat,
                    repeatInterval: allowRepeat ? draft.repeatInterval : "none",
                  })
                }
              />
            </div>
            <fieldset className="notification-recipients">
              <legend>المستلمون وصلاحية المتابعة</legend>
              <CheckField
                label={companyId ? "المالك والمديرون العامون" : "مالك المنصة"}
                checked={draft.notifyManagers}
                onChange={(notifyManagers) =>
                  setDraft({ ...draft, notifyManagers })
                }
              />
              <CheckField
                label={
                  companyId
                    ? "الموظف المعني بالتنبيه"
                    : "المستخدم المعني بالتنبيه"
                }
                checked={draft.notifySubject}
                disabled={draft.code === "AUTH_PASSWORD_CHANGED"}
                onChange={(notifySubject) =>
                  setDraft({ ...draft, notifySubject })
                }
              />
              {companyId && (
                <>
                  <p className="muted">
                    من يستلم التنبيه يستطيع قراءته وإنجاز متابعته؛ التأجيل
                    والتكرار حسب إعداد الكرت. المدير يستطيع إسناد المتابعة لموظف
                    آخر.
                  </p>
                  <div className="notification-recipient-groups">
                    <div>
                      <h3>الأدوار</h3>
                      {query.data?.roles.length ? (
                        query.data.roles.map((role) => (
                          <CheckField
                            key={role.id}
                            label={role.name}
                            checked={draft.roleIds.includes(role.id)}
                            onChange={(selected) =>
                              selectId("roleIds", role.id, selected)
                            }
                          />
                        ))
                      ) : (
                        <p className="muted">لا توجد أدوار مفعّلة.</p>
                      )}
                    </div>
                    <div>
                      <h3>موظفون محددون</h3>
                      {query.data?.employees.length ? (
                        query.data.employees.map((employee) => (
                          <CheckField
                            key={employee.id}
                            label={employee.name}
                            checked={draft.employeeIds.includes(employee.id)}
                            onChange={(selected) =>
                              selectId("employeeIds", employee.id, selected)
                            }
                          />
                        ))
                      ) : (
                        <p className="muted">لا يوجد موظفون مفعّلون.</p>
                      )}
                    </div>
                  </div>
                </>
              )}
            </fieldset>
            <Notice>
              الافتراضي بدون تكرار. الأهمية والمستلمون الافتراضيون يخصون
              التنبيهات الجديدة، ويتوقف تكرار التنبيه عند إنجازه.
            </Notice>
            <div className="form-actions">
              <Button type="submit" disabled={pending}>
                {pending ? "جارٍ الحفظ…" : "حفظ الكرت"}
              </Button>
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() => setDraft(null)}
              >
                إلغاء
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </div>
  );
}
