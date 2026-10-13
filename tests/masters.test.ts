import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import { accountChoices, accountChoiceLabels } from "../packages/contracts/src/index.ts";
import type {
  Account,
  AccountLink,
  Branch,
  Company,
  CompanyCurrency,
  Employee,
  ExchangeRate,
  FinanceSettings,
  Location,
  Page,
  Permission,
  SessionResponse,
  User,
} from "../packages/contracts/src/index.ts";

// These credentials exist only in disposable, isolated test schemas.
const password = "Masters-only-test-passphrase-2026";
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const origin = "http://localhost";

class Client {
  private cookie = "";
  private csrf: string | null = null;
  constructor(private readonly baseUrl: string) {}

  async request<T>(method: string, path: string, body?: unknown) {
    const headers = new Headers({ accept: "application/json" });
    if (this.cookie) headers.set("cookie", this.cookie);
    if (method !== "GET") {
      headers.set("content-type", "application/json");
      headers.set("origin", origin);
      if (this.csrf) headers.set("x-csrf-token", this.csrf);
    }
    const response = await fetch(`${this.baseUrl}/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const value of response.headers.getSetCookie())
      this.cookie = value.split(";", 1)[0]!;
    const result: unknown = await response.json();
    if (result && typeof result === "object" && "csrf" in result)
      this.csrf = (result as SessionResponse).csrf;
    return { status: response.status, body: result as T };
  }

  async ok<T>(method: string, path: string, body?: unknown, status = 200) {
    const response = await this.request<T>(method, path, body);
    assert.equal(
      response.status,
      status,
      `${method} ${path}: ${JSON.stringify(response.body)}`,
    );
    return response.body;
  }
}

async function fixture(t: TestContext) {
  const schema = `masters_${randomUUID().replaceAll("-", "")}`;
  const runtime = await createApp({
    databaseUrl,
    schema,
    appOrigin: origin,
    production: false,
    serveStatic: false,
  });
  const server: Server = runtime.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await runtime.close();
    const cleanup = new Pool({ connectionString: databaseUrl });
    try {
      await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await cleanup.end();
    }
  });
  const user = await provisionOwner(runtime.pool, {
    name: "Masters test owner",
    displayName: "Masters owner",
    email: "owner@masters.test",
    password,
  });
  const owner = new Client(baseUrl);
  await owner.ok("POST", "/auth/login", { email: user.email, password });
  async function company(name = "Masters test company") {
    return (
      await owner.ok<{ company: Company }>(
        "POST",
        "/companies",
        {
          name,
          phone: "",
          address: "",
        },
        201,
      )
    ).company;
  }
  async function member(
    companyId: number,
    permissions: Permission[],
    index = 1,
  ) {
    const client = new Client(baseUrl);
    const session = await client.ok<SessionResponse>(
      "POST",
      "/auth/register",
      {
        name: "Master employee",
        displayName: "Employee",
        email: `employee-${index}@masters.test`,
        phone: "",
        password,
      },
      201,
    );
    assert(session.user);
    const employee = (
      await owner.ok<{ employee: Employee }>(
        "POST",
        `/companies/${companyId}/employees`,
        {
          userId: session.user.id,
          name: "Employee",
          phone: "",
          role: "employee",
          active: true,
          permissions,
        },
        201,
      )
    ).employee;
    return { client, user: session.user, employee };
  }
  return {
    schema,
    pool: runtime.pool,
    owner,
    user,
    company,
    member,
    anonymous: () => new Client(baseUrl),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function account(
  f: Fixture,
  companyId: number,
  overrides: Record<string, unknown> = {},
) {
  return (
    await f.owner.ok<{ account: Account }>(
      "POST",
      `/companies/${companyId}/accounts`,
      {
        code: "1000000000",
        name: "Assets",
        parentId: null,
        kind: "group",
        category: "asset",
        normalSide: "debit",
        ...overrides,
      },
      201,
    )
  ).account;
}
async function currency(
  f: Fixture,
  companyId: number,
  overrides: Record<string, unknown> = {},
) {
  return (
    await f.owner.ok<{ currency: CompanyCurrency }>(
      "POST",
      `/companies/${companyId}/currencies`,
      {
        code: "YER",
        name: "Rial",
        decimalPlaces: 2,
        ...overrides,
      },
      201,
    )
  ).currency;
}
async function branch(f: Fixture, companyId: number, code = "MAIN") {
  return (
    await f.owner.ok<{ branch: Branch }>(
      "POST",
      `/companies/${companyId}/branches`,
      {
        code,
        name: `Branch ${code}`,
        phone: "",
        address: "",
      },
      201,
    )
  ).branch;
}
async function rate(
  f: Fixture,
  companyId: number,
  currencyId: number,
  effectiveAt: string,
  value = "250",
) {
  return (
    await f.owner.ok<{ exchangeRate: ExchangeRate }>(
      "POST",
      `/companies/${companyId}/exchange-rates`,
      {
        currencyId,
        rate: value,
        effectiveAt,
        source: " Manual test quote ",
      },
      201,
    )
  ).exchangeRate;
}
async function auditFor(
  f: Fixture,
  companyId: number,
  targetId: number,
  key: string,
  value: unknown,
) {
  const result = await f.pool.query<{
    before_value: Record<string, unknown> | null;
    after_value: Record<string, unknown>;
  }>(
    "SELECT before_value,after_value FROM audit_events WHERE company_id=$1 AND target_id=$2 AND after_value->>$3=$4 ORDER BY id DESC LIMIT 1",
    [companyId, targetId, key, String(value)],
  );
  assert.equal(
    result.rowCount,
    1,
    `Missing audit snapshot for ${key}=${String(value)}`,
  );
  return result.rows[0]!;
}
async function snapshot(f: Fixture, companyId: number) {
  const tables = [
    "accounts",
    "account_links",
    "company_currencies",
    "finance_settings",
    "exchange_rates",
    "branches",
    "locations",
    "audit_events",
  ];
  const result: Record<string, unknown[]> = {};
  for (const table of tables)
    result[table] = (
      await f.pool.query(
        `SELECT to_jsonb(t) AS value FROM ${table} t WHERE company_id=$1 ORDER BY to_jsonb(t)::text`,
        [companyId],
      )
    ).rows.map((row) => row.value as unknown);
  return result;
}
async function rejectAudit(f: Fixture, run: () => Promise<void>) {
  await f.pool.query(
    "CREATE FUNCTION reject_master_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test rejects master audit'; END $$",
  );
  await f.pool.query(
    "CREATE TRIGGER reject_master_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_master_audit()",
  );
  try {
    await run();
  } finally {
    await f.pool.query("DROP TRIGGER reject_master_audit ON audit_events");
    await f.pool.query("DROP FUNCTION reject_master_audit()");
  }
}
async function blockedOperations<T>(
  f: Fixture,
  companyId: number,
  operations: (() => Promise<T>)[],
  during?: () => Promise<void>,
) {
  const blocker = await f.pool.connect();
  await blocker.query("BEGIN");
  await blocker.query("SELECT id FROM companies WHERE id=$1 FOR UPDATE", [
    companyId,
  ]);
  const pending = Promise.allSettled(
    operations.map((operation) => operation()),
  );
  let barrierError: unknown;
  try {
    const deadline = Date.now() + 5000;
    let waiting = 0;
    do {
      waiting = (
        await f.pool.query<{ count: number }>(
          "SELECT count(DISTINCT l.pid)::int AS count FROM pg_locks l WHERE NOT l.granted AND EXISTS (SELECT 1 FROM pg_locks s JOIN pg_class c ON c.oid=s.relation JOIN pg_namespace n ON n.oid=c.relnamespace WHERE s.pid=l.pid AND n.nspname=$1)",
          [f.schema],
        )
      ).rows[0]!.count;
      if (waiting >= operations.length) break;
      await delay(10);
    } while (Date.now() < deadline);
    assert(
      waiting >= operations.length,
      `Only ${waiting} of ${operations.length} mutations reached the database lock`,
    );
    await during?.();
  } catch (error) {
    barrierError = error;
  } finally {
    await blocker.query("COMMIT");
    blocker.release();
  }
  const settled = await pending;
  if (barrierError) throw barrierError;
  return settled.map((result) => {
    assert.equal(
      result.status,
      "fulfilled",
      result.status === "rejected" ? String(result.reason) : undefined,
    );
    assert(result.status === "fulfilled");
    return result.value;
  });
}

test("master permissions separate reading and writing, manage includes reading, and public roles never grant company access", async (t) => {
  const f = await fixture(t),
    c = await f.company(),
    other = await f.company("Other company");
  const reader = await f.member(c.id, [
    "accounts.view",
    "currencies.view",
    "locations.view",
  ]);
  const writer = await f.member(
    c.id,
    ["accounts.manage", "currencies.manage", "locations.manage"],
    2,
  );
  const outsider = await f.member(other.id, [], 3);
  await f.owner.ok("PATCH", `/users/${outsider.user.id}`, {
    kind: "admin",
    archived: false,
    suspended: false,
    editor: true,
    monitor: true,
  });
  const writes = [
    [
      "accounts",
      {
        code: "1000000000",
        name: "Assets",
        parentId: null,
        kind: "group",
        category: "asset",
        normalSide: "debit",
      },
    ],
    ["currencies", { code: "YER", name: "Rial", decimalPlaces: 2 }],
    ["branches", { code: "MAIN", name: "Main", phone: "", address: "" }],
  ] as const;
  for (const [path, body] of writes) {
    assert.equal(
      (await reader.client.request("POST", `/companies/${c.id}/${path}`, body))
        .status,
      403,
    );
    await writer.client.ok("POST", `/companies/${c.id}/${path}`, body, 201);
  }
  for (const endpoint of [
    "accounts",
    "account-links",
    "currencies",
    "finance-settings",
    "exchange-rates",
    "branches",
    "locations",
  ]) {
    await reader.client.ok("GET", `/companies/${c.id}/${endpoint}`);
    await writer.client.ok("GET", `/companies/${c.id}/${endpoint}`);
    assert.equal(
      (await outsider.client.request("GET", `/companies/${c.id}/${endpoint}`))
        .status,
      403,
    );
    assert.equal(
      (await f.anonymous().request("GET", `/companies/${c.id}/${endpoint}`))
        .status,
      401,
    );
  }
  await f.owner.ok(
    "PATCH",
    `/companies/${c.id}/employees/${writer.employee.id}`,
    { permissions: [] },
  );
  assert.equal(
    (await writer.client.request("GET", `/companies/${c.id}/accounts`)).status,
    403,
  );
  assert.equal(
    (
      await writer.client.request("POST", `/companies/${c.id}/currencies`, {
        code: "USD",
        name: "Dollar",
        decimalPlaces: 2,
      })
    ).status,
    403,
  );
  assert.deepEqual(
    (
      await f.pool.query("SELECT permissions FROM employees WHERE id=$1", [
        reader.employee.id,
      ])
    ).rows[0]?.permissions,
    ["accounts.view", "currencies.view", "locations.view"],
    "New permissions must be explicitly granted to existing employees",
  );
});

test("upgrading a foundation employee preserves explicit grants and never assigns new master permissions", async (t) => {
  const schema = `masters_upgrade_${randomUUID().replaceAll("-", "")}`;
  const setup = new Pool({ connectionString: databaseUrl });
  let runtime: Awaited<ReturnType<typeof createApp>> | undefined;
  let server: Server | undefined;
  t.after(async () => {
    if (server)
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
    await runtime?.close();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await setup.end();
    }
  });
  await setup.query(`CREATE SCHEMA "${schema}"`);
  const legacy = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
  });
  let companyId: number, employeeId: number;
  try {
    await legacy.query(
      await readFile(
        new URL("../apps/api/migrations/001_foundation.sql", import.meta.url),
        "utf8",
      ),
    );
    await legacy.query(
      "CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    await legacy.query(
      "INSERT INTO schema_migrations(version) VALUES ('001_foundation.sql')",
    );
    const owner = await provisionOwner(legacy, {
      name: "Legacy owner",
      displayName: "Legacy owner",
      email: "owner@upgrade.test",
      password,
    });
    const staff = (
      await legacy.query<{ id: number }>(
        "INSERT INTO users(name,display_name,email,password_hash) SELECT 'Legacy accountant','Legacy accountant','staff@upgrade.test',password_hash FROM users WHERE id=$1 RETURNING id",
        [owner.id],
      )
    ).rows[0]!;
    companyId = (
      await legacy.query<{ id: number }>(
        "INSERT INTO companies(name,created_by) VALUES('Legacy company',$1) RETURNING id",
        [owner.id],
      )
    ).rows[0]!.id;
    employeeId = (
      await legacy.query<{ id: number }>(
        "INSERT INTO employees(company_id,user_id,name,role,permissions,created_by) VALUES($1,$2,'Legacy accountant','accountant',ARRAY['employees.view','audit.view'],$3) RETURNING id",
        [companyId, staff.id, owner.id],
      )
    ).rows[0]!.id;
  } finally {
    await legacy.end();
  }
  runtime = await createApp({
    databaseUrl,
    schema,
    appOrigin: origin,
    production: false,
    serveStatic: false,
  });
  server = runtime.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server!.once("listening", resolve);
    server!.once("error", reject);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const client = new Client(`http://127.0.0.1:${address.port}`);
  await client.ok("POST", "/auth/login", {
    email: "staff@upgrade.test",
    password,
  });
  assert.deepEqual(
    (
      await runtime.pool.query(
        "SELECT permissions FROM employees WHERE id=$1",
        [employeeId],
      )
    ).rows[0]?.permissions,
    ["employees.view", "audit.view"],
  );
  await client.ok("GET", `/companies/${companyId}/employees`);
  for (const endpoint of [
    "accounts",
    "currencies",
    "exchange-rates",
    "branches",
    "locations",
  ])
    assert.equal(
      (await client.request("GET", `/companies/${companyId}/${endpoint}`))
        .status,
      403,
      endpoint,
    );
  assert.equal(
    (
      await client.request(
        "POST",
        `/companies/${companyId}/accounts/initialize`,
        {},
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await runtime.pool.query(
        "SELECT count(*)::int AS count FROM accounts WHERE company_id=$1",
        [companyId],
      )
    ).rows[0]?.count,
    0,
  );
});

test("queued master mutation rechecks employee activation inside its transaction", async (t) => {
  const f = await fixture(t),
    c = await f.company();
  const member = await f.member(c.id, ["accounts.manage"]);
  const before = await snapshot(f, c.id);
  const [response] = await blockedOperations(
    f,
    c.id,
    [
      () =>
        member.client.request("POST", `/companies/${c.id}/accounts`, {
          code: "1000000000",
          name: "Queued",
          kind: "group",
          category: "asset",
          normalSide: "debit",
          parentId: null,
        }),
    ],
    async () => {
      await f.pool.query("UPDATE employees SET active=false WHERE id=$1", [
        member.employee.id,
      ]);
    },
  );
  assert.equal(response?.status, 403);
  assert.deepEqual(
    await snapshot(f, c.id),
    before,
    "Denied queued request must create neither record nor audit",
  );
});

test("account identity, parent category and active ancestry remain protected while names audit canonical values", async (t) => {
  const f = await fixture(t),
    c = await f.company(),
    foreignCompany = await f.company("Foreign");
  const parent = await account(f, c.id),
    foreign = await account(f, foreignCompany.id);
  const child = await account(f, c.id, {
    code: "١٠٠٠٠٠٠٠٠١",
    name: " Cash ",
    kind: "posting",
    parentId: parent.id,
    normalSide: "credit",
  });
  assert.equal(child.code, "1000000001");
  assert.equal(child.name, "Cash");
  assert.equal(
    child.normalSide,
    "credit",
    "Contra account sides may differ from their category suggestion",
  );
  const stored = (
    await f.pool.query(
      "SELECT code,name,normal_side FROM accounts WHERE id=$1",
      [child.id],
    )
  ).rows[0]!;
  assert.deepEqual(stored, {
    code: child.code,
    name: child.name,
    normal_side: child.normalSide,
  });
  assert.equal(
    (await auditFor(f, c.id, child.id, "code", child.code)).after_value.name,
    child.name,
  );
  for (const overrides of [
    { parentId: child.id },
    { parentId: foreign.id },
    { category: "liability" },
    { kind: "posting", rangeStart: "1000000010", rangeEnd: "1000000020" },
  ]) {
    const response = await f.owner.request(
      "POST",
      `/companies/${c.id}/accounts`,
      {
        code: "1000000002",
        name: "Invalid",
        kind: "posting",
        category: "asset",
        normalSide: "debit",
        parentId: parent.id,
        ...overrides,
      },
    );
    assert([400, 409].includes(response.status), JSON.stringify(response));
  }
  for (const immutable of [
    { code: "1000000009" },
    { parentId: null },
    { kind: "group" },
    { category: "expense" },
    { normalSide: "debit" },
    { rangeStart: "1000000010", rangeEnd: "1000000020" },
  ])
    assert.equal(
      (
        await f.owner.request(
          "PATCH",
          `/companies/${c.id}/accounts/${child.id}`,
          immutable,
        )
      ).status,
      400,
    );
  assert.equal(
    (
      await f.owner.request(
        "PATCH",
        `/companies/${c.id}/accounts/${parent.id}`,
        { active: false },
      )
    ).status,
    409,
  );
  const renamed = (
    await f.owner.ok<{ account: Account }>(
      "PATCH",
      `/companies/${c.id}/accounts/${child.id}`,
      { name: " Updated cash ", active: false },
    )
  ).account;
  assert.equal(renamed.name, "Updated cash");
  const event = await auditFor(f, c.id, child.id, "name", renamed.name);
  assert.equal(event.before_value?.name, "Cash");
  assert.equal(event.after_value.active, false);
  await f.owner.ok("PATCH", `/companies/${c.id}/accounts/${parent.id}`, {
    active: false,
  });
  assert.equal(
    (
      await f.owner.request(
        "PATCH",
        `/companies/${c.id}/accounts/${child.id}`,
        { active: true },
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await f.owner.request("POST", `/companies/${c.id}/accounts`, {
        code: "1000000003",
        name: "Inactive parent",
        kind: "posting",
        category: "asset",
        normalSide: "debit",
        parentId: parent.id,
      })
    ).status,
    409,
  );
  await f.owner.ok("PATCH", `/companies/${c.id}/accounts/${parent.id}`, {
    active: true,
  });
  await f.owner.ok("PATCH", `/companies/${c.id}/accounts/${child.id}`, {
    active: true,
  });
  assert.equal(
    (
      await f.owner.request(
        "GET",
        `/companies/${foreignCompany.id}/accounts/${child.id}`,
      )
    ).status,
    404,
  );
});

test("automatic account codes cross 999 using strings, skip archived identities and serialize exhaustion", async (t) => {
  const f = await fixture(t),
    c = await f.company();
  const parent = await account(f, c.id, {
    code: "1120000000",
    rangeStart: "1120000001",
    rangeEnd: "1120001002",
  });
  await account(f, c.id, {
    code: "۱۱۲۰۰۰۰۹۹۹",
    name: "Archived 999",
    parentId: parent.id,
    kind: "posting",
  });
  const prior = (
    await f.owner.ok<Page<Account>>(
      "GET",
      `/companies/${c.id}/accounts?q=1120000999`,
    )
  ).items[0]!;
  await f.owner.ok("PATCH", `/companies/${c.id}/accounts/${prior.id}`, {
    active: false,
  });
  const body = {
    name: "Auto account",
    parentId: parent.id,
    kind: "posting",
    category: "asset",
    normalSide: "debit",
  };
  const next = (
    await f.owner.ok<{ account: Account }>(
      "POST",
      `/companies/${c.id}/accounts`,
      body,
      201,
    )
  ).account;
  assert.equal(next.code, "1120001000");
  assert.equal(next.code.length, 10);
  const responses = await blockedOperations(
    f,
    c.id,
    Array.from(
      { length: 3 },
      () => () =>
        f.owner.request<{ account: Account }>(
          "POST",
          `/companies/${c.id}/accounts`,
          body,
        ),
    ),
  );
  assert.deepEqual(
    responses.map((result) => result.status).sort(),
    [201, 201, 409],
  );
  const records = (
    await f.pool.query<{ code: string }>(
      "SELECT code FROM accounts WHERE parent_id=$1 ORDER BY code",
      [parent.id],
    )
  ).rows.map((row) => row.code);
  assert.deepEqual(records, [
    "1120000999",
    "1120001000",
    "1120001001",
    "1120001002",
  ]);
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::int AS count FROM audit_events WHERE company_id=$1 AND after_value->>'parentId'=$2",
        [c.id, String(parent.id)],
      )
    ).rows[0]?.count,
    5,
    "Four creations and the archived identity update must be audited; failed allocation must add none",
  );
  assert.equal(
    (await f.owner.request("POST", `/companies/${c.id}/accounts`, body)).status,
    409,
  );
  const noRange = await account(f, c.id, { code: "2000000000" });
  assert.equal(
    (
      await f.owner.request("POST", `/companies/${c.id}/accounts`, {
        ...body,
        parentId: noRange.id,
      })
    ).status,
    400,
  );
});

test("system account links require matching active posting accounts and preserve linked account activation", async (t) => {
  const f = await fixture(t),
    c = await f.company(),
    other = await f.company("Other");
  const group = await account(f, c.id, {
    category: "income",
    normalSide: "credit",
    code: "4000000000",
  });
  const valid = await account(f, c.id, {
    code: "4000000001",
    parentId: group.id,
    kind: "posting",
    category: "income",
    normalSide: "credit",
  });
  const wrong = await account(f, c.id, {
    code: "5000000001",
    parentId: null,
    kind: "posting",
    category: "expense",
  });
  const foreign = await account(f, other.id, {
    code: "4000000001",
    kind: "posting",
    category: "income",
    normalSide: "credit",
  });
  const endpoint = `/companies/${c.id}/account-links/salesRevenue`;
  const initial = await f.owner.ok<{ items: AccountLink[] }>(
    "GET",
    `/companies/${c.id}/account-links`,
  );
  assert.equal(initial.items.length, 8);
  assert(initial.items.every((link) => link.accountId === null));
  for (const invalid of [group.id, wrong.id, foreign.id])
    assert(
      [400, 409].includes(
        (await f.owner.request("PUT", endpoint, { accountId: invalid })).status,
      ),
    );
  const linked = await f.owner.ok<{ link: AccountLink }>("PUT", endpoint, {
    accountId: valid.id,
  });
  assert.equal(linked.link.accountId, valid.id);
  assert.equal(
    (
      await f.owner.request(
        "PATCH",
        `/companies/${c.id}/accounts/${valid.id}`,
        { active: false },
      )
    ).status,
    409,
  );
  const unlinked = await f.owner.ok<{ link: AccountLink }>("PUT", endpoint, {
    accountId: null,
  });
  assert.equal(unlinked.link.accountId, null);
  await f.owner.ok("PATCH", `/companies/${c.id}/accounts/${valid.id}`, {
    active: false,
  });
  assert.equal(
    (await f.owner.request("PUT", endpoint, { accountId: valid.id })).status,
    409,
  );
});

test("currency precision and base identity are protected and initialization creates no artificial rates", async (t) => {
  const f = await fixture(t),
    c = await f.company(),
    other = await f.company("Foreign");
  assert.equal(
    (
      await f.owner.ok<{ settings: FinanceSettings | null }>(
        "GET",
        `/companies/${c.id}/finance-settings`,
      )
    ).settings,
    null,
  );
  const settings = (
    await f.owner.ok<{ settings: FinanceSettings }>(
      "POST",
      `/companies/${c.id}/currencies/initialize`,
      { baseCurrency: "YER" },
      201,
    )
  ).settings;
  const currencies = await f.owner.ok<Page<CompanyCurrency>>(
    "GET",
    `/companies/${c.id}/currencies?sort=code:asc`,
  );
  assert.deepEqual(
    currencies.items.map((item) => [item.code, item.decimalPlaces]),
    [
      ["SAR", 2],
      ["USD", 2],
      ["YER", 2],
    ],
  );
  const base = currencies.items.find((item) => item.code === "YER")!;
  assert.equal(settings.baseCurrencyId, base.id);
  assert.equal(
    (
      await f.owner.ok<Page<ExchangeRate>>(
        "GET",
        `/companies/${c.id}/exchange-rates`,
      )
    ).total,
    0,
  );
  const before = await snapshot(f, c.id);
  assert.equal(
    (
      await f.owner.request(
        "POST",
        `/companies/${c.id}/currencies/initialize`,
        { baseCurrency: "USD" },
      )
    ).status,
    409,
  );
  assert.deepEqual(await snapshot(f, c.id), before);
  assert.equal(
    (
      await f.owner.request(
        "PATCH",
        `/companies/${c.id}/currencies/${base.id}`,
        { active: false },
      )
    ).status,
    409,
  );
  for (const decimalPlaces of [-1, 7, 1.5, "2"])
    assert.equal(
      (
        await f.owner.request("POST", `/companies/${c.id}/currencies`, {
          code: "GBP",
          name: "Pound",
          decimalPlaces,
        })
      ).status,
      400,
    );
  const custom = await currency(f, c.id, {
    code: " gbp ",
    name: " Pound ",
    decimalPlaces: 6,
  });
  assert.equal(custom.code, "GBP");
  assert.equal(custom.name, "Pound");
  assert.equal(custom.decimalPlaces, 6);
  for (const body of [{ code: "EUR" }, { decimalPlaces: 5 }])
    assert.equal(
      (
        await f.owner.request(
          "PATCH",
          `/companies/${c.id}/currencies/${custom.id}`,
          body,
        )
      ).status,
      400,
    );
  const foreign = await currency(f, other.id);
  assert(
    [400, 409].includes(
      (
        await f.owner.request("PATCH", `/companies/${c.id}/finance-settings`, {
          baseCurrencyId: foreign.id,
        })
      ).status,
    ),
  );
  const changed = (
    await f.owner.ok<{ settings: FinanceSettings }>(
      "PATCH",
      `/companies/${c.id}/finance-settings`,
      { baseCurrencyId: custom.id },
    )
  ).settings;
  assert.equal(changed.baseCurrencyId, custom.id);
  assert.equal(
    (
      await f.pool.query(
        "SELECT base_currency_id FROM finance_settings WHERE company_id=$1",
        [c.id],
      )
    ).rows[0]?.base_currency_id,
    custom.id,
  );
});

test("currency initialization preserves existing identities and precision while first base settings accept a custom currency", async (t) => {
  const f = await fixture(t),
    c = await f.company(),
    customCompany = await f.company("Custom base");
  const existing = await currency(f, c.id, {
    code: "USD",
    name: "Existing dollar",
    decimalPlaces: 4,
  });
  const custom = await currency(f, c.id, {
    code: "GBP",
    name: "Custom pound",
    decimalPlaces: 6,
  });
  const initialized = await f.owner.ok<{ settings: FinanceSettings }>(
    "POST",
    `/companies/${c.id}/currencies/initialize`,
    {},
    201,
  );
  assert.equal(
    initialized.settings.baseCurrencyCode,
    "YER",
    "The confirmed default base is YER",
  );
  const items = (
    await f.owner.ok<Page<CompanyCurrency>>(
      "GET",
      `/companies/${c.id}/currencies?sort=code:asc`,
    )
  ).items;
  assert.deepEqual(
    items.map((item) => item.code),
    ["GBP", "SAR", "USD", "YER"],
  );
  assert.deepEqual(
    items.find((item) => item.code === "USD"),
    existing,
  );
  assert.deepEqual(
    items.find((item) => item.code === "GBP"),
    custom,
  );
  assert.equal(
    (
      await f.owner.ok<Page<ExchangeRate>>(
        "GET",
        `/companies/${c.id}/exchange-rates`,
      )
    ).total,
    0,
  );
  const before = await snapshot(f, c.id);
  assert.equal(
    (
      await f.owner.request(
        "POST",
        `/companies/${c.id}/currencies/initialize`,
        {},
      )
    ).status,
    409,
  );
  assert.deepEqual(await snapshot(f, c.id), before);

  const npr = await currency(f, customCompany.id, {
    code: "NPR",
    name: "Nepalese rupee",
    decimalPlaces: 3,
  });
  assert.equal(
    (
      await f.owner.ok<{ settings: FinanceSettings | null }>(
        "GET",
        `/companies/${customCompany.id}/finance-settings`,
      )
    ).settings,
    null,
  );
  const first = await f.owner.ok<{ settings: FinanceSettings }>(
    "PATCH",
    `/companies/${customCompany.id}/finance-settings`,
    { baseCurrencyId: npr.id },
  );
  assert.equal(first.settings.baseCurrencyId, npr.id);
  assert.equal(first.settings.baseCurrencyCode, "NPR");
  const audit = await auditFor(
    f,
    customCompany.id,
    customCompany.id,
    "baseCurrencyId",
    npr.id,
  );
  assert.equal(audit.before_value, null);
  assert.equal(audit.after_value.baseCurrencyId, npr.id);
});

test("exchange rates retain exact normalized NUMERIC and audit values and reject imprecise or coercible inputs", async (t) => {
  const f = await fixture(t),
    c = await f.company();
  await f.owner.ok(
    "POST",
    `/companies/${c.id}/currencies/initialize`,
    { baseCurrency: "YER" },
    201,
  );
  const currencies = (
    await f.owner.ok<Page<CompanyCurrency>>(
      "GET",
      `/companies/${c.id}/currencies`,
    )
  ).items;
  const usd = currencies.find((item) => item.code === "USD")!,
    yer = currencies.find((item) => item.code === "YER")!;
  const created = await rate(
    f,
    c.id,
    usd.id,
    "2026-01-01T02:00:00+02:00",
    "٠٠١٢٣٫٤٥٠٠٠٠٠٠٠٠٠٠",
  );
  assert.equal(created.rate, "123.45");
  assert.equal(created.source, "Manual test quote");
  assert.equal(created.effectiveAt, "2026-01-01T00:00:00.000Z");
  const actual = (
    await f.pool.query<{ rate: string; effective_at: Date; source: string }>(
      "SELECT rate::text,effective_at,source FROM exchange_rates WHERE id=$1",
      [created.id],
    )
  ).rows[0]!;
  assert.equal(actual.rate, "123.450000000000");
  assert.equal(actual.effective_at.toISOString(), created.effectiveAt);
  const event = await auditFor(f, c.id, created.id, "rate", created.rate);
  assert.equal(event.after_value.rate, created.rate);
  assert.equal(event.after_value.effectiveAt, created.effectiveAt);
  const persian = await rate(
    f,
    c.id,
    usd.id,
    "2026-01-02T00:00:00Z",
    "۰۰۰۲۵۰٫۱۲۳۴۵۶۷۸۹۰۱۲",
  );
  assert.equal(persian.rate, "250.123456789012");
  assert.equal(
    (
      await f.pool.query("SELECT rate::text FROM exchange_rates WHERE id=$1", [
        persian.id,
      ])
    ).rows[0]?.rate,
    persian.rate,
  );
  assert.equal(
    (await auditFor(f, c.id, persian.id, "rate", persian.rate)).after_value
      .rate,
    persian.rate,
  );
  const large = await rate(
    f,
    c.id,
    usd.id,
    "2026-02-01T00:00:00.123Z",
    "9999999999999999.123456789012",
  );
  assert.equal(large.rate, "9999999999999999.123456789012");
  assert.equal(large.effectiveAt, "2026-02-01T00:00:00.123Z");
  const millisecondAt = (
    await f.pool.query<{ effective_at: Date }>(
      "SELECT effective_at FROM exchange_rates WHERE id=$1",
      [large.id],
    )
  ).rows[0]!.effective_at;
  assert.equal(millisecondAt.toISOString(), large.effectiveAt);
  assert.equal(
    (await auditFor(f, c.id, large.id, "rate", large.rate)).after_value
      .effectiveAt,
    large.effectiveAt,
  );
  const effectiveAtMillisecond = await f.owner.ok<{
    rate: string | null;
    at: string;
    exchangeRateId: number | null;
  }>(
    "GET",
    `/companies/${c.id}/exchange-rates/effective?currencyId=${usd.id}&at=${encodeURIComponent(large.effectiveAt)}`,
  );
  assert.equal(effectiveAtMillisecond.at, large.effectiveAt);
  assert.equal(effectiveAtMillisecond.exchangeRateId, large.id);
  assert.equal(effectiveAtMillisecond.rate, large.rate);
  assert.equal(
    (
      await f.pool.query("SELECT rate::text FROM exchange_rates WHERE id=$1", [
        large.id,
      ])
    ).rows[0]?.rate,
    large.rate,
  );
  const before = await snapshot(f, c.id);
  for (const invalid of [
    0,
    1.25,
    "0",
    "-1",
    "+2",
    "1e3",
    "NaN",
    "Infinity",
    "10000000000000000",
    "0.1234567890123",
    "1,000",
  ])
    assert.equal(
      (
        await f.owner.request("POST", `/companies/${c.id}/exchange-rates`, {
          currencyId: usd.id,
          rate: invalid,
          effectiveAt: "2026-03-01T00:00:00Z",
          source: "Manual",
        })
      ).status,
      400,
      `Rejected rate ${String(invalid)}`,
    );
  assert.equal(
    (
      await f.owner.request("POST", `/companies/${c.id}/exchange-rates`, {
        currencyId: yer.id,
        rate: "1",
        effectiveAt: "2026-03-01T00:00:00Z",
        source: "Manual",
      })
    ).status,
    400,
  );
  for (const effectiveAt of [
    "0000-01-01T00:00:00Z",
    "2026-02-30T00:00:00Z",
    "2026-01-01T00:00:00",
    "2026-03-01T00:00:00.123456Z",
  ]) {
    assert.equal(
      (
        await f.owner.request("POST", `/companies/${c.id}/exchange-rates`, {
          currencyId: usd.id,
          rate: "1",
          effectiveAt,
          source: "Manual",
        })
      ).status,
      400,
      `Invalid effective UTC time ${effectiveAt}`,
    );
    assert.equal(
      (
        await f.owner.request(
          "GET",
          `/companies/${c.id}/exchange-rates/effective?currencyId=${usd.id}&at=${encodeURIComponent(effectiveAt)}`,
        )
      ).status,
      400,
      `Invalid effective query time ${effectiveAt}`,
    );
  }
  assert.equal(
    (
      await f.owner.request("POST", `/companies/${c.id}/exchange-rates`, {
        currencyId: usd.id,
        rate: "1",
        effectiveAt: "2026-03-01T00:00:00Z",
        source: " ",
      })
    ).status,
    400,
  );
  assert.deepEqual(
    await snapshot(f, c.id),
    before,
    "Rejected numeric inputs must produce no records or audit events",
  );
});

test("effective rate chooses the latest active past record, preserves history and locks the base currency", async (t) => {
  const f = await fixture(t),
    c = await f.company();
  await f.owner.ok(
    "POST",
    `/companies/${c.id}/currencies/initialize`,
    { baseCurrency: "YER" },
    201,
  );
  const currencies = (
    await f.owner.ok<Page<CompanyCurrency>>(
      "GET",
      `/companies/${c.id}/currencies`,
    )
  ).items;
  const usd = currencies.find((item) => item.code === "USD")!,
    yer = currencies.find((item) => item.code === "YER")!,
    sar = currencies.find((item) => item.code === "SAR")!;
  const first = await rate(f, c.id, usd.id, "2026-01-01T00:00:00Z", "250.000");
  const second = await rate(f, c.id, usd.id, "2026-02-01T00:00:00Z", "275");
  const future = await rate(f, c.id, usd.id, "2030-01-01T00:00:00Z", "999");
  type Effective = {
    currencyId: number;
    baseCurrencyId: number;
    rate: string | null;
    exchangeRateId: number | null;
    at: string;
  };
  async function effective(currencyId: number, at: string) {
    return f.owner.ok<Effective>(
      "GET",
      `/companies/${c.id}/exchange-rates/effective?currencyId=${currencyId}&at=${encodeURIComponent(at)}`,
    );
  }
  assert.equal((await effective(usd.id, "2025-12-31T23:59:59Z")).rate, null);
  const atFirst = await effective(usd.id, "2026-01-01T00:00:00Z");
  assert.equal(atFirst.exchangeRateId, first.id);
  assert.equal(atFirst.rate, "250");
  assert.equal(atFirst.baseCurrencyId, yer.id);
  assert.equal(
    (await effective(usd.id, "2026-02-01T00:00:00Z")).exchangeRateId,
    second.id,
  );
  assert.equal(
    (await effective(usd.id, "2030-01-01T00:00:00Z")).exchangeRateId,
    future.id,
  );
  await f.owner.ok("PATCH", `/companies/${c.id}/exchange-rates/${second.id}`, {
    active: false,
  });
  assert.equal(
    (await effective(usd.id, "2029-12-31T00:00:00Z")).exchangeRateId,
    first.id,
  );
  const base = await effective(yer.id, "2026-01-01T00:00:00Z");
  assert.equal(base.rate, "1");
  assert.equal(base.exchangeRateId, null);
  assert.equal((await effective(sar.id, "2026-01-01T00:00:00Z")).rate, null);
  for (const immutable of [
    { rate: "1" },
    { effectiveAt: "2026-03-01T00:00:00Z" },
    { currencyId: sar.id },
    { source: "Corrected" },
  ])
    assert.equal(
      (
        await f.owner.request(
          "PATCH",
          `/companies/${c.id}/exchange-rates/${second.id}`,
          immutable,
        )
      ).status,
      400,
    );
  const records = (
    await f.pool.query(
      "SELECT id,rate::text,active FROM exchange_rates WHERE company_id=$1 ORDER BY effective_at",
      [c.id],
    )
  ).rows;
  assert.deepEqual(records, [
    { id: first.id, rate: "250.000000000000", active: true },
    { id: second.id, rate: "275.000000000000", active: false },
    { id: future.id, rate: "999.000000000000", active: true },
  ]);
  assert.equal(
    (
      await f.owner.request("PATCH", `/companies/${c.id}/finance-settings`, {
        baseCurrencyId: sar.id,
      })
    ).status,
    409,
  );
  for (const record of [first, future])
    await f.owner.ok(
      "PATCH",
      `/companies/${c.id}/exchange-rates/${record.id}`,
      { active: false },
    );
  assert.equal(
    (
      await f.owner.request("PATCH", `/companies/${c.id}/finance-settings`, {
        baseCurrencyId: sar.id,
      })
    ).status,
    409,
    "Inactive historical rates still bind their original base currency",
  );
});

test("branch creation yields one showroom and branch activation controls effective locations without rewriting their flags", async (t) => {
  const f = await fixture(t),
    c = await f.company(),
    other = await f.company("Foreign");
  const first = await branch(f, c.id),
    second = await branch(f, c.id, "SECOND"),
    foreign = await branch(f, other.id);
  const showrooms = (
    await f.owner.ok<Page<Location>>(
      "GET",
      `/companies/${c.id}/locations?branchId=${first.id}`,
    )
  ).items;
  assert.equal(showrooms.length, 1);
  assert.equal(showrooms[0]?.code, "SHOWROOM");
  assert.equal(showrooms[0]?.kind, "showroom");
  const create = async (branchId: number, code: string, kind = "warehouse") =>
    f.owner.request<{ location: Location }>(
      "POST",
      `/companies/${c.id}/locations`,
      { branchId, code, kind, name: " Warehouse " },
    );
  assert.equal((await create(first.id, "SHOWROOM_2", "showroom")).status, 409);
  const one = await create(first.id, "STORE"),
    two = await create(second.id, "STORE");
  assert.equal(one.status, 201);
  assert.equal(two.status, 201);
  assert.notEqual(one.body.location.id, two.body.location.id);
  assert.equal((await create(first.id, "STORE")).status, 409);
  assert([400, 409].includes((await create(foreign.id, "FOREIGN")).status));
  const location = one.body.location;
  assert.equal(location.name, "Warehouse");
  assert.equal(
    (
      await f.owner.request(
        "PATCH",
        `/companies/${c.id}/locations/${location.id}`,
        { branchId: second.id },
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.owner.request(
        "PATCH",
        `/companies/${c.id}/locations/${location.id}`,
        { code: "NEW" },
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.owner.request(
        "PATCH",
        `/companies/${c.id}/locations/${location.id}`,
        { kind: "showroom" },
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.owner.request(
        "PATCH",
        `/companies/${c.id}/branches/${first.id}`,
        { code: "NEW" },
      )
    ).status,
    400,
  );
  await f.owner.ok(
    "PATCH",
    `/companies/${c.id}/locations/${showrooms[0]!.id}`,
    { active: false },
  );
  await f.owner.ok("PATCH", `/companies/${c.id}/branches/${first.id}`, {
    active: false,
    name: " Closed branch ",
    phone: "+٩٦٧ ٧٧٧-١٢٣",
    address: " Address ",
  });
  const closed = (
    await f.owner.ok<{ location: Location }>(
      "GET",
      `/companies/${c.id}/locations/${location.id}`,
    )
  ).location;
  assert.equal(closed.active, true);
  assert.equal(closed.branchActive, false);
  assert.equal(closed.effectiveActive, false);
  assert.equal((await create(first.id, "NEW")).status, 409);
  await f.owner.ok("PATCH", `/companies/${c.id}/locations/${location.id}`, {
    active: false,
  });
  assert.equal(
    (
      await f.owner.request(
        "PATCH",
        `/companies/${c.id}/locations/${location.id}`,
        { active: true },
      )
    ).status,
    409,
  );
  await f.owner.ok("PATCH", `/companies/${c.id}/branches/${first.id}`, {
    active: true,
  });
  const reopened = (
    await f.owner.ok<Page<Location>>(
      "GET",
      `/companies/${c.id}/locations?branchId=${first.id}`,
    )
  ).items;
  assert(
    reopened.every(
      (item) => !item.active && !item.effectiveActive && item.branchActive,
    ),
  );
  const saved = (
    await f.pool.query("SELECT name,phone,address FROM branches WHERE id=$1", [
      first.id,
    ])
  ).rows[0]!;
  assert.deepEqual(saved, {
    name: "Closed branch",
    phone: "+967777123",
    address: "Address",
  });
  await f.owner.ok("PATCH", `/companies/${c.id}/branches/${first.id}`, {
    active: false,
  });
  const renamedWhileClosed = (
    await f.owner.ok<{ branch: Branch }>(
      "PATCH",
      `/companies/${c.id}/branches/${first.id}`,
      { name: " Renamed closed branch " },
    )
  ).branch;
  assert.equal(
    renamedWhileClosed.active,
    false,
    "A name-only patch must preserve inactive state",
  );
  assert.equal(
    renamedWhileClosed.phone,
    saved.phone,
    "A name-only patch must preserve contacts",
  );
  assert.equal(renamedWhileClosed.address, saved.address);
  const audit = await auditFor(f, c.id, first.id, "name", "Closed branch");
  assert.equal(audit.after_value.phone, saved.phone);
  assert.equal(audit.after_value.address, saved.address);
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::int AS count FROM locations WHERE branch_id=$1 AND kind='showroom'",
        [first.id],
      )
    ).rows[0]?.count,
    1,
  );
});

test("branch and location codes normalize uppercase digits and archived codes remain reserved", async (t) => {
  const f = await fixture(t),
    c = await f.company();
  const created = await branch(f, c.id, " main-١ ");
  assert.equal(created.code, "MAIN-1");
  const warehouse = (
    await f.owner.ok<{ location: Location }>(
      "POST",
      `/companies/${c.id}/locations`,
      {
        branchId: created.id,
        code: " store_۲ ",
        name: "Warehouse",
        kind: "warehouse",
      },
      201,
    )
  ).location;
  assert.equal(warehouse.code, "STORE_2");
  await f.owner.ok("PATCH", `/companies/${c.id}/locations/${warehouse.id}`, {
    active: false,
  });
  assert.equal(
    (
      await f.owner.request("POST", `/companies/${c.id}/locations`, {
        branchId: created.id,
        code: "store_2",
        name: "Replacement",
        kind: "warehouse",
      })
    ).status,
    409,
  );
  await f.owner.ok("PATCH", `/companies/${c.id}/branches/${created.id}`, {
    active: false,
  });
  assert.equal(
    (
      await f.owner.request("POST", `/companies/${c.id}/branches`, {
        code: "main-1",
        name: "Replacement",
        phone: "",
        address: "",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.owner.ok<{ branch: Branch }>(
        "GET",
        `/companies/${c.id}/branches/${created.id}`,
      )
    ).branch.code,
    "MAIN-1",
  );
  assert.equal(
    (
      await f.owner.ok<{ location: Location }>(
        "GET",
        `/companies/${c.id}/locations/${warehouse.id}`,
      )
    ).location.code,
    "STORE_2",
  );
});

test("account/currency initialization and branch-with-showroom creation roll back their complete state on audit failure", async (t) => {
  const f = await fixture(t),
    c = await f.company();
  for (const [path, body] of [
    ["accounts/initialize", {}],
    ["currencies/initialize", { baseCurrency: "YER" }],
    [
      "branches",
      { code: "FAIL", name: "Should roll back", phone: "", address: "" },
    ],
  ] as const) {
    const before = await snapshot(f, c.id);
    await rejectAudit(f, async () => {
      assert.equal(
        (await f.owner.request("POST", `/companies/${c.id}/${path}`, body))
          .status,
        500,
      );
    });
    assert.deepEqual(
      await snapshot(f, c.id),
      before,
      `Audit failure left partial ${path} records`,
    );
  }
  const initialization = await f.owner.ok<{ created: number }>(
    "POST",
    `/companies/${c.id}/accounts/initialize`,
    {},
    201,
  );
  assert(initialization.created >= 10);
  const initialized = await snapshot(f, c.id);
  assert.equal(
    (
      await f.owner.request(
        "POST",
        `/companies/${c.id}/accounts/initialize`,
        {},
      )
    ).status,
    409,
  );
  assert.deepEqual(await snapshot(f, c.id), initialized);
  const stored = (
    await f.pool.query(
      "SELECT code,kind,parent_id FROM accounts WHERE company_id=$1",
      [c.id],
    )
  ).rows;
  assert.equal(stored.length, initialization.created);
  assert(stored.every((row) => /^\d{10}$/.test(row.code as string)));
  const cash = stored.find(
    (row) => row.parent_id !== null && row.kind === "posting",
  )!;
  const before = await snapshot(f, c.id);
  await rejectAudit(f, async () => {
    assert.equal(
      (
        await f.owner.request(
          "PATCH",
          `/companies/${c.id}/accounts/${String((await f.pool.query("SELECT id FROM accounts WHERE code=$1 AND company_id=$2", [cash.code, c.id])).rows[0]!.id)}`,
          { name: "Rollback rename" },
        )
      ).status,
      500,
    );
  });
  assert.deepEqual(await snapshot(f, c.id), before);
});

test("composite database foreign keys reject every cross-company master reference even below the HTTP layer", async (t) => {
  const f = await fixture(t),
    a = await f.company("A"),
    b = await f.company("B");
  const aGroup = await account(f, a.id),
    bGroup = await account(f, b.id);
  const aPosting = await account(f, a.id, {
    code: "1000000001",
    kind: "posting",
    parentId: aGroup.id,
  });
  const bPosting = await account(f, b.id, {
    code: "1000000001",
    kind: "posting",
    parentId: bGroup.id,
  });
  const aCurrency = await currency(f, a.id),
    bCurrency = await currency(f, b.id);
  await f.owner.ok("PATCH", `/companies/${a.id}/finance-settings`, {
    baseCurrencyId: aCurrency.id,
  });
  // B has no rate or document history, so a foreign base reference reaches
  // the composite FK rather than being rejected earlier by a history guard.
  await f.owner.ok("PATCH", `/companies/${b.id}/finance-settings`, {
    baseCurrencyId: bCurrency.id,
  });
  const foreignCurrency = await currency(f, a.id, { code: "USD" });
  const quote = await rate(f, a.id, foreignCurrency.id, "2026-01-01T00:00:00Z");
  const aBranch = await branch(f, a.id),
    bBranch = await branch(f, b.id);
  const location = (
    await f.owner.ok<Page<Location>>(
      "GET",
      `/companies/${a.id}/locations?branchId=${aBranch.id}`,
    )
  ).items[0]!;
  await f.owner.ok("PUT", `/companies/${a.id}/account-links/inventory`, {
    accountId: aPosting.id,
  });
  const operations = [
    ["UPDATE accounts SET parent_id=$1 WHERE id=$2", [bGroup.id, aPosting.id]],
    [
      "UPDATE account_links SET account_id=$1 WHERE company_id=$2 AND purpose='inventory'",
      [bPosting.id, a.id],
    ],
    [
      "UPDATE finance_settings SET base_currency_id=$1 WHERE company_id=$2",
      [aCurrency.id, b.id],
    ],
    [
      "UPDATE exchange_rates SET currency_id=$1 WHERE id=$2",
      [bCurrency.id, quote.id],
    ],
    [
      "UPDATE exchange_rates SET base_currency_id=$1 WHERE id=$2",
      [bCurrency.id, quote.id],
    ],
    [
      "UPDATE locations SET branch_id=$1 WHERE id=$2",
      [bBranch.id, location.id],
    ],
  ] as const;
  const before = await snapshot(f, a.id);
  const otherBefore = await snapshot(f, b.id);
  for (const [resource, recordId, body] of [
    ["accounts", aPosting.id, { name: "Foreign rename" }],
    ["currencies", aCurrency.id, { name: "Foreign rename" }],
    ["exchange-rates", quote.id, { active: false }],
    ["branches", aBranch.id, { name: "Foreign rename" }],
    ["locations", location.id, { name: "Foreign rename" }],
  ] as const) {
    assert.equal(
      (
        await f.owner.request(
          "GET",
          `/companies/${b.id}/${resource}/${recordId}`,
        )
      ).status,
      404,
      `Read foreign ${resource}`,
    );
    assert.equal(
      (
        await f.owner.request(
          "PATCH",
          `/companies/${b.id}/${resource}/${recordId}`,
          body,
        )
      ).status,
      404,
      `Edit foreign ${resource}`,
    );
  }
  const rejectedCurrency = await f.owner.request<{ error: { code: string } }>(
    "POST",
    `/companies/${a.id}/exchange-rates`,
    {
      currencyId: bCurrency.id,
      rate: "1.25",
      effectiveAt: "2026-02-01T00:00:00Z",
      source: "Foreign quote",
    },
  );
  assert.equal(
    rejectedCurrency.status,
    409,
    "A foreign currency must not enter the company's exchange history",
  );
  assert.equal(rejectedCurrency.body.error.code, "conflict");
  for (const [sql, values] of operations)
    await assert.rejects(
      f.pool.query(sql, [...values]),
      (error: unknown) =>
        Boolean(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "23503",
        ),
      sql,
    );
  assert.deepEqual(await snapshot(f, a.id), before);
  assert.deepEqual(await snapshot(f, b.id), otherBefore);
});

test("master lists paginate and combine server filters deterministically without crossing companies", async (t) => {
  const f = await fixture(t),
    c = await f.company(),
    other = await f.company("Other");
  const parent = await account(f, c.id);
  const accounts: Account[] = [];
  for (let index = 1; index <= 25; index++)
    accounts.push(
      await account(f, c.id, {
        code: String(1000000000 + index),
        name: `Cash ${String(index).padStart(2, "0")}`,
        kind: "posting",
        parentId: parent.id,
      }),
    );
  await account(f, other.id, {
    code: "1000000001",
    name: "Cash foreign",
    kind: "posting",
  });
  await f.owner.ok("PATCH", `/companies/${c.id}/accounts/${accounts[0]!.id}`, {
    active: false,
  });
  const filtered = await f.owner.ok<Page<Account>>(
    "GET",
    `/companies/${c.id}/accounts?q=Cash&parentId=${parent.id}&kind=posting&category=asset&active=true&page=2&pageSize=10&sort=name:desc,code:asc`,
  );
  assert.equal(filtered.total, 24);
  assert.equal(filtered.page, 2);
  assert.equal(filtered.pageSize, 10);
  assert.deepEqual(
    filtered.items.map((item) => item.id),
    accounts
      .slice(5, 15)
      .reverse()
      .map((item) => item.id),
  );
  const selectedBranch = await branch(f, c.id),
    anotherBranch = await branch(f, c.id, "SECOND");
  await f.owner.ok(
    "POST",
    `/companies/${c.id}/locations`,
    {
      branchId: selectedBranch.id,
      code: "STORE",
      name: "Store",
      kind: "warehouse",
    },
    201,
  );
  await f.owner.ok(
    "POST",
    `/companies/${c.id}/locations`,
    {
      branchId: anotherBranch.id,
      code: "STORE",
      name: "Store",
      kind: "warehouse",
    },
    201,
  );
  const locations = await f.owner.ok<Page<Location>>(
    "GET",
    `/companies/${c.id}/locations?branchId=${selectedBranch.id}&kind=warehouse&active=true`,
  );
  assert.equal(locations.total, 1);
  assert.equal(locations.items[0]?.branchId, selectedBranch.id);
  for (const invalid of [
    "page=0",
    "pageSize=101",
    "sort=password:asc",
    "active=maybe",
    "parentId=-1",
    "kind=unsupported",
    "category=unsupported",
  ])
    assert.equal(
      (await f.owner.request("GET", `/companies/${c.id}/accounts?${invalid}`))
        .status,
      400,
      invalid,
    );
});

test("account card choice labels retain exact order and support create, update, filtering and legacy accounts", async (t) => {
  const labels = accountChoices.map(choice => accountChoiceLabels[choice]);
  assert.deepEqual(labels, [
    "شركة", "عميل", "مصروف", "جملة", "موزع", "طبيب", "موظف",
    "الرهونات", "صندوق", "عهدة", "حافظة", "حساب اداري",
    "صندوق مشتريات", "صندوق", "صيدلية", "مؤرشف", "موقف", "متابعة",
  ]);
  assert.equal(new Set(accountChoices).size, 18);
  assert.equal(accountChoices[8], "cashbox");
  assert.equal(accountChoices[13], "cashboxSecond");

  const f = await fixture(t);
  const company = await f.company("Company account choices");
  const other = await f.company("Company other");
  const existing = await account(f, company.id);
  assert.equal(existing.accountChoice, null, "Legacy/unspecified accounts remain without choice");
  const chosen = await account(f, company.id, {
    code: "1000000998",
    name: "حساب صندوق",
    kind: "posting",
    accountChoice: "cashboxSecond",
  });
  assert.equal(chosen.accountChoice, "cashboxSecond");
  assert.equal(chosen.normalSide, existing.normalSide);
  assert.equal(chosen.category, existing.category);
  assert.equal(chosen.active, true);
  const detail = await f.owner.ok<{account: Account}>(
    "GET", `/companies/${company.id}/accounts/${chosen.id}`,
  );
  assert.equal(detail.account.accountChoice, "cashboxSecond");
  const filtered = await f.owner.ok<Page<Account>>(
    "GET", `/companies/${company.id}/accounts?accountChoice=cashboxSecond`,
  );
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0]?.id, chosen.id);
  assert.equal((await f.owner.ok<Page<Account>>(
    "GET", `/companies/${company.id}/accounts?accountChoice=cashbox`,
  )).total, 0);
  const updated = (await f.owner.ok<{account: Account}>(
    "PATCH", `/companies/${company.id}/accounts/${chosen.id}`,
    {accountChoice:"stopped"},
  )).account;
  assert.equal(updated.accountChoice,"stopped");
  assert.equal(updated.active,true, "The descriptive choice must not deactivate an account");
  const archived = (await f.owner.ok<{account: Account}>(
    "PATCH", `/companies/${company.id}/accounts/${chosen.id}`,
    {accountChoice:"archived"},
  )).account;
  assert.equal(archived.active,true, "Archived label is descriptive and not the active flag");
  const cleared = (await f.owner.ok<{account: Account}>(
    "PATCH", `/companies/${company.id}/accounts/${chosen.id}`,
    {accountChoice:null},
  )).account;
  assert.equal(cleared.accountChoice,null);
  for (const invalid of ["cashbox-third","nonexistent",1]) {
    assert.equal((await f.owner.request("PATCH",
      `/companies/${company.id}/accounts/${chosen.id}`,
      {accountChoice:invalid})).status, 400);
  }
  assert.equal((await f.owner.request("GET",
    `/companies/${company.id}/accounts?accountChoice=invalid`)).status, 400);
  const otherAccount = await account(f,other.id,{accountChoice:"cashboxSecond"});
  assert.equal(otherAccount.accountChoice, "cashboxSecond");
  assert.equal((await f.owner.ok<Page<Account>>("GET",
    `/companies/${company.id}/accounts?accountChoice=cashboxSecond`)).total,0);
  const reader = await f.member(company.id,["accounts.view"],21);
  assert.equal((await reader.client.ok<{account:Account}>(
    "GET",`/companies/${company.id}/accounts/${chosen.id}`)).account.accountChoice,null);
  assert.equal((await reader.client.request("PATCH",
    `/companies/${company.id}/accounts/${chosen.id}`,
    {accountChoice:"customer"})).status,403);
});
