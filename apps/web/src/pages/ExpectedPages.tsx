import { useEffect, useId, useRef, useState, type FormEvent } from "react";
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
import { formatMoney } from "../format-money";
import { NumericPadField } from "../NumericPadField";
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
const money = (value: string | null) => <bdi>{formatMoney(value)}</bdi>;
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

function Pager<T>({ list, label }: { list: ReturnType<typeof usePagedQuery<T>>; label: string }) {
  const total = list.error ? 0 : list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / list.pageSize));
  return <div className="table-filters expected-pager">
    <Select label="حجم الصفحة" value={list.pageSize} onChange={event => list.setPageSize(Number(event.target.value))}>
      {[10, 20, 50, 100].map(size => <option key={size} value={size}>{size}</option>)}
    </Select>
    <small>{label}: {total} · صفحة {list.page} من {pages}</small>
    <Button type="button" size="compact" variant="secondary" disabled={list.page <= 1}
      onClick={() => list.setPage(list.page - 1)}>السابق</Button>
    <Button type="button" size="compact" variant="secondary" disabled={list.page >= pages}
      onClick={() => list.setPage(list.page + 1)}>التالي</Button>
  </div>;
}

function CardDetails({ card, companyId, canViewMovements }: { card: ExpectedCard; companyId: number; canViewMovements: boolean }) {
  return <>
    <dl className="expected-card-details">
      <div><dt>الحساب</dt><dd>{card.accountName} <small><bdi>{card.accountCode}</bdi></small></dd></div>
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
        accountId: account?.id, amount, description, section, recurrence, startDate, endDate, expiryMode,
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
      setAccount(null); setAmount(""); setDescription(""); setSection(""); setEndDate(""); setStartDate(nowInAden()); setOnceDate(nowInAden());
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
        <div className="expected-full">
          <ServerLookup<ExpectedAccountOption> companyId={companyId}
            resource={`/companies/${companyId}/expected-accounts`}
            label="الحساب من دليل الحسابات" value={account} onChange={setAccount}
            display={value => `${value.code} — ${value.name}`} singleInput pageSize={50} sort="name:asc"
            required disabled={locked} />
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
  const directory = usePageDirectory(companyId);
  const page = directory.data?.find(entry => entry.key === "company.expected-cards");
  const canCreate = !!page?.enabled && !!page.actionAccess.create;
  const canViewMovements = !!directory.data?.find(entry => entry.key === "company.expected-movements" && entry.enabled)?.actionAccess.view;
  const refresh = useExpectedRefresh(companyId);
  const filters = new URLSearchParams();
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
  const columns: InteractiveTableColumn<ExpectedCard>[] = [
    { key: "id", label: "الكرت", width: 70, cell: row => row.id },
    { key: "accountName", label: "الحساب", width: 230, cell: row => row.accountName },
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
        <Field type="search" label="بحث بالحساب أو البيان" value={list.query} onChange={event => list.setQuery(event.target.value)} />
        <SectionField companyId={companyId} value={params.get("section") ?? ""}
          onChange={value => changeFilter(setParams, "section", value)} filter />
        <Button type="button" size="compact" variant="secondary" onClick={() => void refresh()} disabled={list.loading}>تحديث</Button>
      </div>
      {list.error && <Notice tone="error">{errorMessage(list.error)}</Notice>}
      <InteractiveColumnsTable columns={columns} rows={list.error ? [] : list.data?.items ?? []} rowKey={row => row.id}
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
    <Dialog open={!!cardId} title={`كرت المتوقع${cardId ? ` #${cardId}` : ""}`} onClose={closeCard} className="expected-dialog">
      {detail.isFetching && !detail.data && <Notice>جارٍ تحميل الكرت…</Notice>}
      {detail.error && <Notice tone="error">{errorMessage(detail.error)}</Notice>}
      {detail.data && !detail.error && <CardDetails card={detail.data.card} companyId={companyId} canViewMovements={canViewMovements} />}
    </Dialog>
  </div>;
}

function EditMovement({ movement, companyId, onClose, onSaved, onComplete, busy, completionError }: {
  movement: ExpectedMovement; companyId: number; onClose: () => void;
  onSaved: (movement: ExpectedMovement) => void; onComplete: (movement: ExpectedMovement) => Promise<void>; busy: boolean; completionError: string;
}) {
  const guard = useScopeGuard(`company:${companyId}:expected-movements:${movement.id}:edit`);
  const [date, setDate] = useState(movement.date);
  const [amount, setAmount] = useState(movement.amount);
  const [description, setDescription] = useState(movement.description);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const dirty = date !== movement.date || amount !== movement.amount || description !== movement.description;
  const locked = saving || busy;
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || busy) return;
    const result = expectedMovementPatchSchema.safeParse({ revision: movement.revision, date, amount, description });
    if (!result.success) {
      setError(result.error.issues.map(issue => issue.message).join(" · "));
      return;
    }
    setSaving(true); inFlight.current = true; setError("");
    try {
      const response = await api<{ movement: ExpectedMovement }>(`/companies/${companyId}/expected-movements/${movement.id}`, {
        method: "PATCH", body: result.data, signal: guard.signal,
      });
      if (!guard.isCurrent()) return;
      setDate(response.movement.date); setAmount(response.movement.amount); setDescription(response.movement.description);
      onSaved(response.movement);
    } catch (cause) {
      if (!guard.isCurrent()) return;
      setError(cause instanceof ApiFailure && cause.status === 409
        ? `${errorMessage(cause)} أغلق النافذة وحدّث القائمة ثم افتح الحركة لمراجعة آخر تعديل.`
        : errorMessage(cause));
    } finally {
      inFlight.current = false;
      if (guard.isCurrent()) setSaving(false);
    }
  }
  return <Dialog open title={`تعديل الحركة #${movement.id} — ${movement.accountName}`} onClose={() => { if (!locked) onClose(); }} className="expected-dialog">
    <form onSubmit={save}>
      <div className="expected-form-grid">
        <DateField label="تاريخ الحركة" value={date} onCommit={setDate} required disabled={locked} />
        <NumericPadField label="مبلغ الحركة" value={amount} onChange={setAmount} allowNegative allowDecimal allowEmpty
          maxIntegerDigits={22} maxDecimals={6} disabled={locked} />
        <Field label="بيان الحركة" className="expected-full" value={description} maxLength={2000}
          onChange={event => setDescription(event.target.value)} disabled={locked} />
      </div>
      <details className="expected-help">
        <summary>القيم الأصلية</summary>
        <p>المبلغ: {money(movement.originalAmount)} {movement.currencyCode} · الموعد: <bdi>{dateText(movement.originalDate)}</bdi></p>
        <p>البيان: {movement.originalDescription || "—"}</p>
      </details>
      {(error || completionError) && <Notice tone="error">{error || completionError}</Notice>}
      <div className="form-actions">
        <Button type="submit" size="compact" disabled={!dirty || locked}>{saving ? "جارٍ الحفظ…" : "حفظ التعديل"}</Button>
        <Button type="button" size="compact" disabled={dirty || locked}
          onClick={() => void onComplete(movement)}>إنجاز</Button>
        <Button type="button" size="compact" variant="secondary" disabled={locked} onClick={onClose}>إغلاق</Button>
      </div>
      <small className="expected-note">حفظ التعديل يبقي الحركة «لم يتم». {dirty ? "احفظ التعديل أولًا ليُنجز بالمبلغ الجديد." : "الإنجاز يعتمد المبلغ المحفوظ في هذه الحركة."}</small>
    </form>
  </Dialog>;
}

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
  const [editing, setEditing] = useState<ExpectedMovement | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const inFlight = useRef(false);
  const refresh = useExpectedRefresh(companyId);
  const guard = useScopeGuard(`company:${companyId}:expected-movements`);
  const filters = new URLSearchParams();
  for (const key of ["cardId", "accountId", "status", "dateFrom", "dateTo", "section"]) {
    if (params.get(key)) filters.set(key, params.get(key)!);
  }
  const list = usePagedQuery<ExpectedMovement>(`/companies/${companyId}/expected-movements?${filters}`,
    `company:${companyId}:expected-movements`, "date:asc,id:asc");
  const setFilter = (key: string, value: string) => changeFilter(setParams, key, value);

  async function complete(movement: ExpectedMovement) {
    if (!canEdit || inFlight.current || movement.status !== "pending") return;
    inFlight.current = true; setBusy(movement.id); setError(""); setNotice("");
    try {
      const response = await api<{ movement: ExpectedMovement }>(`/companies/${companyId}/expected-movements/${movement.id}/complete`, {
        method: "POST", body: { revision: movement.revision }, signal: guard.signal,
      });
      if (!guard.isCurrent()) return;
      setEditing(null);
      setNotice(`أُنجزت حركة «${response.movement.accountName}» بمبلغ ${formatMoney(response.movement.completedAmount)}.`);
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
      if (guard.isCurrent()) setBusy(null);
    }
  }
  const columns: InteractiveTableColumn<ExpectedMovement>[] = [
    { key: "date", label: "تاريخ الحركة", width: 130, cell: row => <bdi>{dateText(row.date)}</bdi> },
    { key: "accountName", label: "الحساب", width: 230, cell: row => row.accountName },
    { key: "section", label: "القسم", width: 155, cell: row => row.section || "—" },
    { key: "amount", label: "مبلغ الحركة", width: 120, cell: row => money(row.amount) },
    { key: "description", label: "بيان الحركة", width: 250, cell: row => row.description || "—" },
    { key: "postedByName", label: "رُحّل بواسطة", width: 140, cell: row => row.postedByName },
    { key: "postedAt", label: "وقت الترحيل — اليمن", width: 170, cell: row => <bdi>{dateTime.format(new Date(row.postedAt))}</bdi> },
    { key: "status", label: "الحالة", width: 90, cell: row => <span className={`expected-status expected-status-${row.status}`}>{row.status === "completed" ? "تم" : "لم يتم"}</span> },
    { key: "actions", label: "الإجراءات", width: 190, sortable: false, scrollText: false, cell: row => <div className="expected-row-actions">
      {canEdit && row.status === "pending" && <>
        <Button type="button" size="compact" variant="secondary" disabled={busy !== null} onClick={() => { setError(""); setEditing(row); }}>تعديل</Button>
        <Button type="button" size="compact" disabled={busy !== null} onClick={() => void complete(row)}>{busy === row.id ? "جارٍ الإنجاز…" : "إنجاز"}</Button>
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
    <Card>
      <div className="table-filters">
        <Field type="search" label="بحث بالحساب أو البيان" value={list.query} onChange={event => list.setQuery(event.target.value)} />
        <SectionField source="movements" companyId={companyId} value={params.get("section") ?? ""}
          onChange={value => setFilter("section", value)} filter />
        <Select label="الحالة" value={params.get("status") ?? ""} onChange={event => setFilter("status", event.target.value)}>
          <option value="">الكل</option><option value="pending">لم يتم</option><option value="completed">تم</option>
        </Select>
        <DateField label="من تاريخ الحركة" value={params.get("dateFrom") ?? ""} onCommit={value => setFilter("dateFrom", value)} />
        <DateField label="إلى تاريخ الحركة" value={params.get("dateTo") ?? ""} onCommit={value => setFilter("dateTo", value)} />
        <Button type="button" size="compact" variant="secondary" onClick={() => void refresh()} disabled={list.loading}>تحديث</Button>
      </div>
      {(params.get("cardId") || params.get("accountId")) && <div className="expected-filter-note">
        <span>{params.get("cardId") ? `حركات الكرت #${params.get("cardId")}` : `حركات الحساب #${params.get("accountId")}`}</span>
        <Button type="button" size="compact" variant="ghost" onClick={() => setParams(previous => {
          const next = new URLSearchParams(previous); next.delete("cardId"); next.delete("accountId"); next.delete("page"); return next;
        })}>عرض جميع الحركات</Button>
      </div>}
      {list.error && <Notice tone="error">{errorMessage(list.error)}</Notice>}
      <InteractiveColumnsTable columns={columns} rows={list.error ? [] : list.data?.items ?? []} rowKey={row => row.id}
        visibleColumns={columns.map(column => column.key)} allowColumnVisibility
        storageKey={`alraesy:d13:expected-movements:${companyId}:${user?.id ?? "guest"}`}
        sortKey={sort?.id} sortDirection={sort?.desc ? "desc" : "asc"}
        onSort={key => list.setSorting([{ id: key, desc: sort?.id === key ? !sort.desc : false }])}
        dockRowSource={row => ({ companyId, accountId: row.accountId, accountName: row.accountName })}
        ariaLabel="حركة المتوقع" emptyMessage={list.loading ? "جارٍ تحميل الحركات…" : list.error ? "تعذر عرض الحركات." : "لا توجد حركات مطابقة."} />
      <Pager list={list} label="إجمالي الحركات" />
      <ExpectedHelp />
    </Card>
    {editing && <EditMovement key={editing.id} movement={editing} companyId={companyId} busy={busy !== null} completionError={error}
      onClose={() => setEditing(null)} onComplete={complete} onSaved={movement => {
        setEditing(movement); setNotice("حُفظ تعديل الحركة، وحالتها ما زالت «لم يتم»."); void refresh();
      }} />}
  </div>;
}
