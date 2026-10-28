import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import type { Company, Employee, SessionResponse, User } from "../packages/contracts/src/index.ts";
import type { ChatContext, ChatPage } from "../packages/contracts/src/chat.ts";
import type { ChatGroup, ChatGroupDetail, ChatGroupMessage } from "../packages/contracts/src/chat-groups.ts";

const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const origin = "http://localhost";
const password = "Chat-groups-test-passphrase-2026";
const globalChat: ChatContext = { scope: "global" };
class Client {
  private cookie = "";
  private csrf: string | null = null;
  constructor(private readonly baseUrl: () => string) {}
  async request<T>(method: string, path: string, body?: unknown) {
    const headers = new Headers({ accept: "application/json" });
    if (this.cookie) headers.set("cookie", this.cookie);
    if (method !== "GET") {
      headers.set("content-type", "application/json"); headers.set("origin", origin);
      if (this.csrf) headers.set("x-csrf-token", this.csrf);
    }
    const response = await fetch(`${this.baseUrl()}/api${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const value of response.headers.getSetCookie()) this.cookie = value.split(";", 1)[0]!;
    const result = await response.json() as T;
    if (result && typeof result === "object" && "csrf" in result) {
      const csrf = result.csrf;
      if (csrf === null || typeof csrf === "string") this.csrf = csrf;
    }
    return { status: response.status, body: result };
  }
  async ok<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.request<T>(method, path, body);
    assert.equal(response.status, 200, `${method} ${path}: ${JSON.stringify(response.body)}`);
    return response.body;
  }
}
interface Actor { client: Client; user: User; }
async function fixture(t: TestContext) {
  const schema = `chat_groups_test_${randomUUID().replaceAll("-", "")}`;
  const options = { databaseUrl, schema, appOrigin: origin, production: false, serveStatic: false };
  let runtime = await createApp(options), server: Server, baseUrl = "";
  async function start() {
    server = runtime.app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
    const address = server.address(); assert(address && typeof address !== "string");
    baseUrl = `http://127.0.0.1:${address.port}`;
  }
  async function stop() {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await runtime.close();
  }
  await start();
  t.after(async () => {
    await stop(); const cleanup = new Pool({ connectionString: databaseUrl });
    try { await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await cleanup.end(); }
  });
  const actor = async (name: string): Promise<Actor> => {
    const client = new Client(() => baseUrl);
    const response = await client.request<SessionResponse>("POST", "/auth/register", {
      name, displayName: name, email: `${name}@chat-groups.test`, phone: "", password,
    });
    assert.equal(response.status, 201); assert(response.body.user);
    return { client, user: response.body.user };
  };
  const user = await provisionOwner(runtime.pool, { name: "Owner", displayName: "Owner", email: "owner@chat-groups.test", password });
  const owner = { client: new Client(() => baseUrl), user };
  await owner.client.ok("POST", "/auth/login", { email: user.email, password });
  return { actor, owner, get pool() { return runtime.pool; }, async restart() { await stop(); runtime = await createApp(options); await start(); } };
}
const path = (groupId: number) => `/chat/groups/${groupId}`;
const query = (context: ChatContext) => new URLSearchParams({ scope: context.scope,
  ...(context.companyId ? { companyId: String(context.companyId) } : {}) }).toString();
async function create(actor: Actor, members: Actor[], name = "مجموعة الاختبار", context = globalChat, clientGroupId: string = randomUUID()) {
  return actor.client.ok<ChatGroupDetail>("POST", "/chat/groups", { ...context, clientGroupId, name, memberIds: members.map(member => member.user.id) });
}
async function detail(actor: Actor, groupId: number, context = globalChat) {
  return actor.client.ok<ChatGroupDetail>("GET", `${path(groupId)}?${query(context)}`);
}
async function history(actor: Actor, groupId: number, context = globalChat) {
  return (await actor.client.ok<ChatPage<ChatGroupMessage>>("GET", `${path(groupId)}/messages?${query(context)}`)).items;
}
async function update(actor: Actor, group: ChatGroup, changes: { name?: string; addMemberIds?: number[]; removeMemberIds?: number[]; managerId?: number }, context = globalChat) {
  return actor.client.ok<ChatGroupDetail>("PATCH", path(group.id), { ...context, revision: group.revision, ...changes });
}
async function send(actor: Actor, group: ChatGroup, text: string, context = globalChat, clientMessageId: string = randomUUID()) {
  return (await actor.client.ok<{ message: ChatGroupMessage }>("POST", `${path(group.id)}/messages`, {
    ...context, membershipRevision: group.membershipRevision, clientMessageId, text,
  })).message;
}
async function ack(actor: Actor, groupId: number, ids: number[], type: "delivered" | "read", context = globalChat) {
  return actor.client.ok<{ messages: ChatGroupMessage[] }>("POST", `${path(groupId)}/receipt`, {
    ...context, [type === "read" ? "readMessageIds" : "deliveredMessageIds"]: ids,
  });
}
async function denied(actor: Actor, method: string, url: string, body?: unknown) {
  const response = await actor.client.request(method, url, body);
  assert([400, 403, 404, 409].includes(response.status), `Expected rejection: ${method} ${url}: ${JSON.stringify(response)}`);
}
const find = (messages: ChatGroupMessage[], id: number) => { const message = messages.find(message => message.id === id); assert(message); return message; };

test("private groups enforce membership epochs and preserve exact per-recipient receipt snapshots after removal and rejoin", async t => {
  const f = await fixture(t);
  const alice = await f.actor("alice"), bob = await f.actor("bob"), carol = await f.actor("carol"), newcomer = await f.actor("newcomer");
  let { group } = await create(alice, [bob, carol]);
  const first = await send(alice, group, "رسالة قبل انضمام العضو الجديد");
  const sentAlerts=await f.pool.query(
    "SELECT recipient_user_id,subject_key,message FROM notifications WHERE code='CHAT_GROUP_GLOBAL' ORDER BY id");
  assert.deepEqual(sentAlerts.rows.map(row=>row.recipient_user_id).sort((a,b)=>a-b),
    [bob.user.id,carol.user.id].sort((a,b)=>a-b));
  assert(sentAlerts.rows.every(row=>row.subject_key==="chat-group:"+group.id+":message:"+first.id));
  assert(sentAlerts.rows.every(row=>!row.message.includes("رسالة قبل انضمام")),
    "Group messages do not leak into the public notifications table");
  assert.equal(first.recipientCount, 2); assert.equal(first.deliveredCount, 0); assert.equal(first.readCount, 0);
  assert.deepEqual(first.receipts.map(receipt => receipt.userId).sort((a, b) => a - b), [bob.user.id, carol.user.id]);
  for (const outsider of [f.owner, newcomer]) {
    await denied(outsider, "GET", `${path(group.id)}?scope=global`);
    await denied(outsider, "GET", `${path(group.id)}/messages?scope=global`);
    assert.equal((await outsider.client.ok<ChatPage<ChatGroup>>("GET", "/chat/groups?scope=global")).items.length, 0);
    await denied(outsider, "POST", `${path(group.id)}/receipt`, { scope: "global", readMessageIds: [first.id] });
  }
  await denied(alice, "POST", `${path(group.id)}/receipt`, { scope: "global", readMessageIds: [first.id] });
  assert.equal(find(await history(bob, group.id), first.id).readCount, 0, "GET never acknowledges messages");
  await ack(bob, group.id, [first.id], "read");
  const partial = find(await history(alice, group.id), first.id);
  assert.equal(partial.deliveredCount, 1); assert.equal(partial.readCount, 1); assert.equal(partial.readAt, null); assert.equal(partial.deliveredAt, null);
  const bobReceipt = partial.receipts.find(receipt => receipt.userId === bob.user.id)!;
  assert(bobReceipt.readAt && bobReceipt.deliveredAt && Date.parse(bobReceipt.readAt) >= Date.parse(bobReceipt.deliveredAt));
  group = (await update(alice, group, { addMemberIds: [newcomer.user.id] })).group;
  assert.deepEqual(await history(newcomer, group.id), [], "New members cannot see messages from before joining");
  const newcomerDetail = await detail(newcomer, group.id);
  assert.equal(newcomerDetail.group.lastMessage, null); assert.equal(newcomerDetail.group.unreadCount, 0);
  const newcomerList = await newcomer.client.ok<ChatPage<ChatGroup>>("GET", "/chat/groups?scope=global");
  assert.equal(newcomerList.items.find(item => item.id === group.id)?.lastMessage, null);
  const second = await send(alice, group, "رسالة للأعضاء الأربعة الحاليين");
  assert.equal(second.recipientCount, 3);
  const firstPage = await carol.client.ok<ChatPage<ChatGroupMessage>>("GET", `${path(group.id)}/messages?scope=global&limit=1`);
  assert.equal(firstPage.items[0]?.id, second.id); assert(firstPage.nextCursor);
  const older = await carol.client.ok<ChatPage<ChatGroupMessage>>("GET", `${path(group.id)}/messages?scope=global&limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`);
  assert.deepEqual(older.items.map(message => message.id), [first.id]);
  assert.equal((await bob.client.request("GET", `${path(group.id)}/messages?scope=global&cursor=${encodeURIComponent(firstPage.nextCursor)}`)).status, 400, "A history cursor is tied to its actor and membership epoch");
  await denied(newcomer, "POST", `${path(group.id)}/receipt`, { scope: "global", readMessageIds: [first.id, second.id] });
  assert.equal(find(await history(alice, group.id), second.id).readCount, 0, "Invalid receipt batches roll back all valid IDs");
  await ack(newcomer, group.id, [second.id], "read");
  group = (await update(alice, group, { removeMemberIds: [carol.user.id] })).group;
  for (const suffix of ["", "/messages"]) await denied(carol, "GET", `${path(group.id)}${suffix}?scope=global`);
  await denied(carol, "POST", `${path(group.id)}/receipt`, { scope: "global", readMessageIds: [first.id] });
  assert.equal((await carol.client.ok<ChatPage<ChatGroup>>("GET", "/chat/groups?scope=global")).items.length, 0);
  const retained = find(await history(alice, group.id), first.id);
  assert.equal(retained.recipientCount, 2); assert.equal(retained.readCount, 1); assert.equal(retained.readAt, null, "Removing an unread recipient never converts partial read into all read");
  group = (await update(alice, group, { addMemberIds: [carol.user.id] })).group;
  assert.deepEqual(await history(carol, group.id), [], "Rejoining starts a fresh history epoch");
  assert.equal((await detail(carol, group.id)).group.lastMessage, null);
  assert.equal((await carol.client.request("GET", `${path(group.id)}/messages?scope=global&cursor=${encodeURIComponent(firstPage.nextCursor)}`)).status, 400);
  await denied(carol, "POST", `${path(group.id)}/receipt`, { scope: "global", readMessageIds: [second.id] });
  const third = await send(alice, group, "رسالة بعد إعادة الانضمام");
  await ack(bob, group.id, [third.id], "read"); await ack(carol, group.id, [third.id], "read");
  assert.equal(find(await history(alice, group.id), third.id).readAt, null);
  await ack(newcomer, group.id, [third.id], "read");
  const fullyRead = find(await history(alice, group.id), third.id);
  assert.equal(fullyRead.readCount, 3); assert.equal(fullyRead.deliveredCount, 3); assert(fullyRead.readAt && fullyRead.deliveredAt);
  assert(Date.parse(fullyRead.readAt) >= Date.parse(fullyRead.deliveredAt));
  await ack(bob, group.id, [third.id, third.id], "read");
  assert.deepEqual(find(await history(alice, group.id), third.id), fullyRead, "First per-recipient and aggregate timestamps remain unchanged on retry");
  const audit = JSON.stringify((await f.pool.query("SELECT before_value,after_value FROM audit_events WHERE action LIKE 'chat.group.%'")).rows);
  for (const secret of ["مجموعة الاختبار", first.text, second.text, third.text]) assert(!audit.includes(secret), "Group audit records never copy private group names or message text");
  await f.restart(); assert.deepEqual(find(await history(alice, group.id), third.id), fullyRead);
});

test("group UUID creation and send retries are canonical while revisions protect concurrent membership and manager changes", async t => {
  const f = await fixture(t);
  const alice = await f.actor("alice"), bob = await f.actor("bob"), carol = await f.actor("carol"), newcomer = await f.actor("newcomer");
  const key = randomUUID();
  const [created, replay] = await Promise.all([create(alice, [bob, carol], "مجموعة واحدة", globalChat, key), create(alice, [carol, bob, bob], "مجموعة واحدة", globalChat, key)]);
  assert.equal(created.group.id, replay.group.id); assert.equal(created.group.memberCount, 3);
  assert.equal((await alice.client.ok<ChatPage<ChatGroup>>("GET", "/chat/groups?scope=global")).items.length, 1);
  for (const [actor, name, members] of [[alice, "اسم آخر", [bob, carol]], [bob, "مجموعة واحدة", [alice, carol]]] as const) {
    assert.equal((await actor.client.request("POST", "/chat/groups", { scope: "global", clientGroupId: key, name, memberIds: members.map(member => member.user.id) })).status, 409);
  }
  let group = created.group;
  const [renameA, renameB] = await Promise.all(["اسم أول", "اسم ثان"].map(name => alice.client.request<ChatGroupDetail>("PATCH", path(group.id), { scope: "global", revision: group.revision, name })));
  assert.deepEqual([renameA!.status, renameB!.status].sort(), [200, 409]);
  group = (await detail(alice, group.id)).group;
  assert.equal(group.revision, created.group.revision + 1); assert.equal(group.membershipRevision, created.group.membershipRevision, "Renaming does not change message recipients");
  await denied(bob, "PATCH", path(group.id), { scope: "global", revision: group.revision, name: "تغيير من غير المدير" });
  await denied(alice, "POST", `${path(group.id)}/leave`, { scope: "global", revision: group.revision });
  await denied(alice, "PATCH", path(group.id), { scope: "global", revision: group.revision, removeMemberIds: [alice.user.id] });
  const acceptedGroup = group;
  const accepted = await send(alice, acceptedGroup, "رسالة مؤكدة قبل تغير العضوية");
  group = (await update(alice, group, { addMemberIds: [newcomer.user.id] })).group;
  assert(group.membershipRevision > acceptedGroup.membershipRevision);
  assert.deepEqual(await send(alice, acceptedGroup, accepted.text, globalChat, accepted.clientMessageId), accepted, "An exact accepted retry never silently changes the recipient snapshot");
  assert.equal((await alice.client.request("POST", `${path(group.id)}/messages`, { scope: "global", membershipRevision: acceptedGroup.membershipRevision, clientMessageId: randomUUID(), text: "إرسال قديم غير مقبول" })).status, 409);
  assert.equal((await alice.client.request("POST", `${path(group.id)}/messages`, { scope: "global", membershipRevision: acceptedGroup.membershipRevision, clientMessageId: accepted.clientMessageId, text: "حمولة مختلفة" })).status, 409);
  const other = (await create(alice, [bob], "مجموعة أخرى")).group;
  assert.equal((await alice.client.request("POST", `${path(other.id)}/messages`, { scope: "global", membershipRevision: other.membershipRevision, clientMessageId: accepted.clientMessageId, text: accepted.text })).status, 409);
  group = (await update(alice, group, { managerId: bob.user.id })).group;
  assert.equal(group.managerId, bob.user.id);
  await denied(alice, "PATCH", path(group.id), { scope: "global", revision: group.revision, name: "المدير السابق" });
  await alice.client.ok("POST", `${path(group.id)}/leave`, { scope: "global", revision: group.revision });
  await denied(alice, "GET", `${path(group.id)}?scope=global`);
  await denied(alice, "POST", `${path(group.id)}/messages`, { scope: "global", membershipRevision: acceptedGroup.membershipRevision, clientMessageId: accepted.clientMessageId, text: accepted.text });
  const managed = await detail(bob, group.id); assert.equal(managed.group.managerId, bob.user.id); assert(!managed.members.some(member => member.id === alice.user.id));
  await update(bob, managed.group, { addMemberIds: [alice.user.id] });
  assert.deepEqual(await history(alice, group.id), []);
  assert.equal((await alice.client.request("POST", `${path(group.id)}/messages`, {
    scope: "global", membershipRevision: acceptedGroup.membershipRevision,
    clientMessageId: accepted.clientMessageId, text: accepted.text,
  })).status, 404, "An accepted send from an earlier membership epoch cannot bypass the new history cutoff");
  await denied(bob, "POST", "/chat/groups", { scope: "global", clientGroupId: randomUUID(), name: "وحيد", memberIds: [] });
});

test("company groups isolate scope and recheck current company membership, explicit denies and disabled-page UUID confirmations", async t => {
  const f = await fixture(t);
  const alice = await f.actor("alice"), bob = await f.actor("bob"), carol = await f.actor("carol"), outsider = await f.actor("outsider");
  const company = (await f.owner.client.request<{ company: Company }>("POST", "/companies", { name: "شركة مجموعات الاختبار", phone: "", address: "" })).body.company;
  const employees: Employee[] = [];
  for (const actor of [alice, bob, carol]) {
    const result = await f.owner.client.request<{ employee: Employee }>("POST", `/companies/${company.id}/employees`, { userId: actor.user.id, name: actor.user.name, phone: "", role: "employee", active: true, permissions: [] });
    assert.equal(result.status, 201); employees.push(result.body.employee);
  }
  const context: ChatContext = { scope: "company", companyId: company.id };
  const createKey = randomUUID();
  const personal = await create(alice, [bob, carol], "مجموعة عامة", globalChat, createKey);
  const internal = await create(alice, [bob, carol], "مجموعة الشركة", context, createKey);
  assert.notEqual(personal.group.id, internal.group.id);
  await denied(alice, "GET", `${path(internal.group.id)}?scope=global`);
  await denied(alice, "GET", `${path(personal.group.id)}?${query(context)}`);
  await denied(f.owner, "GET", `${path(internal.group.id)}?${query(context)}`);
  await denied(outsider, "GET", `/chat/groups?${query(context)}`);
  await denied(alice, "POST", "/chat/groups", { ...context, clientGroupId: randomUUID(), name: "أعضاء خارج الشركة", memberIds: [outsider.user.id] });
  const message = await send(alice, internal.group, "رسالة الشركة", context);
  assert.deepEqual(await history(alice, personal.group.id), []);
  const settings = { companyId: company.id, visible: true, enabled: false, order: 100, revision: null };
  const disabled = await f.owner.client.ok<{ page: { revision: number } }>("PUT", "/page-catalog/company.chat/settings", settings);
  assert.equal((await create(alice, [carol, bob], "مجموعة الشركة", context, createKey.toUpperCase())).group.id, internal.group.id);
  assert.deepEqual(await send(alice, internal.group, message.text, context, message.clientMessageId), message);
  assert.equal((await alice.client.request("POST", "/chat/groups", { ...context, clientGroupId: createKey, name: "تغيير", memberIds: [bob.user.id, carol.user.id] })).status, 409);
  assert.equal((await alice.client.request("POST", `${path(internal.group.id)}/messages`, { ...context, membershipRevision: internal.group.membershipRevision, clientMessageId: randomUUID(), text: "جديدة" })).status, 403);
  await denied(alice, "GET", `${path(internal.group.id)}?${query(context)}`);
  await f.owner.client.ok("PUT", "/page-catalog/company.chat/settings", { ...settings, enabled: true, revision: disabled.page.revision });
  const rulesPath = `/companies/${company.id}/configuration/employee-rules`;
  const createDeny = await f.owner.client.ok<{ rule: { revision: number } }>("PUT", rulesPath, { employeeId: employees[0]!.id, permissionKey: "company.chat:create", effect: "deny", revision: null });
  assert.equal((await history(alice, internal.group.id, context)).length, 1);
  await denied(alice, "POST", `${path(internal.group.id)}/messages`, { ...context, membershipRevision: internal.group.membershipRevision, clientMessageId: message.clientMessageId, text: message.text });
  await denied(alice, "PATCH", path(internal.group.id), { ...context, revision: internal.group.revision, name: "غير مسموح" });
  await f.owner.client.ok("PUT", rulesPath, { employeeId: employees[0]!.id, permissionKey: "company.chat:create", effect: null, revision: createDeny.rule.revision });
  const viewDeny = await f.owner.client.ok<{ rule: { revision: number } }>("PUT", rulesPath, { employeeId: employees[1]!.id, permissionKey: "company.chat:view", effect: "deny", revision: null });
  await denied(bob, "GET", `${path(internal.group.id)}/messages?${query(context)}`);
  await denied(bob, "POST", `${path(internal.group.id)}/receipt`, { ...context, readMessageIds: [message.id] });
  await f.owner.client.ok("PUT", rulesPath, { employeeId: employees[1]!.id, permissionKey: "company.chat:view", effect: null, revision: viewDeny.rule.revision });
  await f.owner.client.ok("PATCH", `/companies/${company.id}/employees/${employees[2]!.id}`, { active: false });
  await denied(carol, "GET", `${path(internal.group.id)}?${query(context)}`);
  await denied(carol, "POST", `${path(internal.group.id)}/receipt`, { ...context, readMessageIds: [message.id] });
  const unavailableSend = await alice.client.request("POST", `${path(internal.group.id)}/messages`, { ...context, membershipRevision: internal.group.membershipRevision, clientMessageId: randomUUID(), text: "لا تقليل صامت للمستلمين" });
  assert.equal(unavailableSend.status, 409);
  await ack(bob, internal.group.id, [message.id], "read", context);
  const retained = find(await history(alice, internal.group.id, context), message.id);
  assert.equal(retained.recipientCount, 2); assert.equal(retained.readCount, 1); assert.equal(retained.readAt, null);
  await f.owner.client.ok("PATCH", `/companies/${company.id}/employees/${employees[0]!.id}`, { active: false });
  await denied(alice, "GET", `${path(internal.group.id)}?${query(context)}`);
  assert.equal((await detail(alice, personal.group.id)).group.id, personal.group.id, "Independent public group remains accessible after company removal");
});

test("queued group sends and receipts recheck membership after a concurrent removal commits", async t => {
  const f = await fixture(t);
  const alice = await f.actor("alice"), bob = await f.actor("bob"), carol = await f.actor("carol");
  const { group } = await create(alice, [bob, carol]);
  const original = await send(alice, group, "رسالة لا يقرؤها عضو أزيل أثناء الانتظار");
  const blocker = await f.pool.connect();
  await blocker.query("BEGIN");
  const blockerId = (await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
  await blocker.query("SELECT id FROM chat_groups WHERE id=$1 FOR UPDATE", [group.id]);
  const queued = Promise.allSettled([
    bob.client.request("POST", `${path(group.id)}/messages`, { scope: "global", membershipRevision: group.membershipRevision, clientMessageId: randomUUID(), text: "رسالة عضو أزيل أثناء انتظار القفل" }),
    bob.client.request("POST", `${path(group.id)}/receipt`, { scope: "global", readMessageIds: [original.id] }),
  ]);
  let barrierError: unknown;
  try {
    const deadline = Date.now() + 5_000;
    let blocked = 0;
    do {
      const activity = await f.pool.query<{ count: number }>(
        // PostgreSQL may queue the second row-lock waiter behind the first
        // waiter. Follow that blocking chain instead of counting direct
        // blockers only; both HTTP mutations must still reach the group lock.
        `WITH RECURSIVE waiting_chain(pid) AS (
           SELECT $1::integer
           UNION
           SELECT a.pid FROM pg_stat_activity a JOIN waiting_chain parent
             ON parent.pid=ANY(pg_blocking_pids(a.pid))
           WHERE a.wait_event_type='Lock'
         )
         SELECT count(*)::integer AS count FROM waiting_chain chain
         JOIN pg_stat_activity a ON a.pid=chain.pid
         WHERE a.pid<>$1 AND a.wait_event_type='Lock'
           AND a.query LIKE '%FROM chat_groups%'`, [blockerId]);
      blocked = activity.rows[0]!.count;
      if (blocked >= 2) break;
      await delay(10);
    } while (Date.now() < deadline);
    assert.equal(blocked, 2, "Both real HTTP mutations must be waiting on the held group lock before removal");
    await blocker.query("UPDATE chat_group_members SET left_at=date_trunc('milliseconds',clock_timestamp()) WHERE group_id=$1 AND user_id=$2 AND left_at IS NULL", [group.id, bob.user.id]);
    await blocker.query("UPDATE chat_groups SET revision=revision+1,membership_revision=membership_revision+1,updated_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=$1", [group.id]);
    await blocker.query("COMMIT");
  } catch (error) {
    barrierError = error;
    await blocker.query("ROLLBACK");
  } finally { blocker.release(); }
  const responses = await queued;
  if (barrierError) throw barrierError;
  for (const response of responses) {
    assert.equal(response.status, "fulfilled"); assert(response.status === "fulfilled");
    assert([403, 404].includes(response.value.status), `A removed member's queued mutation must fail: ${JSON.stringify(response.value)}`);
  }
  const messages = await history(alice, group.id);
  assert.equal(messages.length, 1);
  const receipt = find(messages, original.id).receipts.find(item => item.userId === bob.user.id)!;
  assert.equal(receipt.deliveredAt, null); assert.equal(receipt.readAt, null);
});


test("image control exemption applies to a group only while the SITE owner is a member", async t => {
  const f = await fixture(t);
  const alice = await f.actor("alice"), bob = await f.actor("bob");
  const imageData="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jaj0AAAAASUVORK5CYII=";
  const upload = async () => (await alice.client.ok<{id:string}>("POST","/media",{
    purpose:"chat",companyId:null,original:imageData,thumbnail:imageData,
  })).id;
  const regular = (await create(alice,[bob],"مجموعة بلا مالك الموقع")).group;
  const rejected = await alice.client.request("POST",`${path(regular.id)}/messages`,{
    ...globalChat,membershipRevision:regular.membershipRevision,clientMessageId:randomUUID(),
    text:"",imageId:await upload(),
  });
  assert.equal(rejected.status,403,"Company/group manager is not the site owner");
  let ownerGroup = (await create(alice,[bob,f.owner],"مجموعة مع مالك الموقع")).group;
  const sent = await alice.client.ok<{message:ChatGroupMessage}>("POST",`${path(ownerGroup.id)}/messages`,{
    ...globalChat,membershipRevision:ownerGroup.membershipRevision,clientMessageId:randomUUID(),
    text:"",imageId:await upload(),
  });
  assert(sent.message.imageUrl,"Any member may send a photo while the platform owner participates");
  ownerGroup = (await update(alice,ownerGroup,{removeMemberIds:[f.owner.user.id]})).group;
  const blocked = await alice.client.request("POST",`${path(ownerGroup.id)}/messages`,{
    ...globalChat,membershipRevision:ownerGroup.membershipRevision,clientMessageId:randomUUID(),
    text:"",imageId:await upload(),
  });
  assert.equal(blocked.status,403,"Removing site owner restores default image prohibition");
});
