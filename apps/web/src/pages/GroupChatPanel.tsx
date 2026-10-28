import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { ArrowDown, ArrowRight, CheckCheck, CircleAlert, Clock3, Info, LoaderCircle, MessageCircle, RefreshCw, Send, Users } from "lucide-react";
import type { User } from "../../../../packages/contracts/src/index";
import type { ChatPage, ChatScope } from "../../../../packages/contracts/src/chat";
import type { ChatGroup, ChatGroupMember, ChatGroupMessage } from "../../../../packages/contracts/src/chat-groups";
import { api, ApiFailure, useScopeGuard } from "../api";
import { Button, Dialog, Notice } from "../ui";
import { ChatGroupDetailsDialog } from "./ChatGroupDialogs";
import { ChatAvatar } from "./ChatAvatar";
import { ChatEmojiPicker } from "./ChatEmojiPicker";
import { ChatImagePicker, type ChatAttachedImage } from "./ChatImagePicker";

interface GroupProps { allowImages: boolean; siteOwnerIds: number[]; user: User; scope: ChatScope; companyId?: number; groupId: number; obscured: boolean; onBack: () => void; }
interface GroupDetail { group: ChatGroup; members: ChatGroupMember[]; }
interface PendingGroupMessage { clientMessageId: string; text: string; imageId?: string; membershipRevision: number; createdAt: string; }
interface GroupDraft { text: string; membershipRevision: number | null; }
interface GroupLocalState { draft: GroupDraft; pending: PendingGroupMessage[]; }
const emptyLocal = (): GroupLocalState => ({ draft: { text: "", membershipRevision: null }, pending: [] });
const timeFormat = new Intl.DateTimeFormat("ar", { hour: "2-digit", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat("ar", { day: "numeric", month: "long", year: "numeric" });
function contextBody(scope: ChatScope, companyId?: number) { return { scope, ...(scope === "company" ? { companyId } : {}) }; }
function contextQuery(scope: ChatScope, companyId?: number, cursor?: string | null) {
  const params = new URLSearchParams({ scope, limit: "40" });
  if (scope === "company" && companyId) params.set("companyId", String(companyId));
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}
function errorText(error: unknown) { return error instanceof Error ? error.message : "تعذر إكمال الطلب. حاول مرة أخرى."; }
function denied(error: unknown) { return error instanceof ApiFailure && [401, 403, 404].includes(error.status); }
function useActivePage() {
  const [active, setActive] = useState(() => document.visibilityState === "visible" && document.hasFocus());
  useEffect(() => {
    const update = () => setActive(document.visibilityState === "visible" && document.hasFocus());
    document.addEventListener("visibilitychange", update); window.addEventListener("focus", update); window.addEventListener("blur", update);
    return () => { document.removeEventListener("visibilitychange", update); window.removeEventListener("focus", update); window.removeEventListener("blur", update); };
  }, []);
  return active;
}
function readLocal(key: string): GroupLocalState {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as Partial<GroupLocalState> | null;
    if (!value) return emptyLocal();
    return {
      draft: typeof value.draft?.text === "string" && value.draft.text.length <= 4_000 && (value.draft.membershipRevision === null || Number.isInteger(value.draft.membershipRevision)) ? value.draft : emptyLocal().draft,
      pending: (Array.isArray(value.pending) ? value.pending : []).filter(message =>
        !!message && typeof message.text === "string" && message.text.length <= 4_000 &&
        (message.text.length > 0 || (typeof message.imageId === "string" && /^[a-f0-9-]{36}$/i.test(message.imageId))) &&
        typeof message.clientMessageId === "string" && /^[a-f0-9-]{36}$/i.test(message.clientMessageId) &&
        Number.isInteger(message.membershipRevision) && message.membershipRevision > 0 && Number.isFinite(Date.parse(message.createdAt)),
      ),
    };
  } catch { return emptyLocal(); }
}

export function GroupChatPanel(props: GroupProps) {
  const { user, scope, companyId, groupId, onBack } = props;
  const active = useActivePage();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detail = useQuery({
    queryKey: ["chat", user.id, scope, companyId ?? null, "groups", "detail", groupId],
    queryFn: ({ signal }) => api<GroupDetail>(`/chat/groups/${groupId}?${contextQuery(scope, companyId)}`, { signal }),
    refetchInterval: active ? 6_000 : false,
    retry: false,
  });
  // Membership revision and join epoch own the history observer, cache, requests and composer.
  // A removed/rejoined member must never retain a prior join's rendered history.
  const joinedAt = detail.data?.members.find(member => member.id === user.id)?.joinedAt;
  const current = detail.error ? undefined : detail.data;
  return <>
    {current && joinedAt ? <GroupHistory key={`${groupId}:${current.group.membershipRevision}:${joinedAt}`} {...props} allowImages={props.allowImages || current.members.some(member => props.siteOwnerIds.includes(member.id))} detail={current} obscured={props.obscured || detailsOpen} onDetails={() => setDetailsOpen(true)} /> : <section className="chat-thread" aria-label="محادثة المجموعة"><header className="chat-thread-heading"><Button className="chat-mobile-back" variant="ghost" size="compact" aria-label="العودة إلى المحادثات" onClick={onBack}><ArrowRight size={20} /></Button><span className="chat-avatar"><Users size={20} /></span><h2>محادثة المجموعة</h2></header><div className="chat-thread-empty">{detail.error ? <Notice tone="error">{errorText(detail.error)}<Button variant="ghost" onClick={() => void detail.refetch()}>إعادة المحاولة</Button></Notice> : <><LoaderCircle className="chat-spinner" size={24} />جارٍ التحقق من عضوية المجموعة…</>}</div></section>}
    <ChatGroupDetailsDialog open={detailsOpen} onClose={() => setDetailsOpen(false)} user={user} scope={scope} companyId={companyId} groupId={groupId} onLeft={onBack} />
  </>;
}

function GroupHistory({ user, scope, companyId, groupId, detail, obscured, onBack, onDetails, allowImages }: GroupProps & { detail: GroupDetail; onDetails: () => void; }) {
  const { group, members } = detail;
  const client = useQueryClient();
  const active = useActivePage();
  const guard = useScopeGuard(`chat-group:${scope}:${companyId ?? "public"}:${groupId}:${group.membershipRevision}:${members.find(member => member.id === user.id)?.joinedAt}`);
  const prefix = useMemo(() => ["chat", user.id, scope, companyId ?? null, "groups"] as const, [user.id, scope, companyId]);
  const messageKey = useMemo(() => [...prefix, "messages", groupId, group.membershipRevision, members.find(member => member.id === user.id)?.joinedAt] as const, [prefix, groupId, group.membershipRevision, members, user.id]);
  const storageKey = `tijara:group-chat:v1:${user.id}:${scope}:${companyId ?? "public"}:${groupId}`;
  const [local, setLocal] = useState(() => readLocal(storageKey));
  const localRef = useRef(local);
  const [storageError, setStorageError] = useState(false);
  const updateLocal = (update: (previous: GroupLocalState) => GroupLocalState) => {
    const next = update(localRef.current); localRef.current = next;
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { setStorageError(true); }
    setLocal(next);
  };
  const feed = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const nearBottom = useRef(true);
  const firstScroll = useRef(true);
  const olderScroll = useRef<{ height: number; top: number } | null>(null);
  const [newMessages, setNewMessages] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [attachment, setAttachment] = useState<ChatAttachedImage | null>(null);
  const [receiptMessageId, setReceiptMessageId] = useState<number | null>(null);
  const [audienceOpen, setAudienceOpen] = useState(false);
  const [restorePending, setRestorePending] = useState<PendingGroupMessage | null>(null);
  const [sending, setSending] = useState<Set<string>>(() => new Set());
  const sendingRef = useRef(new Set<string>());
  const [sendErrors, setSendErrors] = useState<Record<string, { text: string; rejected: boolean }>>({});
  const [receiptError, setReceiptError] = useState<Error | null>(null);
  const deliveredQueue = useRef(new Set<number>());
  const readQueue = useRef(new Set<number>());
  const receiptBusy = useRef(false);
  const messages = useInfiniteQuery({
    queryKey: messageKey,
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) => api<ChatPage<ChatGroupMessage>>(`/chat/groups/${groupId}/messages?${contextQuery(scope, companyId, pageParam)}`, { signal }),
    getNextPageParam: page => page.nextCursor ?? undefined,
    refetchInterval: active ? query => (query.state.data?.pages.length ?? 1) > 1 ? 10_000 : 4_000 : false,
    retry: false,
  });
  const inaccessible = denied(messages.error) || denied(receiptError);
  const items = useMemo(() => inaccessible ? [] : [...new Map((messages.data?.pages.flatMap(page => page.items) ?? []).map(message => [message.id, message])).values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id), [messages.data, inaccessible]);
  const pending = local.pending.filter(message => !items.some(item => item.clientMessageId === message.clientMessageId && item.senderId === user.id));
  const selectedReceipt = items.find(message => message.id === receiptMessageId && message.senderId === user.id);
  const latestId = items.at(-1)?.id;
  const scrollToBottom = () => { if (feed.current) feed.current.scrollTop = feed.current.scrollHeight; nearBottom.current = true; setNewMessages(false); };
  useLayoutEffect(() => {
    if (!feed.current) return;
    if (olderScroll.current) { feed.current.scrollTop = olderScroll.current.top + feed.current.scrollHeight - olderScroll.current.height; olderScroll.current = null; }
    else if (firstScroll.current || nearBottom.current) { scrollToBottom(); if (items.length) firstScroll.current = false; }
    else if (latestId) setNewMessages(true);
  }, [latestId, items.length, pending.length]);
  useEffect(() => {
    const accepted = new Set(items.filter(message => message.senderId === user.id).map(message => message.clientMessageId));
    if (localRef.current.pending.some(message => accepted.has(message.clientMessageId))) updateLocal(previous => ({ ...previous, pending: previous.pending.filter(message => !accepted.has(message.clientMessageId)) }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, user.id]);
  const flushReceipts = useCallback(async () => {
    if (receiptBusy.current || !guard.isCurrent() || inaccessible) return;
    receiptBusy.current = true;
    try {
      while (deliveredQueue.current.size || readQueue.current.size) {
        const deliveredMessageIds = [...deliveredQueue.current].slice(0, 100);
        const readMessageIds = [...readQueue.current].slice(0, 100);
        const result = await api<{ messages: ChatGroupMessage[] }>(`/chat/groups/${groupId}/receipt`, { method: "POST", signal: guard.signal, body: { ...contextBody(scope, companyId), deliveredMessageIds, readMessageIds } });
        if (!guard.isCurrent()) return;
        deliveredMessageIds.forEach(id => deliveredQueue.current.delete(id)); readMessageIds.forEach(id => readQueue.current.delete(id));
        const updated = new Map(result.messages.map(message => [message.id, message]));
        client.setQueryData<InfiniteData<ChatPage<ChatGroupMessage>>>(messageKey, previous => previous && ({ ...previous, pages: previous.pages.map(page => ({ ...page, items: page.items.map(message => updated.get(message.id) ?? message) })) }));
        setReceiptError(null);
        if (readMessageIds.length) void client.invalidateQueries({ queryKey: [...prefix, "list"] });
      }
    } catch (error) { if (guard.isCurrent()) setReceiptError(error instanceof Error ? error : new Error("تعذر تحديث حالة الرسائل")); }
    finally { receiptBusy.current = false; }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, companyId, scope, groupId, messageKey, prefix, inaccessible]);
  useEffect(() => {
    if (messages.error || inaccessible) return;
    items.forEach(message => { const receipt = message.receipts.find(row => row.userId === user.id); if (receipt && !receipt.deliveredAt) deliveredQueue.current.add(message.id); });
    void flushReceipts();
  }, [items, messages.dataUpdatedAt, messages.error, inaccessible, flushReceipts, user.id]);
  useEffect(() => {
    const element = feed.current;
    if (!element || !active || obscured || emojiOpen || selectedReceipt || audienceOpen || restorePending || messages.error || inaccessible || !window.IntersectionObserver) return;
    const observer = new IntersectionObserver(entries => {
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      entries.forEach(entry => {
        const box = entry.intersectionRect;
        const visibleElement = box.width > 0 && box.height > 0 ? document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) : null;
        if (entry.isIntersecting && (entry.intersectionRatio >= 0.5 || box.height >= 80) && visibleElement && entry.target.contains(visibleElement)) {
          const id = Number((entry.target as HTMLElement).dataset.chatGroupMessageId); if (id) readQueue.current.add(id);
        }
      });
      void flushReceipts();
    }, { root: element, threshold: [0, 0.5, 1] });
    element.querySelectorAll('[data-chat-group-unread="true"]').forEach(node => observer.observe(node));
    return () => observer.disconnect();
  }, [items, active, obscured, emojiOpen, selectedReceipt, audienceOpen, restorePending, messages.error, inaccessible, flushReceipts]);
  const sendPending = async (message: PendingGroupMessage) => {
    if (sendingRef.current.has(message.clientMessageId) || inaccessible) return;
    try { localStorage.setItem(storageKey, JSON.stringify(localRef.current)); }
    catch {
      setStorageError(true);
      setSendErrors(previous => ({ ...previous, [message.clientMessageId]: { text: "تعذر حفظ طلب الإرسال على هذا الجهاز. فعّل التخزين المحلي ثم أعد المحاولة.", rejected: false } }));
      return;
    }
    sendingRef.current.add(message.clientMessageId); setSending(new Set(sendingRef.current));
    setSendErrors(previous => ({ ...previous, [message.clientMessageId]: { text: "", rejected: false } }));
    try {
      const result = await api<{ message: ChatGroupMessage }>(`/chat/groups/${groupId}/messages`, { method: "POST", signal: guard.signal, body: { ...contextBody(scope, companyId), clientMessageId: message.clientMessageId, text: message.text, ...(message.imageId ? {imageId:message.imageId} : {}), membershipRevision: message.membershipRevision } });
      if (!guard.isCurrent()) return;
      client.setQueryData<InfiniteData<ChatPage<ChatGroupMessage>>>(messageKey, previous => {
        if (!previous) return { pages: [{ items: [result.message], nextCursor: null }], pageParams: [null] };
        return { ...previous, pages: [{ ...previous.pages[0], items: [result.message, ...previous.pages[0].items.filter(item => item.id !== result.message.id)] }, ...previous.pages.slice(1)] };
      });
      updateLocal(previous => ({ ...previous, pending: previous.pending.filter(item => item.clientMessageId !== message.clientMessageId) }));
      nearBottom.current = true; composer.current?.focus();
      void client.invalidateQueries({ queryKey: [...prefix, "list"] });
    } catch (error) {
      if (guard.isCurrent()) {
        // Only post-idempotency-lookup rejections prove this UUID did not commit.
        // A generic transaction conflict may follow an earlier lost successful response.
        const rejected = error instanceof ApiFailure && error.status === 409 &&
          ["membership_changed", "group_member_unavailable", "group_needs_recipient", "idempotency_conflict"].includes(error.code);
        setSendErrors(previous => ({ ...previous, [message.clientMessageId]: { text: errorText(error), rejected } }));
        if (error instanceof ApiFailure && error.status === 409) void client.invalidateQueries({ queryKey: [...prefix, "detail", groupId] });
      }
    } finally { sendingRef.current.delete(message.clientMessageId); if (guard.isCurrent()) setSending(new Set(sendingRef.current)); }
  };
  const draftChanged = !!local.draft.text.trim() && local.draft.membershipRevision !== group.membershipRevision;
  const restoredText = restorePending ? [local.draft.text, restorePending.text].filter(Boolean).join("\n") : "";
  const submit = (event?: FormEvent) => {
    event?.preventDefault(); const draft = localRef.current.draft;
    if ((!draft.text.trim() && !attachment) || draft.text.length > 4_000 || inaccessible || messages.isPending || (!!attachment && !allowImages)) return;
    if (draft.membershipRevision !== null && draft.membershipRevision !== group.membershipRevision) { setAudienceOpen(true); return; }
    const message: PendingGroupMessage = { clientMessageId: crypto.randomUUID(), text: draft.text.trim(), ...(attachment ? {imageId:attachment.id} : {}), membershipRevision: draft.membershipRevision ?? group.membershipRevision, createdAt: new Date().toISOString() };
    setAttachment(null);
    updateLocal(previous => ({ draft: { text: "", membershipRevision: null }, pending: [...previous.pending, message] }));
    nearBottom.current = true; void sendPending(message);
  };
  let previousDay = "";
  return <section className="chat-thread" aria-label={`المجموعة ${group.name}`} data-chat-group-id={groupId}>
    <header className="chat-thread-heading"><Button className="chat-mobile-back" variant="ghost" size="compact" onClick={onBack} aria-label="العودة إلى المحادثات"><ArrowRight size={20} /></Button><span className="chat-avatar chat-avatar-small chat-group-avatar" aria-hidden="true"><Users size={19} /></span><div className="chat-peer-heading"><h2>{group.name}</h2><small>{group.memberCount.toLocaleString("ar")} أعضاء · {scope === "global" ? "مستخدمو الرئيسي" : "داخل الشركة"}</small></div><Button variant="ghost" size="compact" className="chat-group-details-button" aria-label="تفاصيل المجموعة" title="تفاصيل المجموعة" onClick={onDetails}><Info size={19} /></Button></header>
    {storageError && <Notice tone="warning">تعذر حفظ المسودات على هذا الجهاز. أبقِ الصفحة مفتوحة حتى يتأكد الإرسال.</Notice>}
    {(messages.error || receiptError) && <div className="chat-thread-alert"><Notice tone="error">{errorText(messages.error ?? receiptError)}<Button variant="ghost" size="compact" onClick={() => void messages.refetch().then(result => { if (!result.error && guard.isCurrent()) setReceiptError(null); })}><RefreshCw size={13} />إعادة المحاولة</Button></Notice></div>}
    <div className="chat-feed-wrap"><div className="chat-feed" ref={feed} aria-label="رسائل المجموعة" aria-busy={messages.isFetching} onScroll={() => { const element = feed.current; if (element) { nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 90; if (nearBottom.current) setNewMessages(false); } }}>
      {messages.hasNextPage && !inaccessible && <Button className="chat-load-more" variant="secondary" size="compact" disabled={messages.isFetchingNextPage} onClick={() => { if (feed.current) olderScroll.current = { height: feed.current.scrollHeight, top: feed.current.scrollTop }; void messages.fetchNextPage().then(result => { if (result.isError) olderScroll.current = null; }); }}>{messages.isFetchingNextPage ? "جارٍ التحميل…" : "تحميل رسائل أقدم"}</Button>}
      {messages.isPending && <div className="chat-thread-empty"><LoaderCircle className="chat-spinner" size={25} />جارٍ تحميل رسائل المجموعة…</div>}
      {!messages.isPending && !messages.error && !items.length && !pending.length && !inaccessible && <div className="chat-thread-empty"><MessageCircle size={30} /><strong>مرحبًا بكم في {group.name}</strong><p>ابدأ محادثة تجمع أعضاء المجموعة.</p></div>}
      {items.map(message => {
        const day = dayFormat.format(new Date(message.createdAt)); const showDay = day !== previousDay; previousDay = day;
        const own = message.senderId === user.id; const ownReceipt = message.receipts.find(row => row.userId === user.id);
        return <div className="chat-message-group" key={message.id}>{showDay && <div className="chat-day"><span>{day}</span></div>}<article className={`chat-message chat-group-message ${own ? "chat-message-own" : "chat-message-incoming"}`} data-chat-group-message-id={message.id} data-chat-group-unread={ownReceipt && !ownReceipt.readAt ? "true" : undefined} aria-label={`${own ? "أنت" : message.senderName}: ${message.text}`}>
          <div className="chat-group-sender"><ChatAvatar name={message.senderName} avatarUrl={message.senderAvatarUrl} size="tiny" /><strong>{own ? "أنت" : message.senderName}</strong></div>
          <p dir="auto">{message.text}</p>{message.imageUrl && <a href={message.imageUrl} target="_blank" rel="noopener noreferrer" aria-label="فتح صورة المجموعة"><img className="chat-inline-image" src={message.imageUrl} alt="صورة مرفقة بالمجموعة" loading="lazy"/></a>}<div className="chat-message-meta"><time dateTime={message.createdAt}>{timeFormat.format(new Date(message.createdAt))}</time>{own && <span className="chat-receipt">تم الإرسال</span>}</div>
          {own && <button className={`chat-group-receipt-button ${message.recipientCount > 0 && message.readCount === message.recipientCount ? "chat-receipt-read" : ""}`} aria-label="تفاصيل استلام الرسالة وعرضها" onClick={() => setReceiptMessageId(message.id)}><CheckCheck size={14} /><span>تم الاستلام {message.deliveredCount.toLocaleString("ar")} من {message.recipientCount.toLocaleString("ar")}</span><span>تم العرض {message.readCount.toLocaleString("ar")} من {message.recipientCount.toLocaleString("ar")}</span></button>}
        </article></div>;
      })}
      {!inaccessible && pending.map(message => <article key={message.clientMessageId} className="chat-message chat-message-own chat-message-pending" data-chat-group-pending-id={message.clientMessageId}><p dir="auto">{message.text}</p>{message.imageId && <small>📷 صورة مرفقة</small>}<div className="chat-message-meta"><time dateTime={message.createdAt}>{timeFormat.format(new Date(message.createdAt))}</time><span className="chat-receipt">{sending.has(message.clientMessageId) ? <><Clock3 size={13} />جارٍ الإرسال…</> : <><CircleAlert size={13} />لم يتأكد الإرسال</>}</span></div>{!sending.has(message.clientMessageId) && <div className="chat-send-error"><span>{sendErrors[message.clientMessageId]?.text || "إعادة المحاولة تحفظ الرسالة وأعضاءها المقصودين."}</span><Button variant="ghost" size="compact" aria-label="إعادة إرسال رسالة المجموعة" onClick={() => void sendPending(message)}><RefreshCw size={13} />إعادة الإرسال</Button>{sendErrors[message.clientMessageId]?.rejected && <Button variant="ghost" size="compact" onClick={() => setRestorePending(message)}>نقل النص إلى المسودة</Button>}</div>}</article>)}
    </div>{newMessages && <Button className="chat-jump-latest" variant="secondary" size="compact" onClick={scrollToBottom}><ArrowDown size={14} />أحدث الرسائل</Button>}</div>
    <form className="chat-composer" onSubmit={submit}>{draftChanged && <Notice tone="warning">تغيّر أعضاء المجموعة. راجع الأعضاء قبل الإرسال.<Button variant="ghost" size="compact" onClick={() => setAudienceOpen(true)}>مراجعة الأعضاء</Button></Notice>}<div className="chat-composer-row"><textarea ref={composer} aria-label="نص رسالة المجموعة" placeholder="اكتب رسالة للمجموعة…" dir="auto" rows={2} maxLength={4_000} value={local.draft.text} disabled={inaccessible} onChange={event => {
      const text = event.target.value;
      updateLocal(previous => ({
        ...previous,
        draft: {
          text,
          membershipRevision: text ? previous.draft.text ? previous.draft.membershipRevision : group.membershipRevision : null,
        },
      }));
    }} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} /><ChatImagePicker scope={scope} companyId={companyId} enabled={allowImages} disabled={inaccessible || messages.isPending} value={attachment} onChange={setAttachment}/><ChatEmojiPicker textareaRef={composer} value={local.draft.text} disabled={inaccessible} obscured={obscured || !!selectedReceipt || audienceOpen || !!restorePending} onOpenChange={setEmojiOpen} onChange={text => updateLocal(previous => ({ ...previous, draft: { text, membershipRevision: text ? previous.draft.text ? previous.draft.membershipRevision : group.membershipRevision : null } }))} /><Button type="submit" className="chat-send-button" disabled={(!local.draft.text.trim() && !attachment) || inaccessible || messages.isPending} aria-label="إرسال رسالة المجموعة" title="إرسال رسالة المجموعة"><Send size={19} /></Button></div><div className="chat-composer-hint"><span>Enter للإرسال · Shift + Enter لسطر جديد</span><span>إلى أعضاء المجموعة الحاليين</span></div></form>
    <Dialog open={!!selectedReceipt} onClose={() => setReceiptMessageId(null)} title="تفاصيل استلام الرسالة وعرضها" className="chat-group-dialog"><p className="muted chat-group-receipt-hint">المستلمون المثبتون عند إرسال هذه الرسالة؛ مغادرة المجموعة لا تغيّر عددهم.</p><div className="chat-group-receipt-list">{selectedReceipt?.receipts.map(receipt => <div key={receipt.userId} className="chat-group-receipt-row"><ChatAvatar name={receipt.name} avatarUrl={receipt.avatarUrl} size="small" /><strong>{receipt.name}</strong><div><span>{receipt.deliveredAt ? `تم الاستلام · ${timeFormat.format(new Date(receipt.deliveredAt))}` : "لم يُؤكد الاستلام"}</span><span className={receipt.readAt ? "chat-receipt-read" : "muted"}>{receipt.readAt ? `تم العرض · ${timeFormat.format(new Date(receipt.readAt))}` : "لم يُؤكد العرض"}</span></div></div>)}{selectedReceipt?.recipientCount === 0 && <p className="muted">لا يوجد مستلم آخر لهذه الرسالة.</p>}</div></Dialog>
    <Dialog open={audienceOpen} onClose={() => setAudienceOpen(false)} title="مراجعة أعضاء الرسالة" footer={<><Button variant="secondary" onClick={() => setAudienceOpen(false)}>رجوع</Button><Button onClick={() => { updateLocal(previous => ({ ...previous, draft: { ...previous.draft, membershipRevision: group.membershipRevision } })); setAudienceOpen(false); }}>اعتماد الأعضاء الحاليين</Button></>}><p className="muted">ستُرسل المسودة عند تأكيد الإرسال إلى الأعضاء الحاليين:</p><ul className="chat-group-audience-list">{members.filter(member => member.id !== user.id).map(member => <li key={member.id}>{member.name}</li>)}</ul></Dialog>
    <Dialog open={!!restorePending} onClose={() => setRestorePending(null)} title="نقل النص إلى المسودة" footer={<><Button variant="secondary" onClick={() => setRestorePending(null)}>رجوع</Button><Button disabled={restoredText.length > 4_000} onClick={() => { if (!restorePending || restoredText.length > 4_000) return; const frozen = restorePending; updateLocal(previous => ({ draft: { text: [previous.draft.text, frozen.text].filter(Boolean).join("\n"), membershipRevision: null }, pending: previous.pending.filter(message => message.clientMessageId !== frozen.clientMessageId) })); setRestorePending(null); setAudienceOpen(true); }}>نقل النص ومراجعة الأعضاء</Button></>}><p>رفض الخادم هذه المحاولة. سيُنقل النص إلى مسودة جديدة لمراجعة الأعضاء قبل الإرسال.</p>{local.draft.text && <Notice tone={restoredText.length > 4_000 ? "error" : "warning"}>{restoredText.length > 4_000 ? "تتجاوز المسودة مع الرسالة حد ٤٬٠٠٠ محرف. احتفظ بمسودتك أو أرسلها أولًا قبل نقل الرسالة." : "توجد مسودة حالية؛ سيُضاف نص الرسالة إليها."}</Notice>}</Dialog>
  </section>;
}
