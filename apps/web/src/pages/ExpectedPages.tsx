import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Pencil } from "lucide-react";
import "../doctor-inline-cells.css";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Account, CompanyContext } from "../../../../packages/contracts/src/index";
import {
  expectedCardCreateSchema,
  expectedEndDateLimit,
  expectedMovementPatchSchema,
  type ExpectedCard,
  type ExpectedMovement,
} from "../../../../packages/contracts/src/expected";
import { api, ApiFailure, usePagedQuery, useScopeGuard, useSession } from "../api";
import { usePageDirectory } from "../page-directory";
import { errorMessage, ServerLookup } from "../phase2";
import { formatWholeMoney } from "../format-money";
import { NumericPadField, numericPadDigits } from "../NumericPadField";
import InteractiveColumnsTable, { type InteractiveTableColumn } from "../InteractiveColumnsTable";
import { Button, Card, DateField, Dialog, Field, Notice, PageHeader, Select } from "../ui";
import "./ExpectedPages.css";

const weekdays = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
type ExpectedAccountOption = Pick<Account, "id" | "name" | "code">;
const recurrenceLabels: Record<ExpectedCard["recurrence"], string> = {
  daily: "يومي", weekly: "أسبوعي", monthly: "شهري", once: "مرة واحدة",
};
const expiryLabels: Record<ExpectedCard["expiryMode"], string> = {
  carry: "تراكمي", complete: "يُنجز بانتهاء التاريخ",
};
const dateTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Aden", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const dateText = (value: string) => value.split("-").reverse().join("/");
const nowInAden = () => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Aden", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find(part => part.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
};
const money = (value: string | null) => <bdi>{formatWholeMoney(value)}</bdi>;
const scheduleText = (card: ExpectedCard) => {
  if (card.recurrence === "weekly") return `كل ${weekdays[card.weekday ?? 0]}`;
  if (card.recurrence === "monthly") return `يوم ${card.monthDay} من كل شهر`;
  if (card.recurrence === "once") return card.onceDate ? `مرة واحدة — ${dateText(card.onceDate)}` : "مرة واحدة";
  return "يومي";
};
function changeFilter(setParams: ReturnType<typeof useSearchParams>[1], key: string, value: string) {
  setParams(previous => {
    const next = new URLSearchParams(previous);
    value ? next.set(key, value) : next.delete(key);
    next.delete("page");
    return next;
  });
}

function useExpectedRefresh(companyId: number) {
  const client = useQueryClient();
  const { user } = useSession();
  return () => client.invalidateQueries({
    predicate: ({ queryKey }) => queryKey[1] === user?.id && (
      (queryKey[0] === "list" && String(queryKey[2]).startsWith(`company:${companyId}:expected-`)) ||
      (queryKey[0] === "expected" && queryKey[2] === companyId)
    ),
  });
}

function SectionField({ companyId, value, onChange, disabled = false, filter = false, source = "cards" }: {
  companyId: number; value: string; onChange: (value: string) => void; disabled?: boolean; filter?: boolean; source?: "cards" | "movements";
}) {
  const { user } = useSession();
  const listId = useId();
  const [query, setQuery] = useState(value);
  useEffect(() => {
    const timeout = setTimeout(() => setQuery(value), 180);
    return () => clearTimeout(timeout);
  }, [value]);
  const sections = useQuery({
    queryKey: ["expected", user?.id, companyId, "sections", source, query],
    queryFn: ({ signal }) => api<{ items: string[] }>(
      `/companies/${companyId}/${source === "movements" ? "expected-movements/sections" : "expected-sections"}?${new URLSearchParams({ q: query })}`, { signal },
    ),
    enabled: !!user && !disabled,
    staleTime: 30_000,
  });
  return <div className="expected-section-field">
    <Field label={filter ? "القسم — الكل عند تركه فارغًا" : "القسم"}
      value={value} list={listId} maxLength={120} disabled={disabled}
      placeholder={filter ? "اختر قسمًا أو اكتب اسمه" : "اختر قسمًا سابقًا أو اكتب قسمًا جديدًا"}
      onChange={event => onChange(event.target.value)} />
    <datalist id={listId}>{(sections.data?.items ?? []).map(section => <option key={section} value={section} />)}</datalist>
  </div>;
}

function ExpectedHelp() {
  return <details className="expected-help">
    <summary>طريقة العمل</summary>
    <p>كل موعد حركة مستقلة للمتابعة، ولا يغيّر القيود المحاسبية أو رصيد الحساب. تُنشأ المواعيد كلها عند حفظ الكرت بين تاريخ البداية والنهاية شاملًا، لمدة لا تتجاوز ستة أشهر.</p>
    <p>المبلغ السالب لقبض متوقع، وتبقى إشارته محفوظة عند تعديل الحركة وإنجازها.</p>
    <p>عند منتصف الليل بتوقيت اليمن، ينتقل السطر التراكمي المفتوح إلى اليوم الجديد، أو يُنجز تلقائيًا حسب خيار الكرت. يعتمد ذلك على تاريخ الحركة الحالي، ويستمر التراكمي بعد انتهاء الكرت حتى إنجازه.</p>
  </details>;
}

function Pager<T>({ list, label, disabled = false }: { list: ReturnType<typeof usePagedQuery<T>>; label: string; disabled?: boolean }) {
  const total = list.error ? 0 : list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / list.pageSize));
  return <div className="table-filters expected-pager">
    <Select label="حجم الصفحة" value={list.pageSize} disabled={disabled} onChange={event => list.setPageSize(Number(event.target.value))}>
      {[10, 20, 50, 100].map(size => <option key={size} value={size}>{size}</option>)}
    </Select>
    <small>{label}: {total} · صفحة {list.page} من {pages}</small>
    <Button type="button" size="compact" variant="secondary" disabled={disabled || list.page <= 1}
      onClick={() => list.setPage(list.page - 1)}>السابق</Button>
    <Button type="button" size="compact" variant="secondary" disabled={disabled || list.page >= pages}
      onClick={() => list.setPage(list.page + 1)}>التالي</Button>
  </div>;
}

function CardDetails({ card, companyId, canViewMovements }: { card: ExpectedCard; companyId: number; canViewMovements: boolean }) {
  return <>
    <dl className="expected-card-details">
      <div><dt>الحساب</dt><dd>{card.accountName} <small><bdi>{card.accountCode}</bdi></small></dd></div>
      <div><dt>الصندوق</dt><dd>{card.cashAccountName
        ? <>{card.cashAccountName} <small><bdi>{card.cashAccountCode}</bdi></small></>
        : "غير محدد"}</dd></div>
      <div><dt>القسم</dt><dd>{card.section || "—"}</dd></div>
      <div><dt>المبلغ الأصلي لكل موعد</dt><dd>{money(card.amount)} {card.currencyCode}</dd></div>
      <div className="expected-full"><dt>البيان الأصلي</dt><dd>{card.description || "—"}</dd></div>
      <div><dt>الترحيل والتحديد</dt><dd>{scheduleText(card)}</dd></div>
      <div><dt>ينتهي بعد</dt><dd><bdi>{dateText(card.endDate)}</bdi></dd></div>
      <div><dt>عند انتهاء تاريخ الحركة</dt><dd>{expiryLabels[card.expiryMode]}</dd></div>
      <div><dt>بداية المواعيد</dt><dd><bdi>{dateText(card.startDate)}</bdi></dd></div>
      <div><dt>الحركات</dt><dd>{card.movementCount} · لم يتم: {card.pendingCount} · تم: {card.completedCount}</dd></div>
      <div><dt>المنشئ</dt><dd>{card.createdByName}</dd></div>
      <div><dt>تاريخ الإنشاء — اليمن</dt><dd><bdi>{dateTime.format(new Date(card.createdAt))}</bdi></dd></div>
    </dl>
    {canViewMovements && <Link className="button button-secondary" to={`/companies/${companyId}/expected-movements?cardId=${card.id}`}>
      حركة هذا الكرت
    </Link>}
    <small className="expected-note">هذه القيم هي أصل الكرت، وتبقى ثابتة عند تعديل حركاته أو إنجازها.</small>
  </>;
}

function CreateExpectedCard({ companyId, open, onClose, onCreated }: {
  companyId: number; open: boolean; onClose: () => void; onCreated: (card: ExpectedCard) => void;
}) {
  const guard = useScopeGuard(`company:${companyId}:expected-cards:create`);
  const [account, setAccount] = useState<ExpectedAccountOption | null>(null);
  const [cashAccount, setCashAccount] = useState<ExpectedAccountOption | null>(null);
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [section, setSection] = useState("");
  const [recurrence, setRecurrence] = useState<ExpectedCard["recurrence"]>("daily");
  const [weekday, setWeekday] = useState(0);
  const [monthDay, setMonthDay] = useState(1);
  const [onceDate, setOnceDate] = useState(nowInAden);
  const [startDate, setStartDate] = useState(nowInAden);
  const [endDate, setEndDate] = useState("");
  const [expiryMode, setExpiryMode] = useState<ExpectedCard["expiryMode"]>("carry");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const request = useRef<ReturnType<typeof expectedCardCreateSchema.parse> | null>(null);
  const inFlight = useRef(false);
  const locked = saving || uncertain;
  const endDateLimit = expectedEndDateLimit(startDate);
  const rangeError = endDate && endDate < startDate ? "تاريخ النهاية يسبق تاريخ البداية."
    : endDate && endDate > endDateLimit ? `آخر تاريخ مسموح هو ${dateText(endDateLimit)}؛ المدة لا تتجاوز ستة أشهر من البداية.`
      : "";

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    setError("");
    if (!request.current) {
      const result = expectedCardCreateSchema.safeParse({
        accountId: account?.id, cashAccountId: cashAccount?.id ?? null,
        amount, description, section, recurrence, startDate, endDate, expiryMode,
        ...(recurrence === "weekly" ? { weekday } : {}),
        ...(recurrence === "monthly" ? { monthDay } : {}),
        ...(recurrence === "once" ? { onceDate } : {}),
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.success) {
        setError(result.error.issues.map(issue => issue.message).join(" · "));
        return;
      }
      request.current = result.data;
    }
    inFlight.current = true;
    setSaving(true);
    try {
      const result = await api<{ card: ExpectedCard }>(`/companies/${companyId}/expected-cards`, {
        method: "POST", body: request.current, signal: guard.signal,
      });
      if (!guard.isCurrent()) return;
      setUncertain(false);
      request.current = null;
      onCreated(result.card);
      setAccount(null); setCashAccount(null); setAmount(""); setDescription(""); setSection(""); setEndDate(""); setStartDate(nowInAden()); setOnceDate(nowInAden());
    } catch (cause) {
      if (!guard.isCurrent()) return;
      setError(errorMessage(cause));
      // A lost response must retry the same frozen payload and UUID, never create another card.
      if (cause instanceof ApiFailure && cause.status >= 400 && cause.status < 500 && cause.status !== 408) {
        request.current = null;
        setUncertain(false);
      } else setUncertain(true);
    } finally {
      inFlight.current = false;
      if (guard.isCurrent()) setSaving(false);
    }
  }
  return <Dialog open={open} onClose={() => { if (!saving) onClose(); }} title="كرت المتوقع — جديد" className="expected-dialog">
    <form onSubmit={save}>
      <div className="expected-form-grid">
        <div>
          <ServerLookup<ExpectedAccountOption> companyId={companyId}
            resource={`/companies/${companyId}/expected-accounts`}
            label="الحساب من دليل الحسابات" value={account} onChange={setAccount}
            display={value => `${value.code} — ${value.name}`} singleInput pageSize={50} sort="name:asc"
            required disabled={locked} />
        </div>
        <div>
          <ServerLookup<ExpectedAccountOption> companyId={companyId}
            resource={`/companies/${companyId}/expected-cashboxes`}
            label="الصندوق — اختياري" value={cashAccount} onChange={setCashAccount}
            display={value => `${value.code} — ${value.name}`} singleInput pageSize={50} sort="name:asc"
            searchPlaceholder="ابحث باسم الصندوق أو رقمه" noResultsLabel="لا توجد صناديق مطابقة."
            disabled={locked} />
          {cashAccount && <Button type="button" size="compact" variant="ghost" disabled={locked}
            onClick={() => setCashAccount(null)}>بدون صندوق</Button>}
        </div>
        <SectionField companyId={companyId} value={section} onChange={setSection} disabled={locked} />
        <NumericPadField label="المبلغ الأصلي لكل موعد" value={amount} onChange={setAmount}
          maxIntegerDigits={22} maxDecimals={6} allowNegative allowDecimal allowEmpty disabled={locked} />
        <Field className="expected-full" label="البيان الأصلي" value={description} maxLength={2000}
          onChange={event => setDescription(event.target.value)} disabled={locked} />
        <Select label="الترحيل" value={recurrence} disabled={locked}
          onChange={event => setRecurrence(event.target.value as ExpectedCard["recurrence"])}>
          {Object.entries(recurrenceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </Select>
        {recurrence === "weekly" && <Select label="يوم الأسبوع" value={weekday} disabled={locked}
          onChange={event => setWeekday(Number(event.target.value))}>
          {weekdays.map((day, index) => <option key={index} value={index}>{day}</option>)}
        </Select>}
        {recurrence === "monthly" && <Select label="رقم اليوم من الشهر" value={monthDay} disabled={locked}
          onChange={event => setMonthDay(Number(event.target.value))}>
          {Array.from({ length: 31 }, (_, index) => index + 1).map(day => <option key={day} value={day}>{day}</option>)}
        </Select>}
        {recurrence === "once" && <DateField label="الموعد المحدد" value={onceDate} onCommit={setOnceDate}
          min={startDate} max={endDate || endDateLimit} required disabled={locked} />}
        <DateField label="يبدأ من" value={startDate} onCommit={setStartDate} required disabled={locked} />
        <DateField label="ينتهي بعد — شاملًا هذا اليوم" value={endDate} onCommit={setEndDate}
          min={startDate} max={endDateLimit} required disabled={locked} />
        <Select label="عند انتهاء تاريخ الحركة" value={expiryMode} disabled={locked}
          onChange={event => setExpiryMode(event.target.value as ExpectedCard["expiryMode"])}>
          {Object.entries(expiryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </Select>
      </div>
      <small className="expected-note">تُنشأ المواعيد من البداية حتى النهاية عند الحفظ. آخر تاريخ مسموح: <bdi>{dateText(endDateLimit)}</bdi>، خلال ستة أشهر من البداية.</small>
      <small className="expected-note">المبلغ السالب لقبض متوقع.</small>
      {recurrence === "monthly" && monthDay > 28 && <small className="expected-note">
        الشهر الذي لا يحتوي اليوم {monthDay} لا تُنشأ فيه حركة.
      </small>}
      {error && <Notice tone="error">{error}</Notice>}
      {rangeError && <Notice tone="error">{rangeError}</Notice>}
      {uncertain && <Notice tone="warning">لم يتأكد رد الحفظ. أعد المحاولة بنفس البيانات للتحقق من الكرت ومنع تكراره.</Notice>}
      <div className="form-actions">
        <Button type="submit" size="compact" disabled={saving || !!rangeError}>{saving ? "جارٍ الحفظ…" : uncertain ? "إعادة محاولة الحفظ" : "حفظ وإنشاء الحركات"}</Button>
        <Button type="button" size="compact" variant="secondary" disabled={saving} onClick={onClose}>إغلاق</Button>
      </div>
    </form>
  </Dialog>;
}

export function ExpectedCardsPage({ context }: { context: CompanyContext }) {
  const { user } = useSession();
  return <ExpectedCardsContent key={`${user?.id}:${context.company.id}`} context={context} />;
}

function ExpectedCardsContent({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  const [createOpen, setCreateOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [lifecyclePrompt, setLifecyclePrompt] = useState<{id: number; revision: number; action: "archive" | "restore"} | null>(null);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const lifecycleLock = useRef(false);
  const [lifecycleError, setLifecycleError] = useState("");
  const guard = useScopeGuard(`company:${companyId}:expected-cards:lifecycle`);
  const directory = usePageDirectory(companyId);
  const page = directory.data?.find(entry => entry.key === "company.expected-cards");
  const canArchive = !!page?.enabled && !!page.actionAccess.edit;
  const canCreate = !!page?.enabled && !!page.actionAccess.create;
  const canViewMovements = !!directory.data?.find(entry => entry.key === "company.expected-movements" && entry.enabled)?.actionAccess.view;
  const refresh = useExpectedRefresh(companyId);
  const filters = new URLSearchParams();
  const archived = params.get("visibility") === "archived";
  if (archived) filters.set("visibility", "archived");
  if (params.get("section")) filters.set("section", params.get("section")!);
  const list = usePagedQuery<ExpectedCard>(`/companies/${companyId}/expected-cards?${filters}`,
    `company:${companyId}:expected-cards`, "createdAt:desc,id:desc");
  const cardId = Number(params.get("cardId")) || null;
  const detail = useQuery({
    queryKey: ["expected", user?.id, companyId, "card", cardId],
    queryFn: ({ signal }) => api<{ card: ExpectedCard }>(`/companies/${companyId}/expected-cards/${cardId}`, { signal }),
    enabled: !!user && !!cardId,
  });
  const closeCard = () => changeFilter(setParams, "cardId", "");
  const openCard = (id: number) => changeFilter(setParams, "cardId", String(id));
  async function submitLifecycle() {
    if (!canArchive || !lifecyclePrompt || lifecycleLock.current) return;
    const {id, revision, action} = lifecyclePrompt;
    lifecycleLock.current = true;
    setLifecycleBusy(true);
    setLifecycleError("");
    try {
      const {card} = await api<{card: ExpectedCard}>(`/companies/${companyId}/expected-cards/${id}/lifecycle`, {
        method: "PATCH", body: {revision, action}, signal: guard.signal,
      });
      if (!guard.isCurrent()) return;
      setLifecyclePrompt(null);
      setNotice(action === "archive" ? `أُرشف الكرت و${card.archivedMovementCount} توقعًا.` : "استُعيد الكرت وتوقعاته المؤرشفة.");
      void refresh();
    } catch (error) {
      if (guard.isCurrent()) { setLifecycleError(errorMessage(error)); void refresh(); }
    } finally {
      lifecycleLock.current = false;
      if (guard.isCurrent()) setLifecycleBusy(false);
    }
  }
  const columns: InteractiveTableColumn<ExpectedCard>[] = [
    { key: "id", label: "الكرت", width: 70, cell: row => row.id },
    { key: "accountName", label: "الحساب", width: 230, cell: row => row.accountName },
    { key: "cashAccountName", label: "الصندوق", width: 190, cell: row => row.cashAccountName || "غير محدد" },
    { key: "section", label: "القسم", width: 155, cell: row => row.section || "—" },
    { key: "amount", label: "المبلغ الأصلي", width: 120, cell: row => money(row.amount) },
    { key: "description", label: "البيان الأصلي", width: 240, cell: row => row.description || "—" },
    { key: "recurrence", label: "الترحيل والتحديد", width: 170, cell: scheduleText },
    { key: "startDate", label: "يبدأ من", width: 125, cell: row => <bdi>{dateText(row.startDate)}</bdi> },
    { key: "endDate", label: "ينتهي بعد", width: 125, cell: row => <bdi>{dateText(row.endDate)}</bdi> },
    { key: "expiryMode", label: "عند انتهاء تاريخ الحركة", width: 170, cell: row => expiryLabels[row.expiryMode] },
    { key: "pendingCount", label: "لم يتم", width: 80, cell: row => row.pendingCount },
    { key: "completedCount", label: "تم", width: 70, cell: row => row.completedCount },
    { key: "movementCount", label: "الحركات", width: 80, cell: row => row.movementCount },
    { key: "accountCode", label: "كود الحساب", width: 120, cell: row => <bdi>{row.accountCode}</bdi> },
    { key: "currencyCode", label: "العملة", width: 80, cell: row => <bdi>{row.currencyCode || "—"}</bdi> },
    { key: "createdByName", label: "المنشئ", width: 150, cell: row => row.createdByName },
    { key: "createdAt", label: "أُنشئ — اليمن", width: 170, cell: row => <bdi>{dateTime.format(new Date(row.createdAt))}</bdi> },
    { key: "actions", label: "الإجراءات", width: 170, sortable: false, scrollText: false, cell: row => <div className="expected-row-actions">
      <Button type="button" size="compact" variant="secondary" onClick={() => openCard(row.id)}>الكرت</Button>
      {canViewMovements && <Link to={`/companies/${companyId}/expected-movements?cardId=${row.id}`}>الحركة</Link>}
    </div> },
  ];
  const sort = list.sorting[0];
  return <div className="expected-page">
    <PageHeader title="كروت المتوقع" description="تسجيل المواعيد والمبالغ الأصلية للمتابعة."
      actions={<>
        {canCreate && <Button type="button" size="compact" onClick={() => setCreateOpen(true)}>كرت جديد</Button>}
        {canViewMovements && <Link to={`/companies/${companyId}/expected-movements`}>حركة المتوقع</Link>}
      </>} />
    {notice && <Notice tone="success">{notice}</Notice>}
    <Card>
      <div className="table-filters">
        <label>حالة الكرت <select value={archived ? "archived" : "active"}
          onChange={event => changeFilter(setParams, "visibility", event.target.value === "archived" ? "archived" : "")}>
          <option value="active">النشطة</option><option value="archived">المؤرشفة</option>
        </select></label>
        <Field type="search" label="بحث بالحساب أو البيان" value={list.query} onChange={event => list.setQuery(event.target.value)} />
        <SectionField companyId={companyId} value={params.get("section") ?? ""}
          onChange={value => changeFilter(setParams, "section", value)} filter />
        <Button type="button" size="compact" variant="secondary" onClick={() => void refresh()} disabled={list.loading}>تحديث</Button>
      </div>
      {list.error && <Notice tone="error">{errorMessage(list.error)}</Notice>}
      <InteractiveColumnsTable columns={columns.map(column => ({ ...column, sortable: column.sortable !== false }))} rows={list.error ? [] : list.data?.items ?? []} rowKey={row => row.id}
        visibleColumns={columns.map(column => column.key)} allowColumnVisibility
        storageKey={`alraesy:d13:expected-cards:${companyId}:${user?.id ?? "guest"}`}
        sortKey={sort?.id} sortDirection={sort?.desc ? "desc" : "asc"}
        onSort={key => list.setSorting([{ id: key, desc: sort?.id === key ? !sort.desc : false }])}
        dockRowSource={row => ({ companyId, accountId: row.accountId, accountName: row.accountName })}
        ariaLabel="كروت المتوقع" emptyMessage={list.loading ? "جارٍ تحميل الكروت…" : list.error ? "تعذر عرض الكروت." : "لا توجد كروت مطابقة."} />
      <Pager list={list} label="إجمالي الكروت" />
      <ExpectedHelp />
    </Card>
    <CreateExpectedCard companyId={companyId} open={createOpen} onClose={() => setCreateOpen(false)} onCreated={card => {
      setCreateOpen(false);
      setNotice(`حُفظ كرت الحساب «${card.accountName}» وأنشئت ${card.movementCount} حركة.`);
      void refresh();
      openCard(card.id);
    }} />
    <Dialog open={!!cardId} title={`كرت المتوقع${cardId ? ` #${cardId}` : ""}`} onClose={() => { if (!lifecycleBusy) { setLifecyclePrompt(null); setLifecycleError(""); closeCard(); } }} className="expected-dialog">
      {detail.isFetching && !detail.data && <Notice>جارٍ تحميل الكرت…</Notice>}
      {detail.error && <Notice tone="error">{errorMessage(detail.error)}</Notice>}
      {detail.data && !detail.error && <>
        <CardDetails card={detail.data.card} companyId={companyId} canViewMovements={canViewMovements} />
        {detail.data.card.archivedAt && <Notice>
          مؤرشف منذ {dateTime.format(new Date(detail.data.card.archivedAt))} · توقعات مؤرشفة: {detail.data.card.archivedMovementCount} · حُذف بعد المهلة: {detail.data.card.purgedMovementCount}
        </Notice>}
        {lifecyclePrompt?.id === cardId ? <>
          <Notice>{lifecyclePrompt.action === "archive"
            ? "سيؤرشف الكرت والتوقعات غير المنجزة بعد اليوم بتوقيت عدن. حركات اليوم والأقدم تبقى، ويمكن إنجازها يدويًا. تُحذف التوقعات المؤرشفة بعد 30 يومًا."
            : "سيعود الكرت وتوقعاته المؤرشفة إلى القوائم النشطة."}</Notice>
          {lifecycleError && <Notice tone="error">{lifecycleError}</Notice>}
          <div className="expected-row-actions">
            <Button type="button" size="compact" disabled={lifecycleBusy || !canArchive} onClick={() => void submitLifecycle()}>
              {lifecyclePrompt.action === "archive" ? "تأكيد الأرشفة" : "تأكيد الاستعادة"}
            </Button>
            <Button type="button" size="compact" variant="secondary" disabled={lifecycleBusy} onClick={() => { setLifecyclePrompt(null); setLifecycleError(""); }}>رجوع</Button>
          </div>
        </> : canArchive && !detail.data.card.purgedMovementCount && <Button type="button" size="compact" variant="secondary" onClick={() => {
          const card = detail.data!.card;
          setLifecyclePrompt({id: card.id, revision: card.lifecycleRevision, action: card.archivedAt ? "restore" : "archive"});
        }}>{detail.data.card.archivedAt ? "استعادة الكرت" : "إلغاء وأرشفة الكرت"}</Button>}
      </>}
    </Dialog>
  </div>;
}

type ExpectedInlineField = "date" | "amount" | "description";
type ExpectedInlineEdit = {
  movement: ExpectedMovement;
  field: ExpectedInlineField;
  initialText: string;
  draft: string;
  touched: boolean;
  scope: string;
};
const inlineLabels: Record<ExpectedInlineField, string> = {
  date: "تاريخ الحركة", amount: "مبلغ الحركة", description: "بيان الحركة",
};
const inlineInitialText = (movement: ExpectedMovement, field: ExpectedInlineField) =>
  field === "amount" ? formatWholeMoney(movement.amount).replace(/,/g, "") : movement[field];

export function ExpectedMovementsPage({ context }: { context: CompanyContext }) {
  const { user } = useSession();
  return <ExpectedMovementsContent key={`${user?.id}:${context.company.id}`} context={context} />;
}

function ExpectedMovementsContent({ context }: { context: CompanyContext }) {
  const companyId = context.company.id;
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  const directory = usePageDirectory(companyId);
  const page = directory.data?.find(entry => entry.key === "company.expected-movements");
  const canEdit = !!page?.enabled && !!page.actionAccess.edit;
  const canViewCards = !!directory.data?.find(entry => entry.key === "company.expected-cards" && entry.enabled)?.actionAccess.view;
  const [editing, setEditing] = useState<ExpectedInlineEdit | null>(null);
  const editingRef = useRef<ExpectedInlineEdit | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [busyKind, setBusyKind] = useState<"save" | "complete" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const inFlight = useRef(false);
  const refresh = useExpectedRefresh(companyId);
  const guard = useScopeGuard(`company:${companyId}:expected-movements`);
  const editScope = params.toString();
  const editGuard = useScopeGuard(`company:${companyId}:expected-movements:edit:${editScope}`);
  const currentEditScope = useRef(editScope);
  currentEditScope.current = editScope;
  useEffect(() => {
    editingRef.current = null;
    setEditing(null);
  }, [editScope]);
  const filters = new URLSearchParams();
  for (const key of ["cardId", "accountId", "status", "dateFrom", "dateTo", "section"]) {
    if (params.get(key)) filters.set(key, params.get(key)!);
  }
  const list = usePagedQuery<ExpectedMovement>(`/companies/${companyId}/expected-movements?${filters}`,
    `company:${companyId}:expected-movements`, "date:asc,id:asc");
  const setFilter = (key: string, value: string) => changeFilter(setParams, key, value);
  useEffect(() => {
    const edit = editingRef.current;
    if (!edit || inFlight.current || list.loading || list.error || !list.data) return;
    const current = list.data.items.find(movement => movement.id === edit.movement.id);
    if (!current || current.status !== "pending" || current.revision !== edit.movement.revision) {
      editingRef.current = null;
      setEditing(null);
      setError(!current ? "لم تعد الحركة ضمن النتائج الحالية؛ أُغلق حقل التعديل بعد تحديث القائمة."
        : current.status !== "pending" ? "أصبحت الحركة منجزة؛ أُغلق حقل التعديل بعد تحديث القائمة."
          : "تغيّرت الحركة أثناء التعديل؛ أُغلق المحرر لعرض آخر قيمة محفوظة. راجعها قبل تعديلها مجددًا.");
    }
    // A fresh revision closes the old draft; never transplant it into a write.
  }, [list.data, list.loading, list.error, busy]);

  async function complete(movement: ExpectedMovement) {
    if (!canEdit || inFlight.current || editingRef.current || movement.status !== "pending") return;
    inFlight.current = true; setBusy(movement.id); setBusyKind("complete"); setError(""); setNotice("");
    try {
      const response = await api<{ movement: ExpectedMovement }>(`/companies/${companyId}/expected-movements/${movement.id}/complete`, {
        method: "POST", body: { revision: movement.revision }, signal: guard.signal,
      });
      if (!guard.isCurrent()) return;
      setEditing(null);
      setNotice(`أُنجزت حركة «${response.movement.accountName}» بمبلغ ${formatWholeMoney(response.movement.completedAmount)}.`);
      void refresh();
    } catch (cause) {
      if (!guard.isCurrent()) return;
      setError(cause instanceof ApiFailure && cause.status === 409
        ? `${errorMessage(cause)} حدّث الحركة وراجع مبلغها قبل إنجازها.`
        : errorMessage(cause));
      // Show the server's latest state on reopening; never replace an unsaved editor silently.
      void list.refetch();
    } finally {
      inFlight.current = false;
      if (guard.isCurrent()) { setBusy(null); setBusyKind(null); }
    }
  }
  function cancelInline() {
    // Clear the synchronous ref before unmount/blur can attempt a save.
    editingRef.current = null;
    setEditing(null);
  }
  function openInline(movement: ExpectedMovement, field: ExpectedInlineField) {
    if (!canEdit || inFlight.current || editingRef.current || movement.cardArchived || movement.status !== "pending") return;
    const initialText = inlineInitialText(movement, field);
    const edit = { movement: { ...movement }, field, initialText, draft: initialText, touched: false, scope: editScope };
    editingRef.current = edit;
    setEditing(edit);
    setError(""); setNotice("");
  }
  async function saveInline(input: HTMLInputElement) {
    const edit = editingRef.current;
    if (!edit || inFlight.current || edit.scope !== currentEditScope.current || !canEdit) return;
    const draft = edit.field === "amount" ? numericPadDigits(input.value).trim() : input.value;
    // Opening a rounded amount, then leaving it untouched (or restoring its
    // displayed value), must never round the exact amount stored on the server.
    if (!edit.touched || draft === edit.initialText) { cancelInline(); return; }
    if (!input.reportValidity()) return;
    if (edit.field === "amount" && !/^-?\d{1,22}$/.test(draft)) {
      setError("المبلغ عدد صحيح موجب أو سالب، دون كسور."); return;
    }
    const source = edit.movement;
    const parsed = expectedMovementPatchSchema.safeParse({
      revision: source.revision,
      date: edit.field === "date" ? draft : source.date,
      amount: edit.field === "amount" ? draft : source.amount,
      description: edit.field === "description" ? draft : source.description,
    });
    if (!parsed.success) { setError(parsed.error.issues.map(issue => issue.message).join(" · ")); return; }
    // Shared with completion: the ref changes before any await or re-render,
    // so blur + Enter + a completion click cannot send overlapping mutations.
    inFlight.current = true; setBusy(source.id); setBusyKind("save"); setError(""); setNotice("");
    try {
      await api<{ movement: ExpectedMovement }>(`/companies/${companyId}/expected-movements/${source.id}`, {
        method: "PATCH", body: parsed.data, signal: editGuard.signal,
      });
      if (!editGuard.isCurrent()) return;
      if (editingRef.current === edit) cancelInline();
      setNotice(`حُفظ ${inlineLabels[edit.field]}، وحالة الحركة ما زالت «لم يتم».`);
    } catch (cause) {
      if (!editGuard.isCurrent()) return;
      if (cause instanceof ApiFailure && cause.status === 409) {
        cancelInline();
        setError(`لم يُحفظ التعديل: ${errorMessage(cause)} أُعيد تحميل الحركة؛ راجع قيمتها الحالية قبل تعديلها مجددًا.`);
      } else if (cause instanceof ApiFailure && cause.status >= 400 && cause.status < 500 && cause.status !== 408) {
        setError(`لم يُحفظ ${inlineLabels[edit.field]}: ${errorMessage(cause)}`);
      } else setError(`تعذّر تأكيد حفظ ${inlineLabels[edit.field]}: ${errorMessage(cause)} تُعاد قراءة القائمة للتحقق.`);
    } finally {
      try {
        // Keep editing/completion locked until the refreshed row carries the
        // newly saved revision. Also reconcile lost responses and view changes.
        if (guard.isCurrent()) await refresh();
      } catch {
        // The list query exposes refresh errors; don't reissue the mutation.
      } finally {
        inFlight.current = false;
        if (guard.isCurrent()) { setBusy(null); setBusyKind(null); }
      }
    }
  }
  function inlineCell(movement: ExpectedMovement, field: ExpectedInlineField) {
    const shown = field === "amount" ? money(movement.amount)
      : field === "date" ? <bdi>{dateText(movement.date)}</bdi> : movement.description || "—";
    if (!canEdit || movement.cardArchived || movement.status !== "pending") return shown;
    const current = editing?.movement.id === movement.id && editing.field === field && editing.scope === editScope ? editing : null;
    if (!current) return <button type="button" className="doctor-inline-trigger expected-inline-trigger"
      title={`تعديل ${inlineLabels[field]} مباشرة`} aria-label={`تعديل ${inlineLabels[field]} — ${movement.accountName} — الحركة ${movement.id}`}
      disabled={busy !== null} onClick={() => openInline(movement, field)}>
      <span className="doctor-inline-value">{shown}</span><Pencil size={13} aria-hidden="true" className="doctor-inline-pencil" />
    </button>;
    return <input key={`${movement.id}:${field}:${editScope}`} autoFocus
      className="doctor-inline-editor expected-inline-editor" aria-label={`${inlineLabels[field]} — الحركة ${movement.id}`}
      type={field === "date" ? "date" : "text"} defaultValue={current.draft}
      dir={field === "description" ? "rtl" : "ltr"} disabled={busy !== null}
      required={field !== "description"} min={field === "date" ? "0001-01-01" : undefined}
      max={field === "date" ? "9999-12-31" : undefined} maxLength={field === "description" ? 2000 : field === "amount" ? 23 : undefined}
      pattern={field === "amount" ? "-?[0-9]{1,22}" : undefined}
      onFocus={event => { if (field !== "date") event.currentTarget.select(); }}
      onChange={event => {
        const edit = editingRef.current;
        if (!edit || edit !== current) return;
        const value = field === "amount" ? numericPadDigits(event.currentTarget.value) : event.currentTarget.value;
        if (field === "amount" && !/^-?\d{0,22}$/.test(value)) { event.currentTarget.value = edit.draft; return; }
        if (field === "amount") event.currentTarget.value = value;
        edit.draft = value;
        edit.touched = true;
      }}
      onBlur={event => { void saveInline(event.currentTarget); }}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); if (!inFlight.current) cancelInline(); }
        else if (event.key === "Enter") { event.preventDefault(); void saveInline(event.currentTarget); }
      }} />;
  }
  const columns: InteractiveTableColumn<ExpectedMovement>[] = [
    { key: "date", label: "تاريخ الحركة", width: 145, scrollText: false, cell: row => inlineCell(row, "date") },
    { key: "accountName", label: "الحساب", width: 230, cell: row => row.accountName },
    { key: "section", label: "القسم", width: 155, cell: row => row.section || "—" },
    { key: "amount", label: "مبلغ الحركة", width: 120, scrollText: false, cell: row => inlineCell(row, "amount") },
    { key: "description", label: "بيان الحركة", width: 250, scrollText: false, cell: row => inlineCell(row, "description") },
    { key: "postedByName", label: "رُحّل بواسطة", width: 140, cell: row => row.postedByName },
    { key: "postedAt", label: "وقت الترحيل — اليمن", width: 170, cell: row => <bdi>{dateTime.format(new Date(row.postedAt))}</bdi> },
    { key: "status", label: "الحالة", width: 90, cell: row => <span className={`expected-status expected-status-${row.status}`}>{row.status === "completed" ? "تم" : "لم يتم"}</span> },
    { key: "actions", label: "الإجراءات", width: 190, sortable: false, scrollText: false, cell: row => <div className="expected-row-actions">
      {canEdit && row.status === "pending" && <>
        <Button type="button" size="compact" disabled={busy !== null || editing !== null} onClick={() => void complete(row)}>{busy === row.id ? busyKind === "save" ? "جارٍ الحفظ…" : "جارٍ الإنجاز…" : "إنجاز"}</Button>
      </>}
      {canViewCards && <Link to={`/companies/${companyId}/expected-cards?cardId=${row.cardId}`}>الكرت</Link>}
    </div> },
    { key: "completedAmount", label: "المبلغ المنجز", width: 125, cell: row => money(row.completedAmount) },
    { key: "completedAt", label: "وقت الإنجاز — اليمن", width: 170, cell: row => row.completedAt ? <bdi>{dateTime.format(new Date(row.completedAt))}</bdi> : "—" },
    { key: "completedByName", label: "أُنجز بواسطة", width: 140, cell: row => row.completedByName || "—" },
    { key: "completionSource", label: "طريقة الإنجاز", width: 115, cell: row => row.completionSource === "automatic" ? "تلقائي" : row.completionSource === "manual" ? "يدوي" : "—" },
    { key: "originalDate", label: "الموعد الأصلي", width: 130, cell: row => <bdi>{dateText(row.originalDate)}</bdi> },
    { key: "originalAmount", label: "المبلغ الأصلي", width: 125, cell: row => money(row.originalAmount) },
    { key: "originalDescription", label: "البيان الأصلي", width: 240, cell: row => row.originalDescription || "—" },
    { key: "expiryMode", label: "عند انتهاء التاريخ", width: 175, cell: row => expiryLabels[row.expiryMode] },
    { key: "cardId", label: "رقم الكرت", width: 85, cell: row => row.cardId },
    { key: "accountCode", label: "كود الحساب", width: 120, cell: row => <bdi>{row.accountCode}</bdi> },
    { key: "currencyCode", label: "العملة", width: 80, cell: row => <bdi>{row.currencyCode || "—"}</bdi> },
    { key: "id", label: "رقم الحركة", width: 90, cell: row => row.id },
  ];
  const sort = list.sorting[0];
  return <div className="expected-page">
    <PageHeader title="حركة المتوقع" description="كل موعد في سطر مستقل، ويظهر مع المواعيد المستقبلية."
      actions={canViewCards && <Link to={`/companies/${companyId}/expected-cards`}>كروت المتوقع</Link>} />
    {notice && <Notice tone="success">{notice}</Notice>}
    {error && <Notice tone="error">{error}</Notice>}
    {canEdit && <small className="expected-note">انقر مبلغ الحركة أو تاريخها أو بيانها للتعديل في السطر. يُحفظ عند الخروج من الحقل أو Enter، ويُلغي Escape التعديل.</small>}
    <Card>
      <div className="table-filters">
        <Field type="search" label="بحث بالحساب أو البيان" value={list.query} disabled={busy !== null} onChange={event => list.setQuery(event.target.value)} />
        <SectionField source="movements" companyId={companyId} value={params.get("section") ?? ""}
          onChange={value => setFilter("section", value)} disabled={busy !== null} filter />
        <Select label="الحالة" value={params.get("status") ?? ""} disabled={busy !== null} onChange={event => setFilter("status", event.target.value)}>
          <option value="">الكل</option><option value="pending">لم يتم</option><option value="completed">تم</option>
        </Select>
        <DateField label="من تاريخ الحركة" value={params.get("dateFrom") ?? ""} disabled={busy !== null} onCommit={value => setFilter("dateFrom", value)} />
        <DateField label="إلى تاريخ الحركة" value={params.get("dateTo") ?? ""} disabled={busy !== null} onCommit={value => setFilter("dateTo", value)} />
        <Button type="button" size="compact" variant="secondary" onClick={() => void refresh()} disabled={list.loading || busy !== null}>تحديث</Button>
      </div>
      {(params.get("cardId") || params.get("accountId")) && <div className="expected-filter-note">
        <span>{params.get("cardId") ? `حركات الكرت #${params.get("cardId")}` : `حركات الحساب #${params.get("accountId")}`}</span>
        <Button type="button" size="compact" variant="ghost" disabled={busy !== null} onClick={() => setParams(previous => {
          const next = new URLSearchParams(previous); next.delete("cardId"); next.delete("accountId"); next.delete("page"); return next;
        })}>عرض جميع الحركات</Button>
      </div>}
      {list.error && <Notice tone="error">{errorMessage(list.error)}</Notice>}
      <InteractiveColumnsTable columns={columns.map(column => ({ ...column, sortable: column.sortable !== false }))} rows={list.error ? [] : list.data?.items ?? []} rowKey={row => row.id}
        visibleColumns={columns.map(column => column.key)} allowColumnVisibility
        storageKey={`alraesy:d13:expected-movements:${companyId}:${user?.id ?? "guest"}`}
        sortKey={sort?.id} sortDirection={sort?.desc ? "desc" : "asc"}
        onSort={key => {
          if (editingRef.current || inFlight.current) { setError("احفظ تعديل الحقل بـ Enter أو ألغِه بـ Escape قبل تغيير الفرز."); return; }
          list.setSorting([{ id: key, desc: sort?.id === key ? !sort.desc : false }]);
        }}
        dockRowSource={row => ({ companyId, accountId: row.accountId, accountName: row.accountName })}
        ariaLabel="حركة المتوقع" emptyMessage={list.loading ? "جارٍ تحميل الحركات…" : list.error ? "تعذر عرض الحركات." : "لا توجد حركات مطابقة."} />
      <Pager list={list} label="إجمالي الحركات" disabled={editing !== null || busy !== null} />
      <ExpectedHelp />
    </Card>
  </div>;
}
