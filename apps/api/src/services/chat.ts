import type { PoolClient, QueryResultRow } from "pg";
import { z } from "zod";
import type {
  ChatContext, ChatConversation, ChatMessage, ChatPage, ChatReceiptInput,
  ChatSendInput, ChatUser, User,
} from "../../../../packages/contracts/src/index.ts";
import { companyAccess, currentActor } from "../policies/access.ts";
import { pageByKey, pageRuleAllows } from "../../../../packages/contracts/src/index.ts";
import { HttpError, deny, missing } from "../errors.ts";
import { assertDirectoryAccess, directoryEntries } from "./pages.ts";
import { audit } from "./audit.ts";
import { searchPattern } from "./lists.ts";
import { pagePermissionAliases, permissionRuleEffects } from "./permission-rules.ts";
import { chatAvatarUrls } from "./chat-avatars.ts";
import { notifyChatRecipient } from "./chat-notifications.ts";
import { checkChatImage, checkChatImageAllowed } from "./chat-images.ts";

export interface ChatListQuery extends ChatContext {
  search: string;
  cursor?: string;
  limit: number;
}
interface Access {
  user: User;
  companyId: number | null;
  scopeId: number;
}
const messageDTO = (row: QueryResultRow): ChatMessage => ({
  id: row.id,
  clientMessageId: row.client_message_id,
  senderId: row.sender_id,
  recipientId: row.recipient_id,
  text: row.text,
  imageUrl: row.image_id ? `/api/media/${row.image_id}/full` : null,
  createdAt: row.created_at.toISOString(),
  deliveredAt: row.delivered_at?.toISOString() ?? null,
  readAt: row.read_at?.toISOString() ?? null,
});
const peerDTO = (row: QueryResultRow, avatars: Map<number, string> = new Map()): ChatUser => ({
  id: row.peer_id ?? row.id,
  name: row.peer_name ?? row.display_name,
  avatarUrl: avatars.get(row.peer_id ?? row.id) ?? null,
});
const receiptDTO = (row: QueryResultRow) => ({
  id: row.id,
  deliveredAt: row.delivered_at?.toISOString() ?? null,
  readAt: row.read_at?.toISOString() ?? null,
});

/** No management role can substitute for either conversation participant. */
async function access(
  client: PoolClient, actor: User, context: ChatContext,
  action: "view" | "create" = "view", write = false, requireEnabled = true,
): Promise<Access> {
  const user = await currentActor(client, actor, false);
  if (user.suspended) deny("الحساب موقوف عن المشاركة");
  const companyId = context.scope === "company" ? context.companyId! : null;
  const companyContext = companyId !== null
    ? await companyAccess(client, user, companyId, undefined, write) : null;
  const pageKey = companyId === null ? "public.chat" : "company.chat";
  // Page settings writers take this same registry row FOR UPDATE.
  if (write)
    await client.query("SELECT key FROM page_registry WHERE key=$1 FOR SHARE", [pageKey]);
  if (!requireEnabled) {
    // Accepted UUID confirmation survives a flag change, while identity,
    // current membership and explicit action denies remain authoritative.
    const definition = pageByKey(pageKey);
    const effects = companyContext?.employee && !companyContext.general
      ? await permissionRuleEffects(client, companyId!, companyContext.employee.id)
      : new Map<string, "allow" | "deny">();
    for (const required of action === "view" ? ["view"] as const : ["view", "create"] as const) {
      if (!definition || !pageRuleAllows(definition.actions[required], user, companyContext) ||
        (!companyContext?.general && pagePermissionAliases(pageKey, required)
          .some(key => effects.get(key) === "deny"))) deny();
    }
    return { user, companyId, scopeId: companyId ?? 0 };
  }
  const entry = (await directoryEntries(client, user, companyId))
    .find(entry => entry.key === pageKey);
  if (!entry) deny();
  assertDirectoryAccess(entry, "view");
  if (action !== "view") assertDirectoryAccess(entry, action);
  return { user, companyId, scopeId: companyId ?? 0 };
}

function eligiblePeer(alias: string, companyParameter = "$2"): string {
  return `NOT ${alias}.archived AND NOT ${alias}.suspended AND
    (${companyParameter}::integer IS NULL OR ${alias}.owner OR EXISTS
      (SELECT 1 FROM employees membership WHERE membership.company_id=${companyParameter}
       AND membership.user_id=${alias}.id AND membership.active))`;
}
async function peer(
  client: PoolClient, current: Access, peerId: number, lock = false, requireEligible = true,
): Promise<ChatUser> {
  if (peerId === current.user.id)
    throw new HttpError(400, "invalid_peer", "اختر مستخدمًا آخر للدردشة");
  const row = (await client.query(
    `SELECT u.id,u.display_name FROM users u WHERE u.id=$1
     AND ($3::boolean=false OR (${eligiblePeer("u")}))
     ${lock ? "FOR SHARE OF u" : ""}`,
    [peerId, current.companyId, requireEligible],
  )).rows[0];
  if (!row) missing("المستخدم غير متاح للدردشة في هذا النطاق");
  if (lock && requireEligible && current.companyId !== null)
    await client.query(
      "SELECT id FROM employees WHERE company_id=$1 AND user_id=$2 AND active FOR SHARE",
      [current.companyId, peerId],
    );
  return peerDTO(row);
}
async function conversation(client: PoolClient, current: Access, peerId: number) {
  return (await client.query(
    `SELECT id FROM chat_conversations WHERE scope_id=$1
     AND user_low_id=least($2::integer,$3::integer)
     AND user_high_id=greatest($2::integer,$3::integer)`,
    [current.scopeId, current.user.id, peerId],
  )).rows[0]?.id as number | undefined;
}

const cursorSchema = z.object({
  version: z.literal(1),
  kind: z.enum(["directory", "conversations", "messages"]),
  actorId: z.number().int().positive(),
  scopeId: z.number().int().nonnegative(),
  peerId: z.number().int().positive().nullable(),
  search: z.string().max(100),
  id: z.number().int().positive().max(2_147_483_647),
  at: z.iso.datetime({ precision: 3 }).nullable(),
}).strict();
type Cursor = z.infer<typeof cursorSchema>;
function cursor(
  value: string | undefined, kind: Cursor["kind"], current: Access,
  query: ChatListQuery, peerId: number | null = null,
): Cursor | null {
  if (!value) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 1_024) throw new Error();
    const decoded = cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (decoded.kind !== kind || decoded.actorId !== current.user.id ||
      decoded.scopeId !== current.scopeId || decoded.peerId !== peerId ||
      decoded.search !== query.search ||
      (kind === "conversations") !== (decoded.at !== null)) throw new Error();
    return decoded;
  } catch {
    throw new HttpError(400, "invalid_cursor", "مؤشر التصفح غير صالح لهذا النطاق");
  }
}
function nextCursor(
  kind: Cursor["kind"], current: Access, query: ChatListQuery,
  id: number, at: string | null = null, peerId: number | null = null,
): string {
  return Buffer.from(JSON.stringify({
    version: 1, kind, actorId: current.user.id, scopeId: current.scopeId,
    peerId, search: query.search, id, at,
  } satisfies Cursor)).toString("base64url");
}

export async function chatDirectory(
  client: PoolClient, actor: User, query: ChatListQuery,
): Promise<ChatPage<ChatUser>> {
  const current = await access(client, actor, query);
  const after = cursor(query.cursor, "directory", current, query);
  const rows = (await client.query(
    `SELECT u.id,u.display_name FROM users u WHERE u.id<>$1 AND ${eligiblePeer("u")}
     AND ($3='' OR u.display_name ILIKE $4 ESCAPE '\\')
     AND ($5::integer IS NULL OR u.id>$5) ORDER BY u.id LIMIT $6`,
    [current.user.id, current.companyId, query.search, searchPattern(query.search),
      after?.id ?? null, query.limit + 1],
  )).rows;
  const page = rows.slice(0, query.limit);
  const avatars = await chatAvatarUrls(client, current.companyId, page.map(row => row.id));
  const items = page.map(row => peerDTO(row, avatars));
  return { items, nextCursor: rows.length > query.limit
    ? nextCursor("directory", current, query, items.at(-1)!.id) : null };
}

export async function chatConversations(
  client: PoolClient, actor: User, query: ChatListQuery,
): Promise<ChatPage<ChatConversation>> {
  const current = await access(client, actor, query);
  const after = cursor(query.cursor, "conversations", current, query);
  const rows = (await client.query(
    `SELECT c.id AS conversation_id,c.updated_at,u.id AS peer_id,u.display_name AS peer_name,
       m.*,(SELECT count(*)::integer FROM chat_messages unread
         WHERE unread.conversation_id=c.id AND unread.recipient_id=$1 AND unread.read_at IS NULL) AS unread_count
     FROM chat_conversations c
     JOIN users u ON u.id=CASE WHEN c.user_low_id=$1 THEN c.user_high_id ELSE c.user_low_id END
     JOIN LATERAL (SELECT * FROM chat_messages history WHERE history.conversation_id=c.id ORDER BY history.id DESC LIMIT 1) m ON true
     WHERE c.scope_id=$2 AND (c.user_low_id=$1 OR c.user_high_id=$1)
       AND ($3='' OR u.display_name ILIKE $4 ESCAPE '\\')
       AND ($5::timestamptz IS NULL OR (c.updated_at,c.id)<($5::timestamptz,$6::integer))
     ORDER BY c.updated_at DESC,c.id DESC LIMIT $7`,
    [current.user.id, current.scopeId, query.search,
      searchPattern(query.search), after?.at ?? null, after?.id ?? null, query.limit + 1],
  )).rows;
  const page = rows.slice(0, query.limit);
  const avatars = await chatAvatarUrls(client, current.companyId, page.map(row => row.peer_id));
  return {
    items: page.map(row => ({ peer: peerDTO(row, avatars), lastMessage: messageDTO(row), unreadCount: row.unread_count })),
    nextCursor: rows.length > query.limit ? nextCursor("conversations", current, query,
      page.at(-1)!.conversation_id, page.at(-1)!.updated_at.toISOString()) : null,
  };
}

export async function readChatAvatar(
  client: PoolClient, actor: User, context: ChatContext, userId: number, assetId: string,
) {
  const current = await access(client, actor, context);
  // Self is intentionally allowed, unlike starting a direct conversation.
  const asset = (await client.query(
    `SELECT asset.thumbnail_mime,asset.thumbnail_bytes FROM users u JOIN media_assets asset
       ON asset.uploaded_by=u.id AND asset.purpose='avatar' AND asset.company_id IS NULL
       AND u.image='/api/media/'||asset.id::text||'/full'
     WHERE u.id=$1 AND ${eligiblePeer("u")} AND asset.id=$3::uuid`,
    [userId, current.companyId, assetId],
  )).rows[0];
  if (!asset) missing("الصورة غير متاحة في هذا النطاق");
  return asset;
}

export async function chatMessages(
  client: PoolClient, actor: User, peerId: number, query: ChatListQuery,
): Promise<ChatPage<ChatMessage>> {
  const current = await access(client, actor, query);
  await peer(client, current, peerId, false, false);
  const after = cursor(query.cursor, "messages", current, query, peerId);
  const conversationId = await conversation(client, current, peerId);
  if (conversationId === undefined) return { items: [], nextCursor: null };
  const rows = (await client.query(
    `SELECT * FROM chat_messages WHERE conversation_id=$1
     AND ($2::integer IS NULL OR id<$2) ORDER BY id DESC LIMIT $3`,
    [conversationId, after?.id ?? null, query.limit + 1],
  )).rows;
  const items = rows.slice(0, query.limit).map(messageDTO);
  return { items, nextCursor: rows.length > query.limit
    ? nextCursor("messages", current, query, items.at(-1)!.id, null, peerId) : null };
}

export async function sendChatMessage(
  client: PoolClient, actor: User, peerId: number, input: ChatSendInput,
): Promise<ChatMessage> {
  // Deterministic shared identity locks avoid opposite-direction send deadlocks
  // and serialize against concurrent archive/suspension changes.
  await client.query("SELECT id FROM users WHERE id=ANY($1::integer[]) ORDER BY id FOR SHARE", [[actor.id, peerId]]);
  const current = await access(client, actor, input, "create", true, false);
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `chat-send:${current.scopeId}:${input.clientMessageId}`,
  ]);
  const accepted = (await client.query(
    "SELECT * FROM chat_messages WHERE scope_id=$1 AND client_message_id=$2",
    [current.scopeId, input.clientMessageId],
  )).rows[0];
  if (accepted) {
    if (accepted.sender_id !== current.user.id || accepted.recipient_id !== peerId || accepted.text !== input.text || (accepted.image_id ?? null) !== (input.imageId ?? null))
      throw new HttpError(409, "idempotency_conflict", "استُخدم معرّف الرسالة لطلب مختلف");
    return messageDTO(accepted);
  }
  await access(client, actor, input, "create", true);
  await peer(client, current, peerId, true);
  if (input.imageId) { await checkChatImageAllowed(client, "direct"); await checkChatImage(client, input.imageId, current.user.id, current.companyId); }
  const thread = (await client.query(
    `INSERT INTO chat_conversations(company_id,user_low_id,user_high_id,created_at,updated_at)
     VALUES($1,least($2::integer,$3::integer),greatest($2::integer,$3::integer),
       date_trunc('milliseconds',clock_timestamp()),date_trunc('milliseconds',clock_timestamp()))
     ON CONFLICT(scope_id,user_low_id,user_high_id) DO UPDATE
       SET updated_at=chat_conversations.updated_at RETURNING id`,
    [current.companyId, current.user.id, peerId],
  )).rows[0];
  const row = (await client.query(
    `INSERT INTO chat_messages(conversation_id,scope_id,client_message_id,sender_id,recipient_id,text,image_id,created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,date_trunc('milliseconds',clock_timestamp())) RETURNING *`,
    [thread.id, current.scopeId, input.clientMessageId, current.user.id, peerId, input.text, input.imageId ?? null],
  )).rows[0];
  await client.query("UPDATE chat_conversations SET updated_at=greatest(updated_at,$2) WHERE id=$1", [thread.id, row.created_at]);
  await notifyChatRecipient(client,{
    companyId:current.companyId,recipientId:peerId,
    senderName:current.user.displayName,messageId:row.id,
  });
  // Audit readers are not chat participants: never copy private content into
  // general/company audit logs, including receipt snapshots.
  await audit(client, current.user, "chat.send", "chat_message", row.id, null, {
    messageId: row.id, clientMessageId: row.client_message_id,
    senderId: row.sender_id, recipientId: row.recipient_id,
    companyId: current.companyId, textLength: input.text.length,
    createdAt: row.created_at.toISOString(),
  }, current.companyId);
  return messageDTO(row);
}

export async function acknowledgeChatMessages(
  client: PoolClient, actor: User, peerId: number, input: ChatReceiptInput,
): Promise<ChatMessage[]> {
  await client.query("SELECT id FROM users WHERE id=ANY($1::integer[]) ORDER BY id FOR SHARE", [[actor.id, peerId]]);
  const current = await access(client, actor, input, "view", true);
  await peer(client, current, peerId, true, false);
  const conversationId = await conversation(client, current, peerId);
  if (conversationId === undefined) missing();
  const ids = [...new Set([...input.deliveredMessageIds, ...input.readMessageIds])].sort((a, b) => a - b);
  const before = (await client.query(
    `SELECT * FROM chat_messages WHERE conversation_id=$1 AND recipient_id=$2
     AND sender_id=$3 AND id=ANY($4::integer[]) ORDER BY id FOR UPDATE`,
    [conversationId, current.user.id, peerId, ids],
  )).rows;
  // Validate the entire batch before changing any receipt. In particular, a
  // sender cannot acknowledge their own outgoing messages or another thread.
  if (before.length !== ids.length) missing("تأكيد الاستلام يخص الرسائل الواردة إليك في هذه المحادثة فقط");
  const updated = (await client.query(
    `UPDATE chat_messages SET delivered_at=coalesce(delivered_at,statement_timestamp()),
       read_at=CASE WHEN id=ANY($2::integer[]) THEN coalesce(read_at,statement_timestamp()) ELSE read_at END
     WHERE id=ANY($1::integer[]) RETURNING *`,
    [ids, input.readMessageIds],
  )).rows.sort((a, b) => a.id - b.id);
  if(input.readMessageIds.length){
    await client.query(
      "UPDATE notifications SET read_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp()"+
      " WHERE recipient_user_id=$1 AND company_id IS NOT DISTINCT FROM $2::integer"+
      " AND code IN ('CHAT_DIRECT_GLOBAL','CHAT_DIRECT_COMPANY')"+
      " AND subject_key=ANY($3::text[]) AND read_at IS NULL AND completed_at IS NULL",
      [current.user.id,current.companyId,input.readMessageIds.map(id=>"chat-message:"+id)],
    );
  }
  const changed = updated.some((row, index) =>
    JSON.stringify(receiptDTO(row)) !== JSON.stringify(receiptDTO(before[index]!)));
  if (changed)
    await audit(client, current.user, "chat.receipt", "chat_conversation", conversationId,
      { messages: before.map(receiptDTO) }, { messages: updated.map(receiptDTO) }, current.companyId);
  return updated.map(messageDTO);
}
