import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import type {
  Company,
  CompanyCurrency,
  Employee,
  Item,
  Page,
  PageEntry,
  ItemActivityReport,
  Permission,
  SessionResponse,
} from "../packages/contracts/src/index.ts";

// Fake credentials and disposable schemas only; no production data is changed.
const password = "Coverage-test-password-2026";
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const origin = "http://localhost";

type CoverageItem = Item & {
  reserveQuantity: string;
  approximateCoverageDays: string | null;
  coverageAfterReserveDays: string | null;
};
interface Coverage {
  companyId: number;
  itemId: number;
  asOf: string;
  unitName: string;
  canViewCoverage: boolean;
  approximateCoverageDays: string | null;
  coverageAfterReserveDays: string | null;
}

class Client {
  private cookie = "";
  private csrf: string | null = null;
  constructor(private readonly baseUrl: string) {}

  async request<T>(method: string, path: string, body?: unknown) {
    const response = await fetch(`${this.baseUrl}/api${path}`, {
      method,
      headers: {
        accept: "application/json",
        cookie: this.cookie,
        ...(method === "GET"
          ? {}
          : {
              "content-type": "application/json",
              origin,
              "x-csrf-token": this.csrf ?? "",
            }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const value of response.headers.getSetCookie())
      this.cookie = value.split(";", 1)[0]!;
    const result = (await response.json()) as T;
    if (result && typeof result === "object" && "csrf" in result)
      this.csrf = (result as unknown as SessionResponse).csrf;
    return { status: response.status, body: result };
  }

  async ok<T>(method: string, path: string, body?: unknown, status = 200) {
    const response = await this.request<T>(method, path, body);
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(response.body)}`);
    return response.body;
  }
}

async function fixture(t: TestContext) {
  const schema = `item_coverage_${randomUUID().replaceAll("-", "")}`;
  const runtime = await createApp({
    databaseUrl, schema, appOrigin: origin, production: false, serveStatic: false,
  });
  const server = runtime.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
    await runtime.close();
    const cleanup = new Pool({ connectionString: databaseUrl });
    try { await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await cleanup.end(); }
  });
  const user = await provisionOwner(runtime.pool, {
    name: "Coverage owner", displayName: "Owner", email: "owner@coverage.test", password,
  });
  const owner = new Client(baseUrl);
  await owner.ok("POST", "/auth/login", { email: user.email, password });
  const company = async (name = "Coverage company") => (
    await owner.ok<{ company: Company }>("POST", "/companies", { name, phone: "", address: "" }, 201)
  ).company;
  async function currency(companyId: number) {
    return (await owner.ok<Page<CompanyCurrency>>("GET", `/companies/${companyId}/currencies`))
      .items.find((value) => value.code === "YER")!;
  }
  async function member(companyId: number, permissions: Permission[], index: number) {
    const client = new Client(baseUrl);
    const session = await client.ok<SessionResponse>("POST", "/auth/register", {
      name: "Coverage employee", displayName: "Employee", email: `employee${index}@coverage.test`,
      phone: "", password,
    }, 201);
    const employee = (await owner.ok<{ employee: Employee }>("POST", `/companies/${companyId}/employees`, {
      userId: session.user!.id, name: "Employee", phone: "", role: "employee", active: true, permissions,
    }, 201)).employee;
    return { client, employee };
  }
  return { pool: runtime.pool, owner, user, company, currency, member, anonymous: () => new Client(baseUrl) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function itemBody(currencyId: number, overrides: Record<string, unknown> = {}) {
  return {
    name: "صنف الكفاية", currencyId, unit1Name: "باكت", unit2Name: "شريط", unit3Name: "حبة",
    factor2: 2, factor3: 3, idempotencyKey: randomUUID(), ...overrides,
  };
}
async function item(f: Fixture, companyId: number, currencyId: number, overrides: Record<string, unknown> = {}) {
  return (await f.owner.ok<{ item: CoverageItem }>(
    "POST", `/companies/${companyId}/items`, itemBody(currencyId, overrides), 201,
  )).item;
}
function patchBody(value: CoverageItem, overrides: Record<string, unknown> = {}) {
  return {
    name: value.name, currencyId: value.currencyId,
    unit1Name: value.unit1Name, unit2Name: value.unit2Name, unit3Name: value.unit3Name,
    factor2: value.factor2, factor3: value.factor3, revision: value.revision, ...overrides,
  };
}
async function coverage(client: Client, companyId: number, itemId: number) {
  return (await client.ok<{ coverage: Coverage }>("GET", `/companies/${companyId}/items/${itemId}/coverage`)).coverage;
}

async function seedCoverage(
  f: Fixture, companyId: number, saved: CoverageItem, stock: string, monthlyNet: string, fourMonthNet: string,
) {
  // These are read projections, deliberately seeded independently of the implementation.
  // Real invoice posting/projection refresh behavior is covered by commerce/activity tests.
  await f.pool.query(
    "UPDATE item_statistics SET stock_total=$3,stock_showroom=$3,stock_warehouse=0 WHERE company_id=$1 AND item_id=$2",
    [companyId, saved.id, stock],
  );
  const monthly = BigInt(monthlyNet), older = BigInt(fourMonthNet) - monthly;
  for (const [offset, net] of [["0 days", monthly], ["2 months", older]] as const) {
    await f.pool.query(
      `INSERT INTO item_daily_activity(company_id,item_id,document_date,sale_quantity,sale_return_quantity)
       VALUES($1,$2,((clock_timestamp() AT TIME ZONE 'Asia/Aden')::date-$3::interval)::date,$4,$5)`,
      [companyId, saved.id, offset, net >= 0n ? net.toString() : "0", net < 0n ? (-net).toString() : "0"],
    );
  }
}

test("item reserve quantity is exact, normalized, revisioned, audited and compatible with omitted legacy defaults", async (t) => {
  const f = await fixture(t), company = await f.company(), currency = await f.currency(company.id);
  const path = `/companies/${company.id}/items`;
  const body = itemBody(currency.id, { reserveQuantity: " ۰۰۹۰۰۷۱۹۹۲۵۴۷۴۰۹۹۳ " });
  const created = (await f.owner.ok<{ item: CoverageItem }>("POST", path, body, 201)).item;
  assert.equal(created.reserveQuantity, "9007199254740993");
  const replay = (await f.owner.ok<{ item: CoverageItem }>("POST", path, {
    ...body, reserveQuantity: "9007199254740993",
  })).item;
  assert.equal(replay.id, created.id);
  assert.equal((await f.owner.request("POST", path, { ...body, reserveQuantity: "1" })).status, 409);
  const changed = (await f.owner.ok<{ item: CoverageItem }>("PATCH", `${path}/${created.id}`,
    patchBody(created, { reserveQuantity: " ٠٠٧ " }),
  )).item;
  assert.equal(changed.reserveQuantity, "7");
  assert.equal(changed.revision, created.revision + 1);
  const event = (await f.pool.query(
    "SELECT before_value,after_value FROM audit_events WHERE company_id=$1 AND target_type='item' AND target_id=$2 AND action='item.update' ORDER BY id DESC LIMIT 1",
    [company.id, created.id],
  )).rows[0]!;
  assert.equal(event.before_value.reserveQuantity, "9007199254740993");
  assert.equal(event.after_value.reserveQuantity, "7");
  const omitted = (await f.owner.ok<{ item: CoverageItem }>("PATCH", `${path}/${created.id}`,
    patchBody(changed, { name: "اسم جديد دون تغيير الاحتياط" }),
  )).item;
  assert.equal(omitted.reserveQuantity, "7", "An older editor must preserve reserve when it omits the new field");
  assert.equal((await f.owner.request("PATCH", `${path}/${created.id}`,
    patchBody(changed, { reserveQuantity: "99" }),
  )).status, 409);
  assert.equal((await f.owner.ok<{ item: CoverageItem }>("GET", `${path}/${created.id}`)).item.reserveQuantity, "7");

  const legacyBody = itemBody(currency.id, { name: "افتراضي سابق" });
  const defaults = (await f.owner.ok<{ item: CoverageItem }>("POST", path, legacyBody, 201)).item;
  assert.equal(defaults.reserveQuantity, "0");
  // Seed a genuinely old accepted payload on INSERT; identity protection stays active.
  const legacyRetryBody = { ...legacyBody, idempotencyKey: randomUUID() };
  const legacy = (await f.pool.query(
    `INSERT INTO items(company_id,code,name,unit1_name,unit2_name,unit3_name,factor2,factor3,currency_id,created_by,idempotency_key,creation_payload)
     SELECT company_id,'90000000',name,unit1_name,unit2_name,unit3_name,factor2,factor3,currency_id,created_by,$2::uuid,
       (creation_payload-'reserveQuantity') || jsonb_build_object('idempotencyKey',$2::uuid::text)
     FROM items WHERE company_id=$3 AND id=$1 RETURNING id`,
    [defaults.id, legacyRetryBody.idempotencyKey, company.id],
  )).rows[0]!;
  assert.equal((await f.owner.ok<{ item: CoverageItem }>("POST", path, legacyRetryBody)).item.id, legacy.id);
  assert.equal((await f.owner.ok<{ item: CoverageItem }>("POST", path, { ...legacyRetryBody, reserveQuantity: "0" })).item.id, legacy.id);
  assert.equal((await f.owner.request("POST", path, { ...legacyRetryBody, reserveQuantity: "1" })).status, 409);
  assert.equal((await f.pool.query("SELECT creation_payload ? 'reserveQuantity' AS present FROM items WHERE id=$1", [legacy.id])).rows[0]!.present, false);

  const before = (await f.pool.query("SELECT count(*)::int AS count FROM audit_events WHERE company_id=$1 AND target_type='item'", [company.id])).rows[0]!.count;
  for (const reserveQuantity of ["-1", "1.5", "1e3", "10000000000000000000000", "", 1, null]) {
    assert.equal((await f.owner.request("POST", path, itemBody(currency.id, { reserveQuantity }))).status, 400);
    assert.equal((await f.owner.request("PATCH", `${path}/${created.id}`,
      patchBody(omitted, { reserveQuantity }),
    )).status, 400);
  }
  assert.equal((await f.pool.query("SELECT count(*)::int AS count FROM audit_events WHERE company_id=$1 AND target_type='item'", [company.id])).rows[0]!.count, before);
  const maximum = await item(f, company.id, currency.id, { reserveQuantity: "9999999999999999999999" });
  assert.equal(maximum.reserveQuantity, "9999999999999999999999");
  assert.equal(maximum.code, "00000003", "Invalid requests and accepted retries must not allocate item codes");
});

test("coverage uses monthly net sales from two upward, four months below two, and exact reserve/clamp rules", async (t) => {
  const f = await fixture(t), company = await f.company(), currency = await f.currency(company.id);
  const vectors = [
    { name: "one", stock: "12", reserve: "2", month: "1", four: "12", approximate: "120", after: "100" },
    { name: "two", stock: "12", reserve: "2", month: "2", four: "120", approximate: "180", after: "150" },
    { name: "zero-month-fallback", stock: "12", reserve: "2", month: "0", four: "12", approximate: "120", after: "100" },
    { name: "negative-month-fallback", stock: "12", reserve: "2", month: "-1", four: "12", approximate: "120", after: "100" },
    { name: "zero-selected-sales", stock: "12", reserve: "2", month: "1", four: "0", approximate: "9999", after: "9999" },
    { name: "negative-selected-sales", stock: "12", reserve: "2", month: "-2", four: "-1", approximate: "9999", after: "9999" },
    { name: "reserve-exceeds-stock", stock: "5", reserve: "9", month: "2", four: "2", approximate: "75", after: "0" },
    { name: "reserve-equals-stock-no-sales", stock: "5", reserve: "5", month: "0", four: "0", approximate: "9999", after: "0" },
    { name: "zero-stock-with-sales", stock: "0", reserve: "0", month: "2", four: "2", approximate: "0", after: "0" },
    { name: "zero-stock-no-sales", stock: "0", reserve: "0", month: "0", four: "0", approximate: "9999", after: "0" },
    { name: "negative-stock", stock: "-5", reserve: "0", month: "2", four: "2", approximate: "-75", after: "0" },
    { name: "round-to-two", stock: "1", reserve: "0", month: "7", four: "7", approximate: "4.29", after: "4.29" },
    { name: "half-up", stock: "1", reserve: "0", month: "16", four: "16", approximate: "1.88", after: "1.88" },
    { name: "large-exact", stock: "9007199254740993", reserve: "9007199254740992", month: "2", four: "2", approximate: "135107988821114895", after: "15" },
  ];
  const expected = new Map<number, typeof vectors[number]>();
  for (const vector of vectors) {
    const saved = await item(f, company.id, currency.id, { name: vector.name, reserveQuantity: vector.reserve });
    expected.set(saved.id, vector);
    await seedCoverage(f, company.id, saved, vector.stock, vector.month, vector.four);
    const result = await coverage(f.owner, company.id, saved.id);
    assert.equal(result.canViewCoverage, true, vector.name);
    assert.equal(result.companyId, company.id);
    assert.equal(result.itemId, saved.id);
    assert.equal(result.unitName, "حبة");
    assert.match(result.asOf, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(result.approximateCoverageDays, vector.approximate, vector.name);
    assert.equal(result.coverageAfterReserveDays, vector.after, vector.name);
  }
  // Monthly rolling boundary belongs only to four months; four-month and future rows are excluded.
  const boundary = await item(f, company.id, currency.id, { name: "window-boundaries", reserveQuantity: "2" });
  await seedCoverage(f, company.id, boundary, "12", "1", "1");
  await f.pool.query(
    `INSERT INTO item_daily_activity(company_id,item_id,document_date,sale_quantity)
     SELECT $1,$2,((clock_timestamp() AT TIME ZONE 'Asia/Aden')::date+offset_value)::date,quantity
     FROM (VALUES (-interval '1 month',11::numeric),(-interval '4 months',900::numeric),(interval '1 day',900::numeric)) AS v(offset_value,quantity)`,
    [company.id, boundary.id],
  );
  const atBoundary = await coverage(f.owner, company.id, boundary.id);
  assert.equal(atBoundary.approximateCoverageDays, "120");
  assert.equal(atBoundary.coverageAfterReserveDays, "100");

  const listed = await f.owner.ok<Page<CoverageItem>>("GET", `/companies/${company.id}/items?pageSize=100`);
  for (const row of listed.items) {
    const vector = expected.get(row.id);
    if (!vector) continue;
    assert.equal(row.approximateCoverageDays, vector.approximate, vector.name);
    assert.equal(row.coverageAfterReserveDays, vector.after, vector.name);
  }
  // Values 4.29, 75 and 120 distinguish numeric order from string order.
  const sorted = await f.owner.ok<Page<CoverageItem>>("GET", `/companies/${company.id}/items?sort=approximateCoverageDays:asc&pageSize=100`);
  const numbers = sorted.items.map((row) => Number(row.approximateCoverageDays));
  assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b));
  const afterSorted = await f.owner.ok<Page<CoverageItem>>("GET", `/companies/${company.id}/items?sort=coverageAfterReserveDays:desc&pageSize=100`);
  const afterNumbers = afterSorted.items.map((row) => Number(row.coverageAfterReserveDays));
  assert.deepEqual(afterNumbers, [...afterNumbers].sort((a, b) => b - a));

  // Available stock is pooled in smallest units and sorted by the first unit
  // before pagination, not by formatted strings or the current page alone.
  const pooled = await f.owner.ok<Page<CoverageItem>>(
    "GET", `/companies/${company.id}/items?sort=availableUnit1:desc&pageSize=100`,
  );
  const firstUnitValues = pooled.items.map(row => Number(row.availableSmallest ?? "0") / (row.factor2 * row.factor3));
  assert.deepEqual(firstUnitValues, [...firstUnitValues].sort((a, b) => b - a));
  for (const row of pooled.items) {
    const vector = expected.get(row.id);
    if (vector) assert.equal(row.availableSmallest, vector.stock, vector.name);
  }

  const reportByStock = (await f.owner.ok<{ report: ItemActivityReport }>(
    "GET", `/companies/${company.id}/item-statistics-report?sortBy=availableUnit1&sortDir=asc&pageSize=100`,
  )).report;
  assert.equal(reportByStock.canViewStock, true);
  assert.equal(reportByStock.canViewCoverage, true);
  const reportStock = reportByStock.rows.map(row => Number(row.availableSmallest ?? "0") / (row.factor2 * row.factor3));
  assert.deepEqual(reportStock, [...reportStock].sort((a, b) => a - b));
  const reportByCoverage = (await f.owner.ok<{ report: ItemActivityReport }>(
    "GET", `/companies/${company.id}/item-statistics-report?sortBy=approximateCoverageDays&sortDir=desc&pageSize=100`,
  )).report;
  const days = reportByCoverage.rows.map(row => Number(row.approximateCoverageDays));
  assert.deepEqual(days, [...days].sort((a, b) => b - a));
});

test("returns location stock remains in inventory but never inflates item coverage", async (t) => {
  const f = await fixture(t);
  const company = await f.company();
  const currency = await f.currency(company.id);
  const branches = await f.owner.ok<Page<Branch>>("GET", `/companies/${company.id}/branches`);
  const branch = branches.items[0]!;
  const locations = await f.owner.ok<Page<Location>>("GET", `/companies/${company.id}/locations?branchId=${branch.id}`);
  const showroom = locations.items.find(row => row.kind === "showroom")!;
  const warehouse = (await f.owner.ok<{ location: Location }>(
    "POST", `/companies/${company.id}/locations`,
    { branchId: branch.id, name: "المخزن العادي", kind: "warehouse" }, 201,
  )).location;
  const returns = (await f.owner.ok<{ location: Location }>(
    "POST", `/companies/${company.id}/locations`,
    { branchId: branch.id, name: "مرتجعات العملاء", kind: "returns" }, 201,
  )).location;
  const saved = await item(f, company.id, currency.id, { reserveQuantity: "5" });
  for (const [location, quantity] of [[showroom, "30"], [warehouse, "20"], [returns, "40"]] as const) {
    await f.pool.query(
      "INSERT INTO stock_balances(company_id,item_id,location_id,quantity_smallest) VALUES($1,$2,$3,$4)",
      [company.id, saved.id, location.id, quantity],
    );
  }
  await f.pool.query(
    `INSERT INTO item_daily_activity(company_id,item_id,document_date,sale_quantity)
     VALUES($1,$2,(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Aden')::date,20)`,
    [company.id, saved.id],
  );
  const aggregate = (await f.pool.query(
    "SELECT stock_total::text,stock_showroom::text,stock_warehouse::text,stock_returns::text FROM item_statistics WHERE company_id=$1 AND item_id=$2",
    [company.id, saved.id],
  )).rows[0]!;
  assert.deepEqual(aggregate, {
    stock_total: "90", stock_showroom: "30", stock_warehouse: "20", stock_returns: "40",
  });
  const stats = await coverage(f.owner, company.id, saved.id);
  assert.equal(stats.approximateCoverageDays, "75"); // 50 sellable * 30 / 20
  assert.equal(stats.coverageAfterReserveDays, "67.5"); // (50 - 5) * 30 / 20
  const list = await f.owner.ok<Page<CoverageItem>>("GET", `/companies/${company.id}/items`);
  const row = list.items.find(value => value.id === saved.id)!;
  assert.equal(row.availableSmallest, "90", "Physical stock remains the pooled total");
  assert.equal(row.approximateCoverageDays, stats.approximateCoverageDays);
  assert.equal(row.coverageAfterReserveDays, stats.coverageAfterReserveDays);
  const sorted = await f.owner.ok<Page<CoverageItem>>(
    "GET", `/companies/${company.id}/items?sort=approximateCoverageDays:asc`,
  );
  assert.equal(sorted.items.find(value => value.id === saved.id)?.approximateCoverageDays, "75");
  const report = (await f.owner.ok<{ report: ItemActivityReport }>(
    "GET", `/companies/${company.id}/item-statistics-report?sortBy=approximateCoverageDays&sortDir=desc`,
  )).report;
  assert.equal(report.rows.find(value => value.itemId === saved.id)?.approximateCoverageDays, "75");
  await f.pool.query(
    "UPDATE stock_balances SET quantity_smallest=70 WHERE company_id=$1 AND item_id=$2 AND location_id=$3",
    [company.id, saved.id, returns.id],
  );
  assert.equal((await coverage(f.owner, company.id, saved.id)).approximateCoverageDays, "75");
  assert.equal((await f.pool.query(
    "SELECT stock_total::text,stock_returns::text FROM item_statistics WHERE company_id=$1 AND item_id=$2",
    [company.id, saved.id],
  )).rows[0].stock_total, "120");
});

test("coverage is company scoped and redacted by inventory, commerce, explicit denies and page availability", async (t) => {
  const f = await fixture(t), company = await f.company(), other = await f.company("Other company");
  const saved = await item(f, company.id, (await f.currency(company.id)).id, { reserveQuantity: "2" });
  const foreign = await item(f, other.id, (await f.currency(other.id)).id);
  await seedCoverage(f, company.id, saved, "12", "2", "2");
  const path = `/companies/${company.id}/items/${saved.id}/coverage`;
  assert.equal((await f.anonymous().request("GET", path)).status, 401);
  assert.equal((await f.owner.request("GET", `/companies/${company.id}/items/${foreign.id}/coverage`)).status, 404);
  assert.equal((await f.owner.request("GET", `/companies/${other.id}/items/${saved.id}/coverage`)).status, 404);
  const allowed = await f.member(company.id, ["items.view", "inventory.view", "commerce.view"], 1);
  assert.equal((await coverage(allowed.client, company.id, saved.id)).approximateCoverageDays, "180");
  assert.equal((await allowed.client.request("GET", `/companies/${other.id}/items/${foreign.id}/coverage`)).status, 403);
  async function assertRedacted(client: Client) {
    const report = await coverage(client, company.id, saved.id);
    assert.equal(report.canViewCoverage, false);
    assert.equal(report.approximateCoverageDays, null);
    assert.equal(report.coverageAfterReserveDays, null);
    const list = await client.ok<Page<CoverageItem>>("GET", `/companies/${company.id}/items?sort=approximateCoverageDays:asc`);
    assert.equal(list.items[0]!.approximateCoverageDays, null);
    assert.equal(list.items[0]!.coverageAfterReserveDays, null);
    assert.equal(list.items[0]!.reserveQuantity, "2");
  }
  await assertRedacted((await f.member(company.id, ["items.view"], 2)).client);
  await assertRedacted((await f.member(company.id, ["items.view", "commerce.view"], 3)).client);
  await assertRedacted((await f.member(company.id, ["items.view", "inventory.view"], 4)).client);
  assert.equal((await (await f.member(company.id, ["inventory.view", "commerce.view"], 5)).client.request("GET", path)).status, 403);
  await f.pool.query(
    "INSERT INTO employee_permission_rules(company_id,employee_id,permission_key,effect,created_by) VALUES($1,$2,'company.invoice:view','deny',$3)",
    [company.id, allowed.employee.id, f.user.id],
  );
  await assertRedacted(allowed.client);
  await f.pool.query("UPDATE employee_permission_rules SET active=false WHERE company_id=$1 AND employee_id=$2", [company.id, allowed.employee.id]);
  assert.equal((await coverage(allowed.client, company.id, saved.id)).canViewCoverage, true);
  for (const key of ["company.stock-balances", "company.stock-movements", "company.sales", "company.purchases", "company.invoice"]) {
    const disabled = (await f.owner.ok<{ page: PageEntry }>("PUT", `/page-catalog/${key}/settings`, {
      companyId: company.id, visible: true, enabled: false, order: 100, revision: null,
    })).page;
    await assertRedacted(allowed.client);
    await f.owner.ok("PUT", `/page-catalog/${key}/settings`, {
      companyId: company.id, visible: true, enabled: true, order: 100, revision: disabled.revision,
    });
  }
  assert.equal((await coverage(allowed.client, company.id, saved.id)).canViewCoverage, true);
});
