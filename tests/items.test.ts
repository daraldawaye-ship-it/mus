import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import {
  convertItemQuantity,
  type Company,
  type CompanyCurrency,
  type Employee,
  type Item,
  type ItemAgent,
  type ItemComposition,
  type ItemCompositionPeers,
  type ItemShelf,
  arabicShelfLetters,
  type ItemConversion,
  type Page,
  type Permission,
  type SessionResponse,
} from "../packages/contracts/src/index.ts";

// These credentials exist only in disposable, isolated test schemas.
const password = "Items-only-test-passphrase-2026";
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
  const schema = `items_${randomUUID().replaceAll("-", "")}`;
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
    name: "Items test owner",
    displayName: "Items owner",
    email: "owner@items.test",
    password,
  });
  const owner = new Client(baseUrl);
  await owner.ok("POST", "/auth/login", { email: user.email, password });
  async function company(name = "Items test company") {
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
        name: "Item employee",
        displayName: "Employee",
        email: `employee-${index}@items.test`,
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

async function currency(
  f: Fixture,
  companyId: number,
  decimalPlaces = 2,
  code = "YER",
) {
  return (
    await f.owner.ok<{ currency: CompanyCurrency }>(
      "POST",
      `/companies/${companyId}/currencies`,
      {
        code,
        name: `Currency ${code}`,
        decimalPlaces,
      },
      201,
    )
  ).currency;
}

function itemBody(currencyId: number, overrides: Record<string, unknown> = {}) {
  return {
    name: "صنف الاختبار",
    englishName: "Test item",
    barcode: "",
    agentId: null,
    unit1Name: "باكت",
    unit2Name: "شريط",
    unit3Name: "حبة",
    factor2: 2,
    factor3: 12,
    salePrice1: "1000",
    salePrice2: "500",
    salePrice3: "50",
    purchasePrice: "800",
    purchaseFactor: 1,
    currencyId,
    reorderLimit: "0",
    orderQuantity: "0",
    searchKeys: "",
    purchaseNotes: "",
    orderStoppedUntil: null,
    hasExpiry: true,
    active: true,
    idempotencyKey: randomUUID(),
    ...overrides,
  };
}

function agentBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "وكيل الاختبار",
    phone: "",
    address: "",
    notes: "",
    active: true,
    idempotencyKey: randomUUID(),
    ...overrides,
  };
}

async function item(
  f: Fixture,
  companyId: number,
  currencyId: number,
  overrides: Record<string, unknown> = {},
) {
  return (
    await f.owner.ok<{ item: Item }>(
      "POST",
      `/companies/${companyId}/items`,
      itemBody(currencyId, overrides),
      201,
    )
  ).item;
}

async function agent(
  f: Fixture,
  companyId: number,
  overrides: Record<string, unknown> = {},
) {
  return (
    await f.owner.ok<{ agent: ItemAgent }>(
      "POST",
      `/companies/${companyId}/item-agents`,
      agentBody(overrides),
      201,
    )
  ).agent;
}

function patchItem(value: Item, overrides: Record<string, unknown> = {}) {
  const { idempotencyKey: _key, ...body } = itemBody(value.currencyId);
  for (const key of Object.keys(body)) {
    if (key in value)
      body[key as keyof typeof body] = value[key as keyof Item] as never;
  }
  return { ...body, revision: value.revision, ...overrides };
}

function patchAgent(value: ItemAgent, overrides: Record<string, unknown> = {}) {
  return {
    name: value.name,
    phone: value.phone,
    address: value.address,
    notes: value.notes,
    active: value.active,
    revision: value.revision,
    ...overrides,
  };
}

async function snapshot(f: Fixture, companyId: number) {
  const result: Record<string, unknown[]> = {};
  for (const table of ["items", "item_agents", "item_counters", "audit_events"])
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
    "CREATE FUNCTION reject_item_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test rejects item audit'; END $$",
  );
  await f.pool.query(
    "CREATE TRIGGER reject_item_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_item_audit()",
  );
  try {
    await run();
  } finally {
    await f.pool.query("DROP TRIGGER reject_item_audit ON audit_events");
    await f.pool.query("DROP FUNCTION reject_item_audit()");
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
      `Only ${waiting} of ${operations.length} writes reached the lock`,
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

test("item permissions isolate reading, management and company scope without granting currency management", async (t) => {
  const f = await fixture(t),
    c = await f.company(),
    other = await f.company("Other company");
  const curr = await currency(f, c.id),
    a = await agent(f, c.id);
  const reader = await f.member(c.id, ["items.view"]),
    writer = await f.member(c.id, ["items.manage"], 2);
  const outsider = await f.member(other.id, [], 3);
  await f.owner.ok("PATCH", `/users/${outsider.user.id}`, {
    kind: "admin",
    archived: false,
    suspended: false,
    editor: true,
    monitor: true,
  });
  for (const endpoint of [
    "items",
    "item-agents",
    "item-options?type=agents",
    "item-options?type=currencies",
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
  for (const [endpoint, body] of [
    ["items", itemBody(curr.id)],
    ["item-agents", agentBody()],
  ] as const) {
    assert.equal(
      (
        await reader.client.request(
          "POST",
          `/companies/${c.id}/${endpoint}`,
          body,
        )
      ).status,
      403,
    );
    await writer.client.ok("POST", `/companies/${c.id}/${endpoint}`, body, 201);
  }
  assert.equal(
    (await reader.client.request("GET", `/companies/${c.id}/currencies`))
      .status,
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
  const options = await reader.client.ok<Page<ItemAgent>>(
    "GET",
    `/companies/${c.id}/item-options?type=agents`,
  );
  assert(options.items.some((value) => value.id === a.id));
  await f.owner.ok(
    "PATCH",
    `/companies/${c.id}/employees/${writer.employee.id}`,
    { permissions: [] },
  );
  assert.equal(
    (await writer.client.request("GET", `/companies/${c.id}/items`)).status,
    403,
  );
});

test("item defaults, automatic codes and normalized audit values are generated in company scope", async (t) => {
  const f = await fixture(t),
    c = await f.company(),
    other = await f.company("Other");
  const curr = await currency(f, c.id),
    otherCurr = await currency(f, other.id);
  const a = await agent(f, c.id, {
    name: "  وكيل  ",
    phone: "٠٥٠ (١١١) ٢٢٢٢",
    address: "  عنوان  ",
  });
  assert.equal(a.name, "وكيل");
  assert.equal(a.phone, "0501112222");
  const one = (
    await f.owner.ok<{ item: Item }>(
      "POST",
      `/companies/${c.id}/items`,
      {
        name: "  صنف أول  ",
        currencyId: curr.id,
        agentId: a.id,
        idempotencyKey: randomUUID(),
      },
      201,
    )
  ).item;
  assert.equal(one.code, "00000001");
  assert.equal(one.name, "صنف أول");
  assert.equal(one.unit1Name, "باكت");
  assert.equal(one.factor2, 1);
  assert.equal(one.factor3, 1);
  assert.equal(one.hasExpiry, true);
  assert.equal(one.salePrice1, "0");
  assert.equal(one.purchasePrice, "0");
  assert.equal(one.reorderLimit, "0");
  assert.equal(one.orderQuantity, "0");
  assert.equal(one.revision, 1);
  assert.equal(one.createdBy, f.user.id);
  assert(Number.isFinite(Date.parse(one.createdAt)));
  assert.equal(one.companyId, c.id);
  assert.equal((await item(f, c.id, curr.id)).code, "00000002");
  assert.equal((await item(f, other.id, otherCurr.id)).code, "00000001");
  const event = (
    await f.pool.query(
      "SELECT before_value,after_value FROM audit_events WHERE company_id=$1 AND target_type='item' AND target_id=$2",
      [c.id, one.id],
    )
  ).rows[0];
  assert(event);
  assert.equal(event.before_value, null);
  assert.equal(event.after_value.name, one.name);
  assert.equal(event.after_value.code, one.code);
  for (const table of ["financial_documents", "financial_document_lines"]) {
    assert.equal(
      (
        await f.pool.query(
          `SELECT count(*)::int AS count FROM ${table} WHERE company_id=$1`,
          [c.id],
        )
      ).rows[0]!.count,
      0,
    );
  }
});

test("item creation and agent creation are idempotent without consuming duplicate codes or audit events", async (t) => {
  const f = await fixture(t),
    c = await f.company(),
    curr = await currency(f, c.id);
  const body = itemBody(curr.id),
    aBody = agentBody();
  const responses = await blockedOperations(f, c.id, [
    () =>
      f.owner.request<{ item: Item }>("POST", `/companies/${c.id}/items`, body),
    () =>
      f.owner.request<{ item: Item }>("POST", `/companies/${c.id}/items`, body),
  ]);
  assert(
    responses.every((value) => value.status === 200 || value.status === 201),
  );
  assert.equal(responses[0]!.body.item.id, responses[1]!.body.item.id);
  const replay = await f.owner.request<{ item: Item }>(
    "POST",
    `/companies/${c.id}/items`,
    body,
  );
  assert(replay.status === 200 || replay.status === 201);
  assert.equal(replay.body.item.id, responses[0]!.body.item.id);
  assert.equal(
    (
      await f.owner.request("POST", `/companies/${c.id}/items`, {
        ...body,
        name: "Changed",
      })
    ).status,
    409,
  );
  assert.equal((await item(f, c.id, curr.id)).code, "00000002");
  const created = await f.owner.ok<{ agent: ItemAgent }>(
    "POST",
    `/companies/${c.id}/item-agents`,
    aBody,
    201,
  );
  const aReplay = await f.owner.request<{ agent: ItemAgent }>(
    "POST",
    `/companies/${c.id}/item-agents`,
    aBody,
  );
  assert(aReplay.status === 200 || aReplay.status === 201);
  assert.equal(aReplay.body.agent.id, created.agent.id);
  assert.equal(
    (
      await f.owner.request("POST", `/companies/${c.id}/item-agents`, {
        ...aBody,
        notes: "Changed",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::int AS count FROM audit_events WHERE company_id=$1 AND action='item.create'",
        [c.id],
      )
    ).rows[0]!.count,
    2,
  );
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::int AS count FROM audit_events WHERE company_id=$1 AND action='itemAgent.create'",
        [c.id],
      )
    ).rows[0]!.count,
    1,
  );
});

test("independent sale and purchase prices retain exact Arabic-normalized decimals above Number precision", async (t) => {
  const f = await fixture(t),
    c = await f.company(),
    curr = await currency(f, c.id, 6);
  const saved = await item(f, c.id, curr.id, {
    factor2: "٢",
    factor3: "۱۲",
    purchaseFactor: "١٢",
    salePrice1: "٩٠٠٧١٩٩٢٥٤٧٤٠٩٩٣٫٠٠٠٠٠١",
    salePrice2: "500.250000",
    salePrice3: "50.125",
    purchasePrice: "9999999999999999999999.999999",
    reorderLimit: "۹۰۰۷۱۹۹۲۵۴۷۴۰۹۹۳",
    orderQuantity: "9999999999999999999999",
  });
  assert.equal(saved.salePrice1, "9007199254740993.000001");
  assert.equal(saved.salePrice2, "500.25");
  assert.equal(saved.salePrice3, "50.125");
  assert.equal(saved.purchasePrice, "9999999999999999999999.999999");
  assert.equal(saved.reorderLimit, "9007199254740993");
  assert.equal(saved.orderQuantity, "9999999999999999999999");
  assert.equal(saved.factor2, 2);
  assert.equal(saved.factor3, 12);
  assert.equal(saved.purchaseFactor, 12);
  const raw = (
    await f.pool.query(
      "SELECT sale_price1::text,purchase_price::text,reorder_limit::text FROM items WHERE id=$1",
      [saved.id],
    )
  ).rows[0]!;
  assert.equal(raw.sale_price1, "9007199254740993.000001");
  assert.equal(raw.purchase_price, saved.purchasePrice);
});

test("invalid item units, quantities, dates and prices never allocate a code or create an audit", async (t) => {
  const f = await fixture(t),
    c = await f.company(),
    curr = await currency(f, c.id);
  const before = await snapshot(f, c.id);
  const invalid = [
    { factor2: 0 },
    { factor3: -1 },
    { factor2: 1.5 },
    { factor3: "1e3" },
    { factor2: 1_000_001 },
    { unit1Name: " " },
    { unit2Name: "" },
    { unit3Name: "" },
    { purchaseFactor: 0 },
    { reorderLimit: "1.5" },
    { orderQuantity: "-1" },
    { orderQuantity: 1 },
    { orderQuantity: "10000000000000000000000" },
    { purchasePrice: -1 },
    { salePrice1: "-1" },
    { salePrice2: "0.001" },
    { salePrice3: "1e2" },
    { purchasePrice: "10000000000000000000000" },
    { currencyId: null },
    { orderStoppedUntil: "2026-02-29" },
    { orderStoppedUntil: "2026-13-01" },
    { orderStoppedUntil: "0000-01-01" },
    { orderStoppedUntil: "2026-10-12T00:00:00Z" },
    { idempotencyKey: "not-a-uuid" },
    { code: "00000099" },
  ];
  for (const overrides of invalid) {
    const response = await f.owner.request(
      "POST",
      `/companies/${c.id}/items`,
      itemBody(curr.id, overrides),
    );
    assert(
      [400, 409].includes(response.status),
      `Should reject ${JSON.stringify(overrides)}: ${JSON.stringify(response)}`,
    );
  }
  assert.deepEqual(await snapshot(f, c.id), before);
  assert.equal((await item(f, c.id, curr.id)).code, "00000001");
});

test("price precision follows the selected currency, including zero and six decimal places", async (t) => {
  const f = await fixture(t),
    c = await f.company(),
    zero = await currency(f, c.id, 0),
    six = await currency(f, c.id, 6, "USD");
  assert.equal(
    (
      await f.owner.request(
        "POST",
        `/companies/${c.id}/items`,
        itemBody(zero.id, { salePrice1: "1.1" }),
      )
    ).status,
    400,
  );
  const integer = await item(f, c.id, zero.id, { salePrice1: "1000.000000" });
  assert.equal(integer.salePrice1, "1000");
  const precise = await item(f, c.id, six.id, { salePrice3: "0.000001" });
  assert.equal(precise.salePrice3, "0.000001");
  assert.equal(
    (
      await f.owner.request(
        "PATCH",
        `/companies/${c.id}/items/${precise.id}`,
        patchItem(precise, { currencyId: zero.id }),
      )
    ).status,
    400,
  );
  const latest = await f.owner.ok<{ item: Item }>(
    "GET",
    `/companies/${c.id}/items/${precise.id}`,
  );
  assert.equal(latest.item.revision, precise.revision);
});

test("date-only item fields preserve exact days and leap years independent of runtime timezone", async (t) => {
  const f = await fixture(t),
    c = await f.company(),
    curr = await currency(f, c.id);
  for (const date of ["0001-01-01", "2028-02-29", "2027-01-01", "9999-12-31"]) {
    const saved = await item(f, c.id, curr.id, { orderStoppedUntil: date });
    assert.equal(saved.orderStoppedUntil, date);
    const read = await f.owner.ok<{ item: Item }>(
      "GET",
      `/companies/${c.id}/items/${saved.id}`,
    );
    assert.equal(read.item.orderStoppedUntil, date);
  }
});

test("composite company references reject foreign agents and currencies without allocating identifiers", async (t) => {
  const f = await fixture(t),
    c = await f.company(),
    other = await f.company("Other");
  const curr = await currency(f, c.id),
    foreignCurrency = await currency(f, other.id),
    foreignAgent = await agent(f, other.id);
  const before = await snapshot(f, c.id);
  for (const overrides of [
    { agentId: foreignAgent.id },
    { currencyId: foreignCurrency.id },
  ])
    assert.equal(
      (
        await f.owner.request(
          "POST",
          `/companies/${c.id}/items`,
          itemBody(curr.id, overrides),
        )
      ).status,
      409,
    );
  assert.deepEqual(await snapshot(f, c.id), before);
  const own = await item(f, c.id, curr.id);
  assert.equal(
    (await f.owner.request("GET", `/companies/${other.id}/items/${own.id}`))
      .status,
    404,
  );
  assert.equal(
    (
      await f.owner.request(
        "PATCH",
        `/companies/${other.id}/items/${own.id}`,
        patchItem(own),
      )
    ).status,
    404,
  );
  for (const [column, value] of [
    ["agent_id", foreignAgent.id],
    ["currency_id", foreignCurrency.id],
  ] as const) {
    await assert.rejects(
      () =>
        f.pool.query(
          `UPDATE items SET ${column}=$2,revision=revision+1 WHERE id=$1`,
          [own.id, value],
        ),
      (error: { code?: string }) => error.code === "23503",
    );
  }
});

test("archived current references remain editable but cannot be selected for new items or reactivation", async (t) => {
  const f = await fixture(t),
    c = await f.company(),
    curr = await currency(f, c.id),
    a = await agent(f, c.id);
  const saved = await item(f, c.id, curr.id, { agentId: a.id });
  await f.owner.ok(
    "PATCH",
    `/companies/${c.id}/item-agents/${a.id}`,
    patchAgent(a, { active: false }),
  );
  await f.owner.ok("PATCH", `/companies/${c.id}/currencies/${curr.id}`, {
    active: false,
  });
  const read = await f.owner.ok<{ item: Item }>(
    "GET",
    `/companies/${c.id}/items/${saved.id}`,
  );
  assert.equal(read.item.agentActive, false);
  assert.equal(read.item.currencyActive, false);
  const renamed = (
    await f.owner.ok<{ item: Item }>(
      "PATCH",
      `/companies/${c.id}/items/${saved.id}`,
      patchItem(saved, { name: "Archived refs still kept" }),
    )
  ).item;
  assert.equal(renamed.agentId, a.id);
  assert.equal(renamed.currencyId, curr.id);
  assert.equal(
    (
      await f.owner.request(
        "POST",
        `/companies/${c.id}/items`,
        itemBody(curr.id, { agentId: a.id }),
      )
    ).status,
    409,
  );
  const archived = (
    await f.owner.ok<{ item: Item }>(
      "PATCH",
      `/companies/${c.id}/items/${saved.id}`,
      patchItem(renamed, { active: false }),
    )
  ).item;
  assert.equal(
    (
      await f.owner.request(
        "PATCH",
        `/companies/${c.id}/items/${saved.id}`,
        patchItem(archived, { active: true }),
      )
    ).status,
    409,
  );
  const agentOptions = await f.owner.ok<Page<ItemAgent>>(
    "GET",
    `/companies/${c.id}/item-options?type=agents`,
  );
  assert(!agentOptions.items.some((value) => value.id === a.id));
  const currOptions = await f.owner.ok<Page<CompanyCurrency>>(
    "GET",
    `/companies/${c.id}/item-options?type=currencies`,
  );
  assert(!currOptions.items.some((value) => value.id === curr.id));
});

test("optimistic item and agent revisions accept one concurrent edit and preserve audited before-after values", async (t) => {
  const f = await fixture(t),
    c = await f.company(),
    curr = await currency(f, c.id),
    a = await agent(f, c.id),
    saved = await item(f, c.id, curr.id);
  for (const [endpoint, record, body1, body2] of [
    [
      "items",
      saved,
      patchItem(saved, { name: "First edit" }),
      patchItem(saved, { name: "Second edit" }),
    ],
    [
      "item-agents",
      a,
      patchAgent(a, { name: "First agent" }),
      patchAgent(a, { name: "Second agent" }),
    ],
  ] as const) {
    const results = await blockedOperations(f, c.id, [
      () =>
        f.owner.request(
          "PATCH",
          `/companies/${c.id}/${endpoint}/${record.id}`,
          body1,
        ),
      () =>
        f.owner.request(
          "PATCH",
          `/companies/${c.id}/${endpoint}/${record.id}`,
          body2,
        ),
    ]);
    assert.deepEqual(
      results.map((response) => response.status).sort(),
      [200, 409],
    );
    const response = await f.owner.ok<{ item?: Item; agent?: ItemAgent }>(
      "GET",
      `/companies/${c.id}/${endpoint}/${record.id}`,
    );
    const updated = response.item ?? response.agent;
    assert(updated);
    assert.equal(updated.revision, 2);
    assert.equal(updated.createdAt, record.createdAt);
    const event = (
      await f.pool.query(
        "SELECT before_value,after_value FROM audit_events WHERE company_id=$1 AND target_id=$2 AND target_type=$3 AND before_value IS NOT NULL",
        [c.id, record.id, endpoint === "items" ? "item" : "itemAgent"],
      )
    ).rows;
    assert.equal(event.length, 1);
    assert.equal(event[0]!.before_value.name, record.name);
    assert.equal(event[0]!.after_value.name, updated.name);
  }
});

test("audit failure rolls back item allocation and all item or agent changes", async (t) => {
  const f = await fixture(t),
    c = await f.company(),
    curr = await currency(f, c.id);
  const beforeCreate = await snapshot(f, c.id);
  await rejectAudit(f, async () => {
    assert.equal(
      (
        await f.owner.request(
          "POST",
          `/companies/${c.id}/items`,
          itemBody(curr.id),
        )
      ).status,
      500,
    );
    assert.equal(
      (
        await f.owner.request(
          "POST",
          `/companies/${c.id}/item-agents`,
          agentBody(),
        )
      ).status,
      500,
    );
  });
  assert.deepEqual(await snapshot(f, c.id), beforeCreate);
  const saved = await item(f, c.id, curr.id),
    a = await agent(f, c.id);
  assert.equal(saved.code, "00000001");
  const beforeEdit = await snapshot(f, c.id);
  await rejectAudit(f, async () => {
    assert.equal(
      (
        await f.owner.request(
          "PATCH",
          `/companies/${c.id}/items/${saved.id}`,
          patchItem(saved, { name: "Rejected" }),
        )
      ).status,
      500,
    );
    assert.equal(
      (
        await f.owner.request(
          "PATCH",
          `/companies/${c.id}/item-agents/${a.id}`,
          patchAgent(a, { active: false }),
        )
      ).status,
      500,
    );
  });
  assert.deepEqual(await snapshot(f, c.id), beforeEdit);
});

test("archiving never reuses automatic codes and database guards protect identity, units and precision", async (t) => {
  const f = await fixture(t),
    c = await f.company(),
    curr = await currency(f, c.id),
    saved = await item(f, c.id, curr.id),
    a = await agent(f, c.id);
  await f.owner.ok(
    "PATCH",
    `/companies/${c.id}/items/${saved.id}`,
    patchItem(saved, { active: false }),
  );
  assert.equal((await item(f, c.id, curr.id)).code, "00000002");
  for (const operation of [
    () =>
      f.pool.query(
        "UPDATE items SET code='00000099',revision=revision+1 WHERE id=$1",
        [saved.id],
      ),
    () =>
      f.pool.query(
        "UPDATE items SET factor2=0,revision=revision+1 WHERE id=$1",
        [saved.id],
      ),
    () =>
      f.pool.query(
        "UPDATE items SET factor3=1000001,revision=revision+1 WHERE id=$1",
        [saved.id],
      ),
    () =>
      f.pool.query(
        "UPDATE items SET sale_price1=1.001,revision=revision+1 WHERE id=$1",
        [saved.id],
      ),
    () =>
      f.pool.query("UPDATE items SET name='Bypass revision' WHERE id=$1", [
        saved.id,
      ]),
    () => f.pool.query("DELETE FROM items WHERE id=$1", [saved.id]),
    () => f.pool.query("DELETE FROM item_agents WHERE id=$1", [a.id]),
  ])
    await assert.rejects(
      operation,
      (error: { code?: string }) => error.code === "23514",
    );
});

test("item lists search each name, barcode and search key with stable multi-sort and scoped pagination", async (t) => {
  const f = await fixture(t),
    c = await f.company(),
    curr = await currency(f, c.id),
    other = await f.company("Other"),
    otherCurr = await currency(f, other.id);
  const first = await item(f, c.id, curr.id, {
    name: "Same",
    englishName: "UniqueEnglish",
    barcode: "123456",
    searchKeys: "فلتارين ف15",
    salePrice1: "20",
  });
  const second = await item(f, c.id, curr.id, {
    name: "Same",
    salePrice1: "10",
  });
  await item(f, c.id, curr.id, { name: "Archived", active: false });
  await item(f, other.id, otherCurr.id, {
    name: "Same foreign",
    barcode: "123456",
  });
  for (const query of ["UniqueEnglish", "123456", "فلتارين", "ف15"]) {
    const page = await f.owner.ok<Page<Item>>(
      "GET",
      `/companies/${c.id}/items?q=${encodeURIComponent(query)}`,
    );
    assert.deepEqual(
      page.items.map((value) => value.id),
      [first.id],
    );
    assert.equal(page.total, 1);
  }
  const page1 = await f.owner.ok<Page<Item>>(
    "GET",
    `/companies/${c.id}/items?active=true&sort=name:asc,salePrice1:asc&page=1&pageSize=1`,
  );
  const page2 = await f.owner.ok<Page<Item>>(
    "GET",
    `/companies/${c.id}/items?active=true&sort=name:asc,salePrice1:asc&page=2&pageSize=1`,
  );
  assert.equal(page1.total, 2);
  assert.equal(page1.items[0]!.id, second.id);
  assert.equal(page2.items[0]!.id, first.id);
  for (const query of [
    "sort=name:sideways",
    "sort=prototype:asc",
    "page=0",
    "pageSize=1000",
    "active=invalid",
  ])
    assert.equal(
      (await f.owner.request("GET", `/companies/${c.id}/items?${query}`))
        .status,
      400,
    );
});

test("queued item creation rechecks revoked membership and leaves allocation untouched", async (t) => {
  const f = await fixture(t),
    c = await f.company(),
    curr = await currency(f, c.id),
    member = await f.member(c.id, ["items.manage"]);
  const before = await snapshot(f, c.id);
  const [result] = await blockedOperations(
    f,
    c.id,
    [
      () =>
        member.client.request(
          "POST",
          `/companies/${c.id}/items`,
          itemBody(curr.id),
        ),
    ],
    async () => {
      await f.pool.query("UPDATE employees SET permissions='{}' WHERE id=$1", [
        member.employee.id,
      ]);
    },
  );
  assert.equal(result!.status, 403);
  assert.deepEqual(await snapshot(f, c.id), before);
});

test("three-level quantities retain exact irreducible fractions and smallest-unit integer totals", () => {
  const result = convertItemQuantity(
    { quantity: "2", unit: 3 },
    { factor2: 2, factor3: 12 },
  );
  assert.equal(result.smallestUnits, "2");
  assert.deepEqual(result.unit1, {
    numerator: "1",
    denominator: "12",
    decimal: null,
  });
  assert.deepEqual(result.unit2, {
    numerator: "1",
    denominator: "6",
    decimal: null,
  });
  assert.deepEqual(result.unit3, {
    numerator: "2",
    denominator: "1",
    decimal: "2",
  });
  assert.deepEqual(result.parts, { unit1: "0", unit2: "0", unit3: "2" });
  const huge = convertItemQuantity(
    { quantity: "9007199254740993", unit: 1 },
    { factor2: 1_000_000, factor3: 1_000_000 },
  );
  assert.equal(huge.smallestUnits, "9007199254740993000000000000");
  assert.equal(huge.unit1.numerator, "9007199254740993");
  assert.equal(huge.unit1.denominator, "1");
  const finite = convertItemQuantity(
    { quantity: "3", unit: 3 },
    { factor2: 2, factor3: 4 },
  );
  assert.deepEqual(finite.unit1, {
    numerator: "3",
    denominator: "8",
    decimal: "0.375",
  });
  const split = convertItemQuantity(
    { quantity: "26", unit: 3 },
    { factor2: 2, factor3: 12 },
  );
  assert.deepEqual(split.parts, { unit1: "1", unit2: "0", unit3: "2" });
  const noSplit = convertItemQuantity(
    { quantity: "2", unit: 1 },
    { factor2: 1, factor3: 1 },
  );
  assert.equal(noSplit.smallestUnits, "2");
});

test("conversion preserves conservation and exact decimal identities across independent factor and quantity vectors", () => {
  let vectors = 0;
  for (const factors of [
    { factor2: 1, factor3: 1 },
    { factor2: 2, factor3: 12 },
    { factor2: 3, factor3: 7 },
    { factor2: 2, factor3: 5 },
    { factor2: 999983, factor3: 1000000 },
  ]) {
    for (const quantity of [
      "0",
      "1",
      "26",
      "٩٠٠٧١٩٩٢٥٤٧٤٠٩٩٣",
      "9999999999999999999999",
    ]) {
      for (const unit of [1, 2, 3] as const) {
        if (
          (unit === 2 && factors.factor2 === 1) ||
          (unit === 3 && factors.factor3 === 1)
        )
          continue;
        const value = convertItemQuantity({ quantity, unit }, factors);
        const f2 = BigInt(factors.factor2),
          f3 = BigInt(factors.factor3),
          smallest = BigInt(value.smallestUnits);
        assert.equal(
          BigInt(value.parts.unit1) * f2 * f3 +
            BigInt(value.parts.unit2) * f3 +
            BigInt(value.parts.unit3),
          smallest,
        );
        assert(BigInt(value.parts.unit2) < f2);
        assert(BigInt(value.parts.unit3) < f3);
        for (const [fraction, multiplier] of [
          [value.unit1, f2 * f3],
          [value.unit2, f3],
          [value.unit3, 1n],
        ] as const) {
          const numerator = BigInt(fraction.numerator),
            denominator = BigInt(fraction.denominator);
          assert.equal(numerator * multiplier, smallest * denominator);
          let a = numerator,
            b = denominator;
          while (b) [a, b] = [b, a % b];
          assert.equal(a, 1n);
          if (fraction.decimal !== null) {
            const [whole, digits = ""] = fraction.decimal.split(".");
            assert.equal(
              BigInt(whole! + digits) * denominator,
              numerator * 10n ** BigInt(digits.length),
            );
          } else {
            let rest = denominator;
            while (rest % 2n === 0n) rest /= 2n;
            while (rest % 5n === 0n) rest /= 5n;
            assert(
              rest > 1n,
              "Only genuinely repeating fractions omit an exact finite decimal",
            );
          }
        }
        vectors++;
      }
    }
  }
  assert.equal(vectors, 65);
  for (const quantity of ["-1", "1.5", "1e3", "10000000000000000000000"])
    assert.throws(() =>
      convertItemQuantity({ quantity, unit: 1 }, { factor2: 2, factor3: 12 }),
    );
  assert.throws(() =>
    convertItemQuantity(
      { quantity: "1", unit: 2 },
      { factor2: 1, factor3: 12 },
    ),
  );
  assert.throws(() =>
    convertItemQuantity({ quantity: "1", unit: 3 }, { factor2: 2, factor3: 1 }),
  );
});

test("conversion endpoint checks scoped read permission, rejects inactive units and writes no stock or audit", async (t) => {
  const f = await fixture(t),
    c = await f.company(),
    curr = await currency(f, c.id),
    saved = await item(f, c.id, curr.id),
    reader = await f.member(c.id, ["items.view"]);
  const before = await snapshot(f, c.id);
  const response = await reader.client.ok<{ conversion: ItemConversion }>(
    "GET",
    `/companies/${c.id}/items/${saved.id}/conversion?quantity=2&unit=3`,
  );
  assert.deepEqual(response.conversion.unit1, {
    numerator: "1",
    denominator: "12",
    decimal: null,
  });
  assert.deepEqual(await snapshot(f, c.id), before);
  const collapsed = await item(f, c.id, curr.id, {
    factor2: 1,
    factor3: 1,
    unit2Name: "",
    unit3Name: "",
  });
  for (const unit of [2, 3])
    assert.equal(
      (
        await reader.client.request(
          "GET",
          `/companies/${c.id}/items/${collapsed.id}/conversion?quantity=2&unit=${unit}`,
        )
      ).status,
      400,
    );
  assert.equal(
    (
      await f
        .anonymous()
        .request(
          "GET",
          `/companies/${c.id}/items/${saved.id}/conversion?quantity=2&unit=3`,
        )
    ).status,
    401,
  );
});

test("item compositions support multilingual cards, strict flags, archived links and company isolation", async (t) => {
  const f = await fixture(t);
  const companyA = await f.company("تركيب الشركة الأولى");
  const companyB = await f.company("تركيب الشركة الثانية");
  const currencyA = (await f.owner.ok<Page<CompanyCurrency>>(
    "GET", `/companies/${companyA.id}/currencies`
  )).items.find((value) => value.code === "YER")!;
  const currencyB = (await f.owner.ok<Page<CompanyCurrency>>(
    "GET", `/companies/${companyB.id}/currencies`
  )).items.find((value) => value.code === "YER")!;
  const url = `/companies/${companyA.id}/item-compositions`;
  const body = {
    arabicName:"باراسيتامول",englishName:"Paracetamol",
    description:"مادة تركيب الدواء",active:true,
    identicalAlternative:true,nonInterchangeable:false,
    idempotencyKey:randomUUID(),
  };
  const created = (await f.owner.ok<{composition:ItemComposition}>(
    "POST",url,body,201)).composition;
  assert.equal(created.arabicName,body.arabicName);
  assert.equal(created.englishName,body.englishName);
  assert.equal(created.identicalAlternative,true);
  assert.equal(created.nonInterchangeable,false);
  assert.equal((await f.owner.ok<{composition:ItemComposition}>("POST",url,body)).composition.id,created.id);
  assert.equal((await f.owner.request("POST",url,{...body,englishName:"Other"})).status,409);
  assert.equal((await f.owner.request("POST",url,{
    ...body,idempotencyKey:randomUUID(),nonInterchangeable:true,
  })).status,400);
  const list = await f.owner.ok<Page<ItemComposition>>("GET",url+"?q=Parac");
  assert.equal(list.total,1);
  assert.equal(list.items[0]!.id,created.id);
  const filter = await f.owner.ok<Page<ItemComposition>>(
    "GET",`/companies/${companyA.id}/item-options?type=compositions&active=true`);
  assert.equal(filter.items[0]!.id,created.id);
  const foreign = (await f.owner.ok<{composition:ItemComposition}>("POST",
    `/companies/${companyB.id}/item-compositions`,
    {...body,arabicName:"تركيب مختلف",idempotencyKey:randomUUID()},201)).composition;
  assert.equal((await f.owner.request("GET",url+"/"+foreign.id)).status,404);
  assert.equal((await f.owner.request("POST",`/companies/${companyA.id}/items`,
    itemBody(currencyA.id,{compositionId:foreign.id}))).status,409);
  const itemA = await item(f,companyA.id,currencyA.id,{compositionId:created.id});
  const itemB = await item(f,companyB.id,currencyB.id,{compositionId:foreign.id});
  assert.equal(itemA.compositionArabicName,body.arabicName);
  assert.equal(itemA.compositionId,created.id);
  assert.equal(itemB.compositionId,foreign.id);
  assert.equal((await f.owner.ok<Page<Item>>("GET",
    `/companies/${companyA.id}/items?compositionId=${created.id}`)).total,1);
  const related=await item(f,companyA.id,currencyA.id,{
    name:"تركيب مماثل",compositionId:created.id,
  });
  const peersPath=`/companies/${companyA.id}/items/${itemA.id}/composition-peers`;
  const linked=(await f.owner.ok<{peers:ItemCompositionPeers}>("GET",peersPath)).peers;
  assert.equal(linked.total,1);
  assert.equal(linked.relation,"identicalAlternative");
  assert.equal(linked.peers[0]?.id,related.id);
  assert.equal(linked.peers[0]?.stockSmallest,"0");
  assert.equal(linked.peers[0]?.smallestUnitName,
    related.factor3>1?related.unit3Name:related.factor2>1?related.unit2Name:related.unit1Name);
  const viewRelated=await f.member(companyA.id,["items.view"],46);
  const redacted=(await viewRelated.client.ok<{peers:ItemCompositionPeers}>("GET",peersPath)).peers;
  assert.equal(redacted.canViewStock,false);
  assert.equal(redacted.peers[0]?.stockSmallest,null);
  assert.equal(redacted.total,1);
  assert.equal((await f.owner.request("GET",peersPath+"?page=0")).status,400);
  assert.equal((await f.owner.request("GET",peersPath+"?page=1x")).status,400);
  assert.equal((await f.owner.request("GET",`/companies/${companyB.id}/items/${itemA.id}/composition-peers`)).status,404);
  const stale = await f.owner.request("PATCH",url+"/"+created.id,{
    arabicName:"جديد",englishName:"New",description:"",active:false,
    identicalAlternative:false,nonInterchangeable:true,revision:99,
  });
  assert.equal(stale.status,409);
  const archived = (await f.owner.ok<{composition:ItemComposition}>("PATCH",
    url+"/"+created.id,{
      arabicName:body.arabicName,englishName:body.englishName,
      description:body.description,active:false,
      identicalAlternative:false,nonInterchangeable:true,revision:created.revision,
    })).composition;
  assert.equal(archived.revision,created.revision+1);
  assert.equal(archived.nonInterchangeable,true);
  const forbidden=(await f.owner.ok<{peers:ItemCompositionPeers}>("GET",peersPath)).peers;
  assert.equal(forbidden.relation,"nonInterchangeable");
  const ungrouped=await item(f,companyA.id,currencyA.id,{name:"صنف مستقل"});
  const empty=(await f.owner.ok<{peers:ItemCompositionPeers}>("GET",
    `/companies/${companyA.id}/items/${ungrouped.id}/composition-peers`)).peers;
  assert.equal(empty.relation,"none");
  assert.equal(empty.composition,null);
  assert.equal(empty.total,0);
  assert.equal((await f.owner.ok<Page<ItemComposition>>("GET",
    `/companies/${companyA.id}/item-options?type=compositions`)).items.length,0);
  assert.equal((await f.owner.ok<{item:Item}>("GET",
    `/companies/${companyA.id}/items/${itemA.id}`)).item.compositionActive,false);
  // Unchanged archived link is valid; linking it to another item is not.
  const updated=(await f.owner.ok<{item:Item}>("PATCH",
    `/companies/${companyA.id}/items/${itemA.id}`,
    patchItem(itemA,{searchKeys:"مرتبط بتركيب مؤرشف"}))).item;
  assert.equal(updated.compositionId,created.id);
  assert.equal((await f.owner.request("POST",
    `/companies/${companyA.id}/items`,
    itemBody(currencyA.id,{compositionId:created.id}))).status,409);
  const existing = await item(f,companyA.id,currencyA.id,{name:"صنف بلا تركيب"});
  assert.equal(existing.compositionId,null);
  assert.equal((await f.owner.request("PATCH",
    `/companies/${companyA.id}/items/${existing.id}`,
    patchItem(existing,{compositionId:created.id}))).status,409);
  const viewOnly = await f.member(companyA.id,["items.view"],15);
  const listing = await viewOnly.client.ok<Page<ItemComposition>>("GET",url);
  assert.equal(listing.total,1);
  assert.equal((await viewOnly.client.request("POST",url,{
    ...body,idempotencyKey:randomUUID()})).status,403);
  const anonymous = f.anonymous();
  assert.equal((await anonymous.request("GET",url)).status,401);
  await assert.rejects(f.pool.query("DELETE FROM item_compositions WHERE id=$1",
    [created.id]));
});

test("composition bulk import duplicates a single source name into both fields without overwriting", async (t) => {
  const f = await fixture(t);
  const c = await f.company("مستورد التراكيب");
  const url = `/companies/${c.id}/item-compositions`;
  const longName = "تركيب مطول ".repeat(14).trim();
  assert(longName.length > 120 && longName.length <= 240);
  const existing = (await f.owner.ok<{composition: ItemComposition}>(
    "POST",url,{
      arabicName:"اسم قديم",englishName:"اسم قديم",description:"ابقِ الشرح القديم",
      active:false,identicalAlternative:false,nonInterchangeable:true,
      idempotencyKey:randomUUID(),
    },201)).composition;
  const payload = {format:"tijara-compositions-v1",items:[
    {arabicName:longName,englishName:longName},
    {arabicName:"اسم جديد",englishName:"اسم جديد"},
    {arabicName:" اسم جديد ",englishName:"اسم جديد"},
    {arabicName:"اسم قديم",englishName:"اسم قديم"},
  ]};
  const start = await f.owner.ok<{created:number;skipped:number}>(
    "POST",url+"/import-batch",payload);
  assert.deepEqual(start,{created:2,skipped:2});
  const second = await f.owner.ok<{created:number;skipped:number}>(
    "POST",url+"/import-batch",payload);
  assert.deepEqual(second,{created:0,skipped:4});
  const list = await f.owner.ok<Page<ItemComposition>>("GET",url+"?pageSize=20");
  assert.equal(list.total,3);
  const imported = list.items.find(row=>row.arabicName===longName);
  assert(imported);
  assert.equal(imported.englishName,longName);
  assert.equal(imported.active,true);
  assert.equal(imported.identicalAlternative,false);
  assert.equal(imported.nonInterchangeable,false);
  const stillOld = list.items.find(row=>row.id===existing.id);
  assert(stillOld);
  assert.equal(stillOld.description,"ابقِ الشرح القديم");
  assert.equal(stillOld.active,false);
  assert.equal(stillOld.nonInterchangeable,true);
  const viewOnly = await f.member(c.id,["items.view"],16);
  assert.equal((await viewOnly.client.request("POST",url+"/import-batch",payload)).status,403);
  const illegal = await f.owner.request("POST",url+"/import-batch",{
    format:"tijara-compositions-v1",items:[
      {arabicName:"اسم صالح",englishName:"اسم صالح"},
      {arabicName:"م".repeat(241),englishName:"Invalid"},
    ],
  });
  assert.equal(illegal.status,400);
  const unchanged = await f.owner.ok<Page<ItemComposition>>("GET",url);
  assert.equal(unchanged.total,3,"Batch validation must be atomic");
  const other=await f.company("شركة أخرى");
  const independent=await f.owner.ok<{created:number;skipped:number}>(
    "POST",`/companies/${other.id}/item-compositions/import-batch`,
    {format:payload.format,items:[payload.items[0]]});
  assert.deepEqual(independent,{created:1,skipped:0});
});

test("Arabic shelf cards are seeded 28x12, company-scoped and editable without changing historical item shelf text",async(t)=>{
  const f=await fixture(t);
  const first=await f.company("أرفف صيدلية أولى");
  const second=await f.company("أرفف شركة ثانية");
  const root=`/companies/${first.id}/item-shelves`;
  const count=await f.pool.query<{n:number;groups:number}>(
    "SELECT count(*)::int AS n,count(DISTINCT group_letter)::int AS groups FROM item_shelves WHERE company_id=$1",
    [first.id]);
  assert.equal(count.rows[0]!.n,336);
  assert.equal(count.rows[0]!.groups,28);
  assert.equal(arabicShelfLetters.length,28);
  for(const [index,letter] of arabicShelfLetters.entries()) {
    const group=await f.owner.ok<Page<ItemShelf>>("GET",
      `${root}?groupLetter=${encodeURIComponent(letter)}&pageSize=20`);
    assert.equal(group.total,12);
    assert.deepEqual(group.items.map(x=>x.slotNumber),Array.from({length:12},(_,i)=>i+1));
    assert.deepEqual(group.items.map(x=>x.name),
      Array.from({length:12},(_,i)=>`${letter}-${i+1}`));
    assert(group.items.every(x=>x.groupOrder===index+1));
    assert(group.items.every(x=>x.archived===false && x.vitrine===false));
  }
  const firstShelf=(await f.owner.ok<Page<ItemShelf>>("GET",
    `${root}?q=${encodeURIComponent("ب-12")}`)).items.find(x=>x.name==="ب-12")!;
  assert(firstShelf);
  const updated=(await f.owner.ok<{shelf:ItemShelf}>(
    "PATCH",`${root}/${firstShelf.id}`,
    {revision:firstShelf.revision,archived:false,vitrine:true})).shelf;
  assert.equal(updated.name,"ب-12");
  assert.equal(updated.groupLetter,"ب");
  assert.equal(updated.revision,firstShelf.revision+1);
  assert.equal(updated.vitrine,true);
  assert.equal((await f.owner.ok<Page<ItemShelf>>("GET",
    `${root}?vitrine=true`)).total,1);
  assert.equal((await f.owner.request("PATCH",`${root}/${updated.id}`,
    {revision:firstShelf.revision,archived:true,vitrine:false})).status,409);
  assert.equal((await f.owner.request("PATCH",`${root}/${updated.id}`,
    {revision:updated.revision,archived:false,vitrine:true,name:"غير مصرح"})).status,400);
  const archived=(await f.owner.ok<{shelf:ItemShelf}>(
    "PATCH",`${root}/${updated.id}`,
    {revision:updated.revision,archived:true,vitrine:true})).shelf;
  assert.equal(archived.archived,true);
  assert.equal((await f.owner.ok<Page<ItemShelf>>("GET",
    `/companies/${first.id}/item-options?type=shelves&archived=false&q=${encodeURIComponent("ب-12")}`)).total,0);
  const currencyId=(await f.owner.ok<Page<CompanyCurrency>>("GET",
    `/companies/${first.id}/currencies`)).items.find(c=>c.code==="YER")!.id;
  const previouslyShelved=await item(f,first.id,currencyId,{shelf:"ب-12"});
  assert.equal(previouslyShelved.shelf,"ب-12",
    "Archiving a shelf cannot remove the historical shelf location from an item");
  const foreign=(await f.owner.ok<Page<ItemShelf>>("GET",
    `/companies/${second.id}/item-shelves?q=${encodeURIComponent("ب-12")}`)).items[0]!;
  assert.equal(foreign.vitrine,false);
  assert.equal(foreign.archived,false);
  // Company B's shelf must never be exposed as a record in company A.
  assert.equal((await f.owner.request("GET",`${root}/${foreign.id}`)).status,404);
  const reader=await f.member(first.id,["items.view"],45);
  assert.equal((await reader.client.ok<Page<ItemShelf>>("GET",root)).total,336);
  assert.equal((await reader.client.request("PATCH",`${root}/${archived.id}`,
    {revision:archived.revision,archived:false,vitrine:false})).status,403);
  assert.equal((await f.anonymous().request("GET",root)).status,401);
  await assert.rejects(f.pool.query("DELETE FROM item_shelves WHERE company_id=$1 AND id=$2",
    [first.id,updated.id]));
});

test("Item shelf cards are real company-scoped references while legacy labels remain writable",async(t)=>{
  const f=await fixture(t);
  const a=await f.company("صيدلية اختبار رفوف");
  const b=await f.company("صيدلية اختبار أخرى");
  const shelfa=(await f.owner.ok<Page<ItemShelf>>("GET",
    `/companies/${a.id}/item-shelves?q=${encodeURIComponent("ا-1")}`)).items.find(x=>x.name==="ا-1")!;
  const shelfb=(await f.owner.ok<Page<ItemShelf>>("GET",
    `/companies/${b.id}/item-shelves?q=${encodeURIComponent("ا-2")}`)).items.find(x=>x.name==="ا-2")!;
  const c=(await f.owner.ok<Page<CompanyCurrency>>("GET",
    `/companies/${a.id}/currencies`)).items.find(x=>x.code==="YER")!;
  const first=await item(f,a.id,c.id,{shelf:"ا-1",shelfId:shelfa.id});
  assert.equal(first.shelfId,shelfa.id);
  assert.equal(first.shelf,"ا-1");
  assert.equal((await f.owner.request("POST",`/companies/${a.id}/items`,
    itemBody(c.id,{shelf:"ا-2",shelfId:shelfb.id}))).status,409);
  assert.equal((await f.owner.request("POST",`/companies/${a.id}/items`,
    itemBody(c.id,{shelf:"ب-7",shelfId:shelfa.id}))).status,409);
  const after=(await f.owner.ok<{item:Item}>(
    "PATCH",`/companies/${a.id}/items/${first.id}`,
    patchItem(first,{shelf:"ب-تر",shelfId:null}))).item;
  assert.equal(after.shelf,"ب-تر");
  assert.equal(after.shelfId,null);
  const archived=(await f.owner.ok<{shelf:ItemShelf}>(
    "PATCH",`/companies/${a.id}/item-shelves/${shelfa.id}`,
    {revision:shelfa.revision,archived:true,vitrine:false})).shelf;
  assert.equal(archived.archived,true);
  assert.equal((await f.owner.request("PATCH",`/companies/${a.id}/items/${after.id}`,
    patchItem(after,{shelf:"ا-1",shelfId:shelfa.id}))).status,409);
});
