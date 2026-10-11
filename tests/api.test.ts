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
    const parsed: unknown = raw ? JSON.parse(raw) : null;
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
      "company.edit",
      "currencies.manage",
      "currencies.view",
      "employees.view",
      "finance.manage",
      "finance.post",
      "finance.view",
      "locations.manage",
      "locations.view",
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
