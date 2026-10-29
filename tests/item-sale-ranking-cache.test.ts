import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool, type PoolClient } from "pg";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import type {
  Account, Branch, Company, CompanyCurrency, Employee, Item, Location, Page,
  Permission, SessionResponse,
} from "../packages/contracts/src/index.ts";
import type { Invoice } from "../packages/contracts/src/commerce.ts";
import { itemLookupSearchPlan } from "../apps/api/src/services/item-lookup-search.ts";

// Disposable schemas and test-only credentials; this suite never contacts production.
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const password = "Sale-ranking-cache-test-2026";
const origin = "http://localhost";

class Client {
  private cookie = "";
  private csrf = "";
  constructor(private readonly baseUrl: string) {}
  async request<T>(method: string, path: string, body?: unknown) {
    const response = await fetch(`${this.baseUrl}/api${path}`, {
      method,
      headers: {
        accept: "application/json", cookie: this.cookie,
        ...(method === "GET" ? {} : {
          "content-type": "application/json", origin, "x-csrf-token": this.csrf,
        }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const value of response.headers.getSetCookie())
      this.cookie = value.split(";", 1)[0]!;
    const result = await response.json() as T;
    if (result && typeof result === "object" && "csrf" in result)
      this.csrf = (result as unknown as SessionResponse).csrf ?? "";
    return { status: response.status, body: result };
  }
  async ok<T>(method: string, path: string, body?: unknown, status = 200) {
    const response = await this.request<T>(method, path, body);
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(response.body)}`);
    return response.body;
  }
}

async function fixture(t: TestContext) {
  const schema = `sale_rank_${randomUUID().replaceAll("-", "")}`;
  const runtime = await createApp({
    databaseUrl, schema, appOrigin: origin, production: false, serveStatic: false,
  });
  const server = runtime.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve); server.once("error", reject);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()),
    );
    await runtime.close();
    const cleanup = new Pool({ connectionString: databaseUrl });
    try { await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await cleanup.end(); }
  });
  const user = await provisionOwner(runtime.pool, {
    name: "Sale ranking owner", displayName: "Owner", email: "owner@rank.test", password,
  });
  const owner = new Client(baseUrl);
  await owner.ok("POST", "/auth/login", { email: user.email, password });
  const company = async (name = "Sale ranking company") =>
    (await owner.ok<{ company: Company }>("POST", "/companies", { name, phone: "", address: "" }, 201)).company;
  const currency = async (companyId: number) =>
    (await owner.ok<Page<CompanyCurrency>>("GET", `/companies/${companyId}/currencies`))
      .items.find(value => value.code === "YER")!;
  const item = async (companyId: number, currencyId: number, extra: Record<string, unknown> = {}) =>
    (await owner.ok<{ item: Item }>("POST", `/companies/${companyId}/items`, {
      idempotencyKey: randomUUID(), name: "صنف مشترك للبحث", currencyId,
      unit1Name: "حبة", unit2Name: "حبة", unit3Name: "حبة", factor2: 1, factor3: 1,
      hasExpiry: false, salePrice1: "10", salePrice2: "10", salePrice3: "10",
      purchasePrice: "2", ...extra,
    }, 201)).item;
  async function member(companyId: number, permissions: Permission[]) {
    const client = new Client(baseUrl);
    const session = await client.ok<SessionResponse>("POST", "/auth/register", {
      name: "Item reader", displayName: "Reader", email: "reader@rank.test", phone: "", password,
    }, 201);
    await owner.ok<{ employee: Employee }>("POST", `/companies/${companyId}/employees`, {
      userId: session.user!.id, name: "Reader", phone: "", role: "employee", active: true, permissions,
    }, 201);
    return client;
  }
  return { ...runtime, schema, owner, company, currency, item, member };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function cached(
  db: Pool | PoolClient, companyId: number, itemId: number, day: string,
): Promise<string> {
  const result = await db.query<{ net: string }>(
    `SELECT net_sale_invoices::text AS net FROM item_sale_rankings
     WHERE company_id=$1 AND item_id=$2 AND as_of_date=$3::date`,
    [companyId, itemId, day],
  );
  return result.rows[0]?.net ?? "0";
}

async function daily(
  f: Fixture, companyId: number, itemId: number, day: string, sales: string, returns = "0",
) {
  await f.pool.query(
    `INSERT INTO item_daily_activity(company_id,item_id,document_date,sale_invoices,sale_return_invoices)
     VALUES($1,$2,$3::date,$4::bigint,$5::bigint)`,
    [companyId, itemId, day, sales, returns],
  );
}

async function waitForBlock(pool: Pool, blockedPid: number, blockerPid: number) {
  const deadline = Date.now() + 5000;
  let waiting = false;
  do {
    waiting = (await pool.query<{ waiting: boolean }>(
      "SELECT $2::integer=ANY(pg_blocking_pids($1::integer)) AS waiting",
      [blockedPid, blockerPid],
    )).rows[0]!.waiting;
    if (!waiting) await delay(10);
  } while (!waiting && Date.now() < deadline);
  assert(waiting, "The competing transaction reached the expected database lock");
}

test("monthly sale ranking cache preserves calendar boundaries, signed exact counts and transactional source changes", async t => {
  const f = await fixture(t), c = await f.company(), currency = await f.currency(c.id);
  const product = await f.item(c.id, currency.id);
  const other = await f.company("Other ranking tenant"), otherCurrency = await f.currency(other.id);
  const otherProduct = await f.item(other.id, otherCurrency.id);
  // A 31st-day month subtraction clamps to February before adding one day.
  await f.pool.query("SELECT prepare_item_sale_rankings($1::date)", ["2026-03-31"]);
  for (const [day, sales] of [
    ["2026-02-28", "1000"], ["2026-03-01", "7"], ["2026-03-31", "11"], ["2026-04-01", "13"],
  ]) await daily(f, c.id, product.id, day!, sales!);
  await daily(f, other.id, otherProduct.id, "2026-03-31", "9007199254740993", "2");
  assert.equal(await cached(f.pool, c.id, product.id, "2026-03-31"), "18");
  assert.equal(await cached(f.pool, c.id, product.id, "2026-04-01"), "24");
  assert.equal(await cached(f.pool, other.id, otherProduct.id, "2026-03-31"), "9007199254740991");
  await f.pool.query(
    "UPDATE item_daily_activity SET sale_invoices=8 WHERE company_id=$1 AND item_id=$2 AND document_date='2026-03-01'",
    [c.id, product.id],
  );
  assert.equal(await cached(f.pool, c.id, product.id, "2026-03-31"), "19");
  await f.pool.query(
    "UPDATE item_daily_activity SET document_date='2026-03-02' WHERE company_id=$1 AND item_id=$2 AND document_date='2026-03-01'",
    [c.id, product.id],
  );
  assert.equal(await cached(f.pool, c.id, product.id, "2026-04-01"), "32", "Moving a source day updates tomorrow's prepared rank");
  await f.pool.query(
    "DELETE FROM item_daily_activity WHERE company_id=$1 AND item_id=$2 AND document_date='2026-03-02'",
    [c.id, product.id],
  );
  assert.equal(await cached(f.pool, c.id, product.id, "2026-03-31"), "11");
  const transaction = await f.pool.connect();
  try {
    await transaction.query("BEGIN");
    await transaction.query(
      "UPDATE item_daily_activity SET sale_invoices=0,sale_return_invoices=5 WHERE company_id=$1 AND item_id=$2 AND document_date='2026-03-31'",
      [c.id, product.id],
    );
    assert.equal(await cached(transaction, c.id, product.id, "2026-03-31"), "-5");
    await transaction.query("ROLLBACK");
  } finally { transaction.release(); }
  assert.equal(await cached(f.pool, c.id, product.id, "2026-03-31"), "11", "Source and cache roll back together");
  await Promise.all([
    daily(f, c.id, product.id, "2026-03-29", "2"),
    daily(f, c.id, product.id, "2026-03-30", "0", "17"),
  ]);
  assert.equal(await cached(f.pool, c.id, product.id, "2026-03-31"), "-4", "Concurrent daily changes cannot lose a signed update");
  await f.pool.query("SELECT prepare_item_sale_rankings($1::date)", ["2026-04-01"]);
  assert.equal(await cached(f.pool, c.id, product.id, "2026-04-01"), "9", "Tomorrow's prepared value remains valid at rollover");
  assert.equal((await f.pool.query(
    "SELECT count(*)::integer AS n FROM item_sale_ranking_days WHERE as_of_date<'2026-03-31'",
  )).rows[0]!.n, 0);
  await f.pool.query("DELETE FROM item_daily_activity WHERE company_id=$1", [c.id]);
  assert.equal(await cached(f.pool, c.id, product.id, "2026-04-01"), "0", "Reset-style source deletion clears ready ranks");
  assert.equal(await cached(f.pool, other.id, otherProduct.id, "2026-04-01"), "9007199254740991");

  // An invoice may have written its source fact before waiting on the company
  // lock held by the daily preparer. Its trigger must add the fact exactly once
  // after preparation commits, even though the rebuild could not see that fact.
  const preparer = await f.pool.connect(), writer = await f.pool.connect();
  let preparing = false, pendingWrite: Promise<unknown> | undefined;
  try {
    await preparer.query("BEGIN");
    preparing = true;
    const preparerPid = (await preparer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    const writerPid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    await preparer.query("LOCK TABLE companies IN EXCLUSIVE MODE");
    pendingWrite = writer.query(
      `INSERT INTO item_daily_activity(company_id,item_id,document_date,sale_invoices)
       VALUES($1,$2,'2026-04-03',9)`,
      [c.id, product.id],
    );
    await waitForBlock(f.pool, writerPid, preparerPid);
    await preparer.query("SELECT prepare_item_sale_rankings($1::date)", ["2026-04-02"]);
    assert.equal(await cached(preparer, c.id, product.id, "2026-04-03"), "0", "Uncommitted source facts are not included by the preparer");
    await preparer.query("COMMIT");
    preparing = false;
    await pendingWrite;
    assert.equal(await cached(f.pool, c.id, product.id, "2026-04-03"), "9", "The waiting writer applies its delta exactly once to the newly prepared day");
    assert.equal(await cached(f.pool, c.id, product.id, "2026-04-02"), "0", "The future fact remains excluded from the prior day");
  } finally {
    if (preparing) await preparer.query("ROLLBACK");
    if (pendingWrite) await Promise.allSettled([pendingWrite]);
    preparer.release(); writer.release();
  }

  // Normal company edits lock the row before UPDATE acquires its table lock.
  // A preparer queued behind that transaction must not block the lock upgrade.
  const editor = await f.pool.connect(), nextPreparer = await f.pool.connect();
  let editing = false, pendingPreparation: Promise<unknown> | undefined;
  try {
    await editor.query("BEGIN");
    editing = true;
    await editor.query("SET LOCAL statement_timeout='5s'");
    const editorPid = (await editor.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    const preparerPid = (await nextPreparer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    await editor.query("SELECT id FROM companies WHERE id=$1 FOR UPDATE", [c.id]);
    pendingPreparation = nextPreparer.query("SELECT prepare_item_sale_rankings($1::date)", ["2026-04-03"]);
    await waitForBlock(f.pool, preparerPid, editorPid);
    await editor.query("UPDATE companies SET name=name WHERE id=$1", [c.id]);
    await editor.query("COMMIT");
    editing = false;
    await pendingPreparation;
    assert.equal((await f.pool.query(
      "SELECT count(*)::integer AS n FROM item_sale_ranking_days WHERE as_of_date='2026-04-04'",
    )).rows[0]!.n, 1, "Preparation completes after the concurrent company edit without a deadlock");
  } finally {
    if (editing) await editor.query("ROLLBACK");
    if (pendingPreparation) await Promise.allSettled([pendingPreparation]);
    editor.release(); nextPreparer.release();
  }
});

test("item and invoice search read prepared ranks with exact-match precedence, paging, permissions and readiness", async t => {
  const f = await fixture(t), c = await f.company(), currency = await f.currency(c.id);
  const products: Item[] = [];
  for (let index = 0; index < 4; index++) products.push(await f.item(c.id, currency.id, {
    name: `صنف مشترك ${index}`, searchKeys: "RANK-EXACT", ...(index === 2 ? { barcode: "RANK-EXACT" } : {}),
  }));
  const today = (await f.pool.query<{ day: string }>(
    "SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Aden')::date::text AS day",
  )).rows[0]!.day;
  await daily(f, c.id, products[0]!.id, today, "1");
  await daily(f, c.id, products[1]!.id, today, "5");
  await daily(f, c.id, products[2]!.id, today, "0", "2");
  // Invert the daily-fact order deliberately: the search must use the prepared
  // table, rather than quietly recomputing the source aggregate on read.
  await f.pool.query(
    "UPDATE item_sale_rankings SET net_sale_invoices=100 WHERE company_id=$1 AND item_id=$2 AND as_of_date=$3::date",
    [c.id, products[0]!.id, today],
  );
  const other = await f.company("Search isolation tenant"), otherCurrency = await f.currency(other.id);
  const outsider = await f.item(other.id, otherCurrency.id);
  await daily(f, other.id, outsider.id, today, "9999");
  for (const endpoint of [
    `/companies/${c.id}/items`, `/companies/${c.id}/commerce-options?type=items`,
  ]) {
    const separator = endpoint.includes("?") ? "&" : "?";
    const query = `${separator}q=${encodeURIComponent("مشترك")}&sort=saleTimes:desc,code:asc&pageSize=2`;
    const first = await f.owner.ok<Page<Item>>("GET", `${endpoint}${query}&page=1`);
    const second = await f.owner.ok<Page<Item>>("GET", `${endpoint}${query}&page=2`);
    assert.equal(first.total, 4);
    assert.deepEqual([...first.items, ...second.items].map(value => value.id),
      [products[0]!.id, products[1]!.id, products[3]!.id, products[2]!.id]);
    const exact = await f.owner.ok<Page<Item>>("GET", `${endpoint}${separator}q=RANK-EXACT&sort=saleTimes:desc,code:asc`);
    assert.equal(exact.items[0]!.id, products[2]!.id, "An exact barcode still beats a more popular partial match");
  }
  const reader = await f.member(c.id, ["items.view"]);
  const restricted = await reader.ok<Page<Item>>("GET", `/companies/${c.id}/items?q=${encodeURIComponent("مشترك")}&sort=saleTimes:desc,code:asc`);
  assert.deepEqual(restricted.items.map(value => value.id), products.map(value => value.id), "Items-only access cannot infer hidden sales ranks");
  assert.equal((await reader.request("GET", `/companies/${other.id}/items`)).status, 403);
  await f.pool.query("DELETE FROM item_sale_ranking_days WHERE as_of_date=$1::date", [today]);
  for (const endpoint of [`/companies/${c.id}/items`, `/companies/${c.id}/commerce-options?type=items`])
    assert.equal((await f.owner.request("GET", endpoint)).status, 503, "A missing prepared day must not trigger search-time rebuilding or silently return zero ranks");
  assert.equal((await reader.request("GET", `/companies/${c.id}/items`)).status, 200);
  await f.pool.query("SELECT prepare_item_sale_rankings()");
  const restored = await f.owner.ok<Page<Item>>("GET", `/companies/${c.id}/commerce-options?type=items`);
  assert.equal(restored.items[0]!.id, products[1]!.id, "Preparation restores ranks from committed facts outside the search request");
});

test("real invoice posting updates prepared ranks once per invoice and rolls back on failure", async t => {
  const f = await fixture(t), c = await f.company(), currency = await f.currency(c.id), path = `/companies/${c.id}`;
  await f.owner.ok("PUT", `${path}/control/sales_doctor_threshold`, { value: 999999999, employeeId: null, revision: null });
  const branch = (await f.owner.ok<Page<Branch>>("GET", `${path}/branches`)).items[0]!;
  const location = (await f.owner.ok<Page<Location>>("GET", `${path}/locations`)).items[0]!;
  const counterparty = (await f.owner.ok<{ account: Account }>("POST", `${path}/accounts`, {
    name: "Ranking customer", kind: "posting", category: "asset", normalSide: "debit", parentId: null,
  }, 201)).account;
  const product = await f.item(c.id, currency.id);
  const today = (await f.pool.query<{ day: string }>(
    "SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Aden')::date::text AS day",
  )).rows[0]!.day;
  function body(kind: "sale" | "purchase", quantities: string[]) {
    return {
      idempotencyKey: randomUUID(), kind, documentDate: today, currencyId: currency.id,
      branchId: branch.id, locationId: location.id, counterpartyAccountId: counterparty.id,
      discount: "0", lines: quantities.map(quantity => ({
        itemId: product.id, unit: 1, quantity, expiryDate: null,
        ...(kind === "purchase" ? { unitPrice: "2" } : {}),
      })),
    };
  }
  await f.owner.ok("POST", `${path}/invoices`, body("purchase", ["100"]), 201);
  assert.equal(await cached(f.pool, c.id, product.id, today), "0");
  const salePayload = body("sale", ["1", "2"]);
  const sale = (await f.owner.ok<{ invoice: Invoice }>("POST", `${path}/invoices`, salePayload, 201)).invoice;
  assert.equal(await cached(f.pool, c.id, product.id, today), "1", "Multiple positive lines count as one invoice occurrence");
  const replay = (await f.owner.ok<{ invoice: Invoice }>("POST", `${path}/invoices`, salePayload, 201)).invoice;
  assert.equal(replay.id, sale.id);
  assert.equal(await cached(f.pool, c.id, product.id, today), "1", "An accepted UUID retry must not increment again");
  await f.owner.ok("POST", `${path}/invoices`, body("sale", ["1", "-1"]), 201);
  assert.equal(await cached(f.pool, c.id, product.id, today), "1", "Mixed positive and negative occurrences cancel within one invoice");
  await f.owner.ok("POST", `${path}/invoices`, body("sale", ["-1"]), 201);
  await f.owner.ok("POST", `${path}/invoices`, body("sale", ["-1"]), 201);
  assert.equal(await cached(f.pool, c.id, product.id, today), "-1", "Negative net occurrence counts remain signed");
  await f.pool.query("CREATE FUNCTION reject_rank_invoice_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test audit failure'; END $$");
  await f.pool.query("CREATE TRIGGER reject_rank_invoice_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_rank_invoice_audit()");
  try {
    assert.equal((await f.owner.request("POST", `${path}/invoices`, body("sale", ["1"]))).status, 500);
  } finally {
    await f.pool.query("DROP TRIGGER reject_rank_invoice_audit ON audit_events");
    await f.pool.query("DROP FUNCTION reject_rank_invoice_audit()");
  }
  assert.equal(await cached(f.pool, c.id, product.id, today), "-1", "A failed invoice audit rolls back both facts and ready ranks");
  const facts = (await f.pool.query<{ net: string }>(
    "SELECT (sale_invoices-sale_return_invoices)::text AS net FROM item_daily_activity WHERE company_id=$1 AND item_id=$2 AND document_date=$3::date",
    [c.id, product.id, today],
  )).rows[0]!;
  assert.equal(facts.net, "-1");
});

test("indexed invoice and header item lookup narrows Arabic and composition matches before display joins", async t => {
  const f = await fixture(t), c = await f.company(), currency = await f.currency(c.id);
  const composition = (await f.owner.ok<{ composition: { id: number } }>(
    "POST", `/companies/${c.id}/item-compositions`, {
      idempotencyKey: randomUUID(), arabicName: "تركيبة اسبرين", englishName: "ASPIRIN COMBINATION",
      description: "", active: true, identicalAlternative: false, nonInterchangeable: false,
    }, 201)).composition;
  const named = await f.item(c.id, currency.id, {
    name: "اسبرين للاختبار", englishName: "Aspirin Test", compositionId: composition.id,
  });
  const compositionOnly = await f.item(c.id, currency.id, {
    name: "دواء باسم مختلف", compositionId: composition.id,
  });
  const literal = await f.item(c.id, currency.id, { name: "منتج برمز خاص", barcode: "TXT%_\\123" });
  await f.item(c.id, currency.id, { name: "اسبرين مؤرشف", active: false });
  const other = await f.company("Foreign text search"), otherCurrency = await f.currency(other.id);
  await f.item(other.id, otherCurrency.id, { name: "اسبرين من شركة أخرى" });
  // A representative 15k-card catalog makes the planner exercise the text
  // indexes, instead of a fixture so small that every search is a table scan.
  await f.pool.query(`INSERT INTO items(
    company_id,code,name,english_name,currency_id,unit1_name,has_expiry,
    created_by,idempotency_key,creation_payload
  ) SELECT $1::integer,lpad((500000+n)::text,8,'0'),'صنف تجريبي عادي '||n,
    'Unrelated catalog product '||n,$2::integer,'حبة',false,$3::integer,
    md5(($1::integer)::text||':lookup:'||n)::uuid,'{}'::jsonb FROM generate_series(1,15000) AS series(n)`,
  [c.id, currency.id, named.createdBy]);
  // Production builds the GIN index over the existing catalog. This fixture
  // inserts after migration, so flush its bulk-insert pending list first.
  await f.pool.query("VACUUM (ANALYZE) items");
  await f.pool.query("ANALYZE item_compositions; ANALYZE company_currencies");
  const base = `/companies/${c.id}/commerce-options?type=items&sort=saleTimes:desc,code:asc`;
  for (const q of ["اسبر", "aspirin", "تركيبة اسبرين"]) {
    const started = performance.now();
    const page = await f.owner.ok<Page<Item>>("GET", `${base}&q=${encodeURIComponent(q)}`);
    assert.deepEqual(page.items.map(row => row.id), [named.id, compositionOnly.id]);
    assert.equal(page.total, 2, "An own-text and composition match must not duplicate a card");
    console.log(`Header lookup ${q}: ${Math.round(performance.now() - started)}ms including the full HTTP request`);
  }
  for (const q of ["%", "_", "\\"])
    assert.deepEqual((await f.owner.ok<Page<Item>>("GET", `${base}&q=${encodeURIComponent(q)}`))
      .items.map(row => row.id), [literal.id], "Search wildcard characters stay literal");
  const plan = (await f.pool.query(`${itemLookupSearchPlan.withSql}
    SELECT i.id FROM items i WHERE i.company_id=$1 AND ${itemLookupSearchPlan.predicate}`,
  [c.id, "%اسبر%"])).rows;
  assert.equal(plan.length, 3, "Candidate filtering remains independent of the outer active filter");
  const explained = (await f.pool.query(`EXPLAIN (ANALYZE,FORMAT JSON) ${itemLookupSearchPlan.withSql}
    SELECT i.id FROM items i WHERE i.company_id=$1 AND ${itemLookupSearchPlan.predicate}`,
  [c.id, "%اسبر%"])).rows[0]!;
  const names: string[] = [];
  function indexes(node: Record<string, unknown>) {
    if (typeof node["Index Name"] === "string") names.push(node["Index Name"]);
    for (const child of (node.Plans ?? []) as Array<Record<string, unknown>>) indexes(child);
  }
  indexes(explained["QUERY PLAN"][0].Plan);
  assert(names.includes("items_lookup_text"), "Selective text lookup uses its actual GIN index");
});

test("invoice quick lookup uses bounded pages for short names while keeping longer searches sales-ranked", async t => {
  const f = await fixture(t), c = await f.company(), currency = await f.currency(c.id);
  const products: Item[] = [];
  for (let index = 0; index < 12; index++) {
    products.push(await f.item(c.id, currency.id, {
      name: `صنابير اختبار ${index}`,
      searchKeys: "FAST-LOOKUP-ITEM",
    }));
  }
  await f.item(c.id, currency.id, { name: "صنابير مؤرشف", active: false });
  const other = await f.company("Unrelated typeahead tenant"), otherCurrency = await f.currency(other.id);
  await f.item(other.id, otherCurrency.id, { name: "صنابير لشركة أخرى" });

  const today = (await f.pool.query<{ day: string }>(
    "SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Aden')::date::text AS day",
  )).rows[0]!.day;
  await daily(f, c.id, products[8]!.id, today, "30");
  await daily(f, c.id, products[4]!.id, today, "12");
  await daily(f, c.id, products[11]!.id, today, "5");
  const ordered = [products[8]!, products[4]!, products[11]!,
    ...products.filter((_, index) => ![8, 4, 11].includes(index))];
  const url = `/companies/${c.id}/commerce-options?type=items&fast=1&sort=saleTimes:desc,code:asc&pageSize=5`;
  type FastPage = Page<Item> & { hasMore: boolean };
  // One or two Arabic letters used to drop popularity ordering. They must
  // retain the same 30-day sale-frequency ranking as longer text, including
  // across pages, without paying for a full count on every keystroke.
  for (const term of ["ص", "صن", "صنابير"]) {
    const first = await f.owner.ok<FastPage>("GET", `${url}&q=${encodeURIComponent(term)}&page=1`);
    const second = await f.owner.ok<FastPage>("GET", `${url}&q=${encodeURIComponent(term)}&page=2`);
    const last = await f.owner.ok<FastPage>("GET", `${url}&q=${encodeURIComponent(term)}&page=3`);
    assert.deepEqual([first.items.length, second.items.length, last.items.length], [5, 5, 2]);
    assert.deepEqual([first.hasMore, second.hasMore, last.hasMore], [true, true, false]);
    assert.deepEqual([first.total, second.total, last.total], [6, 11, 12]);
    assert.deepEqual([...first.items, ...second.items, ...last.items].map(value => value.id),
      ordered.map(value => value.id),
      `Fast lookup must sort '${term}' by monthly sale frequency with active/company scope`);
  }
  const legacy = await f.owner.ok<Page<Item>>(
    "GET", `/companies/${c.id}/commerce-options?type=items&q=${encodeURIComponent("صن")}&pageSize=5`,
  );
  assert.equal(legacy.total, 12, "Normal list endpoints retain exact totals");
});


test("raw-only source invoices affect item search and monthly/yearly occurrences without stock, then yield to posting", async t => {
  const f = await fixture(t), c = await f.company(), currency = await f.currency(c.id);
  const product = await f.item(c.id, currency.id, { name: "صنف تاريخي مؤقت" });
  const day = (await f.pool.query<{ day: string }>(
    "SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Aden')::date::text AS day",
  )).rows[0]!.day;
  const ownerId = (await f.pool.query<{ id: number }>(
    "SELECT id FROM users WHERE email='owner@rank.test'",
  )).rows[0]!.id;
  const legacy = "test-provisional", sourceId = "historical-sale-1";
  const source = {
    type: "invoice", sourceId, payload: {
      kind: "sale", lines: [
        { itemId: product.id, quantity: "1", unit: 1 },
        { itemId: product.id, quantity: "2", unit: 1 },
      ],
    },
  };
  await f.pool.query(
    `INSERT INTO legacy_import_staging
       (company_id,source_system,source_kind,source_id,posting_date,source_document,request_hash,created_by)
       VALUES($1,$2,'invoice',$3,$4::date,$5::jsonb,$6,$7)`,
    [c.id, legacy, sourceId, day, JSON.stringify(source), "test-raw-hash", ownerId],
  );
  assert.equal(await cached(f.pool,c.id,product.id,day), "1",
    "The same raw invoice is one occurrence even when its item has several lines");
  const reportUrl = `/companies/${c.id}/item-statistics-report`;
  const report = await f.owner.ok<{ report: {
    rows: Array<{itemId:number;saleTimes:{oneMonth:string;twelveMonths:string}}>
  } }>("GET", reportUrl);
  const row = report.report.rows.find(value => value.itemId === product.id)!;
  assert.equal(row.saleTimes.oneMonth,"1");
  assert.equal(row.saleTimes.twelveMonths,"1");
  assert.equal((await f.pool.query(
    "SELECT count(*)::integer AS n FROM stock_movements WHERE company_id=$1",
    [c.id],
  )).rows[0]!.n,0,"Saving a raw invoice must never change inventory");
  const lookup = await f.owner.ok<Page<Item>>(
    "GET",`/companies/${c.id}/commerce-options?type=items&q=${encodeURIComponent(product.name)}`,
  );
  assert.equal(lookup.items[0]?.id,product.id,"The raw-only sale item remains searchable");

  const branch = (await f.owner.ok<Page<Branch>>("GET",`/companies/${c.id}/branches`)).items[0]!;
  const location = (await f.owner.ok<Page<Location>>("GET",`/companies/${c.id}/locations`)).items[0]!;
  const customer = (await f.owner.ok<{ account:Account }>(
    "POST",`/companies/${c.id}/accounts`,{
      name:"Raw sale mapping customer",kind:"posting",category:"asset",normalSide:"debit",parentId:null,
    },201)).account;
  const base={currencyId:currency.id,branchId:branch.id,locationId:location.id,
    counterpartyAccountId:customer.id,documentDate:day,discount:"0"};
  await f.owner.ok("POST",`/companies/${c.id}/invoices`,{
    ...base,idempotencyKey:randomUUID(),kind:"purchase",lines:[
      {itemId:product.id,unit:1,quantity:"10",unitPrice:"2",expiryDate:null},
    ],
  },201);
  const posted=(await f.owner.ok<{invoice:Invoice}>(
    "POST",`/companies/${c.id}/invoices`,{
      ...base,idempotencyKey:randomUUID(),kind:"sale",lines:[
        {itemId:product.id,unit:1,quantity:"1",expiryDate:null},
      ],
    },201)).invoice;
  assert.equal(await cached(f.pool,c.id,product.id,day),"2",
    "Before the source mapping, separate recorded and raw sales are distinct");
  await f.pool.query(
    `INSERT INTO transaction_source_imports
       (company_id,source_system,source_kind,source_id,created_by,request_hash,source_metadata,invoice_id)
       VALUES($1,$2,'invoice',$3,$4,$5,'{}'::jsonb,$6)`,
    [c.id,legacy,sourceId,ownerId,"test-raw-hash",posted.id],
  );
  assert.equal(await cached(f.pool,c.id,product.id,day),"1",
    "Source mapping removes the provisional count in the same transaction");
  const after = await f.owner.ok<{report:{rows:Array<{itemId:number;saleTimes:{oneMonth:string;twelveMonths:string}}>} }>(
    "GET",reportUrl,
  );
  const final = after.report.rows.find(value=>value.itemId===product.id)!;
  assert.equal(final.saleTimes.oneMonth,"1");
  assert.equal(final.saleTimes.twelveMonths,"1");
});
