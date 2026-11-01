import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import type { Company, Employee, SessionResponse, User } from "../packages/contracts/src/index.ts";
import type { ChatContext, ChatConversation, ChatMessage, ChatPage, ChatUser } from "../packages/contracts/src/chat.ts";
import type { ChatGroupDetail, ChatGroupMessage } from "../packages/contracts/src/chat-groups.ts";
import { CHAT_AVATAR_DATA_URL } from "./chat-avatar-fixture.ts";

const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const origin = "http://localhost";
const password = "Chat-test-passphrase-2026";
const globalChat: ChatContext = { scope: "global" };

class Client {
  private cookie = "";
  private csrf: string | null = null;
  constructor(private readonly baseUrl: () => string) {}
  async image(path: string) {
    const response = await fetch(`${this.baseUrl()}/api${path.replace(/^\/api/, "")}`, {
      headers: this.cookie ? { cookie: this.cookie } : {},
    });
    return { status: response.status, headers: response.headers, bytes: Buffer.from(await response.arrayBuffer()) };
  }
  async request<T>(method: string, path: string, body?: unknown) {
    const headers = new Headers({ accept: "application/json" });
    if (this.cookie) headers.set("cookie", this.cookie);
    if (method !== "GET") {
      headers.set("content-type", "application/json");
      headers.set("origin", origin);
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
  async ok<T>(method: string, path: string, body?: unknown, status = 200): Promise<T> {
    const response = await this.request<T>(method, path, body);
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(response.body)}`);
    return response.body;
  }
}

async function fixture(t: TestContext) {
  const schema = `chat_test_${randomUUID().replaceAll("-", "")}`;
  const options = { databaseUrl, schema, appOrigin: origin, production: false, serveStatic: false };
  let runtime = await createApp(options);
  let server: Server;
  let baseUrl = "";
  const start = async () => {
    server = runtime.app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    assert(address && typeof address !== "string");
    baseUrl = `http://127.0.0.1:${address.port}`;
  };
  const stop = async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await runtime.close();
  };
  await start();
  t.after(async () => {
    await stop();
    const cleanup = new Pool({ connectionString: databaseUrl });
    try { await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await cleanup.end(); }
  });
  const actor = async (name: string) => {
    const client = new Client(() => baseUrl);
    const response = await client.ok<SessionResponse>("POST", "/auth/register", {
      name, displayName: name, email: `${name}@chat.test`, phone: "", password,
    }, 201);
    assert(response.user);
    return { client, user: response.user };
  };
  const ownerUser = await provisionOwner(runtime.pool, {
    name: "Chat owner", displayName: "Chat owner", email: "owner@chat.test", password,
  });
  const owner = { client: new Client(() => baseUrl), user: ownerUser };
  await owner.client.ok("POST", "/auth/login", { email: ownerUser.email, password });
  return {
    owner, actor, client: () => new Client(() => baseUrl),
    get pool() { return runtime.pool; },
    async restart() { await stop(); runtime = await createApp(options); await start(); },
  };
}
type Actor = { client: Client; user: User };
const messagesPath = (peerId: number) => `/chat/conversations/${peerId}/messages`;
const receiptPath = (peerId: number) => `/chat/conversations/${peerId}/receipt`;
const query = (context: ChatContext) => new URLSearchParams({
  scope: context.scope, ...(context.companyId ? { companyId: String(context.companyId) } : {}),
}).toString();
async function send(actor: Actor, peer: Actor, text: string, context = globalChat, clientMessageId: string = randomUUID()) {
  return (await actor.client.ok<{ message: ChatMessage }>("POST", messagesPath(peer.user.id), {
    ...context, clientMessageId, text,
  })).message;
}
async function messages(actor: Actor, peer: Actor, context = globalChat) {
  return (await actor.client.ok<ChatPage<ChatMessage>>("GET", `${messagesPath(peer.user.id)}?${query(context)}`)).items;
}
async function denied(client: Client, method: string, path: string, body?: unknown) {
  const response = await client.request(method, path, body);
  assert([400, 403, 404].includes(response.status), `Expected denial for ${method} ${path}: ${JSON.stringify(response)}`);
}

test("chat receipts acknowledge exact inbound messages, remain monotonic and never grant private access to administrators", async t => {
  const f = await fixture(t);
  const alice = await f.actor("alice"), bob = await f.actor("bob"), admin = await f.actor("admin");
  await f.pool.query("UPDATE users SET kind='admin' WHERE id=$1", [admin.user.id]);
  const first = await send(alice, bob, "الأولى");
  const second = await send(alice, bob, "الثانية");
  const outbound = await send(bob, alice, "رد مستقل");
  const privateAlerts=await f.pool.query(
    "SELECT recipient_user_id,title,message,read_at FROM notifications WHERE code='CHAT_DIRECT_GLOBAL' ORDER BY id"
  );
  assert.equal(privateAlerts.rows.length,3);
  assert.equal(privateAlerts.rows.filter(row=>row.recipient_user_id===bob.user.id).length,2);
  assert.equal(privateAlerts.rows.filter(row=>row.recipient_user_id===alice.user.id).length,1);
  assert(privateAlerts.rows.every(row=>!row.message.includes("الأولى")&&!row.message.includes("الثانية")),
    "Chat message contents must not leak into push notifications");
  const initial = await messages(bob, alice);
  assert.equal(initial.find(message => message.id === first.id)?.deliveredAt, null);
  assert.equal(initial.find(message => message.id === first.id)?.readAt, null, "Fetching messages never marks them read");
  for (const outsider of [f.owner, admin]) {
    assert.deepEqual(await messages(outsider, alice), [], "Administrators only see their own conversation with a peer");
    await denied(outsider.client, "POST", receiptPath(alice.user.id), { ...globalChat, readMessageIds: [first.id] });
    const list = await outsider.client.ok<ChatPage<ChatConversation>>("GET", "/chat/conversations?scope=global");
    assert.equal(list.items.length, 0);
  }
  await denied(alice.client, "POST", receiptPath(bob.user.id), { ...globalChat, readMessageIds: [first.id] });
  // A mixed batch must not partially acknowledge its valid inbound message.
  await denied(bob.client, "POST", receiptPath(alice.user.id), { ...globalChat, readMessageIds: [first.id, outbound.id] });
  assert.equal((await messages(alice, bob)).find(message => message.id === first.id)?.readAt, null);
  await bob.client.ok("POST", receiptPath(alice.user.id), { ...globalChat, deliveredMessageIds: [first.id] });
  const delivered = (await messages(alice, bob)).find(message => message.id === first.id)!;
  assert(delivered.deliveredAt);
  assert.equal(delivered.readAt, null);
  assert(Date.parse(delivered.deliveredAt) >= Date.parse(delivered.createdAt));
  assert.equal((await messages(alice, bob)).find(message => message.id === second.id)?.deliveredAt, null, "Exact IDs do not acknowledge later messages");
  await bob.client.ok("POST", receiptPath(alice.user.id), { ...globalChat, readMessageIds: [first.id, first.id] });
  const storedAlert=await f.pool.query("SELECT read_at FROM notifications WHERE recipient_user_id=$1 AND subject_key=$2",
    [bob.user.id,"chat-message:"+first.id]);
  assert(storedAlert.rows[0]?.read_at,"Reading a private message also reads its notification");
  const read = (await messages(alice, bob)).find(message => message.id === first.id)!;
  assert(read.readAt && read.deliveredAt);
  assert.equal(read.deliveredAt, delivered.deliveredAt);
  assert(Date.parse(read.readAt) >= Date.parse(read.deliveredAt));
  await bob.client.ok("POST", receiptPath(alice.user.id), { ...globalChat, deliveredMessageIds: [first.id], readMessageIds: [first.id] });
  assert.deepEqual((await messages(alice, bob)).find(message => message.id === first.id), read, "Retries never replace first receipt timestamps");
  await f.restart();
  assert.deepEqual((await messages(alice, bob)).find(message => message.id === first.id), read, "Receipts survive application restart");
});

test("chat send UUID retries persist exactly once and reject changed actor, peer or text", async t => {
  const f = await fixture(t);
  const alice = await f.actor("alice"), bob = await f.actor("bob"), carol = await f.actor("carol");
  const key = randomUUID();
  const [first, concurrent] = await Promise.all([
    send(alice, bob, "رسالة واحدة", globalChat, key),
    send(alice, bob, "رسالة واحدة", globalChat, key),
  ]);
  assert.deepEqual(concurrent, first);
  assert.equal((await messages(alice, bob)).length, 1);
  await f.restart();
  assert.deepEqual(await send(alice, bob, "رسالة واحدة", globalChat, key.toUpperCase()), first);
  for (const [actor, peer, text] of [
    [alice, bob, "نص مختلف"], [alice, carol, "رسالة واحدة"], [bob, alice, "رسالة واحدة"],
  ] as const) {
    const response = await actor.client.request("POST", messagesPath(peer.user.id), {
      ...globalChat, clientMessageId: key, text,
    });
    assert.equal(response.status, 409, "A message UUID cannot be silently reused for another payload");
  }
  await denied(alice.client, "POST", messagesPath(bob.user.id), { ...globalChat, clientMessageId: randomUUID(), text: "   " });
  await denied(alice.client, "POST", messagesPath(bob.user.id), { ...globalChat, clientMessageId: randomUUID(), text: "x".repeat(4001) });
  assert.equal((await messages(alice, bob)).length, 1);
});

test("company chat rechecks current memberships and keeps company and global messages and directories separate", async t => {
  const f = await fixture(t);
  const alice = await f.actor("alice"), bob = await f.actor("bob"), outsider = await f.actor("outsider");
  const company = (await f.owner.client.ok<{ company: Company }>("POST", "/companies", { name: "شركة الدردشة", phone: "", address: "" }, 201)).company;
  const addMember = async (actor: Actor) => (await f.owner.client.ok<{ employee: Employee }>("POST", `/companies/${company.id}/employees`, {
    userId: actor.user.id, name: actor.user.name, phone: "", role: "employee", active: true, permissions: [],
  }, 201)).employee;
  const aliceEmployee = await addMember(alice), bobEmployee = await addMember(bob);
  const context: ChatContext = { scope: "company", companyId: company.id };
  const personal = await send(alice, bob, "شخصية"), internal = await send(alice, bob, "داخل الشركة", context);
  assert.deepEqual((await messages(alice, bob)).map(message => message.id), [personal.id]);
  assert.deepEqual((await messages(alice, bob, context)).map(message => message.id), [internal.id]);
  const directory = await alice.client.ok<ChatPage<ChatUser>>("GET", `/chat/directory?${query(context)}`);
  assert(directory.items.some(user => user.id === bob.user.id));
  assert(!directory.items.some(user => user.id === outsider.user.id));
  for (const user of directory.items) assert.deepEqual(Object.keys(user).sort(), ["avatarUrl", "id", "name"]);
  await denied(outsider.client, "GET", `/chat/directory?${query(context)}`);
  await denied(alice.client, "POST", messagesPath(outsider.user.id), { ...context, clientMessageId: randomUUID(), text: "غير مسموحة" });
  await denied(bob.client, "POST", receiptPath(alice.user.id), { ...globalChat, readMessageIds: [internal.id] });
  const settings = { companyId: company.id, visible: true, enabled: false, order: 100, revision: null };
  const disabled = await f.owner.client.ok<{ page: { revision: number } }>("PUT", "/page-catalog/company.chat/settings", settings);
  assert.deepEqual(await send(alice, bob, internal.text, context, internal.clientMessageId), internal, "A disabled page still confirms an already accepted exact UUID");
  assert.equal((await alice.client.request("POST", messagesPath(bob.user.id), {
    ...context, clientMessageId: internal.clientMessageId, text: "مختلفة",
  })).status, 409);
  assert.equal((await alice.client.request("POST", messagesPath(bob.user.id), {
    ...context, clientMessageId: randomUUID(), text: "جديدة",
  })).status, 403);
  await denied(alice.client, "GET", `${messagesPath(bob.user.id)}?${query(context)}`);
  await f.owner.client.ok("PUT", "/page-catalog/company.chat/settings", { ...settings, enabled: true, revision: disabled.page.revision });
  const rulesPath = `/companies/${company.id}/configuration/employee-rules`;
  const createDeny = await f.owner.client.ok<{ rule: { revision: number } }>("PUT", rulesPath, {
    employeeId: aliceEmployee.id, permissionKey: "company.chat:create", effect: "deny", revision: null,
  });
  assert.equal((await messages(alice, bob, context)).length, 1, "Create deny preserves otherwise authorized history read");
  await denied(alice.client, "POST", messagesPath(bob.user.id), { ...context, clientMessageId: internal.clientMessageId, text: internal.text });
  await f.owner.client.ok("PUT", rulesPath, { employeeId: aliceEmployee.id, permissionKey: "company.chat:create", effect: null, revision: createDeny.rule.revision });
  const viewDeny = await f.owner.client.ok<{ rule: { revision: number } }>("PUT", rulesPath, {
    employeeId: aliceEmployee.id, permissionKey: "company.chat:view", effect: "deny", revision: null,
  });
  await denied(alice.client, "GET", `${messagesPath(bob.user.id)}?${query(context)}`);
  await denied(alice.client, "POST", receiptPath(bob.user.id), { ...context, readMessageIds: [internal.id] });
  await f.owner.client.ok("PUT", rulesPath, { employeeId: aliceEmployee.id, permissionKey: "company.chat:view", effect: null, revision: viewDeny.rule.revision });
  await f.owner.client.ok("PATCH", `/companies/${company.id}/employees/${bobEmployee.id}`, { active: false });
  assert.deepEqual((await messages(alice, bob, context)).map(message => message.id), [internal.id], "A remaining participant retains their history after the peer leaves");
  await denied(bob.client, "POST", receiptPath(alice.user.id), { ...context, readMessageIds: [internal.id] });
  await denied(alice.client, "POST", messagesPath(bob.user.id), { ...context, clientMessageId: randomUUID(), text: "موظف موقوف" });
  assert.equal((await messages(alice, bob)).length, 1, "Company removal does not expose or remove the separate personal conversation");
  await f.owner.client.ok("PATCH", `/companies/${company.id}/employees/${bobEmployee.id}`, { active: true });
  await f.owner.client.ok("PATCH", `/companies/${company.id}/employees/${aliceEmployee.id}`, { active: false });
  await denied(alice.client, "GET", `/chat/conversations?${query(context)}`);
  await f.pool.query("UPDATE users SET suspended=true WHERE id=$1", [alice.user.id]);
  await denied(alice.client, "POST", messagesPath(bob.user.id), { ...globalChat, clientMessageId: randomUUID(), text: "موقوف عن المشاركة" });
});

test("chat avatars serve only current owned profile thumbnails with current page and company access", async t => {
  const f = await fixture(t);
  const alice = await f.actor("alice"), bob = await f.actor("bob"), outsider = await f.actor("outsider");
  interface Asset { id: string; fullUrl: string; thumbnailUrl: string; }
  const upload = async (actor: Actor, companyId: number | null = null) => actor.client.ok<Asset>("POST", "/media", {
    purpose: companyId === null ? "avatar" : "item", companyId,
    original: CHAT_AVATAR_DATA_URL, thumbnail: CHAT_AVATAR_DATA_URL,
  }, 201);
  const setImage = async (actor: Actor, image: string) => actor.client.ok("PATCH", "/profile", {
    name: actor.user.name, displayName: actor.user.displayName, email: actor.user.email, phone: actor.user.phone, image,
  });
  const peer = async (context = globalChat) => {
    const directory = await alice.client.ok<ChatPage<ChatUser>>("GET", `/chat/directory?${query(context)}`);
    const result = directory.items.find(user => user.id === bob.user.id); assert(result); return result;
  };
  const avatar = await upload(bob), unlinked = await upload(bob), aliceAvatar = await upload(alice);
  await setImage(bob, avatar.fullUrl); await setImage(alice, aliceAvatar.fullUrl);
  const initial = await peer(); assert(initial.avatarUrl);
  assert.deepEqual(Object.keys(initial).sort(), ["avatarUrl", "id", "name"]);
  const avatarUrl = new URL(initial.avatarUrl, "http://localhost");
  assert.equal(avatarUrl.pathname, `/api/chat/avatars/${bob.user.id}`);
  assert.equal(avatarUrl.searchParams.get("scope"), "global"); assert.equal(avatarUrl.searchParams.get("v"), avatar.id);
  const rendered = await alice.client.image(initial.avatarUrl);
  assert.equal(rendered.status, 200); assert.equal(rendered.headers.get("content-type"), "image/png");
  assert.match(rendered.headers.get("cache-control") ?? "", /no-store/); assert(rendered.bytes.length > 8);
  assert.equal((await bob.client.image(avatar.thumbnailUrl)).status, 200);
  assert.equal((await alice.client.image(avatar.thumbnailUrl)).status, 404, "Generic media access remains owner-only");
  assert.equal((await f.client().image(initial.avatarUrl)).status, 401);
  const guess = (assetId: string) => `/chat/avatars/${bob.user.id}?scope=global&v=${assetId}`;
  assert.equal((await alice.client.image(guess(unlinked.id))).status, 404, "An unlinked private upload is never a chat avatar");
  assert.equal((await alice.client.image(guess(randomUUID()))).status, 404);
  const replacement = await upload(bob); await setImage(bob, replacement.fullUrl);
  const current = await peer(); assert(current.avatarUrl);
  assert.notEqual(current.avatarUrl, initial.avatarUrl); assert.equal((await alice.client.image(initial.avatarUrl)).status, 404);
  assert.equal((await alice.client.image(current.avatarUrl)).status, 200);
  await setImage(bob, ""); assert.equal((await peer()).avatarUrl, null);
  assert.equal((await alice.client.image(current.avatarUrl)).status, 404, "Removing the current profile image immediately invalidates its old URL");
  await setImage(bob, "https://example.invalid/avatar.png"); assert.equal((await peer()).avatarUrl, null);
  assert.equal((await alice.client.image(guess(replacement.id))).status, 404);
  assert.equal((await bob.client.request("PATCH", "/profile", {
    name: bob.user.name, displayName: bob.user.displayName, email: bob.user.email, phone: bob.user.phone, image: aliceAvatar.fullUrl,
  })).status, 403);
  // Isolated legacy-row fixtures verify that forged references are also
  // rejected when projecting and serving, independently of profile writes.
  await f.pool.query("UPDATE users SET image=$1 WHERE id=$2", [aliceAvatar.fullUrl, bob.user.id]);
  assert.equal((await peer()).avatarUrl, null); assert.equal((await alice.client.image(guess(aliceAvatar.id))).status, 404);
  const company = (await f.owner.client.ok<{ company: Company }>("POST", "/companies", { name: "شركة صور الدردشة", phone: "", address: "" }, 201)).company;
  const staff: Employee[] = [];
  for (const user of [alice.user, bob.user]) staff.push((await f.owner.client.ok<{ employee: Employee }>("POST", `/companies/${company.id}/employees`, {
    userId: user.id, name: user.name, phone: "", role: "employee", active: true, permissions: [],
  }, 201)).employee);
  const itemImage = await upload(f.owner, company.id);
  await f.pool.query("UPDATE users SET image=$1 WHERE id=$2", [itemImage.fullUrl, bob.user.id]);
  assert.equal((await peer()).avatarUrl, null); assert.equal((await alice.client.image(guess(itemImage.id))).status, 404);
  await setImage(bob, replacement.fullUrl);
  const group = await alice.client.ok<ChatGroupDetail>("POST", "/chat/groups", { scope: "global", clientGroupId: randomUUID(), name: "صور أعضاء المجموعة", memberIds: [bob.user.id, outsider.user.id] });
  assert.equal(group.members.find(user => user.id === bob.user.id)?.avatarUrl, (await peer()).avatarUrl);
  const groupMessage = (await alice.client.ok<{ message: ChatGroupMessage }>("POST", `/chat/groups/${group.group.id}/messages`, {
    scope: "global", membershipRevision: group.group.membershipRevision, clientMessageId: randomUUID(), text: "الصور تبقى مراجع مخولة فقط",
  })).message;
  assert(groupMessage.senderAvatarUrl); assert.equal((await alice.client.image(groupMessage.senderAvatarUrl)).status, 200);
  assert.equal(groupMessage.receipts.find(receipt => receipt.userId === bob.user.id)?.avatarUrl, (await peer()).avatarUrl);
  const context: ChatContext = { scope: "company", companyId: company.id };
  const companyPeer = await peer(context); assert(companyPeer.avatarUrl);
  assert.equal(new URL(companyPeer.avatarUrl, "http://localhost").searchParams.get("companyId"), String(company.id));
  assert.equal((await alice.client.image(companyPeer.avatarUrl)).status, 200);
  assert.equal((await outsider.client.image(companyPeer.avatarUrl)).status, 403);
  const rulesPath = `/companies/${company.id}/configuration/employee-rules`;
  const deny = await f.owner.client.ok<{ rule: { revision: number } }>("PUT", rulesPath, { employeeId: staff[0]!.id, permissionKey: "company.chat:view", effect: "deny", revision: null });
  assert.equal((await alice.client.image(companyPeer.avatarUrl)).status, 403);
  await f.owner.client.ok("PUT", rulesPath, { employeeId: staff[0]!.id, permissionKey: "company.chat:view", effect: null, revision: deny.rule.revision });
  const settings = { companyId: company.id, visible: true, enabled: false, order: 100, revision: null };
  const disabled = await f.owner.client.ok<{ page: { revision: number } }>("PUT", "/page-catalog/company.chat/settings", settings);
  const blockedPhoto = await alice.client.image(companyPeer.avatarUrl);
  assert.equal(blockedPhoto.status, 403); assert.match(blockedPhoto.headers.get("cache-control") ?? "", /no-store/);
  await f.owner.client.ok("PUT", "/page-catalog/company.chat/settings", { ...settings, enabled: true, revision: disabled.page.revision });
  await f.owner.client.ok("PATCH", `/companies/${company.id}/employees/${staff[1]!.id}`, { active: false });
  assert.equal((await alice.client.image(companyPeer.avatarUrl)).status, 404);
  assert.equal((await alice.client.image((await peer()).avatarUrl!)).status, 200, "Company departure does not leak or revoke the separate public-profile photo");
  await f.owner.client.ok("PATCH", `/companies/${company.id}/employees/${staff[0]!.id}`, { active: false });
  assert.equal((await alice.client.image(companyPeer.avatarUrl)).status, 403);
  const publicPhoto = (await peer()).avatarUrl!;
  await f.pool.query("UPDATE users SET suspended=true WHERE id=$1", [bob.user.id]);
  assert.equal((await alice.client.image(publicPhoto)).status, 404);
  await f.pool.query("UPDATE users SET suspended=false,archived=true WHERE id=$1", [bob.user.id]);
  assert.equal((await alice.client.image(publicPhoto)).status, 404);
  await f.pool.query("UPDATE users SET archived=false WHERE id=$1", [bob.user.id]);
  await f.pool.query("UPDATE users SET suspended=true WHERE id=$1", [alice.user.id]);
  assert.equal((await alice.client.image(publicPhoto)).status, 403);
});

test("chat image defaults deny direct and group attachments; only participants can read uploaded images", async t => {
  const f = await fixture(t);
  const alice = await f.actor("alice"), bob = await f.actor("bob"), other = await f.actor("other");
  const originalSettings = await alice.client.ok<{allowGroupImages:boolean;allowDirectImages:boolean;revision:number;siteOwnerIds:number[]}>("GET", "/chat/image-settings");
  assert.equal(originalSettings.allowGroupImages,false);
  assert.equal(originalSettings.allowDirectImages,false);
  const asset = await alice.client.ok<{id:string;fullUrl:string}>("POST", "/media", {
    purpose:"chat",companyId:null,original:CHAT_AVATAR_DATA_URL,thumbnail:CHAT_AVATAR_DATA_URL,
  },201);
  assert.equal((await alice.client.image(asset.fullUrl)).status,404,"Unsent image must stay private even from its uploader");
  const key = randomUUID();
  const payload = {...globalChat,clientMessageId:key,text:"",imageId:asset.id};
  assert.equal((await alice.client.request("POST",messagesPath(bob.user.id),payload)).status,403);
  // A conversation with the SITE owner is always exempt, in either direction.
  assert(originalSettings.siteOwnerIds?.includes(f.owner.user.id));
  const ownerImage = await alice.client.ok<{id:string;fullUrl:string}>("POST", "/media", {
    purpose:"chat", companyId:null, original:CHAT_AVATAR_DATA_URL, thumbnail:CHAT_AVATAR_DATA_URL,
  },201);
  const withOwner = await alice.client.ok<{message:ChatMessage}>("POST",messagesPath(f.owner.user.id), {
    ...globalChat,clientMessageId:randomUUID(),text:"",imageId:ownerImage.id,
  });
  assert.equal(withOwner.message.imageUrl,ownerImage.fullUrl);
  assert.equal((await f.owner.client.image(ownerImage.fullUrl)).status,200);
  const outboundImage = await f.owner.client.ok<{id:string;fullUrl:string}>("POST", "/media", {
    purpose:"chat", companyId:null, original:CHAT_AVATAR_DATA_URL, thumbnail:CHAT_AVATAR_DATA_URL,
  },201);
  const fromOwner = await f.owner.client.ok<{message:ChatMessage}>("POST",messagesPath(bob.user.id), {
    ...globalChat,clientMessageId:randomUUID(),text:"",imageId:outboundImage.id,
  });
  assert.equal(fromOwner.message.imageUrl,outboundImage.fullUrl);
  assert.equal((await bob.client.image(outboundImage.fullUrl)).status,200);
  // siteOwnerIds belongs to GET metadata and must never be sent to the strict write API.
  const editableSettings = ({allowGroupImages,allowDirectImages,revision}:{allowGroupImages:boolean;allowDirectImages:boolean;revision:number}) =>
    ({allowGroupImages,allowDirectImages,revision});
  const changedSettings = {...editableSettings(originalSettings),allowDirectImages:true};
  assert.equal((await alice.client.request("PUT","/chat/image-settings",changedSettings)).status,403);
  const enabled = await f.owner.client.ok<{allowGroupImages:boolean;allowDirectImages:boolean;revision:number}>("PUT","/chat/image-settings",changedSettings);
  assert.equal(enabled.allowDirectImages,true);
  assert.equal(enabled.allowGroupImages,false);
  const received = await alice.client.ok<{message:ChatMessage}>("POST",messagesPath(bob.user.id),payload);
  assert.equal(received.message.text,"");
  assert.equal(received.message.imageUrl,asset.fullUrl);
  assert.equal((await alice.client.image(asset.fullUrl)).status,200);
  assert.equal((await bob.client.image(asset.fullUrl)).status,200);
  assert.notEqual((await other.client.image(asset.fullUrl)).status,200);
  assert.notEqual((await f.owner.client.image(asset.fullUrl)).status,200);
  await f.owner.client.ok("PUT","/chat/image-settings",{...enabled,allowDirectImages:false});
  const retry = await alice.client.ok<{message:ChatMessage}>("POST",messagesPath(bob.user.id),payload);
  assert.equal(retry.message.id,received.message.id,"Acknowledging a previously accepted UUID survives changes to settings");
  assert.equal((await alice.client.request("POST",messagesPath(bob.user.id),{
    ...globalChat,clientMessageId:randomUUID(),text:"",imageId:asset.id
  })).status,403);
});
