import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import type { Server } from "node:http";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { createDatabase, migrate } from "../apps/api/src/db.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import { DEFAULT_APPEARANCE } from "../packages/contracts/src/index.ts";
import type {
  AppearancePreference,
  AuditEvent,
  Branch,
  Company,
  CompanyContext,
  Location,
  ItemStatistics,
  Invoice,
  CompanyPage,
  Employee,
  GeneralTableRecord,
  Page,
  Permission,
  SessionResponse,
  User,
} from "../packages/contracts/src/index.ts";

const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const appOrigin = "http://localhost";
const password = "a-long-test-passphrase";

interface RequestOptions {
  csrf?: string | false;
  origin?: string | false;
}

class Client {
  private cookie = "";
  csrf: string | null = null;

  constructor(
    private readonly baseUrl: () => string,
    private readonly origin = appOrigin,
  ) {}

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<{ status: number; body: T; headers: Headers }> {
    const headers = new Headers({ accept: "application/json" });
    if (this.cookie) headers.set("cookie", this.cookie);
    if (method !== "GET" && method !== "HEAD") {
      headers.set("content-type", "application/json");
      if (options.origin !== false)
        headers.set("origin", options.origin ?? this.origin);
      if (options.csrf !== false && (options.csrf ?? this.csrf))
        headers.set("x-csrf-token", options.csrf || this.csrf!);
    }
    if (body !== undefined) headers.set("content-type", "application/json");
    const response = await fetch(`${this.baseUrl()}/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const value of response.headers.getSetCookie()) {
      const cookie = value.split(";", 1)[0]!;
      if (/max-age=0/i.test(value)) this.cookie = "";
      else this.cookie = cookie;
    }
    const raw = await response.text();
    const parsed: unknown = raw && response.headers.get("content-type")?.includes("json") ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object" && "csrf" in parsed) {
      const csrf = (parsed as { csrf: unknown }).csrf;
      if (typeof csrf === "string" || csrf === null) this.csrf = csrf;
    }
    return {
      status: response.status,
      body: parsed as T,
      headers: response.headers,
    };
  }

  async ok<T>(
    method: string,
    path: string,
    body?: unknown,
    status = 200,
  ): Promise<T> {
    const response = await this.request<T>(method, path, body);
    assert.equal(
      response.status,
      status,
      `${method} ${path}: ${JSON.stringify(response.body)}`,
    );
    return response.body;
  }
}

async function fixture(
  t: TestContext,
  options: { production?: boolean; appOrigin?: string } = {},
) {
  const schema = `api_test_${randomUUID().replaceAll("-", "")}`;
  const configuration = {
    databaseUrl,
    schema,
    appOrigin: options.appOrigin ?? appOrigin,
    production: options.production ?? false,
    serveStatic: false,
  };
  let runtime = await createApp(configuration);
  let server: Server;
  let baseUrl = "";

  async function listen() {
    server = runtime.app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async function stop() {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await runtime.close();
  }

  await listen();
  t.after(async () => {
    await stop();
    const cleanup = new Pool({ connectionString: databaseUrl });
    try {
      await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await cleanup.end();
    }
  });

  return {
    schema,
    get baseUrl() { return baseUrl; },
    get pool() {
      return runtime.pool;
    },
    client: () => new Client(() => baseUrl, configuration.appOrigin),
    async restart() {
      await stop();
      runtime = await createApp(configuration);
      await listen();
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function overlapping<T>(
  f: Fixture,
  table: "users" | "employees" | "appearance",
  operations: (() => Promise<T>)[],
  userId?: number,
) {
  const blocker = await f.pool.connect();
  await blocker.query("BEGIN");
  if (userId === undefined)
    await blocker.query(`LOCK TABLE "${table}" IN SHARE MODE`);
  else
    await blocker.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
      userId,
    ]);
  const pending = Promise.allSettled(
    operations.map((operation) => operation()),
  );
  let barrierError: unknown;
  try {
    const deadline = Date.now() + 5000;
    let blocked = 0;
    do {
      const locks = await f.pool.query<{ count: number }>(
        `
        SELECT count(DISTINCT waiting.pid)::integer AS count FROM pg_locks waiting
        WHERE NOT waiting.granted AND EXISTS (
          SELECT 1 FROM pg_locks scoped JOIN pg_class relation ON relation.oid=scoped.relation
          JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
          WHERE scoped.pid=waiting.pid AND namespace.nspname=$1
        )`,
        [f.schema],
      );
      blocked = locks.rows[0]!.count;
      if (blocked >= operations.length) break;
      await delay(10);
    } while (Date.now() < deadline);
    assert.ok(
      blocked >= operations.length,
      `Expected ${operations.length} concurrent blocked operations, observed ${blocked}`,
    );
  } catch (error) {
    barrierError = error;
  } finally {
    await blocker.query("COMMIT");
    blocker.release();
  }
  const results = await pending;
  if (barrierError) throw barrierError;
  return results;
}

function fulfilled<T>(result: PromiseSettledResult<T>): T {
  assert.equal(
    result.status,
    "fulfilled",
    result.status === "rejected" ? String(result.reason) : undefined,
  );
  assert.ok(result.status === "fulfilled");
  return result.value;
}

async function register(
  f: Fixture,
  email: string,
  overrides: Partial<{ name: string; displayName: string; phone: string }> = {},
) {
  const client = f.client();
  const response = await client.ok<SessionResponse>(
    "POST",
    "/auth/register",
    {
      name: "Test user",
      displayName: "Test",
      email,
      phone: "",
      password,
      ...overrides,
    },
    201,
  );
  assert.ok(response.user);
  assert.ok(response.csrf);
  return { client, user: response.user };
}

async function owner(f: Fixture) {
  const user = await provisionOwner(f.pool, {
    name: "Platform owner",
    displayName: "Owner",
    email: "owner@example.test",
    password,
  });
  const client = f.client();
  const session = await client.ok<SessionResponse>("POST", "/auth/login", {
    email: user.email,
    password,
  });
  assert.equal(session.user?.id, user.id);
  assert.equal(session.user?.owner, true);
  return { client, user };
}

async function company(client: Client, name: string) {
  return (
    await client.ok<{ company: Company }>(
      "POST",
      "/companies",
      { name, phone: "", address: "" },
      201,
    )
  ).company;
}

async function employee(
  client: Client,
  companyId: number,
  userId: number,
  permissions: Permission[] = [],
) {
  return (
    await client.ok<{ employee: Employee }>(
      "POST",
      `/companies/${companyId}/employees`,
      {
        userId,
        name: "Employee",
        phone: "",
        role: "employee",
        active: true,
        permissions,
      },
      201,
    )
  ).employee;
}

function assertNoSecrets(value: unknown) {
  const sensitiveKeys =
    /^(password|passwordHash|password_hash|token|tokenHash|token_hash|session|sessionToken|csrf)$/i;
  function inspect(node: unknown) {
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      assert.equal(sensitiveKeys.test(key), false, `Secret key leaked: ${key}`);
      inspect(child);
    }
  }
  inspect(value);
  assert.equal(JSON.stringify(value).includes(password), false);
}

test("registration creates an ordinary public identity and sessions enforce CSRF and origin", async (t) => {
  const f = await fixture(t);
  const anonymous = f.client();
  assert.deepEqual(
    await anonymous.ok<SessionResponse>("GET", "/auth/session"),
    { user: null, csrf: null },
  );
  assert.equal((await anonymous.request("GET", "/users")).status, 401);
  assert.equal(
    (
      await anonymous.request("POST", "/auth/register", {
        name: "User",
        displayName: "User",
        email: "short@example.test",
        phone: "",
        password: "short",
      })
    ).status,
    400,
  );

  const { client, user } = await register(f, "  FIRST@EXAMPLE.TEST  ", {
    name: " First user ",
    displayName: " First ",
    phone: "+٩٦٦ (٥٥٥) ١٢٣-٤٥٦",
  });
  assert.equal(user.name, "First user");
  assert.equal(user.email, "first@example.test");
  assert.equal(user.phone, "+966555123456");
  assert.equal(user.owner, false);
  assert.equal(user.kind, "member");
  assert.equal(user.editor, false);
  assert.equal(user.monitor, false);
  assertNoSecrets(user);
  assert.equal((await client.ok<CompanyPage>("GET", "/companies")).total, 0);
  assert.equal(
    (
      await client.request("POST", "/companies", {
        name: "Forbidden",
        phone: "",
        address: "",
      })
    ).status,
    403,
  );
  assert.equal((await client.request("GET", "/users")).status, 403);
  assert.equal((await client.request("GET", "/audit")).status, 403);

  const profile = {
    name: "Changed",
    displayName: "Changed",
    email: user.email,
    phone: user.phone,
    image: "",
  };
  assert.equal(
    (await client.request("PATCH", "/profile", profile, { csrf: false }))
      .status,
    403,
  );
  assert.equal(
    (
      await client.request("PATCH", "/profile", profile, {
        csrf: "invalid-token",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await client.request("PATCH", "/profile", profile, {
        origin: "https://attacker.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (await client.request("PATCH", "/profile", profile, { origin: false }))
      .status,
    403,
  );
  assert.equal(
    (await client.ok<SessionResponse>("GET", "/auth/session")).user?.name,
    "First user",
  );
  assert.equal(
    (
      await anonymous.request("POST", "/auth/register", {
        name: "Duplicate",
        displayName: "Duplicate",
        email: user.email.toUpperCase(),
        phone: "",
        password,
      })
    ).status,
    409,
  );

  const logout = await client.request("POST", "/auth/logout");
  assert.ok(logout.status === 200 || logout.status === 204);
  assert.equal(
    (await client.ok<SessionResponse>("GET", "/auth/session")).user,
    null,
  );
  assert.equal(
    (await client.request("PATCH", "/profile", profile)).status,
    401,
  );
  assert.equal(
    (
      await client.request("POST", "/auth/login", {
        email: user.email,
        password: "incorrect-password",
      })
    ).status,
    401,
  );
  const login = await client.request<SessionResponse>("POST", "/auth/login", {
    email: user.email,
    password,
  });
  assert.equal(login.status, 200);
  assert.equal(login.body.user?.id, user.id);
  const setCookie = login.headers.getSetCookie().join(";");
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  const token = setCookie.match(/^tijara_session=([^;]+)/)?.[1];
  assert.ok(token);
  const sessions = await f.pool.query<{ token_hash: string }>(
    "SELECT token_hash FROM sessions WHERE user_id=$1",
    [user.id],
  );
  assert.equal(sessions.rows.length, 1);
  assert.equal(
    sessions.rows[0]?.token_hash,
    createHash("sha256").update(token).digest("hex"),
  );
  assert.notEqual(sessions.rows[0]?.token_hash, token);
  const stored = await f.pool.query<{ password_hash: string }>(
    "SELECT password_hash FROM users WHERE id=$1",
    [user.id],
  );
  assert.notEqual(stored.rows[0]?.password_hash, password);
  await f.pool.query(
    "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1",
    [user.id],
  );
  assert.equal(
    (await client.ok<SessionResponse>("GET", "/auth/session")).user,
    null,
  );
});

test("production requires a configured HTTPS origin and issues a Secure session cookie", async (t) => {
  await assert.rejects(
    createApp({ databaseUrl, production: true, appOrigin: "" }),
    /explicitly configured/,
  );
  await assert.rejects(
    createApp({
      databaseUrl,
      production: true,
      appOrigin: "http://example.test",
    }),
    /HTTPS/,
  );
  await assert.rejects(
    createApp({ databaseUrl, schema: "public;drop_schema", production: false }),
    /Invalid database schema/,
  );
  const f = await fixture(t, {
    production: true,
    appOrigin: "https://example.test",
  });
  const client = f.client();
  const registered = await client.request<SessionResponse>(
    "POST",
    "/auth/register",
    {
      name: "Production user",
      displayName: "Production",
      email: "production@example.test",
      phone: "",
      password,
    },
  );
  assert.equal(registered.status, 201);
  assert.match(
    registered.headers.getSetCookie().join(";"),
    /(?:^|;)\s*Secure(?:;|$)/i,
  );
  assert.equal(
    (
      await client.request(
        "PATCH",
        "/profile",
        {
          name: "Changed",
          displayName: "Changed",
          email: "production@example.test",
          phone: "",
          image: "",
        },
        { origin: appOrigin },
      )
    ).status,
    403,
  );
});

test("profile and password changes persist normalized values and do not expose secrets in public audit", async (t) => {
  const f = await fixture(t);
  const platform = await owner(f);
  const { client, user } = await register(f, "profile@example.test");
  const profile = {
    name: "  Updated name ",
    displayName: " Display ",
    email: "  UPDATED@EXAMPLE.TEST ",
    phone: "٠٥٠ (١٢٣) ٤٥٦٧",
    image: "https://example.test/avatar.png",
  };
  await client.ok("PATCH", "/profile", profile);
  const updated = (await client.ok<SessionResponse>("GET", "/auth/session"))
    .user;
  assert.ok(updated);
  assert.equal(updated.name, "Updated name");
  assert.equal(updated.displayName, "Display");
  assert.equal(updated.email, "updated@example.test");
  assert.equal(updated.phone, "0501234567");
  assert.equal(updated.image, profile.image);
  assert.equal(
    (await client.request("PATCH", "/profile", { ...profile, owner: true }))
      .status,
    400,
  );
  const fallback = await client.ok<{ user: User }>("PATCH", "/profile", {
    ...profile,
    name: "  Canonical fallback  ",
    displayName: "   ",
  });
  assert.equal(fallback.user.name, "Canonical fallback");
  assert.equal(fallback.user.displayName, fallback.user.name);
  const storedProfile = await f.pool.query<{
    name: string;
    displayName: string;
    email: string;
    phone: string;
    image: string;
  }>(
    'SELECT name,display_name AS "displayName",email,phone,image FROM users WHERE id=$1',
    [user.id],
  );
  assert.equal(storedProfile.rows[0]?.displayName, fallback.user.name);

  const otherSession = f.client();
  await otherSession.ok("POST", "/auth/login", {
    email: updated.email,
    password,
  });
  assert.equal(
    (
      await client.request("POST", "/auth/password", {
        currentPassword: "incorrect-password",
        newPassword: "new-long-passphrase",
      })
    ).status,
    400,
  );
  await client.ok("POST", "/auth/password", {
    currentPassword: password,
    newPassword: "new-long-passphrase",
  });
  assert.equal(
    (await otherSession.ok<SessionResponse>("GET", "/auth/session")).user,
    null,
  );
  const fresh = f.client();
  assert.equal(
    (
      await fresh.request("POST", "/auth/login", {
        email: updated.email,
        password,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fresh.ok<SessionResponse>("POST", "/auth/login", {
        email: updated.email,
        password: "new-long-passphrase",
      })
    ).user?.id,
    user.id,
  );

  const audit = await platform.client.ok<Page<AuditEvent>>(
    "GET",
    "/audit?pageSize=100",
  );
  const entry = audit.items.find(
    (event) =>
      event.targetId === user.id &&
      event.before?.name === user.name &&
      event.after?.name === updated.name,
  );
  assert.ok(
    entry,
    "A profile change must record actual before and normalized after values",
  );
  assert.equal(entry.actorId, user.id);
  assert.equal(entry.scope, "public");
  assert.equal(entry.after?.email, updated.email);
  assert.equal(entry.after?.phone, updated.phone);
  const fallbackAudit = audit.items.find(
    (event) =>
      event.targetId === user.id && event.after?.name === fallback.user.name,
  );
  assert.ok(fallbackAudit);
  assert.deepEqual(fallbackAudit.before, updated);
  assert.deepEqual(fallbackAudit.after, fallback.user);
  for (const [field, stored] of Object.entries(storedProfile.rows[0]!))
    assert.equal(fallbackAudit.after?.[field], stored);
  assertNoSecrets(audit);
  assert.equal(JSON.stringify(audit).includes("new-long-passphrase"), false);
  await f.restart();
  assert.equal(
    (await fresh.ok<SessionResponse>("GET", "/auth/session")).user?.email,
    updated.email,
  );
});

test("public administration grants no company membership and phone matches grant no access", async (t) => {
  const f = await fixture(t);
  const platform = await owner(f);
  const admin = await register(f, "admin@example.test", {
    phone: "0501112222",
  });
  const linked = await register(f, "linked@example.test");
  await platform.client.ok("PATCH", `/users/${admin.user.id}`, {
    kind: "admin",
    editor: true,
    monitor: true,
  });
  const first = await company(platform.client, "Company one");
  const second = await company(platform.client, "Company two");
  const staff = await employee(platform.client, first.id, linked.user.id);
  await platform.client.ok(
    "PATCH",
    `/companies/${first.id}/employees/${staff.id}`,
    { phone: "0501112222" },
  );

  assert.ok(
    (await admin.client.ok<Page<User>>("GET", "/users")).items.some(
      (item) => item.id === linked.user.id,
    ),
  );
  assert.equal(
    (await admin.client.ok<CompanyPage>("GET", "/companies")).total,
    0,
  );
  assert.equal(
    (await admin.client.request("GET", `/companies/${first.id}`)).status,
    403,
  );
  assert.equal(
    (await admin.client.request("POST", `/companies/${first.id}/activate`))
      .status,
    403,
  );
  assert.equal(
    (
      await admin.client.request("POST", "/companies", {
        name: "Denied",
        phone: "",
        address: "",
      })
    ).status,
    403,
  );
  assert.equal(
    (await linked.client.ok<CompanyPage>("GET", "/companies")).items[0]?.id,
    first.id,
  );
  assert.equal(
    (await linked.client.request("GET", `/companies/${second.id}`)).status,
    403,
  );
  assert.equal(
    (await linked.client.request("GET", `/companies/${first.id}/employees`))
      .status,
    403,
  );
  assert.equal(
    (await linked.client.request("GET", `/companies/${first.id}/audit`)).status,
    403,
  );
  assert.equal(
    (
      await linked.client.request("PATCH", `/companies/${first.id}`, {
        name: "Denied change",
      })
    ).status,
    403,
  );
  assert.equal(
    (await platform.client.ok<CompanyContext>("GET", `/companies/${second.id}`))
      .general,
    true,
  );

  const context = await linked.client.ok<CompanyContext>(
    "GET",
    `/companies/${first.id}`,
  );
  assert.equal(context.employee?.userId, linked.user.id);
  assert.equal(context.employee?.phone, admin.user.phone);
  assert.deepEqual(context.permissions, []);
  const search = await platform.client.ok<{ items: User[] }>(
    "GET",
    `/companies/${first.id}/users/search?q=${encodeURIComponent(admin.user.email.toUpperCase())}`,
  );
  assert.equal(search.items[0]?.id, admin.user.id);
  const byPhone = await platform.client.ok<{ items: User[] }>(
    "GET",
    `/companies/${first.id}/users/search?q=${encodeURIComponent("٠٥٠ (١١١) ٢٢٢٢")}`,
  );
  assert.equal(byPhone.items[0]?.id, admin.user.id);
  assert.equal(
    (
      await platform.client.ok<{ items: User[] }>(
        "GET",
        `/companies/${first.id}/users/search?q=admin`,
      )
    ).items.length,
    0,
  );
});

test("multiple general managers have full company access while appointments and manager protection remain owner-only", async (t) => {
  const f = await fixture(t);
  const platform = await owner(f);
  const firstManager = await register(f, "manager-one@example.test");
  const secondManager = await register(f, "manager-two@example.test");
  const ordinary = await register(f, "ordinary@example.test");
  const publicAdmin = await register(f, "public-admin@example.test");
  await platform.client.ok("PATCH", `/users/${publicAdmin.user.id}`, {
    kind: "admin",
  });
  const c = await company(platform.client, "Managers");
  const first = await employee(platform.client, c.id, firstManager.user.id);
  const second = await employee(platform.client, c.id, secondManager.user.id);
  for (const item of [first, second])
    await platform.client.ok(
      "PATCH",
      `/companies/${c.id}/employees/${item.id}/manager`,
      { isGeneralManager: true },
    );

  for (const manager of [firstManager, secondManager]) {
    const context = await manager.client.ok<CompanyContext>(
      "GET",
      `/companies/${c.id}`,
    );
    assert.equal(context.general, true);
    assert.deepEqual([...context.permissions].sort(), [
      "accounts.manage",
      "accounts.view",
      "audit.view",
      "commerce.manage",
      "commerce.view",
      "company.edit",
      "currencies.manage",
      "currencies.view",
      "employees.view",
      "finance.manage",
      "finance.post",
      "finance.view",
      "inventory.manage",
      "inventory.post",
      "inventory.view",
      "items.manage",
      "items.view",
      "locations.manage",
      "locations.view",
      "pages.manage",
    ]);
    await manager.client.ok("GET", `/companies/${c.id}/employees`);
    await manager.client.ok("GET", `/companies/${c.id}/audit`);
  }
  const regular = await employee(firstManager.client, c.id, ordinary.user.id, [
    "employees.view",
  ]);
  assert.equal(
    (
      await firstManager.client.request(
        "PATCH",
        `/companies/${c.id}/employees/${regular.id}`,
        { isGeneralManager: true },
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await firstManager.client.request(
        "POST",
        `/companies/${c.id}/employees`,
        {
          userId: ordinary.user.id,
          name: "Escalation",
          phone: "",
          role: "employee",
          active: true,
          permissions: [],
          isGeneralManager: true,
        },
      )
    ).status,
    400,
  );
  await firstManager.client.ok(
    "PATCH",
    `/companies/${c.id}/employees/${regular.id}`,
    { role: "sales", active: false },
  );
  assert.equal(
    (
      await firstManager.client.request(
        "PATCH",
        `/companies/${c.id}/employees/${second.id}/manager`,
        { isGeneralManager: false },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await firstManager.client.request(
        "PATCH",
        `/companies/${c.id}/employees/${second.id}`,
        { active: false },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await firstManager.client.request(
        "PATCH",
        `/companies/${c.id}/employees/${regular.id}/manager`,
        { isGeneralManager: true },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await publicAdmin.client.request(
        "PATCH",
        `/users/${secondManager.user.id}`,
        { archived: true },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await publicAdmin.client.request("PATCH", `/users/${platform.user.id}`, {
        archived: true,
      })
    ).status,
    403,
  );
  assert.equal(
    (await secondManager.client.ok<CompanyContext>("GET", `/companies/${c.id}`))
      .general,
    true,
  );

  await platform.client.ok("PATCH", `/users/${secondManager.user.id}`, {
    archived: true,
  });
  const audit = await platform.client.ok<Page<AuditEvent>>(
    "GET",
    "/audit?pageSize=100",
  );
  const archival = audit.items.find(
    (event) =>
      event.targetId === secondManager.user.id &&
      event.before?.archived === false &&
      event.after?.archived === true,
  );
  assert.ok(archival);
  assert.equal(archival.actorId, platform.user.id);
});

test("employee permissions and last company are rechecked on every request across tenant changes", async (t) => {
  const f = await fixture(t);
  const platform = await owner(f);
  const member = await register(f, "multi-company@example.test");
  const other = await register(f, "other-company@example.test");
  const a = await company(platform.client, "A");
  const b = await company(platform.client, "B");
  const inA = await employee(platform.client, a.id, member.user.id, [
    "company.edit",
    "employees.view",
  ]);
  const inB = await employee(platform.client, b.id, member.user.id);
  const foreign = await employee(platform.client, b.id, other.user.id);
  await member.client.ok("PATCH", `/companies/${a.id}`, {
    name: "Allowed edit",
  });
  assert.equal(
    (
      await member.client.request(
        "PATCH",
        `/companies/${a.id}/employees/${foreign.id}`,
        { active: false },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await platform.client.request(
        "PATCH",
        `/companies/${a.id}/employees/${foreign.id}`,
        { active: false },
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await platform.client.ok<Page<Employee>>(
        "GET",
        `/companies/${b.id}/employees`,
      )
    ).items.find((item) => item.id === foreign.id)?.active,
    true,
  );
  await member.client.ok("POST", `/companies/${a.id}/activate`);
  assert.equal(
    (await member.client.ok<CompanyPage>("GET", "/companies")).lastCompanyId,
    a.id,
  );
  await platform.client.ok("PATCH", `/companies/${a.id}/employees/${inA.id}`, {
    permissions: [],
  });
  assert.equal(
    (
      await member.client.request("PATCH", `/companies/${a.id}`, {
        name: "Revoked",
      })
    ).status,
    403,
  );
  assert.equal(
    (await member.client.request("GET", `/companies/${a.id}/employees`)).status,
    403,
  );
  await platform.client.ok("PATCH", `/companies/${a.id}/employees/${inA.id}`, {
    active: false,
  });
  const renamedInactive = (
    await platform.client.ok<{ employee: Employee }>(
      "PATCH",
      `/companies/${a.id}/employees/${inA.id}`,
      { name: " Renamed inactive employee " },
    )
  ).employee;
  assert.equal(renamedInactive.name, "Renamed inactive employee");
  assert.equal(
    renamedInactive.active,
    false,
    "A name-only edit must not restore revoked company membership",
  );
  assert.equal(renamedInactive.role, inA.role);
  assert.equal(renamedInactive.phone, inA.phone);
  assert.deepEqual(renamedInactive.permissions, []);
  assert.equal(
    (await f.pool.query("SELECT active FROM employees WHERE id=$1", [inA.id]))
      .rows[0]?.active,
    false,
  );
  assert.equal(
    (await member.client.request("GET", `/companies/${a.id}`)).status,
    403,
  );
  const fallback = await member.client.ok<CompanyPage>("GET", "/companies");
  assert.deepEqual(
    fallback.items.map((item) => item.id),
    [b.id],
  );
  assert.equal(fallback.lastCompanyId, b.id);
  await platform.client.ok("PATCH", `/companies/${b.id}/employees/${inB.id}`, {
    active: false,
  });
  const noAccess = await member.client.ok<CompanyPage>("GET", "/companies");
  assert.equal(noAccess.total, 0);
  assert.equal(noAccess.lastCompanyId, null);
});

test("new company provisions active main branch and showroom atomically", async (t) => {
  const f = await fixture(t);
  const platform = await owner(f);
  const created = await platform.client.ok<{ company: Company }>(
    "POST",
    "/companies",
    { name: " New Company ", phone: "+967777123456", address: " Sana'a " },
    201,
  );
  const c = created.company;
  assert.equal(c.name, "New Company");

  const branches = await platform.client.ok<Page<Branch>>(
    "GET",
    `/companies/${c.id}/branches`,
  );
  assert.equal(branches.total, 1);
  const main = branches.items[0]!;
  assert.equal(main.code, "HQ");
  assert.equal(main.name, "الفرع الرئيسي");
  assert.equal(main.active, true);
  assert.equal(main.phone, c.phone);
  assert.equal(main.address, c.address);
  assert.equal(main.companyId, c.id);
  assert.equal(main.createdBy, platform.user.id);

  const locations = await platform.client.ok<Page<Location>>(
    "GET",
    `/companies/${c.id}/locations?branchId=${main.id}`,
  );
  assert.equal(locations.total, 1);
  assert.deepEqual(
    {
      companyId: locations.items[0]?.companyId,
      branchId: locations.items[0]?.branchId,
      code: locations.items[0]?.code,
      name: locations.items[0]?.name,
      kind: locations.items[0]?.kind,
      active: locations.items[0]?.active,
      branchActive: locations.items[0]?.branchActive,
      effectiveActive: locations.items[0]?.effectiveActive,
    },
    {
      companyId: c.id,
      branchId: main.id,
      code: "SHOWROOM",
      name: "المعرض",
      kind: "showroom",
      active: true,
      branchActive: true,
      effectiveActive: true,
    },
  );

  const events = await platform.client.ok<Page<AuditEvent>>(
    "GET",
    `/companies/${c.id}/audit?pageSize=100`,
  );
  for (const action of ["company.create", "branch.create", "location.create"]) {
    assert.equal(events.items.filter((event) => event.action === action).length, 1);
  }

  const other = await company(platform.client, "Other new company");
  const otherBranches = await platform.client.ok<Page<Branch>>(
    "GET",
    `/companies/${other.id}/branches`,
  );
  assert.equal(otherBranches.total, 1);
  assert.notEqual(otherBranches.items[0]?.id, main.id);
  assert.equal(otherBranches.items[0]?.code, "HQ");
});

test("currency migration initializes legacy companies and preserves existing currency choices", async (t) => {
  const f = await fixture(t);
  const platform = await owner(f);
  const insertLegacy = async (name: string) => (
    await f.pool.query<{ id: number }>(
      "INSERT INTO companies(name,phone,address,created_by) VALUES($1,'','',$2) RETURNING id",
      [name, platform.user.id],
    )
  ).rows[0]!.id;

  const emptyId = await insertLegacy("Legacy Dar Al Dawa fixture");
  const customId = await insertLegacy("Legacy with partial currencies");
  const existing = await company(platform.client, "Already configured");
  const currentBase = (
    await f.pool.query<{ base_currency_id: number }>(
      "SELECT base_currency_id FROM finance_settings WHERE company_id=$1",
      [existing.id],
    )
  ).rows[0]!.base_currency_id;
  const custom = await f.pool.query<{ id: number }>(
    "INSERT INTO company_currencies(company_id,code,name,decimal_places,active,created_by) VALUES($1,'SAR','عملة مخصصة',3,true,$2) RETURNING id",
    [customId, platform.user.id],
  );
  await f.pool.query(
    "INSERT INTO company_currencies(company_id,code,name,decimal_places,active,created_by) VALUES($1,'YER','ريال معطل',2,false,$2)",
    [customId, platform.user.id],
  );
  await f.pool.query(
    "DELETE FROM schema_migrations WHERE version='011_backfill_company_currencies.sql'",
  );
  await migrate(f.pool);

  const currencies = await f.pool.query<{ company_id: number; code: string; name: string; decimal_places: number; active: boolean; id: number }>(
    "SELECT company_id,id,code,name,decimal_places,active FROM company_currencies WHERE company_id=ANY($1::integer[]) ORDER BY company_id,code",
    [[emptyId, customId, existing.id]],
  );
  const emptyRows = currencies.rows.filter(row => row.company_id === emptyId);
  assert.deepEqual(emptyRows.map(row => row.code), ["SAR", "USD", "YER"]);
  const emptyBase = await f.pool.query<{ code: string }>(
    "SELECT cur.code FROM finance_settings fs JOIN company_currencies cur ON cur.id=fs.base_currency_id WHERE fs.company_id=$1",
    [emptyId],
  );
  assert.equal(emptyBase.rows[0]?.code, "YER");
  const customRows = currencies.rows.filter(row => row.company_id === customId);
  assert.deepEqual(customRows.map(row => row.code), ["SAR", "USD", "YER"]);
  assert.equal(customRows.find(row => row.code === "SAR")?.id, custom.rows[0]?.id);
  assert.equal(customRows.find(row => row.code === "SAR")?.name, "عملة مخصصة");
  assert.equal(customRows.find(row => row.code === "SAR")?.decimal_places, 3);
  assert.equal(customRows.find(row => row.code === "YER")?.active, false);
  const customBase = await f.pool.query<{ code: string }>(
    "SELECT cur.code FROM finance_settings fs JOIN company_currencies cur ON cur.id=fs.base_currency_id WHERE fs.company_id=$1",
    [customId],
  );
  assert.equal(customBase.rows[0]?.code, "SAR");

  const existingBase = await f.pool.query<{ base_currency_id: number }>(
    "SELECT base_currency_id FROM finance_settings WHERE company_id=$1",
    [existing.id],
  );
  assert.equal(existingBase.rows[0]?.base_currency_id, currentBase);
  const snapshot = currencies.rows;
  await migrate(f.pool);
  const again = await f.pool.query(
    "SELECT company_id,id,code,name,decimal_places,active FROM company_currencies WHERE company_id=ANY($1::integer[]) ORDER BY company_id,code",
    [[emptyId, customId, existing.id]],
  );
  assert.deepEqual(again.rows, snapshot);
  const audit = await f.pool.query(
    "SELECT company_id FROM audit_events WHERE action='currencies.initialize' AND actor_id IS NULL AND company_id=ANY($1::integer[])",
    [[emptyId, customId]],
  );
  assert.equal(audit.rowCount, 2);
});

test("migration backfills only older companies without branches, and never duplicates a showroom", async (t) => {
  const f = await fixture(t);
  const platform = await owner(f);
  // Simulate a company created before HQ provisioning (without using the current API).
  const legacy = await f.pool.query<{ id: number }>(
    "INSERT INTO companies(name,phone,address,created_by) VALUES($1,$2,$3,$4) RETURNING id",
    ["Legacy Company", "+967123456789", "Old address", platform.user.id],
  );
  const legacyId = legacy.rows[0]!.id;
  const existing = await company(platform.client, "Existing organized company");
  const existingBranch = (
    await platform.client.ok<Page<Branch>>("GET", `/companies/${existing.id}/branches`)
  ).items[0]!;
  const existingShowroom = (
    await platform.client.ok<Page<Location>>("GET", `/companies/${existing.id}/locations`)
  ).items[0]!;

  // Mark only this migration as unapplied inside the disposable test schema.
  await f.pool.query("DELETE FROM schema_migrations WHERE version=$1", [
    "003_backfill_main_branch.sql",
  ]);
  await migrate(f.pool);
  const branches = await platform.client.ok<Page<Branch>>(
    "GET", `/companies/${legacyId}/branches`,
  );
  assert.equal(branches.total, 1);
  const main = branches.items[0]!;
  assert.equal(main.code, "HQ");
  assert.equal(main.name, "الفرع الرئيسي");
  assert.equal(main.active, true);
  assert.equal(main.phone, "+967123456789");
  assert.equal(main.address, "Old address");
  const locations = await platform.client.ok<Page<Location>>(
    "GET", `/companies/${legacyId}/locations`,
  );
  assert.equal(locations.total, 1);
  assert.equal(locations.items[0]?.branchId, main.id);
  assert.equal(locations.items[0]?.code, "SHOWROOM");
  assert.equal(locations.items[0]?.name, "المعرض");
  assert.equal(locations.items[0]?.effectiveActive, true);
  const events = await platform.client.ok<Page<AuditEvent>>(
    "GET", `/companies/${legacyId}/audit?pageSize=100`,
  );
  assert.equal(events.items.filter((event) => event.action === "branch.create").length, 1);
  assert.equal(events.items.filter((event) => event.action === "location.create").length, 1);

  // A second migration pass must do nothing; an already configured company is untouched.
  await migrate(f.pool);
  assert.equal(
    (await platform.client.ok<Page<Branch>>("GET", `/companies/${legacyId}/branches`)).total,
    1,
  );
  const stillBranch = await platform.client.ok<Page<Branch>>(
    "GET", `/companies/${existing.id}/branches`,
  );
  const stillShowroom = await platform.client.ok<Page<Location>>(
    "GET", `/companies/${existing.id}/locations`,
  );
  assert.equal(stillBranch.total, 1);
  assert.equal(stillBranch.items[0]?.id, existingBranch.id);
  assert.equal(stillShowroom.total, 1);
  assert.equal(stillShowroom.items[0]?.id, existingShowroom.id);
});

test("bulk duplicate of selected general-table rows is atomic, audited and restricted", async (t) => {
  const f = await fixture(t);
  const admin = await owner(f);
  const ordinary = await register(f, "general-table-duplicate-ordinary@example.test");
  const template = {
    tableName: "duplicates", category: "test", title: "Copied entry",
    description: "An exact non-empty description",
    number1: "102.5", number2: "-7.125",
    date1: "2026-10-12T08:00:00.000Z", date2: null,
    ...Object.fromEntries(Array.from({ length: 9 }, (_, index) => [
      `text${index + 1}`, `Sample ${index + 1}`,
    ])),
  };
  const first = (await admin.client.ok<{record:GeneralTableRecord}>(
    "POST", "/general-table", template, 201,
  )).record;
  const second = (await admin.client.ok<{record:GeneralTableRecord}>(
    "POST", "/general-table", { ...template, title: "Second copied entry" }, 201,
  )).record;
  const ids = [first.id, second.id];
  assert.equal(
    (await ordinary.client.request("POST", "/general-table/duplicate", { ids })).status, 403,
  );
  assert.equal(
    (await f.client().request("POST", "/general-table/duplicate", { ids })).status, 401,
  );
  for (const invalid of [{ ids: [] }, { ids: [first.id, first.id] }, { ids: [0] }]) {
    assert.equal(
      (await admin.client.request("POST", "/general-table/duplicate", invalid)).status, 400,
    );
  }
  assert.equal(
    (await admin.client.request("POST", "/general-table/duplicate", {
      ids: [first.id, 2_147_483_647],
    })).status, 404,
  );
  assert.equal(
    (await admin.client.ok<Page<GeneralTableRecord>>(
      "GET", "/general-table?tableName=duplicates",
    )).total, 2,
    "A missing selected source must roll back all copies",
  );

  const copies = await admin.client.ok<{ created: number; records: GeneralTableRecord[] }>(
    "POST", "/general-table/duplicate", { ids }, 201,
  );
  assert.equal(copies.created, 2);
  assert.equal(copies.records.length, 2);
  for (const [index, original] of [first, second].entries()) {
    const copied = copies.records[index]!;
    assert.notEqual(copied.id, original.id);
    const withoutIdentity = (record: GeneralTableRecord) =>
      Object.fromEntries(Object.entries(record).filter(([key]) =>
        !["id", "createdAt", "updatedAt"].includes(key)));
    assert.deepEqual(withoutIdentity(copied), withoutIdentity(original));
    const originalAfter = await admin.client.ok<{ record: GeneralTableRecord }>(
      "GET", `/general-table/${original.id}`,
    );
    assert.deepEqual(originalAfter.record, original);
  }
  assert.equal(
    (await admin.client.ok<Page<GeneralTableRecord>>(
      "GET", "/general-table?tableName=duplicates",
    )).total, 4,
  );
  const logs = await admin.client.ok<Page<AuditEvent>>(
    "GET", "/audit?action=generalTable.duplicate",
  );
  for (const copy of copies.records) {
    assert(logs.items.some((event) =>
      event.targetId === copy.id && event.action === "generalTable.duplicate"));
  }
});

test("company configuration safely manages options, roles, and scoped grants or denies",async(t)=>{
  const f=await fixture(t);
  const platform=await owner(f);
  const co=await company(platform.client,"Configuration company");
  const prefix=`/companies/${co.id}/configuration`;
  const initial=await platform.client.ok<{options:{id:number;key:string}[];roles:{id:number;key:string}[];definitions:{key:string}[]}>(
    "GET",prefix+"/directory");
  assert(initial.options.some(o=>o.key==="items.archived"));
  assert(initial.roles.some(r=>r.key==="accountant"));
  assert(initial.definitions.some(r=>r.key==="company.items:view"));
  const definition={
    key:"item.warranty_months",pageKey:"company.item-card",recordKind:"item",
    name:"مدة الضمان",description:"شهور",valueType:"integer",defaultValue:"12",
    choices:[],required:true,searchable:true,showOnCard:true,
    showInList:false,sortOrder:90,active:true,
  };
  const created=await platform.client.ok<{option:{id:number;revision:number;valueType:string}}>(
    "POST",prefix+"/options",definition,201);
  assert.equal(created.option.revision,1);
  assert.equal((await platform.client.request("PATCH",
    prefix+"/options/"+created.option.id,{revision:1,name:"ضمان بالأشهر"})).status,200);
  assert.equal((await platform.client.request("PATCH",
    prefix+"/options/"+created.option.id,{revision:1,name:"نسخة قديمة"})).status,409);
  const role=await platform.client.ok<{role:{id:number;revision:number;key:string}}>(
    "POST",prefix+"/roles",{key:"stock_readers",name:"قارئ الأصناف"},201);
  assert.equal(role.role.key,"stock_readers");
  const ordinary=await register(f,"configuration-member@example.test");
  const member=await employee(platform.client,co.id,ordinary.user.id,[]);
  assert.equal((await ordinary.client.request("GET",prefix+"/directory")).status,403);
  assert.equal((await ordinary.client.request("GET",`/companies/${co.id}/items`)).status,403);
  assert.equal((await ordinary.client.request("GET",`/companies/${co.id}/accounts`)).status,403);
  await platform.client.ok("PUT",prefix+"/assignments",{
    employeeId:member.id,roleId:role.role.id,active:true,revision:null,
  });
  await platform.client.ok("PUT",prefix+"/roles/"+role.role.id+"/rules",{
    permissionKey:"company.items:view",effect:"allow",revision:null,
  });
  // The role grants exactly the item list read, not accounting, writes or posting.
  assert.equal((await ordinary.client.request("GET",`/companies/${co.id}/items`)).status,200);
  assert.equal((await ordinary.client.request("GET",`/companies/${co.id}/accounts`)).status,403);
  const itemNewPage=await ordinary.client.ok<{items:{key:string;actionAccess:Record<string,boolean>}[]}>(
    "GET",`/page-catalog?companyId=${co.id}&q=إضافة صنف`);
  assert.equal(itemNewPage.items.find(x=>x.key==="company.item-new")?.actionAccess.view,false);
  await platform.client.ok("PUT",prefix+"/employee-rules",{
    employeeId:member.id,permissionKey:"company.items:view",effect:"deny",revision:null,
  });
  assert.equal((await ordinary.client.request("GET",`/companies/${co.id}/items`)).status,403);
  const directory=await platform.client.ok<{employeeRules:{id:number;revision:number;employeeId:number;permissionKey:string}[]}>(
    "GET",prefix+"/directory");
  const override=directory.employeeRules.find(x=>x.employeeId===member.id&&x.permissionKey==="company.items:view")!;
  await platform.client.ok("PUT",prefix+"/employee-rules",{
    employeeId:member.id,permissionKey:"company.items:view",effect:null,revision:override.revision,
  });
  assert.equal((await ordinary.client.request("GET",`/companies/${co.id}/items`)).status,200);
  const existingAccounts=await platform.client.ok<Page<{id:number}>>("GET",`/companies/${co.id}/accounts`);
  assert(existingAccounts.items.length>0);
  const accountId=existingAccounts.items[0]!.id;
  const option=await platform.client.ok<{option:{id:number;revision:number}}>("POST",prefix+"/options",{
    ...definition,key:"account.note",pageKey:"company.accounts",recordKind:"account",
    valueType:"text",name:"ملاحظة خاصة",defaultValue:"افتتاحي",required:false,
  },201);
  const url=prefix+`/record-options?recordKind=account&recordId=${accountId}`;
  const before=await platform.client.ok<{definitions:{key:string;id:number}[];values:{definitionId:number;value:unknown;revision:number}[]}>("GET",url);
  assert(before.definitions.some(x=>x.key==="account.note"));
  const saved=await platform.client.ok<{value:{revision:number;value:string}}>("PUT",url,{
    definitionId:option.option.id,value:"تجربة",revision:null,
  });
  assert.equal(saved.value.value,"تجربة");
  assert.equal((await platform.client.request("PUT",url,{
    definitionId:option.option.id,value:"نسخة متأخرة",revision:null,
  })).status,409);
  assert.equal((await ordinary.client.request("PUT",url,{
    definitionId:option.option.id,value:"غير مصرح",revision:saved.value.revision,
  })).status,403);
});

test("company item imports preserve original legacy IDs and are idempotent across batches", async (t) => {
  const f=await fixture(t);
  const platform=await owner(f);
  const pharmacy=await company(platform.client,"صيدلية دار الدواء");
  const another=await company(platform.client,"شركة أخرى");
  const url=`/companies/${pharmacy.id}/items/import-batch`;
  const source={
    format:"tijara-items-v1",companyHint:"صيدلية دار الدواء",currency:"YER",
    items:[
      {legacyId:"8247",name:"إبرة 1 سي سي",englishName:"SYRINGE 1CC",
       unit1Name:"واحدة",unit2Name:"",unit3Name:"",factor2:1,factor3:1,
       salePrice1:"35",salePrice2:"0",salePrice3:"0",purchasePrice:"22",
       hasExpiry:false,active:true,searchKeys:"ابره"},
      {legacyId:"1",name:"منتج مؤرشف",englishName:"ADIPRIL",
       unit1Name:"واحدة",unit2Name:"قطعة",unit3Name:"",factor2:4,factor3:1,
       salePrice1:"3",salePrice2:"0",salePrice3:"0",purchasePrice:"200",
       hasExpiry:true,active:false,searchKeys:""},
    ],
  };
  assert.equal((await platform.client.request("POST",`/companies/${another.id}/items/import-batch`,source)).status,409);
  const started=await platform.client.ok<{created:number;skipped:number}>("POST",url,source);
  assert.deepEqual(started,{created:2,skipped:0});
  const again=await platform.client.ok<{created:number;skipped:number}>("POST",url,source);
  assert.deepEqual(again,{created:0,skipped:2});
  const items=await platform.client.ok<Page<{legacyId:string;active:boolean;name:string;hasExpiry:boolean;factor2:number;purchasePrice:string}>>(
    "GET",`/companies/${pharmacy.id}/items?q=`);
  assert.equal(items.total,2);
  assert(items.items.some(x=>x.legacyId==="8247"&&x.active&&x.name==="إبرة 1 سي سي"&&x.purchasePrice==="22"));
  assert(items.items.some(x=>x.legacyId==="1"&&!x.active&&x.hasExpiry&&x.factor2===4));
  const invalid={...source,items:[source.items[0],{...source.items[1],factor2:4,unit2Name:""}]};
  assert.equal((await platform.client.request("POST",url,invalid)).status,400);
  const normal=await register(f,"no-import-rights@example.test");
  await employee(platform.client,pharmacy.id,normal.user.id,["items.view"]);
  assert.equal((await normal.client.request("POST",url,source)).status,403);
  const otherCompany=await platform.client.ok<Page<{legacyId:string}>>("GET",`/companies/${another.id}/items`);
  assert.equal(otherCompany.items.some(x=>x.legacyId==="8247"),false);
});

test("ChatGPT MCP read-only OAuth approves per-user access, filters general table and revokes immediately",async(t)=>{
  const f=await fixture(t),ownerUser=await owner(f);
  const {createSession}=await import("../apps/api/src/services/auth.ts");
  const session=await createSession(f.pool,ownerUser.user.id);
  const base=(p:string)=>f.baseUrl+p;
  const meta=await fetch(base("/.well-known/oauth-authorization-server"));
  assert.equal(meta.status,200);
  const m=await meta.json() as {code_challenge_methods_supported:string[];authorization_response_iss_parameter_supported:boolean};
  assert(m.code_challenge_methods_supported.includes("S256"));
  assert.equal(m.authorization_response_iss_parameter_supported,true);
  const unauthorized=await fetch(base("/mcp"),{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{
      name:"query_general_table",arguments:{tableName:"طلب تعديلات في الموقع"},
    }}),
  });
  assert.equal(unauthorized.status,200);
  assert.match(unauthorized.headers.get("www-authenticate")??"",/oauth-protected-resource/);
  const oauthChallenge=await unauthorized.json() as {result:{isError:boolean;_meta:Record<string,string[]>}};
  assert.equal(oauthChallenge.result.isError,true);
  assert.match(oauthChallenge.result._meta["mcp/www_authenticate"]?.[0]??"",/invalid_token/);
  const anonymousList=await fetch(base("/mcp"),{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/list"}),
  });
  assert.equal(anonymousList.status,200);
  const anonymousTools=await anonymousList.json() as {result:{tools:{securitySchemes:{type:string;scopes:string[]}[]}[]}};
  assert(anonymousTools.result.tools.every(tool=>
    tool.securitySchemes.some(scheme=>scheme.type==="oauth2"&&scheme.scopes.includes("general_table.read"))));

  const register=await fetch(base("/oauth/register"),{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({redirect_uris:["http://localhost:4321/callback"],
      token_endpoint_auth_method:"none"}),
  });
  assert.equal(register.status,201);
  const client=await register.json() as {client_id:string};
  const verifier="v".repeat(64);
  const challenge=createHash("sha256").update(verifier).digest("base64url");
  const fields={client_id:client.client_id,redirect_uri:"http://localhost:4321/callback",
    response_type:"code",scope:"general_table.read",state:"state_12345678",
    resource:"http://localhost/mcp",code_challenge:challenge,code_challenge_method:"S256"};
  const params=new URLSearchParams(fields);
  const authorize=await fetch(base("/oauth/authorize?"+params),{
    headers:{cookie:"tijara_session="+session.token},
  });
  assert.equal(authorize.status,200);
  assert.match(await authorize.text(),/الجدول العام فقط/);
  const response=await fetch(base("/oauth/authorize"),{
    method:"POST",redirect:"manual",
    headers:{"content-type":"application/x-www-form-urlencoded",
      cookie:"tijara_session="+session.token},
    body:new URLSearchParams({...fields,csrf:session.csrf}),
  });
  assert.equal(response.status,302);
  const callback=new URL(response.headers.get("location")!);
  assert.equal(callback.searchParams.get("iss"),"http://localhost");
  const code=callback.searchParams.get("code")!;
  const exchange=await fetch(base("/oauth/token"),{
    method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({
      grant_type:"authorization_code",client_id:client.client_id,
      redirect_uri:fields.redirect_uri,code,code_verifier:verifier,resource:fields.resource,
    }),
  });
  assert.equal(exchange.status,200);
  const issued=await exchange.json() as {access_token:string;refresh_token:string};
  const reused=await fetch(base("/oauth/token"),{
    method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({grant_type:"authorization_code",client_id:client.client_id,
      redirect_uri:fields.redirect_uri,code,code_verifier:verifier,resource:fields.resource}),
  });
  assert.equal(reused.status,400,"Authorization code may only be used once");

  const emptyRow={
    tableName:"طلب تعديلات في الموقع",category:"test",title:"طلب كبير",
    description:"الشرح المطلوب قراءته أولًا",number1:"900",number2:null,
    date1:null,date2:null,...Object.fromEntries(Array.from({length:9},(_,i)=>["text"+(i+1),""])),
  };
  await ownerUser.client.ok("POST","/general-table",emptyRow,201);
  await ownerUser.client.ok("POST","/general-table",{
    ...emptyRow,title:"رقم أقل",description:"الشرح الثاني",number1:"100",number2:"0",
  },201);
  await ownerUser.client.ok("POST","/general-table",{
    ...emptyRow,title:"طلب مكتمل",description:"لا يظهر",number1:"9999",number2:"2",
  },201);
  const rpc=async(method:string,paramsValue:unknown,access=issued.access_token)=>{
    const res=await fetch(base("/mcp"),{
      method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+access},
      body:JSON.stringify({jsonrpc:"2.0",id:1,method,params:paramsValue}),
    });
    return {status:res.status,body:await res.json() as {result?:{tools?:{name:string}[];structuredContent?:{
      total?:number;records?:{description:string;number1:string}[]
    }}}};
  };
  const found=await rpc("tools/list",{});
  assert.equal(found.status,200);
  assert.deepEqual(found.body.result?.tools?.map(t=>t.name),[
    "query_general_table","get_general_table_record",
    "create_general_table_record","update_general_table_record",
  ]);
  const sorted=await rpc("tools/call",{name:"query_general_table",arguments:{
    tableName:"طلب تعديلات في الموقع",number2EmptyOrZero:true,pageSize:10,
  }});
  assert.equal(sorted.body.result?.structuredContent?.total,2);
  assert.deepEqual(sorted.body.result?.structuredContent?.records?.map(r=>r.description),
    ["الشرح المطلوب قراءته أولًا","الشرح الثاني"]);
  const connectors=(await f.pool.query<{id:number}>(
    "SELECT id FROM chatgpt_oauth_tokens WHERE user_id=$1",[ownerUser.user.id])).rows;
  assert.equal(connectors.length,1);
  const revoked=await fetch(base("/oauth/connections/"+connectors[0]!.id+"/revoke"),{
    method:"POST",redirect:"manual",
    headers:{"content-type":"application/x-www-form-urlencoded",cookie:"tijara_session="+session.token},
    body:new URLSearchParams({csrf:session.csrf}),
  });
  assert.equal(revoked.status,303);
  const blocked=await fetch(base("/mcp"),{
    method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+issued.access_token},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{
      name:"query_general_table",arguments:{tableName:"طلب تعديلات في الموقع"},
    }}),
  });
  assert.equal(blocked.status,200);
  assert.equal((await blocked.json() as {result:{isError:boolean}}).result.isError,true);
});

test("ChatGPT MCP write access needs fresh OAuth approval and audits conflict-safe changes",async(t)=>{
  const f=await fixture(t),platform=await owner(f);
  const {createSession}=await import("../apps/api/src/services/auth.ts");
  const session=await createSession(f.pool,platform.user.id);
  const base=(path:string)=>f.baseUrl+path;
  const registration=await fetch(base("/oauth/register"),{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({redirect_uris:["http://localhost:4322/callback"],token_endpoint_auth_method:"none"}),
  });
  assert.equal(registration.status,201);
  const client=await registration.json() as {client_id:string};
  const verifier="w".repeat(64);
  const challenge=createHash("sha256").update(verifier).digest("base64url");
  const fields={client_id:client.client_id,redirect_uri:"http://localhost:4322/callback",
    response_type:"code",scope:"general_table.read general_table.write",state:"write_state_12345678",
    resource:"http://localhost/mcp",code_challenge:challenge,code_challenge_method:"S256"};
  const consent=await fetch(base("/oauth/authorize?"+new URLSearchParams(fields)),{
    headers:{cookie:"tijara_session="+session.token},
  });
  assert.equal(consent.status,200);
  assert.match(await consent.text(),/القراءة والإنشاء والتعديل/);
  const approval=await fetch(base("/oauth/authorize"),{
    method:"POST",redirect:"manual",headers:{
      "content-type":"application/x-www-form-urlencoded",
      cookie:"tijara_session="+session.token,
    },
    body:new URLSearchParams({...fields,csrf:session.csrf}),
  });
  assert.equal(approval.status,302);
  const code=new URL(approval.headers.get("location")!).searchParams.get("code")!;
  const exchange=await fetch(base("/oauth/token"),{
    method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({grant_type:"authorization_code",client_id:client.client_id,
      redirect_uri:fields.redirect_uri,code,code_verifier:verifier,resource:fields.resource}),
  });
  assert.equal(exchange.status,200);
  const tokenData=await exchange.json() as {access_token:string;scope:string};
  assert.equal(tokenData.scope,fields.scope);
  const rpc=async(name:string,args:unknown)=>{
    const res=await fetch(base("/mcp"),{method:"POST",headers:{
      authorization:"Bearer "+tokenData.access_token,"content-type":"application/json",
    },body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})});
    assert.equal(res.status,200);
    return await res.json() as {result?:{structuredContent?:Record<string,any>;isError?:boolean}};
  };
  const created=await rpc("create_general_table_record",{
    tableName:"طلبات اختبار ChatGPT",title:"First",description:"created via scoped tool",
  });
  const row=created.result?.structuredContent?.record;
  assert(row?.id>0);
  assert.equal(row.title,"First");
  const updated=await rpc("update_general_table_record",{
    id:row.id,expectedUpdatedAt:row.updatedAt,changes:{title:"Updated",description:"edited"},
  });
  assert.equal(updated.result?.structuredContent?.record?.title,"Updated");
  const stale=await rpc("update_general_table_record",{
    id:row.id,expectedUpdatedAt:row.updatedAt,changes:{title:"Overwritten"},
  });
  assert.equal(stale.result?.isError,true);
  assert.equal(stale.result?.structuredContent?.code,"conflict");
  const stored=await f.pool.query("SELECT general_table_title FROM general_table WHERE general_table_id=$1",[row.id]);
  assert.equal(stored.rows[0]?.general_table_title,"Updated");
  const events=await f.pool.query<{action:string}>(
    "SELECT action FROM audit_events WHERE target_type='generalTable' AND target_id=$1 ORDER BY id",[row.id]);
  assert.deepEqual(events.rows.map(e=>e.action),["generalTable.create","generalTable.update"]);
});

test("general table stores reusable records, filters them and enforces public admin access", async (t) => {
  const f = await fixture(t);
  const platform = await owner(f);
  const ordinary = await register(f, "general-table-reader@example.test");
  const blank = {
    tableName: "directories",
    category: "shops",
    title: "First entry",
    description: "Description",
    number1: "100.125",
    number2: null,
    date1: "2026-10-11T17:00:00.000Z",
    date2: null,
    ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`text${i+1}`, ""])),
    text9: "نص إضافي",
  };
  assert.equal((await f.client().request("GET", "/general-table")).status, 401);
  assert.equal((await ordinary.client.request("GET", "/general-table")).status, 403);
  assert.equal(
    (await ordinary.client.request("POST", "/general-table", blank)).status,
    403,
  );
  assert.equal(
    (await platform.client.request("POST", "/general-table", { ...blank, tableName: "" })).status,
    400,
  );

  const created = await platform.client.ok<{record:GeneralTableRecord}>(
    "POST", "/general-table", blank, 201,
  );
  assert(created.record.id > 0);
  assert.equal(created.record.tableName, "directories");
  assert.equal(created.record.category, "shops");
  assert.equal(created.record.title, "First entry");
  assert.equal(created.record.number1, "100.125");
  assert.equal(created.record.date1, "2026-10-11T17:00:00.000Z");
  assert.equal(created.record.text9, "نص إضافي");
  assert.equal(created.record.createdBy, platform.user.id);

  const page = await platform.client.ok<Page<GeneralTableRecord>>(
    "GET", "/general-table?q=First&tableName=directories&category=shops",
  );
  assert.equal(page.total, 1);
  assert.equal(page.items[0]?.id, created.record.id);
  assert.equal(
    (await platform.client.ok<Page<GeneralTableRecord>>(
      "GET", "/general-table?tableName=other",
    )).total,
    0,
  );
  const detail = await platform.client.ok<{record:GeneralTableRecord}>(
    "GET", `/general-table/${created.record.id}`,
  );
  assert.equal(detail.record.text9, "نص إضافي");
  const patched = await platform.client.ok<{record:GeneralTableRecord}>(
    "PATCH", `/general-table/${created.record.id}`, {
      ...blank,
      title: "Updated entry",
      description: "Changed description",
      text9: "آخر حقل",
      number2: "-23.456",
      date2: "2026-10-12T01:30:00.000Z",
    },
  );
  assert.equal(patched.record.title, "Updated entry");
  assert.equal(patched.record.number2, "-23.456");
  assert.equal(patched.record.date2, "2026-10-12T01:30:00.000Z");
  assert.equal(patched.record.text9, "آخر حقل");
  assert.equal((await ordinary.client.request(
    "PATCH", `/general-table/${created.record.id}`, blank,
  )).status, 403);
  assert.equal((await platform.client.request(
    "PATCH", "/general-table/999999", blank,
  )).status, 404);
  const stored = await f.pool.query(
    "SELECT general_table_text9,general_table_number2,general_table_title FROM general_table WHERE general_table_id=$1",
    [created.record.id],
  );
  assert.equal(stored.rows[0]?.general_table_text9, "آخر حقل");
  assert.equal(stored.rows[0]?.general_table_number2, "-23.456");
  const events = await platform.client.ok<Page<AuditEvent>>(
    "GET", "/audit?action=generalTable.update",
  );
  assert.ok(events.items.some((event) => event.targetId === created.record.id
    && event.after?.title === "Updated entry"));
});

test("company audit records canonical database values and mutation rolls back when audit insertion fails", async (t) => {
  const f = await fixture(t);
  const platform = await owner(f);
  const c = await company(platform.client, " Initial company ");
  await platform.client.ok("PATCH", `/companies/${c.id}`, {
    name: " Canonical company ",
    phone: "+٩٦٦ (٥٠) ١٢٣-٤٥٦٧",
    address: " New address ",
  });
  const changed = (
    await platform.client.ok<CompanyContext>("GET", `/companies/${c.id}`)
  ).company;
  assert.equal(changed.name, "Canonical company");
  assert.equal(changed.phone, "+966501234567");
  assert.equal(changed.address, "New address");
  const audit = await platform.client.ok<Page<AuditEvent>>(
    "GET",
    `/companies/${c.id}/audit?pageSize=100`,
  );
  const event = audit.items.find(
    (entry) =>
      entry.targetType === "company" &&
      entry.targetId === c.id &&
      entry.after?.name === changed.name,
  );
  assert.ok(event);
  assert.equal(event.actorId, platform.user.id);
  assert.equal(event.scope, "company");
  assert.equal(event.companyId, c.id);
  assert.equal(event.before?.name, "Initial company");
  assert.equal(event.before?.phone, "");
  assert.equal(event.after?.phone, changed.phone);
  assert.equal(event.after?.address, changed.address);
  assert.ok(!Number.isNaN(Date.parse(event.createdAt)));
  assertNoSecrets(audit);
  const member = await register(f, "canonical-employee@example.test");
  const staff = await employee(platform.client, c.id, member.user.id, [
    "employees.view",
    "company.edit",
    "employees.view",
  ]);
  assert.deepEqual(staff.permissions, ["company.edit", "employees.view"]);
  const employeeAudit = await platform.client.ok<Page<AuditEvent>>(
    "GET",
    `/companies/${c.id}/audit?pageSize=100`,
  );
  const createdEmployee = employeeAudit.items.find(
    (entry) =>
      entry.targetType === "employee" &&
      entry.targetId === staff.id &&
      entry.before === null,
  );
  assert.ok(createdEmployee);
  assert.deepEqual(createdEmployee.after?.permissions, staff.permissions);
  const persistedPermissions = await f.pool.query<{ permissions: string[] }>(
    "SELECT permissions FROM employees WHERE id=$1",
    [staff.id],
  );
  assert.deepEqual(
    persistedPermissions.rows[0]?.permissions,
    createdEmployee.after?.permissions,
  );

  const tables = await f.pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns WHERE table_schema=$1 AND column_name='before_value'`,
    [f.schema],
  );
  assert.equal(
    tables.rows.length,
    1,
    "Exactly one transactional audit table must store before values",
  );
  const auditTable = tables.rows[0]!.table_name;
  assert.match(auditTable, /^[a-z_]+$/);
  await f.pool.query(
    `CREATE FUNCTION reject_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test rejects audit insert'; END $$`,
  );
  await f.pool.query(
    `CREATE TRIGGER reject_test_audit BEFORE INSERT ON "${auditTable}" FOR EACH ROW EXECUTE FUNCTION reject_test_audit()`,
  );
  try {
    assert.equal(
      (
        await platform.client.request("PATCH", `/companies/${c.id}`, {
          name: "Must roll back",
        })
      ).status,
      500,
    );
    assert.equal(
      (await platform.client.request("GET", "/audit")).status,
      500,
      "A sensitive page must fail when its access audit cannot be saved",
    );
    const row = await f.pool.query<{ name: string }>(
      "SELECT name FROM companies WHERE id=$1",
      [c.id],
    );
    assert.equal(row.rows[0]?.name, changed.name);
  } finally {
    await f.pool.query(`DROP TRIGGER reject_test_audit ON "${auditTable}"`);
    await f.pool.query("DROP FUNCTION reject_test_audit()");
  }
  await f.restart();
  assert.equal(
    (await platform.client.ok<CompanyContext>("GET", `/companies/${c.id}`))
      .company.name,
    changed.name,
  );
  const persisted = await platform.client.ok<Page<AuditEvent>>(
    "GET",
    `/companies/${c.id}/audit?pageSize=100`,
  );
  assert.ok(persisted.items.some((item) => item.id === event.id));
  assert.equal(
    persisted.items.some((item) => item.after?.name === "Must roll back"),
    false,
  );
});

test("appearance is independent per identity and scope, access checked, and persisted across restart", async (t) => {
  const f = await fixture(t);
  const platform = await owner(f);
  const member = await register(f, "appearance@example.test");
  const outsider = await register(f, "outsider@example.test");
  const a = await company(platform.client, "Appearance A");
  const b = await company(platform.client, "Appearance B");
  const membership = await employee(platform.client, a.id, member.user.id);
  await employee(platform.client, b.id, member.user.id);
  const get = async (client: Client, scope: string) =>
    (
      await client.ok<{ preference: AppearancePreference }>(
        "GET",
        `/appearance?scope=${encodeURIComponent(scope)}`,
      )
    ).preference;
  const outsiderDefault = await get(outsider.client, "public");
  assert.deepEqual(outsiderDefault, DEFAULT_APPEARANCE);
  const preferences = [
    { scope: "public", mode: "dark", color: "#2A6399" },
    { scope: `company:${a.id}`, mode: "light", color: "#7353BA" },
    { scope: `company:${b.id}`, mode: "dark", color: "#067B70" },
  ] as const;
  for (const preference of preferences)
    await member.client.ok("PATCH", "/appearance", preference);
  for (const preference of preferences)
    assert.deepEqual(await get(member.client, preference.scope), {
      mode: preference.mode,
      color: preference.color.toLowerCase(),
    });
  assert.deepEqual(await get(outsider.client, "public"), outsiderDefault);
  assert.equal(
    (await outsider.client.request("GET", `/appearance?scope=company:${a.id}`))
      .status,
    403,
  );
  assert.equal(
    (
      await outsider.client.request("PATCH", "/appearance", {
        ...preferences[1],
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await member.client.request("PATCH", "/appearance", {
        scope: "company:0",
        mode: "dark",
        color: "#123456",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await member.client.request("PATCH", "/appearance", {
        scope: "public",
        mode: "dark",
        color: "red",
      })
    ).status,
    400,
  );
  await f.restart();
  for (const preference of preferences)
    assert.deepEqual(await get(member.client, preference.scope), {
      mode: preference.mode,
      color: preference.color.toLowerCase(),
    });
  await platform.client.ok(
    "PATCH",
    `/companies/${a.id}/employees/${membership.id}`,
    { active: false },
  );
  assert.equal(
    (await member.client.request("GET", `/appearance?scope=company:${a.id}`))
      .status,
    403,
  );
  assert.equal(
    (await member.client.request("PATCH", "/appearance", preferences[1]))
      .status,
    403,
  );
});

test("list pagination and validated multi-sort are deterministic and invalid input stays rejected", async (t) => {
  const f = await fixture(t);
  const platform = await owner(f);
  for (const [name, email] of [
    ["Same", "c@example.test"],
    ["Same", "a@example.test"],
    ["Other", "b@example.test"],
  ] as const) {
    await register(f, email, { name });
  }
  const first = await platform.client.ok<Page<User>>(
    "GET",
    "/users?sort=name:asc,email:desc&page=1&pageSize=2",
  );
  assert.equal(first.page, 1);
  assert.equal(first.pageSize, 2);
  assert.equal(first.total, 4);
  const all = await platform.client.ok<Page<User>>(
    "GET",
    "/users?sort=name:asc,email:desc&pageSize=100",
  );
  const same = all.items.filter((item) => item.name === "Same");
  assert.deepEqual(
    same.map((item) => item.email),
    ["c@example.test", "a@example.test"],
  );
  assert.deepEqual(
    (
      await platform.client.ok<Page<User>>(
        "GET",
        "/users?sort=name:asc,email:desc&page=1&pageSize=2",
      )
    ).items.map((item) => item.id),
    first.items.map((item) => item.id),
  );
  const second = await platform.client.ok<Page<User>>(
    "GET",
    "/users?sort=name:asc,email:desc&page=2&pageSize=2",
  );
  assert.equal(
    new Set([...first.items, ...second.items].map((item) => item.id)).size,
    4,
  );
  assert.equal(
    (await platform.client.request("GET", "/users?sort=password:asc")).status,
    400,
  );
  assert.equal(
    (await platform.client.request("GET", "/users?sort=name:sideways")).status,
    400,
  );
  for (const inherited of ["constructor", "toString", "__proto__"]) {
    assert.equal(
      (await platform.client.request("GET", `/users?sort=${inherited}:asc`))
        .status,
      400,
    );
  }
  assert.equal(
    (await platform.client.request("GET", "/users?page=0")).status,
    400,
  );
  assert.equal(
    (await platform.client.request("GET", "/users?pageSize=1000")).status,
    400,
  );
  assert.equal(
    (
      await platform.client.ok<Page<User>>(
        "GET",
        "/users?q=Same&kind=member&archived=false",
      )
    ).total,
    2,
  );
  assert.equal(
    (await platform.client.request("GET", "/users?kind=owner")).status,
    400,
  );
  assert.equal(
    (
      await platform.client.request("PATCH", `/users/${all.items[0]!.id}`, {
        owner: true,
      })
    ).status,
    400,
  );
  assert.equal(
    (await platform.client.request("GET", "/companies/2147483648")).status,
    400,
  );
  assert.equal(
    (
      await platform.client.request("PATCH", "/users/2147483648", {
        archived: true,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await platform.client.request(
        "GET",
        "/appearance?scope=company:2147483648",
      )
    ).status,
    400,
  );
  const c = await company(platform.client, "ID validation");
  assert.equal(
    (
      await platform.client.request("POST", `/companies/${c.id}/employees`, {
        userId: 2147483648,
        name: "Invalid ID",
        phone: "",
        role: "employee",
        active: true,
        permissions: [],
      })
    ).status,
    400,
  );
});

test("concurrent duplicate employee creation commits one identity link and one audit event", async (t) => {
  const f = await fixture(t);
  const platform = await owner(f);
  const member = await register(f, "concurrent-employee@example.test");
  const c = await company(platform.client, "Concurrent employee");
  const input = {
    userId: member.user.id,
    name: "Concurrent employee",
    phone: "",
    role: "employee",
    active: true,
    permissions: [],
  };
  const outcomes = await overlapping(f, "employees", [
    () =>
      platform.client.request<{ employee: Employee }>(
        "POST",
        `/companies/${c.id}/employees`,
        input,
      ),
    () =>
      platform.client.request<{ employee: Employee }>(
        "POST",
        `/companies/${c.id}/employees`,
        input,
      ),
  ]);
  const responses = outcomes.map(fulfilled);
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [201, 409],
  );
  const created = responses.find((response) => response.status === 201)!.body
    .employee;
  const links = await f.pool.query<{ id: number }>(
    "SELECT id FROM employees WHERE company_id=$1 AND user_id=$2",
    [c.id, member.user.id],
  );
  assert.deepEqual(
    links.rows.map((row) => row.id),
    [created.id],
  );
  const audit = await f.pool.query<{
    actor_id: number;
    before_value: unknown;
    after_value: Employee;
  }>(
    "SELECT actor_id,before_value,after_value FROM audit_events WHERE action='employee.create' AND company_id=$1 AND target_id=$2",
    [c.id, created.id],
  );
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0]?.actor_id, platform.user.id);
  assert.equal(audit.rows[0]?.before_value, null);
  assert.deepEqual(audit.rows[0]?.after_value, created);
});

test("concurrent platform-owner provisioning commits exactly one owner and its creation audit", async (t) => {
  const f = await fixture(t);
  const candidates = [
    {
      name: "Candidate one",
      displayName: "One",
      email: "owner-one@example.test",
      password,
    },
    {
      name: "Candidate two",
      displayName: "Two",
      email: "owner-two@example.test",
      password,
    },
  ];
  const outcomes = await overlapping(
    f,
    "users",
    candidates.map((candidate) => () => provisionOwner(f.pool, candidate)),
  );
  const successes = outcomes.filter(
    (outcome): outcome is PromiseFulfilledResult<User> =>
      outcome.status === "fulfilled",
  );
  const failures = outcomes.filter(
    (outcome): outcome is PromiseRejectedResult =>
      outcome.status === "rejected",
  );
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);
  assert.equal((failures[0]!.reason as { code?: string }).code, "23505");
  const winner = successes[0]!.value;
  const owners = await f.pool.query<{ id: number }>(
    "SELECT id FROM users WHERE owner",
  );
  assert.deepEqual(
    owners.rows.map((row) => row.id),
    [winner.id],
  );
  assert.equal(
    (
      await f.pool.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM users",
      )
    ).rows[0]?.count,
    1,
  );
  const audit = await f.pool.query<{
    actor_id: number | null;
    target_id: number;
    before_value: unknown;
    after_value: User;
  }>(
    "SELECT actor_id,target_id,before_value,after_value FROM audit_events WHERE action='owner.create'",
  );
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0]?.actor_id, null);
  assert.equal(audit.rows[0]?.target_id, winner.id);
  assert.equal(audit.rows[0]?.before_value, null);
  assert.deepEqual(audit.rows[0]?.after_value, winner);
});

test("public archival racing a general-manager appointment preserves protection and audits only the winning mutation", async (t) => {
  const f = await fixture(t);
  const platform = await owner(f);
  const publicAdmin = await register(f, "race-admin@example.test");
  await platform.client.ok("PATCH", `/users/${publicAdmin.user.id}`, {
    kind: "admin",
  });
  const c = await company(platform.client, "Protected appointment race");
  for (let iteration = 0; iteration < 5; iteration++) {
    const member = await register(f, `race-target-${iteration}@example.test`);
    const staff = await employee(platform.client, c.id, member.user.id);
    const archive = () =>
      publicAdmin.client.request("PATCH", `/users/${member.user.id}`, {
        archived: true,
      });
    const appoint = () =>
      platform.client.request(
        "PATCH",
        `/companies/${c.id}/employees/${staff.id}/manager`,
        { isGeneralManager: true },
      );
    const operations =
      iteration % 2 === 0 ? [archive, appoint] : [appoint, archive];
    const outcomes = await overlapping(f, "users", operations, member.user.id);
    const [first, second] = outcomes.map(fulfilled);
    const archival = iteration % 2 === 0 ? first! : second!;
    const appointment = iteration % 2 === 0 ? second! : first!;
    assert.deepEqual(
      [archival.status, appointment.status].sort(),
      [200, 403],
      `Unexpected race result: ${JSON.stringify([archival, appointment])}`,
    );
    const state = await f.pool.query<{
      archived: boolean;
      active: boolean;
      is_general_manager: boolean;
    }>(
      "SELECT u.archived,e.active,e.is_general_manager FROM users u JOIN employees e ON e.user_id=u.id WHERE e.id=$1",
      [staff.id],
    );
    const row = state.rows[0]!;
    assert.equal(row.active, true);
    assert.equal(
      row.archived && row.is_general_manager,
      false,
      "Public administration must never archive an active general manager through a race",
    );
    const changes = await f.pool.query<{
      action: string;
      actor_id: number;
      after_value: Record<string, unknown>;
    }>(
      `
      SELECT action,actor_id,after_value FROM audit_events
      WHERE (action='user.update' AND target_id=$1) OR (action='manager.appoint' AND target_id=$2 AND company_id=$3)`,
      [member.user.id, staff.id, c.id],
    );
    assert.equal(changes.rows.length, 1);
    const change = changes.rows[0]!;
    if (archival.status === 200) {
      assert.equal(row.archived, true);
      assert.equal(row.is_general_manager, false);
      assert.equal(change.action, "user.update");
      assert.equal(change.actor_id, publicAdmin.user.id);
      assert.equal(change.after_value.archived, true);
    } else {
      assert.equal(row.archived, false);
      assert.equal(row.is_general_manager, true);
      assert.equal(change.action, "manager.appoint");
      assert.equal(change.actor_id, platform.user.id);
      assert.equal(change.after_value.isGeneralManager, true);
    }
  }
});

test("concurrent first appearance writes audit the committed preference chain", async (t) => {
  const f = await fixture(t);
  const member = await register(f, "appearance-race@example.test");
  const defaultPreference = (
    await member.client.ok<{ preference: AppearancePreference }>(
      "GET",
      "/appearance?scope=public",
    )
  ).preference;
  assert.deepEqual(defaultPreference, DEFAULT_APPEARANCE);
  const preferences = [
    { mode: "dark", color: "#112233" },
    { mode: "light", color: "#445566" },
  ] as const;
  const outcomes = await overlapping(
    f,
    "appearance",
    preferences.map(
      (preference) => () =>
        member.client.request<{ preference: AppearancePreference }>(
          "PATCH",
          "/appearance",
          { scope: "public", ...preference },
        ),
    ),
  );
  const responses = outcomes.map(fulfilled);
  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200],
  );
  const audit = await f.pool.query<{
    before_value: AppearancePreference;
    after_value: AppearancePreference;
  }>(
    "SELECT before_value,after_value FROM audit_events WHERE action='appearance.update' AND target_id=$1 AND scope='public' ORDER BY id",
    [member.user.id],
  );
  assert.equal(audit.rows.length, 2);
  const [first, second] = audit.rows;
  assert.deepEqual(first!.before_value, defaultPreference);
  assert.deepEqual(second!.before_value, first!.after_value);
  assert.notDeepEqual(first!.after_value, second!.after_value);
  for (const response of responses)
    assert.ok(
      audit.rows.some(
        (entry) =>
          JSON.stringify(entry.after_value) ===
          JSON.stringify(response.body.preference),
      ),
    );
  const stored = await member.client.ok<{ preference: AppearancePreference }>(
    "GET",
    "/appearance?scope=public",
  );
  assert.deepEqual(stored.preference, second!.after_value);
  const database = await f.pool.query<AppearancePreference>(
    "SELECT mode,color FROM appearance WHERE user_id=$1 AND scope='public'",
    [member.user.id],
  );
  assert.deepEqual(database.rows[0], second!.after_value);
});

test("concurrent initialization applies each migration once and repeat startup preserves the result", async (t) => {
  const schema = `api_test_bootstrap_${randomUUID().replaceAll("-", "")}`;
  const cleanup = new Pool({ connectionString: databaseUrl });
  const blocker = await cleanup.connect();
  const pools: Pool[] = [];
  let released = false;
  t.after(async () => {
    if (!released) {
      await blocker.query("SELECT pg_advisory_unlock_all()");
      blocker.release();
    }
    await Promise.allSettled(pools.map((pool) => pool.end()));
    try {
      await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await cleanup.end();
    }
  });
  await blocker.query("SELECT pg_advisory_lock(hashtext($1))", [schema]);
  const pid = (
    await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
  ).rows[0]!.pid;
  const pending = Promise.allSettled([
    createDatabase(databaseUrl, schema),
    createDatabase(databaseUrl, schema),
  ]);
  let barrierError: unknown;
  try {
    const deadline = Date.now() + 5000;
    let blocked = 0;
    do {
      const locks = await cleanup.query<{ count: number }>(
        `
        SELECT count(DISTINCT waiting.pid)::integer AS count FROM pg_locks waiting
        WHERE NOT waiting.granted AND waiting.locktype='advisory' AND EXISTS (
          SELECT 1 FROM pg_locks held WHERE held.pid=$1 AND held.granted
          AND held.locktype=waiting.locktype AND held.database=waiting.database
          AND held.classid=waiting.classid AND held.objid=waiting.objid AND held.objsubid=waiting.objsubid
        )`,
        [pid],
      );
      blocked = locks.rows[0]!.count;
      if (blocked >= 2) break;
      await delay(10);
    } while (Date.now() < deadline);
    assert.equal(
      blocked,
      2,
      "Both initializers must overlap before schema creation",
    );
  } catch (error) {
    barrierError = error;
  } finally {
    await blocker.query("SELECT pg_advisory_unlock(hashtext($1))", [schema]);
    blocker.release();
    released = true;
  }
  const outcomes = await pending;
  for (const outcome of outcomes)
    if (outcome.status === "fulfilled") pools.push(outcome.value);
  if (barrierError) throw barrierError;
  for (const outcome of outcomes) fulfilled(outcome);
  const migrationFiles = (
    await readdir(
      fileURLToPath(new URL("../apps/api/migrations/", import.meta.url)),
    )
  )
    .filter((name) => /^\d+_[a-z_]+\.sql$/.test(name))
    .sort();
  assert(migrationFiles.length > 0, "Startup must run actual migration files");
  pools.push(await createDatabase(databaseUrl, schema));
  for (const pool of pools) {
    assert.deepEqual(
      (
        await pool.query<{ version: string }>(
          "SELECT version FROM schema_migrations ORDER BY version",
        )
      ).rows,
      migrationFiles.map((version) => ({ version })),
    );
    assert.equal(
      (
        await pool.query<{ count: number }>(
          "SELECT count(*)::integer AS count FROM users",
        )
      ).rows[0]?.count,
      0,
    );
    assert.equal(
      (
        await pool.query<{ schema: string }>(
          "SELECT current_schema() AS schema",
        )
      ).rows[0]?.schema,
      schema,
    );
  }
});

test("configuration review isolates companies and keeps denies stronger than grants", async (t) => {
  const f=await fixture(t),platform=await owner(f);
  const first=await company(platform.client,"First rules company"),second=await company(platform.client,"Second rules company");
  const person=await register(f,"review-employee@example.test");
  const staff=await employee(platform.client,first.id,person.user.id,[]);
  const secondStaff=await employee(platform.client,second.id,person.user.id,["accounts.view"]);
  const base=`/companies/${first.id}/configuration`;
  const allow=(await platform.client.ok<{role:{id:number}}>("POST",base+"/roles",{key:"review_reader",name:"Reader"},201)).role;
  const block=(await platform.client.ok<{role:{id:number;revision:number}}>("POST",base+"/roles",{key:"review_block",name:"Block"},201)).role;
  const grant=async(roleId:number,key:string,effect:"allow"|"deny")=>platform.client.ok("PUT",base+`/roles/${roleId}/rules`,{permissionKey:key,effect,revision:null});
  const assign=async(roleId:number)=>platform.client.ok("PUT",base+"/assignments",{employeeId:staff.id,roleId,active:true,revision:null});
  await grant(allow.id,"company.accounts:view","allow");await assign(allow.id);
  assert.equal((await person.client.request("GET",`/companies/${first.id}/accounts`)).status,200);
  await grant(block.id,"company.accounts:view","deny");await assign(block.id);
  await platform.client.ok("PUT",base+"/employee-rules",{employeeId:staff.id,permissionKey:"company.accounts:view",effect:"allow",revision:null});
  assert.equal((await person.client.request("GET",`/companies/${first.id}/accounts`)).status,403);
  assert.equal((await person.client.request("GET",`/companies/${second.id}/accounts`)).status,200);
  assert.equal((await platform.client.request("PUT",`/companies/${second.id}/configuration/assignments`,{employeeId:staff.id,roleId:allow.id,active:true,revision:null})).status,404);
  assert.equal((await platform.client.request("PUT",`/companies/${second.id}/configuration/assignments`,{employeeId:secondStaff.id,roleId:allow.id,active:true,revision:null})).status,404);
  await platform.client.ok("PATCH",base+`/roles/${block.id}`,{active:false,revision:block.revision});
  assert.equal((await person.client.request("GET",`/companies/${first.id}/accounts`)).status,200);
  await grant(allow.id,"company.accounts:edit","allow");
  const accounts=await platform.client.ok<Page<{id:number}>>("GET",`/companies/${first.id}/accounts`);
  assert.equal((await person.client.request("PATCH",`/companies/${first.id}/accounts/${accounts.items[0]!.id}`,{name:"Edited by exact grant"})).status,200);
  assert.equal((await person.client.request("POST",`/companies/${first.id}/accounts`,{name:"Forbidden create",kind:"group",category:"asset",normalSide:"debit",parentId:null})).status,403);
  await grant(allow.id,"company.configuration:view","allow");
  assert.equal((await person.client.request("GET",base+"/directory")).status,200);
  assert.equal((await person.client.request("POST",base+"/options",{key:"forbidden.option",pageKey:"company.accounts",recordKind:"account",name:"Forbidden",valueType:"text"})).status,403);
  await grant(allow.id,"company.sales:view","allow");
  assert.equal((await person.client.request("GET",`/companies/${first.id}/invoices?kind=sale`)).status,200);
  assert.equal((await person.client.request("GET",`/companies/${first.id}/invoices`)).status,403);
  await grant(allow.id,"company.purchases:view","allow");
  await platform.client.ok("PUT",base+"/employee-rules",{employeeId:staff.id,permissionKey:"company.purchases:view",effect:"deny",revision:null});
  assert.equal((await person.client.request("GET",`/companies/${first.id}/invoices?kind=purchase`)).status,403);
  assert.equal((await person.client.request("GET",`/companies/${first.id}/invoices`)).status,403);
  const protectedPerson=await register(f,"review-manager@example.test");
  const manager=await employee(platform.client,first.id,protectedPerson.user.id,[]);
  await platform.client.ok("PATCH",`/companies/${first.id}/employees/${manager.id}/manager`,{isGeneralManager:true});
  assert.equal((await platform.client.request("PUT",base+"/employee-rules",{employeeId:manager.id,permissionKey:"company.accounts:view",effect:"deny",revision:null})).status,403);
  assert.equal((await protectedPerson.client.request("GET",`/companies/${first.id}/accounts`)).status,200);
  const blockedAlias=await platform.client.ok<{rule:{revision:number}}>("PUT",base+"/employee-rules",{employeeId:staff.id,permissionKey:"company.items:view",effect:"deny",revision:null});
  assert(blockedAlias.rule.revision>0);
  await grant(allow.id,"company.item-card:view","allow");
  assert.equal((await person.client.request("GET",`/companies/${first.id}/items/999`)).status,403);
  await grant(allow.id,"company.pages:edit","allow");
  assert.equal((await person.client.request("PUT","/page-catalog/company.accounts/settings",{companyId:first.id,visible:false,enabled:true,order:20,revision:null})).status,200);
});

test("configuration review rejects invalid dates and preserves old values and native options", async(t)=>{
  const f=await fixture(t),platform=await owner(f),co=await company(platform.client,"Options review");
  const base=`/companies/${co.id}/configuration`;
  const definition={key:"review.date",pageKey:"company.accounts",recordKind:"account",name:"Review date",valueType:"date",defaultValue:"2026-02-30"};
  assert.equal((await platform.client.request("POST",base+"/options",definition)).status,400);
  assert.equal((await platform.client.request("POST",base+"/options",{...definition,defaultValue:"0000-01-01"})).status,400);
  const option=(await platform.client.ok<{option:{id:number}}>("POST",base+"/options",{...definition,defaultValue:"2026-02-28"},201)).option;
  const renamed=await platform.client.ok<{option:{defaultValue:string}}>("PATCH",base+`/options/${option.id}`,{name:"Renamed only",revision:1});
  assert.equal(renamed.option.defaultValue,"2026-02-28");
  const records=await platform.client.ok<Page<{id:number}>>("GET",`/companies/${co.id}/accounts`);
  const url=base+`/record-options?recordKind=account&recordId=${records.items[0]!.id}`;
  const original=await platform.client.ok<{values:{definitionId:number}[]}>("GET",url);
  assert(!original.values.some(v=>v.definitionId===option.id));
  const saved=await platform.client.ok<{value:{revision:number}}>("PUT",url,{definitionId:option.id,value:null,revision:null});
  assert.equal((await platform.client.request("PUT",url,{definitionId:option.id,value:"2026-03-01",revision:null})).status,409);
  const loaded=await platform.client.ok<{values:{definitionId:number;value:unknown}[]}>("GET",url);
  assert.equal(loaded.values.find(v=>v.definitionId===option.id)?.value,null);
  assert.equal((await platform.client.request("PUT",url,{definitionId:option.id,value:"2026-02-30",revision:saved.value.revision})).status,400);
  const directory=await platform.client.ok<{options:{id:number;key:string;revision:number}[]}>("GET",base+"/directory");
  const native=directory.options.find(v=>v.key==="accounts.archived")!;
  assert.equal((await platform.client.request("PATCH",base+`/options/${native.id}`,{name:"أرشفة الحساب",description:"مستمد من الحالة الأساسية",revision:native.revision})).status,200);
  assert.equal((await platform.client.request("PUT",url,{definitionId:native.id,value:true,revision:null})).status,403);
});

test("option lists keep typed filtering, label search, archival and company isolation", async(t)=>{
  const f=await fixture(t),platform=await owner(f),co=await company(platform.client,"Option lists");
  const base=`/companies/${co.id}`,config=base+"/configuration";
  type Def={id:number;key:string;revision:number};
  type Row={id:number;name:string;optionValues:Record<string,string|boolean|null>};
  type List=Page<Row>&{optionDefinitions:Def[]};
  const records=[] as {id:number}[];
  for(const suffix of ["Alpha","Beta","Gamma","Unset"]) records.push((await platform.client.ok<{account:{id:number}}>("POST",base+"/accounts",{name:"Option record "+suffix,kind:"group",category:"asset",normalSide:"debit",parentId:null},201)).account);
  const create=async(key:string,valueType:string,extra:object={})=>(await platform.client.ok<{option:Def}>("POST",config+"/options",{key:"list."+key,pageKey:"company.accounts",recordKind:"account",name:key,valueType,searchable:true,showInList:true,...extra},201)).option;
  const integer=await create("integer","integer",{defaultValue:"100"}),decimal=await create("decimal","decimal"),date=await create("date","date");
  const choice=await create("choice","list",{choices:[{key:"premium",label:"عميل مميز"},{key:"regular",label:"عادي"}]}),hidden=await create("hidden","text",{showInList:false});
  const put=async(id:number,def:Def,value:string|boolean|null)=>platform.client.ok("PUT",config+`/record-options?recordKind=account&recordId=${id}`,{definitionId:def.id,value,revision:null});
  for(const [index,values] of [[0,["9007199254740993","9007199254740993.000001","2026-10-01","premium","needle"]],[1,["9007199254740994","9007199254740993.000002","2026-10-12","regular",null]],[2,["0","0",null,"premium",null]]] as const)
    for(const [column,def] of [integer,decimal,date,choice,hidden].entries()) await put(records[index]!.id,def,values[column]!);
  const list=async(extra:Record<string,string>={})=>platform.client.ok<List>("GET",base+"/accounts?"+new URLSearchParams({q:"Option record",pageSize:"100",...extra}));
  const ids=(page:List)=>page.items.map(row=>row.id);
  const first=await list();
  assert(first.optionDefinitions.some(def=>def.id===hidden.id));
  assert(!Object.hasOwn(first.items.find(row=>row.id===records[0]!.id)!.optionValues,String(hidden.id)));
  assert.equal(first.items.find(row=>row.id===records[3]!.id)!.optionValues[integer.id],null,"New definition defaults never fill old records");
  assert.deepEqual(ids(await list({q:"عميل مميز"})),[records[0]!.id,records[2]!.id]);
  assert.deepEqual(ids(await list({q:"needle"})),[records[0]!.id]);
  assert.deepEqual(ids(await list({optionId:String(integer.id),optionOperator:"gte",optionValue:"9007199254740994"})),[records[1]!.id]);
  assert.deepEqual(ids(await list({optionId:String(decimal.id),optionOperator:"gte",optionValue:"9007199254740993.000002"})),[records[1]!.id]);
  assert.deepEqual(ids(await list({optionId:String(date.id),optionOperator:"lte",optionValue:"2026-10-01"})),[records[0]!.id]);
  assert.deepEqual(ids(await list({optionId:String(choice.id),optionOperator:"eq",optionValue:"premium"})),[records[0]!.id,records[2]!.id]);
  assert.deepEqual(ids(await list({optionId:String(integer.id),optionOperator:"empty"})),[records[3]!.id],"Zero is a specified value");
  assert.deepEqual(ids(await list({optionId:String(integer.id),optionOperator:"filled",sort:`option.${integer.id}:asc`})),[records[2]!.id,records[0]!.id,records[1]!.id]);
  const directory=await platform.client.ok<{options:Def[]}>("GET",config+"/directory"),native=directory.options.find(def=>def.key==="accounts.archived")!;
  assert.deepEqual(ids(await list({optionId:String(native.id),optionOperator:"empty"})),[],"False is a specified native value");
  const other=await company(platform.client,"Other option lists");
  const foreign=await platform.client.request("GET",`/companies/${other.id}/accounts?optionId=${integer.id}&optionOperator=eq&optionValue=0`);
  assert([400,404].includes(foreign.status));
  const invalid=await platform.client.request("GET",base+`/accounts?optionId=${date.id}&optionOperator=eq&optionValue=2026-02-30`);
  assert.equal(invalid.status,400);
  await platform.client.ok("PATCH",config+`/options/${hidden.id}`,{active:false,revision:hidden.revision});
  assert.equal((await list({q:"needle"})).total,0);
  await platform.client.ok("PATCH",config+`/options/${integer.id}`,{active:false,revision:integer.revision});
  assert(!(await list()).optionDefinitions.some(def=>def.id===integer.id));
  const card=await platform.client.ok<{values:{definitionId:number;value:unknown}[]}>("GET",config+`/record-options?recordKind=account&recordId=${records[0]!.id}`);
  assert.equal(card.values.find(value=>value.definitionId===integer.id)?.value,"9007199254740993");
  assert.equal(card.values.find(value=>value.definitionId===hidden.id)?.value,"needle");
});

test("option lists search and filter native item booleans without widening pickers",async(t)=>{
  const f=await fixture(t),platform=await owner(f),co=await company(platform.client,"Item option lists"),base=`/companies/${co.id}`;
  const currencies=await platform.client.ok<Page<{id:number;code:string}>>("GET",base+"/currencies"),currencyId=currencies.items.find(row=>row.code==="YER")!.id;
  const withExpiry=(await platform.client.ok<{item:{id:number}}>("POST",base+"/items",{name:"Expiry item",currencyId,hasExpiry:true,idempotencyKey:randomUUID()},201)).item;
  const withoutExpiry=(await platform.client.ok<{item:{id:number}}>("POST",base+"/items",{name:"Simple item",currencyId,hasExpiry:false,idempotencyKey:randomUUID()},201)).item;
  const directory=await platform.client.ok<{options:{id:number;key:string;revision:number}[]}>("GET",base+"/configuration/directory"),native=directory.options.find(def=>def.key==="items.has-expiry")!;
  await platform.client.ok("PATCH",base+`/configuration/options/${native.id}`,{showInList:true,revision:native.revision});
  type Result=Page<{id:number;optionValues:Record<string,unknown>}>&{optionDefinitions:{id:number}[]};
  const yes=await platform.client.ok<Result>("GET",base+"/items?q="+encodeURIComponent("نعم"));
  assert.deepEqual(yes.items.map(row=>row.id),[withExpiry.id]);
  assert.equal(yes.items[0]!.optionValues[native.id],true);
  const no=await platform.client.ok<Result>("GET",base+`/items?optionId=${native.id}&optionOperator=eq&optionValue=false`);
  assert.deepEqual(no.items.map(row=>row.id),[withoutExpiry.id]);
  assert.equal(no.items[0]!.optionValues[native.id],false);
  const picker=await platform.client.ok<Page<{id:number}>>("GET",base+"/commerce-options?type=items&q="+encodeURIComponent("نعم"));
  assert.equal(picker.items.length,0,"Option search stays scoped to primary business lists");
  assert(!Object.hasOwn(picker,"optionDefinitions"));
});

test("negative stock in sales, purchase replenishment, transfers and standalone returns keeps books balanced",async(t)=>{
  const f=await fixture(t),ownerUser=await owner(f),co=await company(ownerUser.client,"Negative stock accounting"),prefix=`/companies/${co.id}`;
  const settings=(await f.pool.query<{allow_negative:boolean}>("SELECT allow_negative FROM inventory_settings WHERE company_id=$1",[co.id])).rows[0]!;
  assert.equal(settings.allow_negative,true);
  const currency=(await ownerUser.client.ok<Page<{id:number;code:string}>>("GET",prefix+"/currencies")).items.find(row=>row.code==="YER")!;
  const main=(await ownerUser.client.ok<Page<{id:number;code:string}>>("GET",prefix+"/branches")).items.find(row=>row.code==="HQ")!;
  const showroom=(await ownerUser.client.ok<Page<{id:number;code:string;branchId:number}>>("GET",prefix+`/locations?branchId=${main.id}`)).items.find(row=>row.code==="SHOWROOM")!;
  const accounts=(await ownerUser.client.ok<Page<{id:number;code:string;kind:string;category:string}>>("GET",prefix+"/accounts?pageSize=100")).items;
  const forbidden=new Set((await f.pool.query<{id:number}>("SELECT inventory_account_id AS id FROM inventory_settings WHERE company_id=$1 UNION SELECT sales_account_id FROM inventory_settings WHERE company_id=$1 UNION SELECT cogs_account_id FROM inventory_settings WHERE company_id=$1 UNION SELECT surplus_account_id FROM inventory_settings WHERE company_id=$1 UNION SELECT shortage_account_id FROM inventory_settings WHERE company_id=$1",[co.id])).rows.map(x=>x.id));
  let counterparty=accounts.find(a=>a.kind==="posting"&&a.category==="asset"&&!forbidden.has(a.id));
  if(!counterparty)counterparty=(await ownerUser.client.ok<{account:{id:number;code:string;kind:string;category:string}}>("POST",prefix+"/accounts",{
    code:"1111999999",name:"حساب المبيعات التجريبي",kind:"posting",category:"asset",normalSide:"debit",parentId:null,active:true,
  },201)).account;
  const item=(await ownerUser.client.ok<{item:{id:number}}>("POST",prefix+"/items",{
    idempotencyKey:randomUUID(),name:"Negative stock item",currencyId:currency.id,
    unit1Name:"قطعة",salePrice1:"30",purchasePrice:"15",hasExpiry:false,
  },201)).item;
  const invoice=(kind:"sale"|"purchase",quantity:string,price?:string)=>({
    idempotencyKey:randomUUID(),kind,documentDate:"2026-10-12",currencyId:currency.id,
    branchId:main.id,locationId:showroom.id,counterpartyAccountId:counterparty!.id,description:"اختبار المخزون السالب",
    discount:"0",lines:[{itemId:item.id,unit:1,quantity,unitPrice:price??"30",expiryDate:null,originalLineId:null}],
  });
  const sale=await ownerUser.client.ok<{invoice:{id:number;returning:boolean;total:string}}>("POST",prefix+"/invoices",invoice("sale","5"),201);
  assert(!sale.invoice.returning);
  const balances=async()=>f.pool.query<{quantity_smallest:string;value_base:string}>(
    "SELECT quantity_smallest::text,value_base::text FROM stock_item_valuations WHERE company_id=$1 AND item_id=$2",[co.id,item.id]);
  assert.equal((await balances()).rows[0]!.quantity_smallest,"-5");
  const warehouse=(await ownerUser.client.ok<{location:{id:number}}>("POST",prefix+"/locations",{
    branchId:main.id,code:"NEGWH",name:"مخزن استلام سالب",kind:"warehouse",active:true,
  },201)).location;
  await ownerUser.client.ok("POST",prefix+"/stock-transfers",{
    documentDate:"2026-10-12",itemId:item.id,fromLocationId:showroom.id,toLocationId:warehouse.id,
    quantity:"2",unit:1,expiryDate:null,description:"نقل من معرض سالب",idempotencyKey:randomUUID(),
  },201);
  const sourceBal=await f.pool.query<{quantity_smallest:string}>(
    "SELECT quantity_smallest::text FROM stock_balances WHERE company_id=$1 AND item_id=$2 AND location_id=$3",[co.id,item.id,showroom.id]);
  assert.equal(sourceBal.rows[0]!.quantity_smallest,"-7");
  const direct=await ownerUser.client.ok<{invoice:{returning:boolean;total:string}}>("POST",prefix+"/invoices",invoice("sale","-1"),201);
  assert.equal(direct.invoice.returning,true);
  assert.equal(direct.invoice.total,"-30");
  const replenished=await ownerUser.client.ok<{invoice:{varianceDocumentId:number|null}}>("POST",prefix+"/invoices",invoice("purchase","4","15"),201);
  assert(replenished.invoice.varianceDocumentId!==null,"Negative inventory replenishment needs an auditable variance journal");
  const pool=(await balances()).rows[0]!;
  assert.equal(pool.quantity_smallest,"0");
  assert.equal(pool.value_base,"0");
  const balanced=await f.pool.query<{count:string}>(
    "SELECT count(*)::text AS count FROM financial_documents WHERE company_id=$1 AND status='posted' AND total_debit<>total_credit",[co.id]);
  assert.equal(balanced.rows[0]!.count,"0");
});
test("item statistics track finalized stock and last normal documents without leaking company data", async (t) => {
  const f = await fixture(t), platform = await owner(f);
  const co = await company(platform.client, "Item statistics"), prefix = `/companies/${co.id}`;
  const currency = (await platform.client.ok<Page<{ id: number; code: string }>>("GET", prefix + "/currencies")).items.find((row) => row.code === "YER")!;
  const branch = (await platform.client.ok<Page<{ id: number; code: string }>>("GET", prefix + "/branches")).items.find((row) => row.code === "HQ")!;
  const showroom = (await platform.client.ok<Page<{ id: number; code: string }>>("GET", prefix + `/locations?branchId=${branch.id}`)).items.find((row) => row.code === "SHOWROOM")!;
  const warehouse = (await platform.client.ok<{ location: { id: number } }>("POST", prefix + "/locations", {
    branchId: branch.id, code: "STATWH", name: "مخزن الإحصائيات", kind: "warehouse",
  }, 201)).location;
  const counterparty = (await platform.client.ok<{ account: { id: number } }>("POST", prefix + "/accounts", {
    code: "1111999998", name: "حساب اختبار الإحصائيات", kind: "posting", category: "asset", normalSide: "debit", parentId: null, active: true,
  }, 201)).account;
  const item = (await platform.client.ok<{ item: { id: number } }>("POST", prefix + "/items", {
    idempotencyKey: randomUUID(), name: "صنف بثلاث وحدات", currencyId: currency.id, hasExpiry: false, shelf: "رف A3",
    unit1Name: "كرتون", unit2Name: "باكت", unit3Name: "حبة", factor2: 7, factor3: 3,
    salePrice1: "210", salePrice2: "30", salePrice3: "10", purchasePrice: "84",
  }, 201)).item;
  const statistics = async (client = platform.client, companyId = co.id) =>
    (await client.ok<{ statistics: ItemStatistics }>("GET", `/companies/${companyId}/items/${item.id}/statistics`)).statistics;
  const initial = await statistics();
  assert.equal(initial.companyId, co.id);
  assert.equal(initial.itemId, item.id);
  assert.equal(initial.canViewStock, true);
  assert.equal(initial.canViewCommerce, true);
  assert.equal(initial.stock?.total, "0");
  assert.equal(initial.lastMovement, null);
  assert.equal(initial.lastPurchase, null);
  assert.equal(initial.lastSale, null);
  assert.equal(initial.lastAdjustment, null);
  const save = async (kind: "sale" | "purchase", quantity: string, unit: 1 | 2 | 3, originalLineId: number | null = null) =>
    (await platform.client.ok<{ invoice: Invoice }>("POST", prefix + "/invoices", {
      idempotencyKey: randomUUID(), kind, documentDate: "2026-10-12", currencyId: currency.id,
      branchId: branch.id, locationId: showroom.id, counterpartyAccountId: counterparty.id,
      discount: "0", lines: [{ itemId: item.id, unit, quantity, unitPrice: kind === "purchase" ? "84" : undefined, originalLineId, expiryDate: null }],
    }, 201)).invoice;
  const purchase = await save("purchase", "2", 1);
  const purchased = await statistics();
  assert.equal(purchased.stock?.total, "42", "Unit conversion uses the smallest part exactly");
  const preview = await platform.client.ok<{items:{itemId:number;quantitySmallest:string;shelf:string}[]}>(
    "GET", prefix+`/invoice-stock-preview?locationId=${showroom.id}&itemIds=${item.id}`);
  assert.deepEqual(preview.items,[{itemId:item.id,quantitySmallest:"42",shelf:"رف A3"}]);
  assert.equal((await platform.client.request("GET",prefix+`/invoice-stock-preview?locationId=${showroom.id}&itemIds=invalid`)).status,400);
  assert.equal(purchased.stock?.unitName, "حبة");
  assert.equal(purchased.lastPurchase?.invoiceId, purchase.id);
  const sale = await save("sale", "3", 2);
  const sold = await statistics();
  assert.equal(sold.stock?.total, "33");
  assert.equal(sold.lastSale?.invoiceId, sale.id);
  await save("sale", "-1", 2, sale.lines[0]!.id);
  await save("purchase", "-1", 1, purchase.lines[0]!.id);
  const returned = await statistics();
  assert.equal(returned.stock?.total, "15");
  assert.equal(returned.lastSale?.invoiceId, sale.id, "A return does not replace the last normal sale");
  assert.equal(returned.lastPurchase?.invoiceId, purchase.id, "A return does not replace the last normal purchase");
  await platform.client.ok("POST", prefix + "/stock-transfers", {
    documentDate: "2026-10-12", itemId: item.id, fromLocationId: showroom.id, toLocationId: warehouse.id,
    quantity: "4", unit: 3, expiryDate: null, description: "مناقلة الإحصائيات", idempotencyKey: randomUUID(),
  }, 201);
  const transferred = await statistics();
  assert.equal(transferred.stock?.total, "15", "A transfer preserves the company total");
  assert.equal(transferred.stock?.showroom, "11");
  assert.equal(transferred.stock?.warehouse, "4");
  const adjustment = (await platform.client.ok<{ operation: { id: number } }>("POST", prefix + "/stock-adjustments", {
    documentDate: "2026-10-12", itemId: item.id, locationId: showroom.id,
    countedQuantity: "10", expectedQuantitySmallest: "11", unit: 3, expiryDate: null,
    unitCostBase: "4", description: "تسوية الإحصائيات", idempotencyKey: randomUUID(),
  }, 201)).operation;
  const adjusted = await statistics();
  assert.equal(adjusted.stock?.total, "14");
  assert.equal(adjusted.lastAdjustment?.id, adjustment.id);
  const other = await company(platform.client, "Other statistics company");
  assert.equal((await platform.client.request("GET", `/companies/${other.id}/items/${item.id}/statistics`)).status, 404);
  const clerk = await register(f, "statistics-items-only@example.test");
  await employee(platform.client, co.id, clerk.user.id, ["items.view"]);
  const limited = await statistics(clerk.client);
  assert.equal(limited.canViewStock, false);
  assert.equal(limited.canViewCommerce, false);
  assert.equal(limited.stock, null);
  assert.equal(limited.lastMovement, null);
  assert.equal(limited.lastAdjustment, null);
  assert.equal(limited.lastPurchase, null);
  assert.equal(limited.lastSale, null);
});

test("inventory accounts are ready automatically for new and existing companies",async(t)=>{
  const f=await fixture(t),platform=await owner(f),co=await company(platform.client,"Automatic inventory");
  type Settings={inventory_account_id:number;sales_account_id:number;cogs_account_id:number;surplus_account_id:number;shortage_account_id:number;revision:number};
  const current=(await f.pool.query<Settings>("SELECT * FROM inventory_settings WHERE company_id=$1",[co.id])).rows[0]!;
  assert(current);
  const ids=[current.inventory_account_id,current.sales_account_id,current.cogs_account_id,current.surplus_account_id,current.shortage_account_id];
  assert.equal(new Set(ids).size,5);
  const accounts=(await f.pool.query<{id:number;category:string;active:boolean;kind:string}>("SELECT * FROM accounts WHERE company_id=$1 AND id=ANY($2::integer[])",[co.id,ids])).rows;
  for(const [i,category] of ["asset","income","expense","income","expense"].entries())assert(accounts.some(a=>a.id===ids[i]&&a.category===category&&a.active&&a.kind==="posting"));
  assert.equal((await f.pool.query("SELECT initialize_company_inventory_settings($1,$2) AS changed",[co.id,platform.user.id])).rows[0].changed,false);
  assert.deepEqual((await f.pool.query("SELECT * FROM inventory_settings WHERE company_id=$1",[co.id])).rows[0],current);
  const existing=(await f.pool.query<{id:number}>("INSERT INTO companies(name,created_by) VALUES('Legacy inventory company',$1) RETURNING id",[platform.user.id])).rows[0]!;
  assert.equal((await f.pool.query("SELECT initialize_company_inventory_settings($1,$2) AS changed",[existing.id,platform.user.id])).rows[0].changed,true);
  const backfilled=(await f.pool.query<Settings>("SELECT * FROM inventory_settings WHERE company_id=$1",[existing.id])).rows[0]!;
  assert.equal(new Set([backfilled.inventory_account_id,backfilled.sales_account_id,backfilled.cogs_account_id,backfilled.surplus_account_id,backfilled.shortage_account_id]).size,5);
  assert.equal((await f.pool.query("SELECT count(*)::integer AS total FROM accounts WHERE company_id=$1 AND active AND kind='posting'",[existing.id])).rows[0].total,5);
});

test("attendance schedules and punches enforce server time, privacy and duplicate safety",async(t)=>{
 const f=await fixture(t),platform=await owner(f),co=await company(platform.client,"Attendance"),other=await company(platform.client,"Other attendance");
 const person=await register(f,"attendance-person@example.test"),someone=await register(f,"attendance-other@example.test");
 const staff=await employee(platform.client,co.id,person.user.id,[]),peer=await employee(platform.client,co.id,someone.user.id,[]);
 await employee(platform.client,other.id,person.user.id,[]);
 const base=`/companies/${co.id}/attendance`;
 const branches=await platform.client.ok<Page<{id:number}>>("GET",`/companies/${co.id}/branches`);
 const foreign=await platform.client.ok<Page<{id:number}>>("GET",`/companies/${other.id}/branches`);
 const draft={branchId:branches.items[0]!.id,workDays:[0,1,2,3,4,5,6],startTime:"08:00",endTime:"16:00",active:true,revision:null};
 assert.equal((await person.client.request("POST",base+"/check-in",{idempotencyKey:randomUUID()})).status,409);
 assert.equal((await person.client.request("PUT",base+`/schedules/${staff.id}`,draft)).status,403);
 assert.equal((await platform.client.request("PUT",base+`/schedules/${staff.id}`,{...draft,branchId:foreign.items[0]!.id})).status,400);
 await platform.client.ok("PUT",base+`/schedules/${staff.id}`,draft);
 assert.equal((await platform.client.request("PUT",base+`/schedules/${staff.id}`,draft)).status,409);
 assert.equal((await person.client.request("POST",base+"/check-in",{idempotencyKey:randomUUID(),checkedInAt:"2020-01-01"})).status,400);
 const key=randomUUID();
 const punches=await Promise.all([person.client.request<{record:{id:number;checkedInAt:string;workDate:string}}>("POST",base+"/check-in",{idempotencyKey:key}),person.client.request<{record:{id:number;checkedInAt:string;workDate:string}}>("POST",base+"/check-in",{idempotencyKey:key})]);
 assert(punches.every(p=>p.status===200));assert.equal(punches[0]!.body.record.id,punches[1]!.body.record.id);
 const record= punches[0]!.body.record;
 assert(Math.abs(Date.now()-new Date(record.checkedInAt).getTime())<10000);
 const self=await person.client.ok<{items:{employeeId:number}[];employees:{id:number}[];canCheckOut:boolean}>("GET",base);
 assert(self.items.every(r=>r.employeeId===staff.id));assert.deepEqual(self.employees.map(e=>e.id),[staff.id]);assert(self.canCheckOut);
 assert.equal((await person.client.request("GET",base+`?employeeId=${peer.id}`)).status,403);
 assert.equal((await someone.client.request("POST",base+"/check-out",{recordId:record.id})).status,404);
 assert.equal((await person.client.request("POST",`/companies/${other.id}/attendance/check-out`,{recordId:record.id})).status,404);
 const closed=await person.client.ok<{record:{checkedOutAt:string;revision:number}}>("POST",base+"/check-out",{recordId:record.id});
 assert(new Date(closed.record.checkedOutAt)>=new Date(record.checkedInAt));
 const retry=await person.client.ok<{record:{checkedOutAt:string;revision:number}}>("POST",base+"/check-out",{recordId:record.id});assert.deepEqual(retry,closed);
 const duplicate=await person.client.ok<{record:{id:number}}>("POST",base+"/check-in",{idempotencyKey:randomUUID()});assert.equal(duplicate.record.id,record.id);
 const events=await f.pool.query("SELECT action FROM audit_events WHERE company_id=$1 AND action LIKE 'attendance.%' ORDER BY id",[co.id]);
 assert.deepEqual(events.rows.map(e=>e.action),["attendance.schedule","attendance.checkIn","attendance.checkOut"]);
 await assert.rejects(f.pool.query("DELETE FROM attendance_records WHERE id=$1",[record.id]),(error:{code?:string})=>error.code==="23514");
});

test("attendance reports preserve overnight metrics, absence deadlines, history and privacy", async (t) => {
  const f=await fixture(t), platform=await owner(f), co=await company(platform.client,"Attendance reports"), other=await company(platform.client,"Other reports");
  const people=await Promise.all(Array.from({length:5},(_,i)=>register(f,`report-${i}@example.test`)));
  const staff: Employee[]=[];
  for(const person of people) staff.push(await employee(platform.client,co.id,person.user.id,[]));
  const branch=(await platform.client.ok<Page<{id:number}>>("GET",`/companies/${co.id}/branches`)).items[0]!.id;
  const base=`/companies/${co.id}/attendance`,day="2000-01-03";
  for(const i of [0,1,2,4]) await f.pool.query(`INSERT INTO employee_schedules(company_id,employee_id,branch_id,work_days,start_time,end_time,active,updated_by,updated_at) VALUES($1,$2,$3,$4,'22:00','06:00',true,$5,'2000-01-03T08:00:00+03:00')`,[co.id,staff[i]!.id,branch,i===2?[2]:[0,1,2,3,4,5,6],platform.user.id]);
  for(const i of [0,4]) await f.pool.query(`INSERT INTO attendance_records(company_id,employee_id,employee_name,branch_id,branch_name,work_date,checked_in_at,checked_out_at,start_time,end_time,schedule_revision,idempotency_key,created_by,updated_by) VALUES($1,$2,$3,$4,'Historical branch',$5,$6,$7,'22:00','06:00',1,$8,$9,$9)`,[co.id,staff[i]!.id,staff[i]!.name,branch,day,i===0?"2000-01-03T22:07:00+03:00":"2000-01-03T22:00:00+03:00",i===0?"2000-01-04T05:30:00+03:00":null,randomUUID(),platform.user.id]);
  type Report=import("../packages/contracts/src/attendance.ts").AttendanceReport;
  const report=await platform.client.ok<Report>("GET",base+`/report?day=${day}&pageSize=1&sort=workDate:desc,id:desc`);
  assert.equal(report.items.length,1);assert.equal(report.total,5);
  assert.deepEqual(report.summary,{total:5,attended:2,absent:1,late:1,missingCheckout:1,workedMinutes:443});
  const own=await people[0]!.client.ok<Report>("GET",base+`/report?day=${day}`);
  assert.equal(own.total,1);assert.equal(own.items[0]!.employeeId,staff[0]!.id);
  assert.equal(own.items[0]!.lateMinutes,7);assert.equal(own.items[0]!.earlyLeaveMinutes,30);assert.equal(own.items[0]!.workedMinutes,443);
  const all=await platform.client.ok<Report>("GET",base+`/report?day=${day}&sort=lateMinutes:desc,workedMinutes:desc`);
  assert.equal(all.items.find(r=>r.employeeId===staff[2]!.id)!.status,"rest");
  assert.equal(all.items.find(r=>r.employeeId===staff[3]!.id)!.status,"unconfigured");
  assert.equal(all.items.find(r=>r.employeeId===staff[4]!.id)!.workedMinutes,null);
  assert.equal((await people[0]!.client.request("GET",base+`/report?day=${day}&employeeId=${staff[1]!.id}`)).status,403);
  assert.equal((await platform.client.request("GET",`/companies/${other.id}/attendance/report?employeeId=${staff[0]!.id}`)).status,404);
  const absent=await platform.client.ok<Report>("GET",base+`/report?day=${day}&status=absent`);assert.equal(absent.total,1);assert.equal(absent.items[0]!.employeeId,staff[1]!.id);
  await platform.client.ok("PUT",base+`/schedules/${staff[1]!.id}`,{branchId:branch,workDays:[0],startTime:"08:00",endTime:"16:00",active:false,revision:1});
  const preserved=await platform.client.ok<Report>("GET",base+`/report?day=${day}&employeeId=${staff[1]!.id}`);assert.equal(preserved.items[0]!.status,"absent");assert.equal(preserved.items[0]!.startTime,"22:00");
  const late=await platform.client.ok<Report>("GET",base+`/report?day=${day}&status=late`);assert.equal(late.total,1);assert.equal(late.summary.late,1);
  await platform.client.ok("PUT",base+`/schedules/${staff[1]!.id}`,{branchId:branch,workDays:[0,1,2,3,4,5,6],startTime:"00:00",endTime:"23:59",active:true,revision:2});
  const now=(await f.pool.query("SELECT (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date::text AS day,(clock_timestamp() AT TIME ZONE 'Asia/Aden')::time<'23:59'::time AS during")).rows[0];
  const during=await people[1]!.client.ok<Report>("GET",base+`/report?day=${now.day}`);assert.equal(during.items[0]!.status,now.during?"notRecorded":"absent");
  const upcoming=await people[0]!.client.ok<Report>("GET",base+"/report?day=2099-01-01");assert.equal(upcoming.items[0]!.status,"waiting");assert.equal(upcoming.summary.absent,0);
  const past=await people[0]!.client.ok<Report>("GET",base+"/report?day=1999-01-01");assert.equal(past.items[0]!.status,"unconfigured");
  assert.equal((await platform.client.request("GET",base+"/report?status=invalid")).status,400);
  await assert.rejects(f.pool.query("DELETE FROM employee_schedule_history WHERE company_id=$1",[co.id]),(error:{code?:string})=>error.code==="23514");
});

test("media images upload thumbnails, protect tenants, and persist profile URLs",async(t)=>{
  const f=await fixture(t);
  const {client,user}=await owner(f);
  const other=await register(f,"media-outsider@example.test");
  const c=await company(client,"Image company");
  // A 1x1 PNG; the browser produces the full-sized and 160px renditions.
  const data="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9YiR7j8AAAAASUVORK5CYII=";
  const avatar=await client.ok<{id:string;fullUrl:string;thumbnailUrl:string}>("POST","/media",{
    purpose:"avatar",companyId:null,original:data,thumbnail:data
  },201);
  assert.match(avatar.fullUrl,/^\/api\/media\/[0-9a-f-]{36}\/full$/);
  const thumbnail=await client.request("GET",avatar.thumbnailUrl.replace(/^\/api/,""));
  assert.equal(thumbnail.status,200);
  assert.equal(thumbnail.headers.get("content-type"),"image/png");
  assert.equal((await other.client.request("GET",avatar.thumbnailUrl.replace(/^\/api/,""))).status,404);
  assert.equal((await f.client().request("GET",avatar.thumbnailUrl.replace(/^\/api/,""))).status,401);
  const profile=await client.ok<{user:User}>("PATCH","/profile",{
    name:user.name,displayName:user.displayName,email:user.email,phone:user.phone,image:avatar.fullUrl
  });
  assert.equal(profile.user.image,avatar.fullUrl);
  const itemImage=await client.ok<{id:string;thumbnailUrl:string}>("POST","/media",{
    purpose:"item",companyId:c.id,original:data,thumbnail:data
  },201);
  assert.equal((await client.request("GET",itemImage.thumbnailUrl.replace(/^\/api/,""))).status,200);
  assert.equal((await other.client.request("GET",itemImage.thumbnailUrl.replace(/^\/api/,""))).status,403);
  assert.equal((await client.request("POST","/media",{
    purpose:"item",companyId:c.id,original:"data:image/png;base64,ZmFrZQ==",thumbnail:data
  })).status,400);
  const stored=await f.pool.query("SELECT count(*)::int AS count FROM media_assets WHERE uploaded_by=$1",[user.id]);
  assert.equal(stored.rows[0].count,2);
});


test("memo followers isolate companies, respect roles and explicit denies, and comment without transferring responsibility", async (t) => {
  const f = await fixture(t);
  const platform = await owner(f);
  const companyA = await company(platform.client, "Memo follow A");
  const companyB = await company(platform.client, "Memo follow B");
  const sender = await register(f, "memo-follow-sender@example.test");
  const receiver = await register(f, "memo-follow-recipient@example.test");
  const watcher = await register(f, "memo-follow-watcher@example.test");
  const roleWatcher = await register(f, "memo-follow-role@example.test");
  const stranger = await register(f, "memo-follow-stranger@example.test");
  await employee(platform.client, companyA.id, sender.user.id);
  const recipientEmployee = await employee(platform.client, companyA.id, receiver.user.id);
  const watcherEmployee = await employee(platform.client, companyA.id, watcher.user.id);
  const roleEmployee = await employee(platform.client, companyA.id, roleWatcher.user.id);
  await employee(platform.client, companyB.id, stranger.user.id);
  const base = `/companies/${companyA.id}/memos`;
  const roles = (await platform.client.ok<{roles:{id:number;name:string}[]}>(
    "GET", `${base}/roles`,
  )).roles;
  const accountantRole = roles.find(r => r.name === "محاسب");
  assert.ok(accountantRole);
  const key = randomUUID();
  const created = await sender.client.ok<{memo: import("../packages/contracts/src/index.ts").MemoDetail}>(
    "POST",base,{
      title:"Follow audit", body:"Check invoices", type:"task",
      recipientEmployeeId:recipientEmployee.id,
      followers:[{kind:"employee",employeeId:watcherEmployee.id,accessLevel:"view"},
        {kind:"role",roleId:accountantRole.id,accessLevel:"comment"}],
      idempotencyKey:key,
    },201,
  );
  const memoId = created.memo.id;
  assert.equal(created.memo.currentUserId, receiver.user.id);
  assert.equal(created.memo.followerRevision, 1);
  assert.equal((await sender.client.ok<{memo:{id:number}}>("POST",base,{
    title:"Follow audit", body:"Check invoices", type:"task",
    recipientEmployeeId:recipientEmployee.id,
    followers:[{kind:"employee",employeeId:watcherEmployee.id,accessLevel:"view"},
      {kind:"role",roleId:accountantRole.id,accessLevel:"comment"}],
    idempotencyKey:key,
  })).memo.id,memoId);
  assert.equal((await watcher.client.ok<{memo:{canComment:boolean;canTransfer:boolean}}>(
    "GET",`${base}/${memoId}`
  )).memo.canComment,false);
  assert.equal((await watcher.client.ok<{items:{id:number}[]}>(
    "GET",`${base}?box=watching`
  )).items[0]?.id,memoId);
  assert.equal((await watcher.client.request("POST",`${base}/${memoId}/comments`,{
    body:"Not authorized",idempotencyKey:randomUUID(),
  })).status,403);
  assert.equal((await watcher.client.request("POST",`${base}/${memoId}/actions`,{
    action:"approve-completion",body:"Override",revision:1,idempotencyKey:randomUUID(),
  })).status,403);
  assert.equal((await roleWatcher.client.request("GET",`${base}/${memoId}`)).status,404);
  assert.equal((await stranger.client.request("GET",`${base}/${memoId}`)).status,403);
  await platform.client.ok("PUT",`/companies/${companyA.id}/configuration/assignments`,{
    employeeId:roleEmployee.id,roleId:accountantRole.id,active:true,revision:null,
  });
  const allowed=(await roleWatcher.client.ok<{memo:{canComment:boolean;canTransfer:boolean;currentUserId:number}}>(
    "GET",`${base}/${memoId}`
  )).memo;
  assert.equal(allowed.canComment,true);
  assert.equal(allowed.canTransfer,false);
  const commentKey=randomUUID();
  const payload={body:"Reviewed the invoice",idempotencyKey:commentKey};
  const commented=(await roleWatcher.client.ok<{memo:{events:{kind:string}[];currentUserId:number;revision:number}}>(
    "POST",`${base}/${memoId}/comments`,payload,201
  )).memo;
  assert.equal(commented.events.filter(e=>e.kind==="follower_comment").length,1);
  assert.equal(commented.currentUserId,receiver.user.id);
  assert.equal(commented.revision,created.memo.revision);
  await roleWatcher.client.ok("POST",`${base}/${memoId}/comments`,payload,201);
  assert.equal((await f.pool.query(
    "SELECT count(*)::integer AS count FROM memo_follow_comments WHERE company_id=$1 AND memo_id=$2",
    [companyA.id,memoId],
  )).rows[0].count,1);
  const revised=(await sender.client.ok<{memo:{followerRevision:number;followers:{id:number}[]}}>(
    "PUT",`${base}/${memoId}/followers`,{
      revision:1,followers:[{kind:"employee",employeeId:watcherEmployee.id,accessLevel:"comment"}],
    },
  )).memo;
  assert.equal(revised.followerRevision,2);
  assert.equal(revised.followers.length,1);
  assert.equal((await sender.client.request("PUT",`${base}/${memoId}/followers`,{
    revision:1,followers:[],
  })).status,409);
  assert.equal((await roleWatcher.client.request("GET",`${base}/${memoId}`)).status,404);
  assert.equal((await watcher.client.ok<{memo:{canComment:boolean}}>(
    "GET",`${base}/${memoId}`
  )).memo.canComment,true);
  await platform.client.ok("PUT",`/companies/${companyA.id}/configuration/employee-rules`,{
    employeeId:watcherEmployee.id,permissionKey:"company.memos:view",effect:"deny",revision:null,
  });
  assert.equal((await watcher.client.request("GET",`${base}/${memoId}`)).status,403);
  assert.equal((await watcher.client.request("GET",`${base}?box=watching`)).status,403);
  assert.equal((await watcher.client.request("POST",`${base}/${memoId}/comments`,{
    body:"Cannot bypass deny",idempotencyKey:randomUUID(),
  })).status,403);
  const changes=(await f.pool.query(
    "SELECT revision FROM memo_follow_changes WHERE company_id=$1 AND memo_id=$2 ORDER BY revision",
    [companyA.id,memoId],
  )).rows.map(row=>row.revision);
  assert.deepEqual(changes,[1,2]);
});

test("memo links resolve safely, redact unauthorized account details and reject cross-company records", async(t)=>{
 const f=await fixture(t);
 const platform=await owner(f);
 const coA=await company(platform.client,"Memo links A");
 const coB=await company(platform.client,"Memo links B");
 const recipient=await register(f,"memo-link-reader@example.test");
 const staff=await employee(platform.client,coA.id,recipient.user.id);
 const accountA=(await f.pool.query("SELECT id FROM accounts WHERE company_id=$1 ORDER BY id LIMIT 1",[coA.id])).rows[0].id;
 const accountB=(await f.pool.query("SELECT id FROM accounts WHERE company_id=$1 ORDER BY id LIMIT 1",[coB.id])).rows[0].id;
 const base=`/companies/${coA.id}/memos`;
 const created=(await platform.client.ok<{memo:import("../packages/contracts/src/index.ts").MemoDetail}>(
  "POST",base,{title:"Review supplier account",body:"Review purchases",
    recipientEmployeeId:staff.id,type:"task",idempotencyKey:randomUUID(),
    links:{
      followPage:{pageKey:"company.purchases",recordId:null},
      referencePage:{pageKey:"company.account-ledger",recordId:null},
      itemId:null,accountId:accountA,
    },
  },201)).memo;
 assert.equal(created.links.followPage?.pageKey,"company.purchases");
 assert.equal(created.links.account?.id,accountA);
 assert.equal(created.links.revision,1);
 const viewed=(await recipient.client.ok<{memo:import("../packages/contracts/src/index.ts").MemoDetail}>(
   "GET",`${base}/${created.id}`
 )).memo;
 assert.equal(viewed.links.account,null);
 assert.equal(viewed.links.hiddenAccount,true);
 assert.equal(viewed.links.referencePage,null);
 assert.equal(viewed.links.hiddenReferencePage,true);
 assert.equal(viewed.links.followPage,null);
 assert.equal(viewed.links.hiddenFollowPage,true);
 assert.equal(viewed.canManageLinks,false);
 const changed=(await platform.client.ok<{memo:import("../packages/contracts/src/index.ts").MemoDetail}>(
   "PUT",`${base}/${created.id}/links`,{
     revision:1,followPage:{pageKey:"company.accounts",recordId:null},
     referencePage:null,itemId:null,accountId:accountA,
   }
 )).memo;
 assert.equal(changed.links.revision,2);
 assert.equal(changed.revision,created.revision);
 assert.equal(changed.currentUserId,recipient.user.id);
 assert.equal(changed.links.changes.length,1);
 assert.equal((await platform.client.request("PUT",`${base}/${created.id}/links`,{
   revision:1,followPage:null,referencePage:null,itemId:null,accountId:null,
 })).status,409);
 assert.equal((await recipient.client.request("PUT",`${base}/${created.id}/links`,{
   revision:2,followPage:null,referencePage:null,itemId:null,accountId:null,
 })).status,403);
 assert.equal((await platform.client.request("PUT",`${base}/${created.id}/links`,{
   revision:2,followPage:null,referencePage:null,itemId:null,accountId:accountB,
 })).status,403);
 assert.equal((await platform.client.request("PUT",`${base}/${created.id}/links`,{
   revision:2,followPage:{pageKey:"company.invoice",recordId:999999999},
   referencePage:null,itemId:null,accountId:null,
 })).status,404);
 assert.equal((await recipient.client.request("GET",`${base}/link-accounts`)).status,403);
});

test("memo options use shared typed definitions, capture defaults, filter lists, audit changes and preserve old values",async(t)=>{
 const f=await fixture(t);
 const platform=await owner(f);
 const co=await company(platform.client,"Memo options");
 const reader=await register(f,"memo-option-reader@example.test");
 const employeeCard=await employee(platform.client,co.id,reader.user.id);
 const config=`/companies/${co.id}/configuration`;
 const createOption=(key:string,name:string,type:"boolean"|"list",
   defaultValue:boolean|string|null,choices:{key:string;label:string}[]=[])=>
    platform.client.ok<{option:{id:number;revision:number}}>("POST",`${config}/options`,{
      key,pageKey:"company.memos",recordKind:"memo",name,valueType:type,
      defaultValue,choices,description:"",required:false,
      searchable:true,showOnCard:true,showInList:true,sortOrder:10,active:true,
    },201);
 const urgent= (await createOption("memo.urgent","عاجلة","boolean",false)).option;
 const method= (await createOption("memo.method","طريقة المتابعة","list",null,[
   {key:"call",label:"هاتف"},{key:"visit",label:"زيارة"},
 ])).option;
 const base=`/companies/${co.id}/memos`;
 const inputs={title:"Review memo vendor",body:"Review documents",
   type:"task",recipientEmployeeId:employeeCard.id};
 const first=(await platform.client.ok<{memo:import("../packages/contracts/src/index.ts").MemoDetail}>(
   "POST",base,{...inputs,idempotencyKey:randomUUID(),
     options:[{definitionId:urgent.id,value:true},{definitionId:method.id,value:"call"}],
   },201)).memo;
 assert.equal(first.optionValues.find(v=>v.definitionId===urgent.id)?.value,true);
 assert.equal(first.optionValues.find(v=>v.definitionId===method.id)?.value,"call");
 assert.equal(first.optionRevision,1);
 const second=(await platform.client.ok<{memo:import("../packages/contracts/src/index.ts").MemoDetail}>(
  "POST",base,{...inputs,title:"Review other memo",idempotencyKey:randomUUID()},201)).memo;
 assert.equal(second.optionValues.find(v=>v.definitionId===urgent.id)?.value,false);
 assert.equal(second.optionValues.find(v=>v.definitionId===method.id)?.value,null);
 const result=await platform.client.ok<{total:number;items:{id:number;optionValues:Record<string,unknown>}[];optionDefinitions:{key:string}[]}>(
   "GET",`${base}?box=all&optionKey=memo.urgent&optionValue=true`,
 );
 assert.equal(result.total,1);
 assert.equal(result.items[0]?.id,first.id);
 assert.equal(result.items[0]?.optionValues["memo.urgent"],true);
 assert.ok(result.optionDefinitions.some(v=>v.key==="memo.urgent"));
 assert.equal((await reader.client.request("PUT",`${base}/${first.id}/options`,{
   revision:1,values:[{definitionId:urgent.id,value:false}],
 })).status,403);
 assert.equal((await platform.client.request("PUT",`${base}/${first.id}/options`,{
   revision:1,values:[{definitionId:urgent.id,value:"not boolean"}],
 })).status,400);
 const edited=(await platform.client.ok<{memo:import("../packages/contracts/src/index.ts").MemoDetail}>(
   "PUT",`${base}/${first.id}/options`,{revision:1,values:[{definitionId:urgent.id,value:false}]},
 )).memo;
 assert.equal(edited.optionRevision,2);
 assert.equal(edited.revision,first.revision);
 assert.equal(edited.currentUserId,reader.user.id);
 assert.equal(edited.optionChanges.length,1);
 assert.equal((await platform.client.request("PUT",`${base}/${first.id}/options`,{
   revision:1,values:[],
 })).status,409);
 const editedDef=(await platform.client.ok<{option:{revision:number}}>(
   "PATCH",`${config}/options/${urgent.id}`,{defaultValue:true,revision:urgent.revision},
 )).option;
 assert.ok(editedDef.revision>urgent.revision);
 const old=(await platform.client.ok<{memo:import("../packages/contracts/src/index.ts").MemoDetail}>(
   "GET",`${base}/${second.id}`
 )).memo;
 assert.equal(old.optionValues.find(v=>v.definitionId===urgent.id)?.value,false);
 const third=(await platform.client.ok<{memo:import("../packages/contracts/src/index.ts").MemoDetail}>(
   "POST",base,{...inputs,title:"New default memo",idempotencyKey:randomUUID()},201
 )).memo;
 assert.equal(third.optionValues.find(v=>v.definitionId===urgent.id)?.value,true);
 const other=await company(platform.client,"Isolated memo options");
 const otherRecipient=await employee(platform.client,other.id,reader.user.id);
 assert.equal((await platform.client.request("POST",`/companies/${other.id}/memos`,{
   ...inputs,recipientEmployeeId:otherRecipient.id,title:"Cross-company option",
   idempotencyKey:randomUUID(),options:[{definitionId:urgent.id,value:true}],
 })).status,400);
});

test("memo followup defers independently, wakes once and cancels on transfer",async(t)=>{
 const f=await fixture(t),platform=await owner(f);
 const co=await company(platform.client,"Memo return to work");
 const receiver=await register(f,"memo-followup-recipient@example.test");
 const outsider=await register(f,"memo-followup-outsider@example.test");
 const another=await register(f,"memo-followup-another@example.test");
 const staff=await employee(platform.client,co.id,receiver.user.id);
 await employee(platform.client,co.id,outsider.user.id);
 const anotherStaff=await employee(platform.client,co.id,another.user.id);
 const base=`/companies/${co.id}/memos`;
 const created=(await platform.client.ok<{memo:import("../packages/contracts/src/index.ts").MemoDetail}>(
 "POST",base,{title:"Followup test",body:"Wait for supplier",type:"task",
 recipientEmployeeId:staff.id,idempotencyKey:randomUUID()},201)).memo;
 const localDate=new Date(Date.now()+2*86400000).toISOString().slice(0,10);
 const deferred=(await receiver.client.ok<{memo:import("../packages/contracts/src/index.ts").MemoDetail}>(
 "PUT",`${base}/${created.id}/schedule`,{action:"set",revision:0,
 localDate,localTime:"10:00",reason:"انتظار رد المورد",repeatInterval:"none"})).memo;
 assert.equal(deferred.schedule?.active,true);
 assert.equal(deferred.currentUserId,receiver.user.id);
 assert.equal(deferred.revision,created.revision);
 assert.equal((await platform.client.ok<{memo:import("../packages/contracts/src/index.ts").MemoDetail}>(
 "GET",`${base}/${created.id}`)).memo.schedule?.reason,"انتظار رد المورد");
 assert.equal((await receiver.client.ok<{items:{id:number}[]}>(
 "GET",`${base}?box=deferred`)).items[0]?.id,created.id);
 assert.equal((await outsider.client.ok<{items:{id:number}[]}>(
 "GET",`${base}?box=deferred`)).items.length,0);
 assert.equal((await outsider.client.request("PUT",`${base}/${created.id}/schedule`,{
 action:"cancel",revision:1,reason:"not permitted"})).status,404);
 assert.equal((await receiver.client.request("PUT",`${base}/${created.id}/schedule`,{
 action:"set",revision:0,localDate,localTime:"10:00",
 reason:"stale",repeatInterval:"none"})).status,409);
 const cancelled=(await platform.client.ok<{memo:import("../packages/contracts/src/index.ts").MemoDetail}>(
 "PUT",`${base}/${created.id}/schedule`,{action:"cancel",revision:1,reason:"متابعة الآن"})).memo;
 assert.equal(cancelled.schedule?.active,false);
 assert.equal(cancelled.revision,created.revision);
 assert.equal((await receiver.client.ok<{items:{id:number}[]}>(
 "GET",`${base}?box=deferred`)).items.length,0);
});

test("memo report scopes employee totals and approval intervals",async t=>{
 const f=await fixture(t);
 const platform=await owner(f);
 const first=await company(platform.client,"Memo report first");
 const second=await company(platform.client,"Memo report second");
 const employeeUser=await register(f,"memo-report-worker@example.test");
 const stranger=await register(f,"memo-report-other@example.test");
 const employeeCard=await employee(platform.client,first.id,employeeUser.user.id);
 await employee(platform.client,first.id,stranger.user.id);
 const base=`/companies/${first.id}/memos`;
 const created=(await platform.client.ok<{memo:import("../packages/contracts/src/index.ts").MemoDetail}>(
  "POST",base,{title:"Reconcile stock",body:"Review batches",type:"task",
   recipientEmployeeId:employeeCard.id,idempotencyKey:randomUUID()},201)).memo;
 const report=await platform.client.ok<import("../packages/contracts/src/index.ts").MemoReportResult>("GET",base+"/report");
 assert.equal(report.total,1);
 assert.equal(report.metrics.pending,1);
 assert.equal(report.items[0]?.id,created.id);
 assert.equal(report.employees.find(p=>p.userId===employeeUser.user.id)?.required,1);
 const hidden=await stranger.client.ok<{total:number}>("GET",base+"/report");
 assert.equal(hidden.total,0);
});

test("memo feature rules target current executor and preview scoped warnings",async t=>{
 const f=await fixture(t),platform=await owner(f);
 const co=await company(platform.client,"Rules A");
 const other=await company(platform.client,"Rules B");
 const worker=await register(f,"memo-rule-employee@example.test");
 const outsider=await register(f,"memo-rule-outsider@example.test");
 const employeeCard=await employee(platform.client,co.id,worker.user.id);
 await employee(platform.client,co.id,outsider.user.id);
 const base=`/companies/${co.id}`;
 const created=(await platform.client.ok<{memo:import("../packages/contracts/src/index.ts").MemoDetail}>(
  "POST",base+"/memos",{
   title:"Task to follow",body:"Complete inspection",type:"task",
   recipientEmployeeId:employeeCard.id,idempotencyKey:randomUUID(),
  },201)).memo;
 const input={name:"Sales pending work",enabled:true,employeeIds:[employeeCard.id],
  roleIds:[],actionCode:"invoice.sale.create",effect:"warn",minimumCount:1,
  minimumHours:null,matchMode:"all",excludeDeferredUntilDue:true,
  message:"راجع مذكرة التكليف قبل البيع"};
 const rule=(await platform.client.ok<{rule:import("../packages/contracts/src/index.ts").MemoFeatureRule}>(
  "POST",base+"/memo-feature-rules",input,201)).rule;
 assert.equal(rule.enabled,true);
 const preview=await platform.client.ok<import("../packages/contracts/src/index.ts").MemoFeaturePreview>(
  "GET",base+`/memo-feature-rules/${rule.id}/preview`);
 assert.equal(preview.totalImpacted,1);
 assert.equal(preview.impacted[0]?.employeeId,employeeCard.id);
 const impacted=await worker.client.ok<{matches:{ruleId:number;effect:string}[]}>(
  "GET",base+"/memo-feature-impact?kind=sale");
 assert.equal(impacted.matches[0]?.ruleId,rule.id);
 assert.equal(impacted.matches[0]?.effect,"warn");
