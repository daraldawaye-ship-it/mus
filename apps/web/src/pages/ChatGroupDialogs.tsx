import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Crown, LoaderCircle, Plus, Users, X } from "lucide-react";
import type { User } from "../../../../packages/contracts/src/index";
import type { ChatPage, ChatScope, ChatUser } from "../../../../packages/contracts/src/chat";
import type { ChatGroup, ChatGroupDetail, ChatGroupUpdateInput } from "../../../../packages/contracts/src/chat-groups";
import { api, ApiFailure, useScopeGuard } from "../api";
import { Button, Dialog, Field, Notice, Select } from "../ui";
import { ChatAvatar } from "./ChatAvatar";

interface GroupContext {
  user: User;
  scope: ChatScope;
  companyId?: number;
}
interface CreateProps extends GroupContext {
  open: boolean;
  onClose: () => void;
  onCreated: (group: ChatGroup) => void;
}
interface DetailsProps extends GroupContext {
  open: boolean;
  onClose: () => void;
  onLeft: () => void;
  onChanged?: (group: ChatGroup) => void;
  groupId: number;
}
interface FrozenCreation {
  clientGroupId: string;
  name: string;
  memberIds: number[];
}
interface CreationDraft {
  name: string;
  members: ChatUser[];
  frozen: FrozenCreation | null;
  rejected: boolean;
  uncertain: boolean;
}
const emptyDraft = (): CreationDraft => ({ name: "", members: [], frozen: null, rejected: false, uncertain: false });
const validId = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2_147_483_647;
const validName = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 120 && !value.includes("\u0000");
const errorText = (error: unknown) => error instanceof Error ? error.message : "تعذر الاتصال. حاول مرة أخرى.";
const accessDenied = (error: unknown) => error instanceof ApiFailure && [401, 403, 404].includes(error.status);

function contextBody(scope: ChatScope, companyId?: number) {
  return { scope, ...(scope === "company" ? { companyId } : {}) };
}
function scopeQuery(scope: ChatScope, companyId?: number, values: Record<string, string | null> = {}) {
  const params = new URLSearchParams({ scope });
  if (scope === "company" && companyId) params.set("companyId", String(companyId));
  Object.entries(values).forEach(([key, value]) => { if (value) params.set(key, value); });
  return params.toString();
}
function readCreationDraft(key: string, userId: number): CreationDraft {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!parsed || typeof parsed !== "object") return emptyDraft();
    const value = parsed as Partial<CreationDraft>;
    const members = (Array.isArray(value.members) ? value.members : []).filter(
      (member): member is ChatUser => !!member && validId(member.id) && member.id !== userId && typeof member.name === "string",
    ).filter((member, index, all) => all.findIndex(other => other.id === member.id) === index).slice(0, 49)
      .map(member => ({ id: member.id, name: member.name, avatarUrl: null }));
    const candidate = value.frozen;
    const frozen = candidate && typeof candidate === "object" &&
      typeof candidate.clientGroupId === "string" && /^[a-f0-9-]{36}$/i.test(candidate.clientGroupId) &&
      validName(candidate.name) && Array.isArray(candidate.memberIds) &&
      candidate.memberIds.length >= 1 && candidate.memberIds.length <= 49 &&
      candidate.memberIds.every(id => validId(id) && id !== userId) &&
      new Set(candidate.memberIds).size === candidate.memberIds.length
      ? { clientGroupId: candidate.clientGroupId, name: candidate.name, memberIds: [...candidate.memberIds] }
      : null;
    // A submitted payload is authoritative; display its members even if local labels were lost.
    return {
      name: frozen?.name ?? (typeof value.name === "string" ? value.name.slice(0, 120) : ""),
      members: frozen ? frozen.memberIds.map(id => members.find(member => member.id === id) ?? { id, name: `مستخدم ${id}`, avatarUrl: null }) : members,
      frozen,
      rejected: !!frozen && value.uncertain === false && value.rejected === true,
      // Older persisted frozen requests may already have committed.
      uncertain: !!frozen && value.uncertain !== false,
    };
  } catch { return emptyDraft(); }
}

interface PickerProps extends GroupContext {
  selected: ChatUser[];
  onChange: (members: ChatUser[]) => void;
  excludeIds?: number[];
  max: number;
  disabled?: boolean;
}
function MemberPicker({ user, scope, companyId, selected, onChange, excludeIds = [], max, disabled = false }: PickerProps) {
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim());
  const directory = useInfiniteQuery({
    queryKey: ["chat", user.id, scope, companyId ?? null, "directory", deferredSearch],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) => api<ChatPage<ChatUser>>(
      `/chat/directory?${scopeQuery(scope, companyId, { search: deferredSearch, cursor: pageParam, limit: "40" })}`, { signal },
    ),
    getNextPageParam: page => page.nextCursor ?? undefined,
    enabled: !disabled,
    retry: false,
  });
  const rows = directory.error ? [] : (directory.data?.pages.flatMap(page => page.items) ?? []).filter(
    member => member.id !== user.id && !excludeIds.includes(member.id),
  );
  return <div className="chat-member-picker">
    <div className="chat-member-chips" aria-label="الأعضاء المحددون">
      {selected.map(member => <span className="chat-member-chip" key={member.id}>
        <ChatAvatar name={member.name} avatarUrl={member.avatarUrl} size="tiny" />
        <span>{member.name}</span>
        <Button variant="ghost" size="compact" disabled={disabled} aria-label={`إلغاء اختيار ${member.name}`}
          onClick={() => onChange(selected.filter(other => other.id !== member.id))}><X size={13} /></Button>
      </span>)}
    </div>
    <span className="chat-group-selection-count">{selected.length.toLocaleString("ar")} من {Math.max(0, max).toLocaleString("ar")} أعضاء إضافيين</span>
    {!disabled && <>
      <Field label="البحث عن أعضاء" placeholder="ابحث بالاسم" maxLength={100} value={search} onChange={event => setSearch(event.target.value)} />
      {directory.error && <Notice tone="error">{errorText(directory.error)} <Button variant="ghost" size="compact" onClick={() => void directory.refetch()}>إعادة المحاولة</Button></Notice>}
      <div className="chat-member-search-results" aria-label="دليل الأعضاء" aria-busy={directory.isFetching}>
        {rows.map(member => {
          const checked = selected.some(other => other.id === member.id);
          return <label key={member.id} className="chat-member-option">
            <input type="checkbox" checked={checked} disabled={!checked && selected.length >= max}
              onChange={() => onChange(checked ? selected.filter(other => other.id !== member.id) : [...selected, member])} />
            <ChatAvatar name={member.name} avatarUrl={member.avatarUrl} size="small" />
            <span>{member.name}</span>{checked && <Check size={14} aria-hidden="true" />}
          </label>;
        })}
        {!rows.length && !directory.error && <p className="chat-dialog-empty">{directory.isPending ? "جارٍ تحميل الأعضاء…" : "لا يوجد أعضاء مطابقون في هذه الصفحة"}</p>}
      </div>
      {directory.hasNextPage && <Button variant="secondary" size="compact" disabled={directory.isFetchingNextPage}
        onClick={() => void directory.fetchNextPage()}>{directory.isFetchingNextPage ? "جارٍ التحميل…" : "عرض المزيد من الأعضاء"}</Button>}
    </>}
  </div>;
}

/** Key local and persisted creation state to the actor and exact chat scope. */
export function ChatGroupCreateDialog(props: CreateProps) {
  return <GroupCreateDialog key={`${props.user.id}:${props.scope}:${props.companyId ?? "public"}`} {...props} />;
}
function GroupCreateDialog({ user, scope, companyId, open, onClose, onCreated }: CreateProps) {
  const client = useQueryClient();
  const guard = useScopeGuard(`chat-group-create:${scope}:${companyId ?? "public"}`);
  const storageKey = `tijara:chat:groups:create:v1:${user.id}:${scope}:${companyId ?? "public"}`;
  const [draft, setDraft] = useState(() => readCreationDraft(storageKey, user.id));
  const draftRef = useRef(draft);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;
  const [error, setError] = useState<string | null>(null);
  const [storageFailed, setStorageFailed] = useState(false);
  const saveDraft = (next: CreationDraft) => {
    draftRef.current = next;
    setDraft(next);
    try {
      // Persist creation identity and labels, without retaining scoped photo URLs.
      localStorage.setItem(storageKey, JSON.stringify({ ...next, members: next.members.map(({ id, name }) => ({ id, name })) }));
      setStorageFailed(false);
      return true;
    } catch { setStorageFailed(true); return false; }
  };
  const submit = async () => {
    if (busyRef.current || !guard.isCurrent()) return;
    const previous = draftRef.current;
    if (!previous.frozen && (!validName(previous.name.trim()) || !previous.members.length || previous.members.length > 49)) {
      setError("اكتب اسمًا للمجموعة واختر عضوًا آخر على الأقل، وبحد أقصى ٤٩ عضوًا.");
      return;
    }
    const frozen = previous.frozen ?? {
      clientGroupId: crypto.randomUUID(), name: previous.name.trim(),
      memberIds: previous.members.map(member => member.id).sort((a, b) => a - b),
    };
    // Persist the exact UUID and payload synchronously BEFORE the first request or retry.
    if (!saveDraft({ ...previous, name: frozen.name, frozen, rejected: false, uncertain: true })) {
      setError("تعذر حفظ طلب الإنشاء على هذا الجهاز. فعّل التخزين المحلي ثم أعد المحاولة.");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await api<ChatGroupDetail>("/chat/groups", {
        method: "POST", signal: guard.signal, body: { ...contextBody(scope, companyId), ...frozen },
      });
      if (!guard.isCurrent()) return;
      try { localStorage.removeItem(storageKey); } catch { setStorageFailed(true); }
      draftRef.current = emptyDraft();
      setDraft(draftRef.current);
      const prefix = ["chat", user.id, scope, companyId ?? null, "groups"];
      client.setQueryData([...prefix, "detail", result.group.id], result);
      void client.invalidateQueries({ queryKey: prefix });
      // A completed background request must not replace a later navigation choice.
      if (openRef.current) { onCreated(result.group); onClose(); }
    } catch (failure) {
      if (!guard.isCurrent()) return;
      // A network/5xx failure may have committed. Never replace its UUID or payload.
      const definiteRejection = failure instanceof ApiFailure && failure.status >= 400 && failure.status < 500;
      // A later denial cannot disprove an earlier commit whose response was lost.
      const uncertain = previous.uncertain || !definiteRejection;
      saveDraft({ ...draftRef.current, rejected: definiteRejection && !uncertain, uncertain });
      setError(errorText(failure));
    } finally {
      busyRef.current = false;
      if (guard.isCurrent()) setBusy(false);
    }
  };
  return <Dialog open={open} onClose={onClose} title="إنشاء مجموعة دردشة" className="chat-group-dialog" footer={<>
    <Button variant="secondary" onClick={onClose}>إغلاق</Button>
    <Button onClick={() => void submit()} disabled={busy || (!draft.frozen && (!draft.name.trim() || !draft.members.length))}>
      {busy ? <LoaderCircle size={16} className="spin" /> : <Plus size={16} />}
      {draft.frozen ? "إعادة محاولة الإنشاء" : "إنشاء المجموعة"}
    </Button>
  </>}>
    <div className="chat-group-form">
      <div className="chat-group-summary"><span className="chat-avatar" aria-hidden="true"><Users size={22} /></span><p>مجموعة {scope === "company" ? "داخل الشركة" : "بين مستخدمي تجارة"}. تُضاف أنت تلقائيًا مديرًا للمجموعة.</p></div>
      {error && <Notice tone="error">{error}</Notice>}
      {storageFailed && <Notice tone="warning">تعذر حفظ المسودة محليًا؛ يلزم نجاح الحفظ قبل إرسال طلب الإنشاء.</Notice>}
      {draft.frozen && <Notice tone="warning">
        {draft.rejected ? "رفض الخادم طلب الإنشاء. يمكنك إعادة المحاولة بالطلب نفسه أو تعديل المسودة صراحةً." : "طلب الإنشاء محفوظ. إذا لم يصل التأكيد، ستُعاد المحاولة بنفس الطلب لمنع إنشاء مجموعة مكررة. يمكنك إغلاق النافذة والعودة لاحقًا."}
        {draft.rejected && <Button variant="secondary" size="compact" disabled={busy} onClick={() => {
          if (saveDraft({ ...draftRef.current, frozen: null, rejected: false, uncertain: false })) setError(null);
        }}>تعديل المسودة بطلب جديد</Button>}
      </Notice>}
      <Field label="اسم المجموعة" maxLength={120} value={draft.name} disabled={!!draft.frozen || busy}
        onChange={event => saveDraft({ ...draftRef.current, name: event.target.value })} />
      <MemberPicker user={user} scope={scope} companyId={companyId} selected={draft.members} max={49}
        disabled={!!draft.frozen || busy} onChange={members => saveDraft({ ...draftRef.current, members })} />
    </div>
  </Dialog>;
}

interface GroupEdit {
  revision: number;
  name: string;
  additions: ChatUser[];
  removals: number[];
}
const editFrom = (detail: ChatGroupDetail): GroupEdit => ({ revision: detail.group.revision, name: detail.group.name, additions: [], removals: [] });

export function ChatGroupDetailsDialog(props: DetailsProps) {
  return <GroupDetailsDialog key={`${props.user.id}:${props.scope}:${props.companyId ?? "public"}:${props.groupId}`} {...props} />;
}
function GroupDetailsDialog({ user, scope, companyId, groupId, open, onClose, onLeft, onChanged }: DetailsProps) {
  const client = useQueryClient();
  const guard = useScopeGuard(`chat-group-details:${scope}:${companyId ?? "public"}:${groupId}`);
  const prefix = useMemo(() => ["chat", user.id, scope, companyId ?? null, "groups"] as const, [user.id, scope, companyId]);
  const detailKey = useMemo(() => [...prefix, "detail", groupId] as const, [prefix, groupId]);
  const detail = useQuery({
    queryKey: detailKey,
    queryFn: ({ signal }) => api<ChatGroupDetail>(`/chat/groups/${groupId}?${scopeQuery(scope, companyId)}`, { signal }),
    enabled: open,
    retry: false,
  });
  const [edit, setEdit] = useState<GroupEdit | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [mustReload, setMustReload] = useState(false);
  const [leaveConfirm, setLeaveConfirm] = useState<number | null>(null);
  const [transferId, setTransferId] = useState("");
  const [transferConfirm, setTransferConfirm] = useState<{ member: ChatUser; revision: number } | null>(null);
  useEffect(() => {
    if (!open) { setEdit(null); setLeaveConfirm(null); setTransferConfirm(null); setTransferId(""); return; }
    if (detail.data && !detail.error && !edit) setEdit(editFrom(detail.data));
  }, [open, detail.data, detail.error, edit]);
  const current = detail.error || blocked ? undefined : detail.data;
  const manager = current?.group.managerId === user.id;
  const changedRevision = !!current && !!edit && current.group.revision !== edit.revision;
  const locked = busy || mustReload || changedRevision;
  const effectiveCount = current && edit ? current.members.length + edit.additions.length - edit.removals.length : 0;
  const changed = current && edit && (edit.name.trim() !== current.group.name || edit.additions.length > 0 || edit.removals.length > 0);
  const reload = async () => {
    if (busyRef.current) return;
    const result = await detail.refetch();
    if (!guard.isCurrent()) return;
    if (result.data && !result.error) {
      setEdit(editFrom(result.data)); setError(null); setMustReload(false); setBlocked(false);
      setLeaveConfirm(null); setTransferConfirm(null); setTransferId("");
    }
  };
  const acceptDetail = (next: ChatGroupDetail) => {
    client.setQueryData(detailKey, next);
    setEdit(editFrom(next)); setMustReload(false); setError(null); setTransferId("");
    void client.invalidateQueries({ queryKey: prefix });
    onChanged?.(next.group);
  };
  const mutationError = (failure: unknown) => {
    setError(errorText(failure));
    if (accessDenied(failure)) setBlocked(true);
    // A lost PATCH reply may already have committed. Read current revision before another edit.
    if (!(failure instanceof ApiFailure) || failure.status === 409 || failure.status >= 500) setMustReload(true);
  };
  const patch = async (body: ChatGroupUpdateInput) => {
    if (busyRef.current || !guard.isCurrent() || blocked || detail.error || !current) return;
    busyRef.current = true; setBusy(true); setError(null);
    try {
      const result = await api<ChatGroupDetail>(`/chat/groups/${groupId}`, { method: "PATCH", signal: guard.signal, body });
      if (guard.isCurrent()) { acceptDetail(result); setTransferConfirm(null); }
    } catch (failure) { if (guard.isCurrent()) mutationError(failure); }
    finally { busyRef.current = false; if (guard.isCurrent()) setBusy(false); }
  };
  const save = () => {
    if (!edit || !manager || locked || !changed || !validName(edit.name.trim()) || effectiveCount > 50) return;
    void patch({ ...contextBody(scope, companyId), revision: edit.revision,
      ...(edit.name.trim() !== current?.group.name ? { name: edit.name.trim() } : {}),
      ...(edit.additions.length ? { addMemberIds: edit.additions.map(member => member.id) } : {}),
      ...(edit.removals.length ? { removeMemberIds: edit.removals } : {}),
    });
  };
  const leave = async () => {
    if (!leaveConfirm || busyRef.current || !guard.isCurrent() || blocked || detail.error || !current) return;
    busyRef.current = true; setBusy(true); setError(null);
    try {
      await api(`/chat/groups/${groupId}/leave`, { method: "POST", signal: guard.signal,
        body: { ...contextBody(scope, companyId), revision: leaveConfirm } });
      if (!guard.isCurrent()) return;
      client.removeQueries({ queryKey: detailKey });
      client.removeQueries({ queryKey: [...prefix, "messages", groupId] });
      void client.invalidateQueries({ queryKey: prefix });
      setLeaveConfirm(null); onLeft(); onClose();
    } catch (failure) {
      if (guard.isCurrent()) { mutationError(failure); setLeaveConfirm(null); }
    } finally { busyRef.current = false; if (guard.isCurrent()) setBusy(false); }
  };
  return <>
    <Dialog open={open} onClose={onClose} title="تفاصيل المجموعة" className="chat-group-dialog" footer={<>
      <Button variant="secondary" onClick={onClose}>إغلاق</Button>
      {manager && current && edit && <Button onClick={save} disabled={locked || !changed || !validName(edit.name.trim()) || effectiveCount > 50}>
        {busy && <LoaderCircle size={16} className="spin" />}حفظ التغييرات
      </Button>}
    </>}>
      <div className="chat-group-form">
        {(error || detail.error) && <Notice tone="error">{error ?? errorText(detail.error)} <Button variant="ghost" size="compact" disabled={busy} onClick={() => void reload()}>تحديث البيانات</Button></Notice>}
        {detail.isPending && <p className="chat-dialog-empty">جارٍ تحميل المجموعة…</p>}
        {(mustReload || changedRevision) && <Notice tone="warning">تغيّرت بيانات المجموعة أو لم يصل تأكيد التعديل. حمّل أحدث البيانات قبل المتابعة؛ سيُلغي ذلك التعديلات غير المحفوظة. <Button variant="secondary" size="compact" disabled={busy} onClick={() => void reload()}>تحديث البيانات وإلغاء التعديلات</Button></Notice>}
        {current && edit && <>
          <div className="chat-group-summary"><span className="chat-avatar" aria-hidden="true"><Users size={22} /></span><div><strong>{current.group.name}</strong><p className="muted">{current.members.length.toLocaleString("ar")} عضو · {scope === "company" ? "دردشة الشركة" : "دردشة تجارة العامة"}</p></div></div>
          {manager ? <Field label="اسم المجموعة" maxLength={120} value={edit.name} disabled={locked}
            onChange={event => setEdit({ ...edit, name: event.target.value })} /> : <Notice>يدير هذه المجموعة {current.members.find(member => member.id === current.group.managerId)?.name ?? "مدير المجموعة"}.</Notice>}
          <section className="chat-group-section" aria-label="أعضاء المجموعة">
            <h3>أعضاء المجموعة</h3>
            <ul className="chat-group-members">
              {current.members.map(member => <li className="chat-group-member" key={member.id}>
                <ChatAvatar name={member.name} avatarUrl={member.avatarUrl} size="small" />
                <div className="chat-group-member-info"><strong>{member.name}{member.id === user.id ? " (أنت)" : ""}</strong>
                  {member.id === current.group.managerId && <span className="muted"><Crown size={13} aria-hidden="true" /> مدير المجموعة</span>}
                  {member.available === false && <small className="text-error">غير متاح للمراسلة</small>}
                </div>
                {manager && member.id !== current.group.managerId && <label className="chat-group-member-actions">
                  <input type="checkbox" aria-label={`إزالة ${member.name} من المجموعة`} checked={edit.removals.includes(member.id)} disabled={locked}
                    onChange={() => setEdit({ ...edit, removals: edit.removals.includes(member.id) ? edit.removals.filter(id => id !== member.id) : [...edit.removals, member.id] })} />إزالة
                </label>}
              </li>)}
            </ul>
          </section>
          {manager && <>
            <section className="chat-group-section" aria-label="إضافة أعضاء">
              <h3>إضافة أعضاء</h3>
              <p className="muted">الحد الأقصى ٥٠ عضوًا مع مدير المجموعة. لن يشاهد الأعضاء الجدد الرسائل السابقة لإضافتهم.</p>
              <MemberPicker user={user} scope={scope} companyId={companyId} selected={edit.additions}
                excludeIds={current.members.map(member => member.id)} max={Math.max(0, 50 - current.members.length + edit.removals.length)}
                disabled={locked} onChange={additions => setEdit({ ...edit, additions })} />
              {effectiveCount > 50 && <Notice tone="error">تجاوزت المجموعة الحد الأقصى. ألغِ بعض الإضافات أو اختر أعضاء لإزالتهم.</Notice>}
            </section>
            <section className="chat-group-section" aria-label="نقل إدارة المجموعة">
              <h3>نقل الإدارة</h3>
              <p className="muted">احفظ أي تعديلات أولًا. بعد النقل تصبح عضوًا عاديًا ويمكنك مغادرة المجموعة.</p>
              <Select label="المدير الجديد" value={transferId} disabled={locked || !!changed}
                onChange={event => setTransferId(event.target.value)}>
                <option value="">اختر عضوًا</option>
                {current.members.filter(member => member.id !== user.id).map(member => <option value={member.id} key={member.id}>{member.name}</option>)}
              </Select>
              <Button variant="secondary" disabled={locked || !!changed || !transferId} onClick={() => {
                const member = current.members.find(candidate => candidate.id === Number(transferId));
                if (member) setTransferConfirm({ member, revision: current.group.revision });
              }}>نقل الإدارة</Button>
            </section>
          </>}
          <section className="chat-group-section" aria-label="مغادرة المجموعة">
            {manager ? <p className="muted">لنقل مسؤولية المجموعة قبل المغادرة، اختر مديرًا آخر من الأعضاء أعلاه.</p> : <Button variant="danger" disabled={locked}
              onClick={() => setLeaveConfirm(current.group.revision)}>مغادرة المجموعة</Button>}
          </section>
        </>}
      </div>
    </Dialog>
    <Dialog open={open && !!current && leaveConfirm !== null} onClose={() => { if (!busy) setLeaveConfirm(null); }} title="تأكيد مغادرة المجموعة" footer={<>
      <Button variant="secondary" disabled={busy} onClick={() => setLeaveConfirm(null)}>إلغاء</Button>
      <Button variant="danger" disabled={busy || mustReload || changedRevision} onClick={() => void leave()}>{busy && <LoaderCircle size={16} className="spin" />}تأكيد المغادرة</Button>
    </>}><p>هل تريد مغادرة «{current?.group.name}»؟ ستفقد الوصول إلى المجموعة ورسائلها بعد المغادرة.</p></Dialog>
    <Dialog open={open && !!current && transferConfirm !== null} onClose={() => { if (!busy) setTransferConfirm(null); }} title="تأكيد نقل الإدارة" footer={<>
      <Button variant="secondary" disabled={busy} onClick={() => setTransferConfirm(null)}>إلغاء</Button>
      <Button disabled={busy || mustReload || changedRevision} onClick={() => {
        if (transferConfirm) void patch({ ...contextBody(scope, companyId), revision: transferConfirm.revision, managerId: transferConfirm.member.id });
      }}>{busy && <LoaderCircle size={16} className="spin" />}تأكيد نقل الإدارة</Button>
    </>}><p>ستُنقل إدارة «{current?.group.name}» إلى {transferConfirm?.member.name}، وستصبح أنت عضوًا عاديًا.</p></Dialog>
  </>;
}
