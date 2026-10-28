import type { PoolClient, QueryResultRow } from "pg";
import { z } from "zod";
import {
  pageByKey, pageRuleAllows,
  type ChatContext, type ChatGroup, type ChatGroupCreateInput, type ChatGroupDetail,
  type ChatGroupLeaveInput, type ChatGroupMessage, type ChatGroupReceipt,
  type ChatGroupSendInput, type ChatGroupUpdateInput, type ChatPage,
  type ChatReceiptInput, type User,
} from "../../../../packages/contracts/src/index.ts";
import { companyAccess, currentActor } from "../policies/access.ts";
import { deny, HttpError, missing } from "../errors.ts";
import { assertDirectoryAccess, directoryEntries } from "./pages.ts";
import { pagePermissionAliases, permissionRuleEffects } from "./permission-rules.ts";
import { audit } from "./audit.ts";
import { searchPattern } from "./lists.ts";
import type { ChatListQuery } from "./chat.ts";
import { chatAvatarUrls } from "./chat-avatars.ts";
import { notifyChatRecipient } from "./chat-notifications.ts";
import { checkChatImage, checkChatImageAllowed } from "./chat-images.ts";

interface Access { user: User; companyId: number | null; scopeId: number; }
async function access(client: PoolClient, actor: User, context: ChatContext,
  action: "view" | "create" = "view", write = false, enabled = true): Promise<Access> {
  if (write) await client.query("SELECT id FROM users WHERE id=$1 FOR SHARE", [actor.id]);
  const user = await currentActor(client, actor, false);
  if (user.suspended) deny("الحساب موقوف عن المشاركة");
  const companyId = context.scope === "company" ? context.companyId! : null;
  const company = companyId !== null ? await companyAccess(client, user, companyId, undefined, write) : null;
  const key = companyId === null ? "public.chat" : "company.chat";
  if (write) await client.query("SELECT key FROM page_registry WHERE key=$1 FOR SHARE", [key]);
  if (enabled) {
    const entry = (await directoryEntries(client, user, companyId)).find(entry => entry.key === key);
    if (!entry) deny();
    assertDirectoryAccess(entry, "view");
    if (action === "create") assertDirectoryAccess(entry, "create");
  } else {
    const definition = pageByKey(key);
    const effects = company?.employee && !company.general
      ? await permissionRuleEffects(client, companyId!, company.employee.id) : new Map<string, "allow" | "deny">();
    for (const required of action === "view" ? ["view"] as const : ["view", "create"] as const)
      if (!definition || !pageRuleAllows(definition.actions[required], user, company) ||
        (!company?.general && pagePermissionAliases(key, required).some(key => effects.get(key) === "deny"))) deny();
  }
  return { user, companyId, scopeId: companyId ?? 0 };
}
async function eligible(client: PoolClient, current: Access, ids: number[], unavailableConflict = false) {
  const rows = (await client.query(
    `SELECT u.id FROM users u WHERE u.id=ANY($1::integer[]) AND NOT u.archived AND NOT u.suspended
     AND ($2::integer IS NULL OR u.owner OR EXISTS(SELECT 1 FROM employees e
       WHERE e.company_id=$2 AND e.user_id=u.id AND e.active)) ORDER BY u.id FOR SHARE OF u`,
    [ids, current.companyId],
  )).rows;
  if (rows.length !== ids.length) {
    if (unavailableConflict) throw new HttpError(409, "group_member_unavailable", "يوجد عضو غير متاح؛ على مدير المجموعة تحديث الأعضاء قبل الإرسال");
    missing("أحد الأعضاء غير متاح للدردشة في هذا النطاق");
  }
  if (current.companyId !== null)
    await client.query("SELECT id FROM employees WHERE company_id=$1 AND user_id=ANY($2::integer[]) AND active ORDER BY id FOR SHARE", [current.companyId, ids]);
}
async function group(client: PoolClient, current: Access, groupId: number, lock = false) {
  // Lock the group before taking the membership snapshot. A joined SELECT
  // waiting on a group row can otherwise retain a pre-removal member tuple.
  if (lock) await client.query("SELECT id FROM chat_groups WHERE id=$1 AND scope_id=$2 FOR UPDATE", [groupId, current.scopeId]);
  const row = (await client.query(
    `SELECT g.*,member.id AS own_membership_id,member.joined_after_message_id AS own_cutoff,
      member.joined_at AS own_joined_at FROM chat_groups g JOIN chat_group_members member
      ON member.group_id=g.id AND member.user_id=$2 AND member.left_at IS NULL
      WHERE g.id=$1 AND g.scope_id=$3`,
    [groupId, current.user.id, current.scopeId],
  )).rows[0];
  if (!row) missing("المجموعة غير متاحة لحسابك في هذا النطاق");
  return row;
}
async function currentMembers(client: PoolClient, groupId: number) {
  return (await client.query(
    `SELECT member.*,u.display_name,(NOT u.archived AND NOT u.suspended AND
       (g.company_id IS NULL OR u.owner OR EXISTS(SELECT 1 FROM employees eligible
         WHERE eligible.company_id=g.company_id AND eligible.user_id=u.id AND eligible.active))) AS available
     FROM chat_group_members member JOIN users u ON u.id=member.user_id JOIN chat_groups g ON g.id=member.group_id
     WHERE member.group_id=$1 AND member.left_at IS NULL ORDER BY member.id`, [groupId],
  )).rows;
}
const iso = (value: Date | null | undefined) => value?.toISOString() ?? null;
async function messageDTOs(client: PoolClient, rows: QueryResultRow[]): Promise<ChatGroupMessage[]> {
  if (!rows.length) return [];
  const snapshots = (await client.query(
    `SELECT * FROM chat_group_receipts WHERE message_id=ANY($1::integer[]) ORDER BY message_id,user_id`, [rows.map(row => row.id)],
  )).rows;
  const avatars = await chatAvatarUrls(client, rows[0]!.scope_id === 0 ? null : rows[0]!.scope_id,
    [...rows.map(row => row.sender_id), ...snapshots.map(row => row.user_id)]);
  const byMessage = new Map<number, ChatGroupReceipt[]>();
  for (const row of snapshots) {
    const values = byMessage.get(row.message_id) ?? [];
    values.push({ userId: row.user_id, name: row.recipient_name, avatarUrl: avatars.get(row.user_id) ?? null, deliveredAt: iso(row.delivered_at), readAt: iso(row.read_at) });
    byMessage.set(row.message_id, values);
  }
  return rows.map(row => {
    const receipts = byMessage.get(row.id) ?? [];
    const recipientCount = row.intended_membership_ids.length;
    const delivered = receipts.filter(receipt => receipt.deliveredAt !== null);
    const read = receipts.filter(receipt => receipt.readAt !== null);
    const latest = (values: string[]) => values.reduce((last, value) => value > last ? value : last);
    return {
      id: row.id, groupId: row.group_id, clientMessageId: row.client_message_id,
      senderId: row.sender_id, senderName: row.sender_name, senderAvatarUrl: avatars.get(row.sender_id) ?? null, text: row.text,
      imageUrl: row.image_id ? `/api/media/${row.image_id}/full` : null,
      createdAt: row.created_at.toISOString(), membershipRevision: row.membership_revision,
      recipientCount, deliveredCount: delivered.length, readCount: read.length,
      deliveredAt: recipientCount > 0 && delivered.length === recipientCount ? latest(delivered.map(receipt => receipt.deliveredAt!)) : null,
      readAt: recipientCount > 0 && read.length === recipientCount ? latest(read.map(receipt => receipt.readAt!)) : null,
      receipts,
    };
  });
}
async function groupDTOs(client: PoolClient, rows: QueryResultRow[]): Promise<ChatGroup[]> {
  if (!rows.length) return [];
  // One bounded projection and one receipt query for the whole inbox page;
  // periodic refresh must not issue several queries for each group row.
  const projected = (await client.query(
    `WITH input AS(SELECT * FROM unnest($1::integer[],$2::integer[],$3::integer[])
      AS source_rows(group_key,cutoff,membership_key))
     SELECT input.group_key,latest.*,members.member_count,unread.unread_count FROM input
     LEFT JOIN LATERAL(SELECT * FROM chat_group_messages history
       WHERE history.group_id=input.group_key AND history.id>input.cutoff ORDER BY history.id DESC LIMIT 1) latest ON true
     CROSS JOIN LATERAL(SELECT count(*)::integer AS member_count FROM chat_group_members
       WHERE group_id=input.group_key AND left_at IS NULL) members
     CROSS JOIN LATERAL(SELECT count(*)::integer AS unread_count FROM chat_group_receipts
       WHERE membership_id=input.membership_key AND read_at IS NULL) unread`,
    [rows.map(row => row.id), rows.map(row => row.own_cutoff), rows.map(row => row.own_membership_id)],
  )).rows;
  const facts = new Map(projected.map(value => [value.group_key as number, value]));
  const latest = await messageDTOs(client, projected.filter(value => value.id !== null));
  const latestByGroup = new Map(latest.map(message => [message.groupId, message]));
  return rows.map((row): ChatGroup => ({
    id: row.id, scope: row.company_id === null ? "global" : "company", companyId: row.company_id,
    name: row.name, managerId: row.manager_id, revision: row.revision,
    membershipRevision: row.membership_revision, memberCount: facts.get(row.id)!.member_count,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    lastMessage: latestByGroup.get(row.id) ?? null, unreadCount: facts.get(row.id)!.unread_count,
  }));
}
async function detail(client: PoolClient, row: QueryResultRow): Promise<ChatGroupDetail> {
  const members = await currentMembers(client, row.id);
  const avatars = await chatAvatarUrls(client, row.company_id, members.map(member => member.user_id));
  return {
    group: (await groupDTOs(client, [row]))[0]!,
    members: members.map(member => ({ id: member.user_id, name: member.display_name, avatarUrl: avatars.get(member.user_id) ?? null, joinedAt: member.joined_at.toISOString(), available: member.available })),
  };
}
async function creationConfirmation(client: PoolClient, row: QueryResultRow): Promise<ChatGroupDetail> {
  const result = await detail(client, row);
  // Confirming an accepted creation UUID is not a history-read endpoint,
  // especially when page flags changed after the original request.
  return { ...result, group: { ...result.group, lastMessage: null, unreadCount: 0 } };
}
const cursorId = z.number().int().positive().max(2_147_483_647);
const cursorSchema = z.object({ actorId: cursorId, scopeId: z.number().int().nonnegative().max(2_147_483_647),
  groupId: cursorId.nullable(), membershipId: cursorId.nullable(),
  id: cursorId, search: z.string().max(100), at: z.iso.datetime({ precision: 3 }).nullable() }).strict();
type Cursor = z.infer<typeof cursorSchema>;
function decodeCursor(current: Access, query: ChatListQuery, groupRow?: QueryResultRow): Cursor | null {
  if (!query.cursor) return null;
  try {
    if (!/^[A-Za-z0-9_-]{1,1024}$/.test(query.cursor)) throw new Error();
    const decoded = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")));
    if (decoded.actorId !== current.user.id || decoded.scopeId !== current.scopeId || decoded.search !== query.search ||
      decoded.groupId !== (groupRow?.id ?? null) || decoded.membershipId !== (groupRow?.own_membership_id ?? null) ||
      (groupRow === undefined) !== (decoded.at !== null)) throw new Error();
    return decoded;
  } catch { throw new HttpError(400, "invalid_cursor", "مؤشر التصفح غير صالح لهذه المجموعة أو العضوية"); }
}
const encodeCursor = (current: Access, query: ChatListQuery, id: number, at: string | null, row?: QueryResultRow) =>
  Buffer.from(JSON.stringify({ actorId: current.user.id, scopeId: current.scopeId, search: query.search,
    groupId: row?.id ?? null, membershipId: row?.own_membership_id ?? null, id, at } satisfies Cursor)).toString("base64url");

export async function listChatGroups(client: PoolClient, actor: User, query: ChatListQuery): Promise<ChatPage<ChatGroup>> {
  const current = await access(client, actor, query);
  const cursor = decodeCursor(current, query);
  const rows = (await client.query(
    `SELECT g.*,member.id AS own_membership_id,member.joined_after_message_id AS own_cutoff
     FROM chat_groups g JOIN chat_group_members member ON member.group_id=g.id AND member.user_id=$1 AND member.left_at IS NULL
     WHERE g.scope_id=$2 AND ($3='' OR g.name ILIKE $4 ESCAPE '\\')
       AND ($5::timestamptz IS NULL OR (g.updated_at,g.id)<($5::timestamptz,$6::integer))
     ORDER BY g.updated_at DESC,g.id DESC LIMIT $7`,
    [current.user.id, current.scopeId, query.search, searchPattern(query.search), cursor?.at ?? null, cursor?.id ?? null, query.limit + 1],
  )).rows;
  const page = rows.slice(0, query.limit), items = await groupDTOs(client, page);
  return { items, nextCursor: rows.length > query.limit ? encodeCursor(current, query, page.at(-1)!.id, page.at(-1)!.updated_at.toISOString()) : null };
}
export async function getChatGroup(client: PoolClient, actor: User, groupId: number, context: ChatContext) {
  const current = await access(client, actor, context);
  return detail(client, await group(client, current, groupId));
}
export async function createChatGroup(client: PoolClient, actor: User, input: ChatGroupCreateInput): Promise<ChatGroupDetail> {
  const current = await access(client, actor, input, "create", true, false);
  const payload = { actorId: current.user.id, name: input.name, memberIds: input.memberIds };
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`chat-group-create:${current.scopeId}:${input.clientGroupId}`]);
  const accepted = (await client.query("SELECT * FROM chat_groups WHERE scope_id=$1 AND client_group_id=$2", [current.scopeId, input.clientGroupId])).rows[0];
  if (accepted) {
    if (accepted.creator_id !== current.user.id || accepted.create_payload.name !== payload.name ||
      JSON.stringify(accepted.create_payload.memberIds) !== JSON.stringify(payload.memberIds))
      throw new HttpError(409, "idempotency_conflict", "استُخدم معرّف المجموعة لطلب مختلف");
    return creationConfirmation(client, await group(client, current, accepted.id, true));
  }
  await access(client, actor, input, "create", true);
  if (input.memberIds.includes(current.user.id)) throw new HttpError(400, "invalid_members", "منشئ المجموعة يضاف تلقائيًا؛ اختر أعضاء آخرين");
  const ids = [...input.memberIds, current.user.id].sort((a, b) => a - b);
  await eligible(client, current, ids);
  const created = (await client.query(
    `INSERT INTO chat_groups(company_id,client_group_id,creator_id,create_payload,name,manager_id)
      VALUES($1,$2,$3,$4,$5,$3) RETURNING id`,
    [current.companyId, input.clientGroupId, current.user.id, JSON.stringify(payload), input.name],
  )).rows[0];
  await client.query("INSERT INTO chat_group_members(group_id,user_id) SELECT $1,unnest($2::integer[])", [created.id, ids]);
  await audit(client, current.user, "chat.group.create", "chat_group", created.id, null,
    { groupId: created.id, managerId: current.user.id, memberIds: ids, nameLength: input.name.length, revision: 1, membershipRevision: 1 }, current.companyId);
  return creationConfirmation(client, await group(client, current, created.id));
}
function checkRevision(row: QueryResultRow, revision: number) {
  if (row.revision !== revision) throw new HttpError(409, "conflict", "تغيرت المجموعة؛ حدثها قبل إجراء التعديل");
}
const snapshot = (row: QueryResultRow, ids: number[]) => ({
  groupId: row.id, managerId: row.manager_id, memberIds: [...ids].sort((a, b) => a - b),
  nameLength: row.name.length, revision: row.revision, membershipRevision: row.membership_revision,
});
export async function updateChatGroup(client: PoolClient, actor: User, groupId: number, input: ChatGroupUpdateInput): Promise<ChatGroupDetail> {
  const current = await access(client, actor, input, "create", true);
  const row = await group(client, current, groupId, true);
  if (row.manager_id !== current.user.id) deny("إدارة المجموعة لمديرها الحالي فقط");
  checkRevision(row, input.revision);
  const before = await currentMembers(client, groupId), oldIds: number[] = before.map(member => member.user_id);
  const add = input.addMemberIds ?? [], remove = input.removeMemberIds ?? [];
  if (remove.includes(current.user.id)) throw new HttpError(400, "manager_must_transfer", "انقل إدارة المجموعة ثم استخدم المغادرة");
  if (add.some(id => oldIds.includes(id) || remove.includes(id)) || remove.some(id => !oldIds.includes(id)))
    throw new HttpError(400, "invalid_members", "تحقق من الأعضاء المطلوب إضافتهم أو إزالتهم");
  const nextIds = [...oldIds.filter(id => !remove.includes(id)), ...add].sort((a, b) => a - b);
  if (nextIds.length > 50) throw new HttpError(400, "group_limit", "الحد الأقصى للمجموعة 50 عضوًا");
  const managerId = input.managerId ?? row.manager_id;
  if (!nextIds.includes(managerId)) throw new HttpError(400, "invalid_manager", "اختر مديرًا من أعضاء المجموعة الحاليين");
  await eligible(client, current, [...new Set([...add, managerId])].sort((a, b) => a - b));
  if (remove.length) await client.query("UPDATE chat_group_members SET left_at=greatest(joined_at,clock_timestamp()) WHERE group_id=$1 AND user_id=ANY($2::integer[]) AND left_at IS NULL", [groupId, remove]);
  if (add.length) await client.query("INSERT INTO chat_group_members(group_id,user_id,joined_after_message_id) SELECT $1,unnest($2::integer[]),$3", [groupId, add, row.last_message_id ?? 0]);
  await client.query(`UPDATE chat_groups SET name=$2,manager_id=$3,revision=revision+1,
    membership_revision=membership_revision+$4,updated_at=greatest(updated_at,date_trunc('milliseconds',clock_timestamp())) WHERE id=$1`,
  [groupId, input.name ?? row.name, managerId, add.length + remove.length > 0 ? 1 : 0]);
  const updated = await group(client, current, groupId);
  await audit(client, current.user, "chat.group.update", "chat_group", groupId, snapshot(row, oldIds), snapshot(updated, nextIds), current.companyId);
  return detail(client, updated);
}
export async function leaveChatGroup(client: PoolClient, actor: User, groupId: number, input: ChatGroupLeaveInput) {
  const current = await access(client, actor, input, "create", true);
  const row = await group(client, current, groupId, true);
  checkRevision(row, input.revision);
  if (row.manager_id === current.user.id) throw new HttpError(409, "manager_must_transfer", "انقل إدارة المجموعة إلى عضو آخر قبل المغادرة");
  await client.query("UPDATE chat_group_members SET left_at=greatest(joined_at,clock_timestamp()) WHERE id=$1", [row.own_membership_id]);
  await client.query("UPDATE chat_groups SET revision=revision+1,membership_revision=membership_revision+1,updated_at=greatest(updated_at,date_trunc('milliseconds',clock_timestamp())) WHERE id=$1", [groupId]);
  await audit(client, current.user, "chat.group.leave", "chat_group", groupId,
    { memberId: current.user.id, revision: row.revision, membershipRevision: row.membership_revision },
    { memberId: current.user.id, left: true, revision: row.revision + 1, membershipRevision: row.membership_revision + 1 }, current.companyId);
  return { left: true };
}
export async function listChatGroupMessages(client: PoolClient, actor: User, groupId: number, query: ChatListQuery): Promise<ChatPage<ChatGroupMessage>> {
  const current = await access(client, actor, query), row = await group(client, current, groupId);
  const cursor = decodeCursor(current, query, row);
  const rows = (await client.query(`SELECT * FROM chat_group_messages WHERE group_id=$1 AND id>$2
    AND ($3::integer IS NULL OR id<$3) ORDER BY id DESC LIMIT $4`, [groupId, row.own_cutoff, cursor?.id ?? null, query.limit + 1])).rows;
  const page = rows.slice(0, query.limit);
  return { items: await messageDTOs(client, page), nextCursor: rows.length > query.limit ? encodeCursor(current, query, page.at(-1)!.id, null, row) : null };
}
export async function sendChatGroupMessage(client: PoolClient, actor: User, groupId: number, input: ChatGroupSendInput): Promise<ChatGroupMessage> {
  const current = await access(client, actor, input, "create", true, false), row = await group(client, current, groupId, true);
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`chat-group-send:${current.scopeId}:${input.clientMessageId}`]);
  const accepted = (await client.query("SELECT * FROM chat_group_messages WHERE scope_id=$1 AND client_message_id=$2", [current.scopeId, input.clientMessageId])).rows[0];
  if (accepted) {
    if (accepted.group_id !== groupId || accepted.sender_id !== current.user.id || accepted.text !== input.text || (accepted.image_id ?? null) !== (input.imageId ?? null) || accepted.membership_revision !== input.membershipRevision)
      throw new HttpError(409, "idempotency_conflict", "استُخدم معرّف الرسالة لطلب مختلف");
    if (accepted.id <= row.own_cutoff || accepted.sender_membership_id !== row.own_membership_id) missing("الرسالة خارج فترة عضويتك الحالية");
    return (await messageDTOs(client, [accepted]))[0]!;
  }
  await access(client, actor, input, "create", true);
  if (row.membership_revision !== input.membershipRevision) throw new HttpError(409, "membership_changed", "تغير أعضاء المجموعة؛ راجع المستلمين وأنشئ رسالة جديدة صراحةً");
  const members = await currentMembers(client, groupId);
  if (members.length < 2) throw new HttpError(409, "group_needs_recipient", "أضف عضوًا آخر قبل إرسال رسالة للمجموعة");
  await eligible(client, current, members.map(member => member.user_id).sort((a, b) => a - b), true);
  if (input.imageId) { await checkChatImageAllowed(client, "group"); await checkChatImage(client, input.imageId, current.user.id, current.companyId); }
  const recipientMembers = members.filter(member => member.user_id !== current.user.id);
  const created = (await client.query(`INSERT INTO chat_group_messages(group_id,scope_id,client_message_id,sender_id,
    sender_membership_id,sender_name,membership_revision,intended_membership_ids,text,image_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [groupId, current.scopeId, input.clientMessageId,
    current.user.id, row.own_membership_id, current.user.displayName, input.membershipRevision,
    recipientMembers.map(member => member.id), input.text, input.imageId ?? null])).rows[0];
  for (const member of recipientMembers) await client.query(`INSERT INTO chat_group_receipts(message_id,group_id,membership_id,user_id,recipient_name)
    VALUES($1,$2,$3,$4,$5)`, [created.id, groupId, member.id, member.user_id, member.display_name]);
  await client.query("UPDATE chat_groups SET last_message_id=$2,updated_at=greatest(updated_at,$3) WHERE id=$1", [groupId, created.id, created.created_at]);
  for (const member of recipientMembers) {
    await notifyChatRecipient(client,{
      companyId:current.companyId,recipientId:member.user_id,
      senderName:current.user.displayName,messageId:created.id,
      groupId,groupName:row.name,
    });
  }
  await audit(client, current.user, "chat.group.send", "chat_group_message", created.id, null,
    { groupId, messageId: created.id, senderId: current.user.id, membershipRevision: input.membershipRevision,
      recipientIds: recipientMembers.map(member => member.user_id), textLength: input.text.length, createdAt: created.created_at.toISOString() }, current.companyId);
  return (await messageDTOs(client, [created]))[0]!;
}
export async function acknowledgeChatGroupMessages(client: PoolClient, actor: User, groupId: number, input: ChatReceiptInput): Promise<ChatGroupMessage[]> {
  const current = await access(client, actor, input, "view", true), row = await group(client, current, groupId, true);
  const ids = [...new Set([...input.deliveredMessageIds, ...input.readMessageIds])].sort((a, b) => a - b);
  const before = (await client.query(`SELECT * FROM chat_group_receipts WHERE group_id=$1 AND membership_id=$2
    AND user_id=$3 AND message_id=ANY($4::integer[]) AND message_id>$5 ORDER BY message_id FOR UPDATE`,
  [groupId, row.own_membership_id, current.user.id, ids, row.own_cutoff])).rows;
  if (before.length !== ids.length) missing("التأكيد يخص الرسائل الواردة أثناء عضويتك الحالية فقط");
  const after = (await client.query(`UPDATE chat_group_receipts SET delivered_at=coalesce(delivered_at,statement_timestamp()),
    read_at=CASE WHEN message_id=ANY($2::integer[]) THEN coalesce(read_at,statement_timestamp()) ELSE read_at END
    WHERE membership_id=$3 AND message_id=ANY($1::integer[]) RETURNING *`, [ids, input.readMessageIds, row.own_membership_id])).rows.sort((a, b) => a.message_id - b.message_id);
  if(input.readMessageIds.length){
    await client.query(
      "UPDATE notifications SET read_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp()"+
      " WHERE recipient_user_id=$1 AND company_id IS NOT DISTINCT FROM $2::integer"+
      " AND code IN ('CHAT_GROUP_GLOBAL','CHAT_GROUP_COMPANY')"+
      " AND subject_key=ANY($3::text[]) AND read_at IS NULL AND completed_at IS NULL",
      [current.user.id,current.companyId,
       input.readMessageIds.map(id=>"chat-group:"+groupId+":message:"+id)],
    );
  }
  const receipt = (value: QueryResultRow) => ({ messageId: value.message_id, userId: value.user_id, deliveredAt: iso(value.delivered_at), readAt: iso(value.read_at) });
  if (JSON.stringify(before.map(receipt)) !== JSON.stringify(after.map(receipt)))
    await audit(client, current.user, "chat.group.receipt", "chat_group", groupId, { receipts: before.map(receipt) }, { receipts: after.map(receipt) }, current.companyId);
  return messageDTOs(client, (await client.query("SELECT * FROM chat_group_messages WHERE group_id=$1 AND id=ANY($2::integer[]) ORDER BY id", [groupId, ids])).rows);
}
