import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowRight,
  Check,
  CheckCheck,
  CircleAlert,
  Clock3,
  Globe2,
  LoaderCircle,
  MessageCircle,
  MessageSquarePlus,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Users,
} from "lucide-react";
import type { User, Company, CompanyPage } from "../../../../packages/contracts/src/index";
import { useNavigate } from "react-router-dom";
import type {
  ChatConversation,
  ChatMessage,
  ChatPage as ChatResultPage,
  ChatScope,
  ChatUser,
} from "../../../../packages/contracts/src/chat";
import type { ChatGroup } from "../../../../packages/contracts/src/chat-groups";
import { api, ApiFailure, useScopeGuard } from "../api";
import { Button, Dialog, Field, Notice, PageHeader } from "../ui";
import { ChatGroupCreateDialog } from "./ChatGroupDialogs";
import { GroupChatPanel } from "./GroupChatPanel";
import { ChatAvatar, ownChatAvatarUrl } from "./ChatAvatar";
import { ChatEmojiPicker } from "./ChatEmojiPicker";

interface ChatProps {
  scope: ChatScope;
  companyId?: number;
  user: User;
}
interface PendingMessage {
  clientMessageId: string;
  text: string;
  peer: ChatUser;
  createdAt: string;
}
interface SavedChat {
  drafts: Record<string, string>;
  pending: PendingMessage[];
}
const emptySavedChat = (): SavedChat => ({ drafts: {}, pending: [] });
const timeFormat = new Intl.DateTimeFormat("ar", { hour: "2-digit", minute: "2-digit" });
const dateFormat = new Intl.DateTimeFormat("ar", { day: "numeric", month: "long", year: "numeric" });

function readSavedChat(key: string): SavedChat {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!saved || typeof saved !== "object") return emptySavedChat();
    const value = saved as Partial<SavedChat>;
    return {
      drafts: Object.fromEntries(Object.entries(value.drafts ?? {}).filter(
        ([id, text]) => /^\d+$/.test(id) && typeof text === "string" && text.length <= 4_000,
      )),
      pending: (Array.isArray(value.pending) ? value.pending : []).filter(
        (message): message is PendingMessage =>
          !!message && typeof message === "object" &&
          typeof message.clientMessageId === "string" &&
          /^[a-f0-9-]{36}$/i.test(message.clientMessageId) &&
          typeof message.text === "string" && message.text.length > 0 && message.text.length <= 4_000 &&
          typeof message.createdAt === "string" && Number.isFinite(Date.parse(message.createdAt)) &&
          Number.isInteger(message.peer?.id) && typeof message.peer?.name === "string",
      ),
    };
  } catch {
    return emptySavedChat();
  }
}
function usePageActivity() {
  const [active, setActive] = useState(() => document.visibilityState === "visible" && document.hasFocus());
  useEffect(() => {
    const update = () => setActive(document.visibilityState === "visible" && document.hasFocus());
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    };
  }, []);
  return active;
}
function accessDenied(error: unknown) {
  return error instanceof ApiFailure && [401, 403, 404].includes(error.status);
}
function errorText(error: unknown) {
  return error instanceof Error ? error.message : "تعذر الاتصال. حاول مرة أخرى.";
}
function queryString(scope: ChatScope, companyId?: number, values: Record<string, string | null | undefined> = {}) {
  const params = new URLSearchParams({ scope, limit: "40" });
  if (scope === "company" && companyId) params.set("companyId", String(companyId));
  Object.entries(values).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  return params.toString();
}
function Receipt({ message }: { message: ChatMessage }) {
  return (
    <span className={`chat-receipt ${message.readAt ? "chat-receipt-read" : ""}`}>
      {message.readAt || message.deliveredAt ? <CheckCheck size={14} /> : <Check size={14} />}
      {message.readAt ? "تم العرض" : message.deliveredAt ? "تم الاستلام" : "تم الإرسال"}
    </span>
  );
}

/** Remount the entire local state when actor or public/company scope changes. */
export function ChatPage(props: ChatProps) {
  return <>
    <ChatScopePicker {...props} />
    <ChatWorkspace key={`${props.user.id}:${props.scope}:${props.companyId ?? "public"}`} {...props} />
  </>;
}

/** Existing company permissions remain authoritative; selecting a company
 * only navigates to its protected chat route. */
function ChatScopePicker({ user, scope, companyId }: ChatProps) {
  const navigate=useNavigate();
  const companies=useQuery({
    queryKey:["chat","scope-companies",user.id],
    queryFn: async()=>{
      const first=await api<CompanyPage>("/companies?page=1&pageSize=100&sort=name:asc");
      const pages=Math.min(20,Math.ceil(first.total/100));
      if(pages<=1)return first.items;
      const rest=await Promise.all(Array.from({length:pages-1},(_,i)=>
        api<CompanyPage>(`/companies?page=${i+2}&pageSize=100&sort=name:asc`)));
      return [first,...rest].flatMap(page=>page.items);
    },
    staleTime:60000,
  });
  const available=companies.data??[];
  if(companies.isError)return <Notice tone="warning">تعذر تحميل قائمة شركات الدردشة. يمكنك فتح الشركة من قائمة الشركات والمحاولة مجددًا.</Notice>;
  if(!available.length)return null;
  const selected=scope==="company"&&companyId?"company:"+companyId:"global";
  return <div className="chat-scope-picker">
    <label htmlFor="chat-scope-select">اختر الدردشة</label>
    <select id="chat-scope-select" value={selected} onChange={event=>{
      const target=event.target.value;
      if(target==="global"){navigate("/chat");return;}
      const id=Number(target.slice("company:".length));
      if(target.startsWith("company:") && available.some(company=>company.id===id))
        navigate("/companies/"+id+"/chat");
    }}>
      <option value="global">الدردشة العامة — الرئيسي</option>
      {available.map((company:Company)=><option key={company.id} value={`company:${company.id}`}>{company.name}</option>)}
    </select>
  </div>;
}

function ChatWorkspace({ user, scope, companyId }: ChatProps) {
  const active = usePageActivity();
  const guard = useScopeGuard(`chat:${scope}:${companyId ?? "public"}`);
  const [peer, setPeer] = useState<ChatUser | null>(null);
  const [group, setGroup] = useState<ChatGroup | null>(null);
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim());
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [directorySearch, setDirectorySearch] = useState("");
  const deferredDirectorySearch = useDeferredValue(directorySearch.trim());
  const storageKey = `tijara:chat:v1:${user.id}:${scope}:${companyId ?? "public"}`;
  const [saved, setSaved] = useState(() => readSavedChat(storageKey));
  const savedRef = useRef(saved);
  const [storageFailed, setStorageFailed] = useState(false);
  const [previewReceiptError, setPreviewReceiptError] = useState<Error | null>(null);
  const deliveredPreviews = useRef(new Set<number>());
  const previewReceiptBusy = useRef(false);
  const updateSaved = useCallback((update: (previous: SavedChat) => SavedChat) => {
    const next = update(savedRef.current);
    savedRef.current = next;
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      setStorageFailed(true);
    }
    setSaved(next);
  }, [storageKey]);
  const scopeKey = useMemo(() => ["chat", user.id, scope, companyId ?? null] as const, [user.id, scope, companyId]);
  const conversations = useInfiniteQuery({
    queryKey: [...scopeKey, "conversations", deferredSearch],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) => api<ChatResultPage<ChatConversation>>(
      `/chat/conversations?${queryString(scope, companyId, { search: deferredSearch, cursor: pageParam })}`, { signal },
    ),
    getNextPageParam: page => page.nextCursor ?? undefined,
    refetchInterval: active ? 6_000 : false,
    retry: false,
  });
  const groups = useInfiniteQuery({
    queryKey: [...scopeKey, "groups", "list", deferredSearch],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) => api<ChatResultPage<ChatGroup>>(
      `/chat/groups?${queryString(scope, companyId, { search: deferredSearch, cursor: pageParam })}`, { signal },
    ),
    getNextPageParam: page => page.nextCursor ?? undefined,
    refetchInterval: active ? 6_000 : false,
    retry: false,
  });
  const groupRows = [...new Map((groups.data?.pages.flatMap(page => page.items) ?? []).map(item => [item.id, item])).values()];
  const directory = useInfiniteQuery({
    queryKey: [...scopeKey, "directory", deferredDirectorySearch],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) => api<ChatResultPage<ChatUser>>(
      `/chat/directory?${queryString(scope, companyId, { search: deferredDirectorySearch, cursor: pageParam })}`, { signal },
    ),
    getNextPageParam: page => page.nextCursor ?? undefined,
    enabled: directoryOpen,
    retry: false,
  });
  const acknowledgePreviews = useCallback(async () => {
    if (previewReceiptBusy.current || !guard.isCurrent() || conversations.error) return;
    const received = (conversations.data?.pages.flatMap(page => page.items) ?? []).filter(row =>
      row.lastMessage.recipientId === user.id && !row.lastMessage.deliveredAt && !deliveredPreviews.current.has(row.lastMessage.id),
    );
    previewReceiptBusy.current = true;
    try {
      for (const row of received) {
        await api(`/chat/conversations/${row.peer.id}/receipt`, {
          method: "POST", signal: guard.signal,
          body: { scope, ...(scope === "company" ? { companyId } : {}), deliveredMessageIds: [row.lastMessage.id], readMessageIds: [] },
        });
        if (!guard.isCurrent()) return;
        deliveredPreviews.current.add(row.lastMessage.id);
      }
      if (guard.isCurrent()) setPreviewReceiptError(null);
    } catch (error) {
      if (guard.isCurrent()) setPreviewReceiptError(error instanceof Error ? error : new Error("تعذر تحديث حالة الاستلام"));
    } finally {
      previewReceiptBusy.current = false;
    }
  // The scope guard itself stays valid until this keyed workspace unmounts.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations.data, conversations.error, companyId, scope, user.id]);
  useEffect(() => { void acknowledgePreviews(); }, [acknowledgePreviews, conversations.dataUpdatedAt]);
  const deliveredGroupPreviews = useRef(new Set<number>());
  const groupPreviewBusy = useRef(false);
  const [groupPreviewError, setGroupPreviewError] = useState<Error | null>(null);
  const acknowledgeGroupPreviews = useCallback(async () => {
    if (groupPreviewBusy.current || !guard.isCurrent() || groups.error) return;
    groupPreviewBusy.current = true;
    try {
      for (const item of groups.data?.pages.flatMap(page => page.items) ?? []) {
        const message = item.lastMessage;
        const ownReceipt = message?.receipts.find(receipt => receipt.userId === user.id);
        if (!message || !ownReceipt || ownReceipt.deliveredAt || deliveredGroupPreviews.current.has(message.id)) continue;
        await api(`/chat/groups/${item.id}/receipt`, {
          method: "POST", signal: guard.signal,
          body: { scope, ...(scope === "company" ? { companyId } : {}), deliveredMessageIds: [message.id], readMessageIds: [] },
        });
        if (!guard.isCurrent()) return;
        deliveredGroupPreviews.current.add(message.id);
      }
      if (guard.isCurrent()) setGroupPreviewError(null);
    } catch (error) {
      if (guard.isCurrent()) setGroupPreviewError(error instanceof Error ? error : new Error("تعذر تحديث استلام رسائل المجموعات"));
    } finally { groupPreviewBusy.current = false; }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups.data, groups.error, companyId, scope, user.id]);
  useEffect(() => { void acknowledgeGroupPreviews(); }, [acknowledgeGroupPreviews, groups.dataUpdatedAt]);
  const rows = useMemo(() => {
    if (accessDenied(conversations.error) || accessDenied(previewReceiptError)) return [];
    const result: { peer: ChatUser; lastMessage?: ChatMessage; unreadCount: number; pending?: PendingMessage }[] =
      conversations.data?.pages.flatMap(page => page.items) ?? [];
    const peerIds = new Set(result.map(row => row.peer.id));
    for (const pending of [...saved.pending].reverse()) {
      if (!peerIds.has(pending.peer.id) && (!deferredSearch || pending.peer.name.includes(deferredSearch))) {
        result.unshift({ peer: pending.peer, unreadCount: 0, pending });
        peerIds.add(pending.peer.id);
      }
    }
    return result;
  }, [conversations.data, conversations.error, previewReceiptError, saved.pending, deferredSearch]);
  const openDirectory = () => {
    setDirectorySearch("");
    setDirectoryOpen(true);
  };
  const selectedPeer = peer ? rows.find(row => row.peer.id === peer.id)?.peer ?? peer : null;
  return (
    <div className="chat-page" dir="rtl" data-chat-scope={scope}>
      <PageHeader
        title={scope === "global" ? "دردشة الرئيسي" : "دردشة الشركة"}
        description={scope === "global" ? "محادثاتك العامة" : "محادثات أعضاء الشركة"}
        actions={<span className="chat-scope-badge">{scope === "global" ? <Globe2 size={15} /> : <Users size={15} />}{scope === "global" ? "مستخدمو الرئيسي" : "أعضاء الشركة"}</span>}
      />
      {storageFailed && <Notice tone="warning">تعذر حفظ المسودات على هذا الجهاز. أبقِ الصفحة مفتوحة حتى يتأكد إرسال رسائلك.</Notice>}
      <div className={`chat-shell ${peer || group ? "chat-shell-selected" : ""}`}>
        <aside className="chat-sidebar" aria-label="المحادثات">
          <div className="chat-sidebar-heading">
            <div><h2>المحادثات</h2><small>مساحتك للتواصل المباشر</small></div>
          </div>
          <div className="chat-sidebar-actions"><Button variant="secondary" size="compact" onClick={openDirectory} aria-label="محادثة جديدة"><MessageSquarePlus size={15} />محادثة جديدة</Button><Button variant="secondary" size="compact" onClick={() => setCreateGroupOpen(true)}><Users size={15} />إنشاء مجموعة</Button></div>
          <div className="chat-search"><Search size={16} /><input aria-label="البحث في المحادثات" placeholder="ابحث في محادثاتك…" maxLength={100} value={search} onChange={event => setSearch(event.target.value)} /></div>
          {conversations.error && <div className="chat-inline-notice"><Notice tone="error">{errorText(conversations.error)}<Button variant="ghost" size="compact" onClick={() => void conversations.refetch()}>إعادة المحاولة</Button></Notice></div>}
          {previewReceiptError && <div className="chat-inline-notice"><Notice tone="error">{errorText(previewReceiptError)}<Button variant="ghost" size="compact" onClick={() => void acknowledgePreviews()}>إعادة المحاولة</Button></Notice></div>}
          <div className="chat-conversations" aria-busy={conversations.isFetching}>
            <h3 className="chat-list-section-title">المجموعات</h3>
            {(groups.error || groupPreviewError) && <Notice tone="error">{errorText(groups.error ?? groupPreviewError)}<Button variant="ghost" size="compact" onClick={() => { void groups.refetch(); void acknowledgeGroupPreviews(); }}>إعادة المحاولة</Button></Notice>}
            {!groups.error && !accessDenied(groupPreviewError) && groupRows.map(item => <button key={item.id} className={`chat-conversation ${group?.id === item.id ? "chat-conversation-selected" : ""}`} aria-label={`فتح مجموعة ${item.name}`} aria-current={group?.id === item.id ? "true" : undefined} onClick={() => { setGroup(item); setPeer(null); }}><span className="chat-avatar chat-group-avatar" aria-hidden="true"><Users size={20} /></span><span className="chat-conversation-copy"><span className="chat-conversation-title"><strong>{item.name}</strong><small className="muted">{item.memberCount} أعضاء</small></span><span className="chat-conversation-preview">{item.lastMessage ? `${item.lastMessage.senderName}: ${item.lastMessage.text}` : "ابدأ أول رسالة في المجموعة"}</span></span>{item.unreadCount > 0 && <span className="chat-unread" aria-label={`${item.unreadCount} رسائل مجموعة غير مقروءة`}>{item.unreadCount > 99 ? "+99" : item.unreadCount.toLocaleString("ar")}</span>}</button>)}
            {!groups.error && !groups.isPending && !groups.data?.pages.some(page => page.items.length) && <p className="chat-groups-empty">{search ? "لا توجد مجموعة تطابق البحث" : "أنشئ مجموعة لتجمع فريقك في محادثة واحدة"}</p>}
            {groups.isPending && <p className="chat-groups-empty">جارٍ تحميل المجموعات…</p>}
            {groups.hasNextPage && <Button className="chat-load-more" variant="ghost" size="compact" disabled={groups.isFetchingNextPage} onClick={() => void groups.fetchNextPage()}>عرض مجموعات أخرى</Button>}
            <h3 className="chat-list-section-title">الرسائل الخاصة</h3>
            {rows.map(row => (
              <button className={`chat-conversation ${peer?.id === row.peer.id ? "chat-conversation-selected" : ""}`} key={row.peer.id} onClick={() => { setPeer(row.peer); setGroup(null); }} aria-label={`فتح محادثة ${row.peer.name}`} aria-current={peer?.id === row.peer.id ? "true" : undefined}>
                <ChatAvatar name={row.peer.name} avatarUrl={row.peer.avatarUrl} />
                <span className="chat-conversation-copy"><span className="chat-conversation-title"><strong>{row.peer.name}</strong><time dateTime={row.lastMessage?.createdAt ?? row.pending?.createdAt}>{row.lastMessage ? timeFormat.format(new Date(row.lastMessage.createdAt)) : ""}</time></span><span className="chat-conversation-preview">{row.lastMessage?.senderId === user.id && <Check size={12} />}{row.lastMessage?.text ?? row.pending?.text}</span></span>
                {row.unreadCount > 0 && <span className="chat-unread" aria-label={`${row.unreadCount} رسائل غير مقروءة`}>{row.unreadCount > 99 ? "+99" : row.unreadCount.toLocaleString("ar")}</span>}
              </button>
            ))}
            {!rows.length && !conversations.error && <div className="chat-sidebar-empty">{conversations.isPending ? <><LoaderCircle size={24} className="chat-spinner" />جارٍ تحميل المحادثات…</> : <><MessageCircle size={30} /><strong>{search ? "لا توجد محادثة تطابق البحث" : "ابدأ أول محادثة"}</strong><span>{search ? "جرّب اسمًا آخر." : "اختر مستخدمًا وابدأ التواصل."}</span>{!search && <Button variant="secondary" size="compact" onClick={openDirectory}>محادثة جديدة</Button>}</>}</div>}
            {conversations.hasNextPage && <Button className="chat-load-more" variant="ghost" size="compact" disabled={conversations.isFetchingNextPage} onClick={() => void conversations.fetchNextPage()}>عرض محادثات أقدم</Button>}
          </div>
          <div className="chat-sidebar-footer"><ShieldCheck size={14} /><span>المحادثات خاصة بالمشاركين فيها</span></div>
        </aside>
        {group ? <GroupChatPanel key={group.id} user={user} scope={scope} companyId={companyId} groupId={group.id} obscured={directoryOpen || createGroupOpen} onBack={() => setGroup(null)} /> : selectedPeer ? <ConversationPanel key={selectedPeer.id} user={user} scope={scope} companyId={companyId} peer={selectedPeer} saved={saved} updateSaved={updateSaved} obscured={directoryOpen || createGroupOpen} onBack={() => setPeer(null)} /> : (
          <section className="chat-welcome" aria-label="اختر محادثة">
            <span className="chat-welcome-icon"><MessageCircle size={38} strokeWidth={1.5} /></span>
            <span className="chat-eyebrow">تواصل أوضح، وعمل أقرب</span>
            <h2>كل محادثة تبدأ برسالة</h2>
            <p>اختر محادثة من القائمة أو ابدأ محادثة جديدة.<br />تابع استلام رسائلك وعرضها من مكان واحد.</p>
            <Button onClick={openDirectory}><MessageSquarePlus size={17} />محادثة جديدة</Button>
            <div className="chat-receipt-guide"><span><CheckCheck size={15} />تم الاستلام</span><span><CheckCheck size={15} />تم العرض</span></div>
          </section>
        )}
      </div>
      <Dialog open={directoryOpen} onClose={() => setDirectoryOpen(false)} title="محادثة جديدة" className="chat-directory-dialog">
        <p className="chat-directory-description">{scope === "global" ? "ابحث عن مستخدم في الرئيسي لبدء محادثة خاصة." : "اختر أحد أعضاء الشركة لبدء محادثة خاصة."}</p>
        <Field autoFocus label="البحث عن مستخدم" placeholder="اكتب الاسم…" maxLength={100} value={directorySearch} onChange={event => setDirectorySearch(event.target.value)} />
        {directory.error && <Notice tone="error">{errorText(directory.error)}<Button variant="ghost" size="compact" onClick={() => void directory.refetch()}>إعادة المحاولة</Button></Notice>}
        <div className="chat-directory-list" aria-busy={directory.isFetching}>
          {!directory.error && directory.data?.pages.flatMap(page => page.items).map(person => <button key={person.id} className="chat-directory-user" aria-label={`بدء محادثة مع ${person.name}`} onClick={() => { setPeer(person); setGroup(null); setDirectoryOpen(false); }}><ChatAvatar name={person.name} avatarUrl={person.avatarUrl} /><strong>{person.name}</strong><MessageCircle size={17} /></button>)}
          {!directory.error && !(directory.data?.pages.some(page => page.items.length)) && <div className="chat-sidebar-empty">{directory.isPending ? "جارٍ البحث…" : "لا يوجد مستخدم يطابق البحث"}</div>}
          {directory.hasNextPage && <Button variant="ghost" disabled={directory.isFetchingNextPage} onClick={() => void directory.fetchNextPage()}>عرض المزيد</Button>}
        </div>
      </Dialog>
      <ChatGroupCreateDialog open={createGroupOpen} onClose={() => setCreateGroupOpen(false)} user={user} scope={scope} companyId={companyId} onCreated={created => { setGroup(created); setPeer(null); setCreateGroupOpen(false); }} />
    </div>
  );
}

function ConversationPanel({ user, scope, companyId, peer, saved, updateSaved, obscured, onBack }: ChatProps & {
  peer: ChatUser;
  saved: SavedChat;
  updateSaved: (update: (previous: SavedChat) => SavedChat) => void;
  obscured: boolean;
  onBack: () => void;
}) {
  const client = useQueryClient();
  const guard = useScopeGuard(`chat:${scope}:${companyId ?? "public"}:${peer.id}`);
  const active = usePageActivity();
  const scopeKey = useMemo(() => ["chat", user.id, scope, companyId ?? null] as const, [user.id, scope, companyId]);
  const messageKey = useMemo(() => [...scopeKey, "messages", peer.id] as const, [scopeKey, peer.id]);
  const feed = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const nearBottom = useRef(true);
  const firstScroll = useRef(true);
  const olderScroll = useRef<{ height: number; top: number } | null>(null);
  const [newMessages, setNewMessages] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [sendingIds, setSendingIds] = useState<Set<string>>(() => new Set());
  const sendingRef = useRef(new Set<string>());
  const [sendErrors, setSendErrors] = useState<Record<string, string>>({});
  const [receiptError, setReceiptError] = useState<Error | null>(null);
  const deliveredQueue = useRef(new Set<number>());
  const readQueue = useRef(new Set<number>());
  const receiptBusy = useRef(false);
  const messages = useInfiniteQuery({
    queryKey: messageKey,
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) => api<ChatResultPage<ChatMessage>>(
      `/chat/conversations/${peer.id}/messages?${queryString(scope, companyId, { cursor: pageParam })}`, { signal },
    ),
    getNextPageParam: page => page.nextCursor ?? undefined,
    refetchInterval: active ? query => (query.state.data?.pages.length ?? 1) > 1 ? 10_000 : 4_000 : false,
    retry: false,
  });
  const denied = accessDenied(messages.error) || accessDenied(receiptError);
  const items = useMemo(() => {
    if (denied) return [];
    const unique = new Map((messages.data?.pages.flatMap(page => page.items) ?? []).map(message => [message.id, message]));
    return [...unique.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
  }, [messages.data, denied]);
  const pending = saved.pending.filter(message => message.peer.id === peer.id && !items.some(item => item.clientMessageId === message.clientMessageId));
  const draft = saved.drafts[String(peer.id)] ?? "";
  const ownAvatarUrl = ownChatAvatarUrl(user, scope, companyId);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const latestId = items.at(-1)?.id;
  const scrollToBottom = () => {
    if (feed.current) feed.current.scrollTop = feed.current.scrollHeight;
    nearBottom.current = true;
    setNewMessages(false);
  };
  useLayoutEffect(() => {
    const element = feed.current;
    if (!element) return;
    if (olderScroll.current) {
      element.scrollTop = olderScroll.current.top + element.scrollHeight - olderScroll.current.height;
      olderScroll.current = null;
    } else if (firstScroll.current || nearBottom.current) {
      scrollToBottom();
      if (items.length) firstScroll.current = false;
    } else if (latestId) setNewMessages(true);
  }, [latestId, items.length, pending.length]);
  useEffect(() => {
    const accepted = new Set(items.filter(message => message.senderId === user.id).map(message => message.clientMessageId));
    if (saved.pending.some(message => accepted.has(message.clientMessageId))) {
      updateSaved(previous => ({ ...previous, pending: previous.pending.filter(message => !accepted.has(message.clientMessageId)) }));
    }
  }, [items, saved.pending, updateSaved, user.id]);

  const flushReceipts = useCallback(async () => {
    if (receiptBusy.current || !guard.isCurrent() || denied) return;
    receiptBusy.current = true;
    try {
      // Each successful batch drains before the next; failures remain for an explicit/poll retry.
      while (deliveredQueue.current.size || readQueue.current.size) {
        const deliveredMessageIds = [...deliveredQueue.current].slice(0, 100);
        const readMessageIds = [...readQueue.current].slice(0, 100);
        const result = await api<{ messages: ChatMessage[] }>(`/chat/conversations/${peer.id}/receipt`, {
          method: "POST", signal: guard.signal,
          body: { scope, ...(scope === "company" ? { companyId } : {}), deliveredMessageIds, readMessageIds },
        });
        if (!guard.isCurrent()) return;
        deliveredMessageIds.forEach(id => deliveredQueue.current.delete(id));
        readMessageIds.forEach(id => readQueue.current.delete(id));
        const updated = new Map(result.messages.map(message => [message.id, message]));
        client.setQueryData<InfiniteData<ChatResultPage<ChatMessage>>>(messageKey, previous => previous && ({
          ...previous, pages: previous.pages.map(page => ({ ...page, items: page.items.map(message => updated.get(message.id) ?? message) })),
        }));
        setReceiptError(null);
        if (readMessageIds.length) void client.invalidateQueries({ queryKey: [...scopeKey, "conversations"] });
      }
    } catch (error) {
      if (guard.isCurrent()) setReceiptError(error instanceof Error ? error : new Error("تعذر تحديث حالة الرسائل"));
    } finally {
      receiptBusy.current = false;
    }
  // The guard getters use the current scope; its object need not restart effects on each render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, companyId, scope, peer.id, messageKey, scopeKey, denied]);
  useEffect(() => {
    if (messages.error || denied) return;
    items.forEach(message => {
      if (message.recipientId === user.id && !message.deliveredAt) deliveredQueue.current.add(message.id);
    });
    void flushReceipts();
  }, [items, messages.dataUpdatedAt, messages.error, denied, flushReceipts, user.id]);
  useEffect(() => {
    const element = feed.current;
    if (!element || !active || obscured || emojiOpen || messages.error || denied || !window.IntersectionObserver) return;
    const observer = new IntersectionObserver(entries => {
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      entries.forEach(entry => {
        const box = entry.intersectionRect;
        const visibleElement = box.width > 0 && box.height > 0
          ? document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
          : null;
        if (entry.isIntersecting && (entry.intersectionRatio >= 0.5 || box.height >= 80) && visibleElement && entry.target.contains(visibleElement)) {
          const id = Number((entry.target as HTMLElement).dataset.chatMessageId);
          if (id) readQueue.current.add(id);
        }
      });
      void flushReceipts();
    }, { root: element, threshold: [0, 0.5, 1] });
    element.querySelectorAll('[data-chat-unread="true"]').forEach(node => observer.observe(node));
    return () => observer.disconnect();
  }, [items, active, obscured, emojiOpen, messages.error, denied, flushReceipts]);

  const sendPending = async (message: PendingMessage) => {
    if (sendingRef.current.has(message.clientMessageId) || denied) return;
    sendingRef.current.add(message.clientMessageId);
    setSendingIds(new Set(sendingRef.current));
    setSendErrors(previous => ({ ...previous, [message.clientMessageId]: "" }));
    try {
      const result = await api<{ message: ChatMessage }>(`/chat/conversations/${peer.id}/messages`, {
        method: "POST", signal: guard.signal,
        body: { scope, ...(scope === "company" ? { companyId } : {}), clientMessageId: message.clientMessageId, text: message.text },
      });
      if (!guard.isCurrent()) return;
      client.setQueryData<InfiniteData<ChatResultPage<ChatMessage>>>(messageKey, previous => {
        if (!previous) return { pages: [{ items: [result.message], nextCursor: null }], pageParams: [null] };
        const first = previous.pages[0];
        return { ...previous, pages: [{ ...first, items: [result.message, ...first.items.filter(item => item.id !== result.message.id)] }, ...previous.pages.slice(1)] };
      });
      updateSaved(previous => ({ ...previous, pending: previous.pending.filter(item => item.clientMessageId !== message.clientMessageId) }));
      void client.invalidateQueries({ queryKey: [...scopeKey, "conversations"] });
      nearBottom.current = true;
      composer.current?.focus();
    } catch (error) {
      if (guard.isCurrent()) setSendErrors(previous => ({ ...previous, [message.clientMessageId]: errorText(error) }));
    } finally {
      sendingRef.current.delete(message.clientMessageId);
      if (guard.isCurrent()) setSendingIds(new Set(sendingRef.current));
    }
  };
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const currentDraft = draftRef.current;
    if (!currentDraft.trim() || currentDraft.length > 4_000 || denied || messages.isPending) return;
    const message: PendingMessage = { clientMessageId: crypto.randomUUID(), text: currentDraft.trim(), peer, createdAt: new Date().toISOString() };
    draftRef.current = "";
    // Persist the frozen UUID/payload before starting the request so an uncertain response is retryable.
    updateSaved(previous => ({ drafts: { ...previous.drafts, [peer.id]: "" }, pending: [...previous.pending, message] }));
    nearBottom.current = true;
    void sendPending(message);
  };
  let previousDay = "";
  return (
    <section className="chat-thread" aria-label={`المحادثة مع ${peer.name}`}>
      <header className="chat-thread-heading">
        <Button variant="ghost" className="chat-mobile-back" size="compact" onClick={onBack} aria-label="العودة إلى المحادثات"><ArrowRight size={20} /></Button>
        <ChatAvatar name={peer.name} avatarUrl={peer.avatarUrl} size="small" />
        <div className="chat-peer-heading"><h2>{peer.name}</h2><small>{scope === "global" ? "محادثة خاصة · مستخدم الرئيسي" : "محادثة خاصة · داخل الشركة"}</small></div>
        <ShieldCheck size={17} className="chat-thread-shield" aria-label="محادثة خاصة بين الطرفين" />
      </header>
      {(messages.error || receiptError) && <div className="chat-thread-alert"><Notice tone="error">{errorText(messages.error ?? receiptError)}<Button variant="ghost" size="compact" onClick={() => {
        void messages.refetch().then(result => { if (!result.error && guard.isCurrent()) setReceiptError(null); });
      }}><RefreshCw size={13} />إعادة المحاولة</Button></Notice></div>}
      <div className="chat-feed-wrap">
        <div className="chat-feed" ref={feed} onScroll={() => {
          const element = feed.current;
          if (!element) return;
          nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 90;
          if (nearBottom.current) setNewMessages(false);
        }} aria-label="الرسائل" aria-busy={messages.isFetching}>
          {messages.hasNextPage && !denied && <Button className="chat-load-more" variant="secondary" size="compact" disabled={messages.isFetchingNextPage} onClick={() => {
            if (feed.current) olderScroll.current = { height: feed.current.scrollHeight, top: feed.current.scrollTop };
            void messages.fetchNextPage().then(result => { if (result.isError) olderScroll.current = null; });
          }}>{messages.isFetchingNextPage ? "جارٍ التحميل…" : "تحميل رسائل أقدم"}</Button>}
          {messages.isPending && <div className="chat-thread-empty"><LoaderCircle className="chat-spinner" size={25} />جارٍ تحميل الرسائل…</div>}
          {!messages.isPending && !messages.error && !items.length && !pending.length && !denied && <div className="chat-thread-empty"><MessageCircle size={30} /><strong>قل مرحبًا لـ{peer.name}</strong><p>اكتب رسالتك الأولى لبدء المحادثة.</p></div>}
          {items.map(message => {
            const day = dateFormat.format(new Date(message.createdAt));
            const showDay = day !== previousDay;
            previousDay = day;
            const own = message.senderId === user.id;
            return <div className="chat-message-group" key={message.id}>{showDay && <div className="chat-day"><span>{day}</span></div>}<article className={`chat-message ${own ? "chat-message-own" : "chat-message-incoming"}`} data-chat-message-id={message.id} data-chat-unread={!own && !message.readAt ? "true" : undefined} aria-label={`${own ? "أنت" : peer.name}: ${message.text}`}><div className="chat-message-sender"><ChatAvatar name={own ? user.displayName || user.name : peer.name} avatarUrl={own ? ownAvatarUrl : peer.avatarUrl} size="tiny" /><strong>{own ? "أنت" : peer.name}</strong></div><p dir="auto">{message.text}</p><div className="chat-message-meta"><time dateTime={message.createdAt}>{timeFormat.format(new Date(message.createdAt))}</time>{own && <Receipt message={message} />}</div></article></div>;
          })}
          {!denied && pending.map(message => <article key={message.clientMessageId} className="chat-message chat-message-own chat-message-pending" data-chat-pending-id={message.clientMessageId}><p dir="auto">{message.text}</p><div className="chat-message-meta"><time dateTime={message.createdAt}>{timeFormat.format(new Date(message.createdAt))}</time><span className="chat-receipt">{sendingIds.has(message.clientMessageId) ? <><Clock3 size={13} />جارٍ الإرسال…</> : <><CircleAlert size={13} />لم يتأكد الإرسال</>}</span></div>{!sendingIds.has(message.clientMessageId) && <div className="chat-send-error"><span>{sendErrors[message.clientMessageId] || "يمكنك إعادة المحاولة بنفس الرسالة."}</span><Button variant="ghost" size="compact" aria-label="إعادة إرسال الرسالة" onClick={() => void sendPending(message)}><RefreshCw size={13} />إعادة الإرسال</Button></div>}</article>)}
        </div>
        {newMessages && <Button className="chat-jump-latest" variant="secondary" size="compact" onClick={scrollToBottom}><ArrowDown size={14} />أحدث الرسائل</Button>}
      </div>
      <form className="chat-composer" onSubmit={submit}>
        <div className="chat-composer-row"><textarea ref={composer} aria-label="نص الرسالة" placeholder="اكتب رسالتك…" dir="auto" rows={2} maxLength={4_000} value={draft} disabled={denied} onChange={event => {
          const value = event.target.value;
          draftRef.current = value;
          updateSaved(previous => ({ ...previous, drafts: { ...previous.drafts, [peer.id]: value } }));
        }} onKeyDown={event => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); }
        }} /><ChatEmojiPicker textareaRef={composer} value={draft} disabled={denied} obscured={obscured} onOpenChange={setEmojiOpen} onChange={text => {
          draftRef.current = text;
          updateSaved(previous => ({ ...previous, drafts: { ...previous.drafts, [peer.id]: text } }));
        }} /><Button type="submit" className="chat-send-button" disabled={!draft.trim() || denied || messages.isPending} aria-label="إرسال الرسالة" title="إرسال الرسالة"><Send size={19} /></Button></div>
        <div className="chat-composer-hint"><span>Enter للإرسال · Shift + Enter لسطر جديد</span>{draft.length > 3_500 && <span>{draft.length.toLocaleString("ar")} / ٤٬٠٠٠</span>}</div>
      </form>
    </section>
  );
}
