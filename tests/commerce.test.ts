import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import { processInvoicePostFollowup } from "../apps/api/src/services/invoice-post-followups.ts";
import type {
  Account,
  AccountCategory,
  AccountLinkPurpose,
  Branch,
  Company,
  CompanyCurrency,
  Employee,
  Item,
  ItemInput,
  Location,
  Page,
  Permission,
  SessionResponse,
} from "../packages/contracts/src/index.ts";
import type {
  InventorySettings,
  ItemLocationBalances,
  StockAdjustmentInput,
  StockBalance,
  StockMovement,
  StockOperation,
  StockTransferInput,
} from "../packages/contracts/src/inventory.ts";
import type {
  Invoice,
  InvoiceInput,
} from "../packages/contracts/src/commerce.ts";

// All data and credentials here belong to disposable isolated test schemas.
const password = "Commerce-only-test-passphrase-2026";
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

  async ok<T>(
    method: string,
    path: string,
    body?: unknown,
    status: number | number[] = 200,
  ) {
    const response = await this.request<T>(method, path, body);
    assert(
      (Array.isArray(status) ? status : [status]).includes(response.status),
      `${method} ${path}: expected ${JSON.stringify(status)}, received ${response.status}: ${JSON.stringify(response.body)}`,
    );
    return response.body;
  }
}

async function fixture(t: TestContext) {
  const schema = `commerce_${randomUUID().replaceAll("-", "")}`;
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
    name: "Commerce owner",
    displayName: "Commerce owner",
    email: "owner@commerce.test",
    password,
  });
  const owner = new Client(baseUrl);
  await owner.ok("POST", "/auth/login", { email: user.email, password });
  async function company(name = "Commerce test company") {
    return (
      await owner.ok<{ company: Company }>(
        "POST",
        "/companies",
        { name, phone: "", address: "" },
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
        name: "Commerce employee",
        displayName: "Employee",
        email: `employee-${index}@commerce.test`,
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

async function setup(f: Fixture, name?: string) {
  const company = await f.company(name);
  const path = `/companies/${company.id}`;
  // Legacy commerce fixtures exercise accounting independently of the new
  // referral gate; dedicated referral tests lower the threshold explicitly.
  await f.owner.ok("PUT",`${path}/control/sales_doctor_threshold`,
    {value:999999999,employeeId:null,revision:null});
  // New companies already have YER as their base currency; legacy fixtures may not.
  const currencySettings = await f.owner.ok<{ settings: { baseCurrencyId: number } | null }>(
    "GET",
    `${path}/finance-settings`,
  );
  if (!currencySettings.settings) {
    await f.owner.ok(
      "POST",
      `${path}/currencies/initialize`,
      { baseCurrency: "YER" },
      201,
    );
  }
  const currencies = (
    await f.owner.ok<Page<CompanyCurrency>>("GET", `${path}/currencies`)
  ).items;
  const yer = currencies.find((value) => value.code === "YER")!;
  const usd = currencies.find((value) => value.code === "USD")!;
  const accounts: Record<string, Account> = {};
  async function account(
    key: string,
    category: AccountCategory,
    index: number,
    cashOrBank = false,
  ) {
    const value = (
      await f.owner.ok<{ account: Account }>(
        "POST",
        `${path}/accounts`,
        {
          code: `${index}`.padStart(10, "0"),
          name: key,
          parentId: null,
          kind: "posting",
          category,
          normalSide:
            category === "asset" || category === "expense" ? "debit" : "credit",
          cashOrBank,
        },
        201,
      )
    ).account;
    accounts[key] = value;
    return value;
  }
  const cash = await account("Cash", "asset", 1, true);
  const customer = await account("Customer", "asset", 2);
  const supplier = await account("Supplier", "liability", 3);
  let accountIndex = 4;
  for (const [purpose, category] of [
    ["salesRevenue", "income"],
    ["discountAllowed", "expense"],
    ["discountEarned", "income"],
    ["inventory", "asset"],
    ["purchases", "expense"],
    ["costOfGoodsSold", "expense"],
    ["stockShortage", "expense"],
    ["stockSurplus", "income"],
  ] satisfies [AccountLinkPurpose, AccountCategory][]) {
    const value = await account(purpose, category, accountIndex++);
    await f.owner.ok("PUT", `${path}/account-links/${purpose}`, {
      accountId: value.id,
    });
  }
  const branch = (await f.owner.ok<Page<Branch>>("GET", `${path}/branches`))
    .items[0]!;
  const showroom = (
    await f.owner.ok<Page<Location>>("GET", `${path}/locations`)
  ).items[0]!;
  const warehouse = (
    await f.owner.ok<{ location: Location }>(
      "POST",
      `${path}/locations`,
      {
        branchId: branch.id,
        code: "WAREHOUSE",
        name: "Warehouse",
        kind: "warehouse",
      },
      201,
    )
  ).location;
  const currentInventory = await f.owner.ok<{ settings: InventorySettings | null }>(
    "GET",
    `${path}/inventory-settings`,
  );
  const settings = (
    await f.owner.ok<{ settings: InventorySettings }>(
      "PUT",
      `${path}/inventory-settings`,
      {
        inventoryAccountId: accounts.inventory!.id,
        salesAccountId: accounts.salesRevenue!.id,
        cogsAccountId: accounts.costOfGoodsSold!.id,
        surplusAccountId: accounts.stockSurplus!.id,
        shortageAccountId: accounts.stockShortage!.id,
        costingMethod: "weighted_average",
        allowNegative: false,
        revision: currentInventory.settings?.revision ?? null,
      },
    )
  ).settings;
  async function item(overrides: Partial<ItemInput> = {}) {
    return (
      await f.owner.ok<{ item: Item }>(
        "POST",
        `${path}/items`,
        {
          idempotencyKey: randomUUID(),
          name: "Commerce item",
          unit1Name: "باكت",
          unit2Name: "شريط",
          unit3Name: "حبة",
          factor2: 2,
          factor3: 12,
          purchaseFactor: 3,
          salePrice1: "1000",
          salePrice2: "500",
          salePrice3: "50",
          purchasePrice: "800",
          hasExpiry: true,
          currencyId: yer.id,
          ...overrides,
        },
        201,
      )
    ).item;
  }
  return {
    company,
    path,
    yer,
    usd,
    accounts,
    cash,
    customer,
    supplier,
    branch,
    showroom,
    warehouse,
    settings,
    item,
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function rejectAudit(f: Fixture, operation: () => Promise<void>) {
  await f.pool.query(
    "CREATE FUNCTION reject_commerce_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test rejects commerce audit'; END $$",
  );
  await f.pool.query(
    "CREATE TRIGGER reject_commerce_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_commerce_audit()",
  );
  try {
    await operation();
  } finally {
    await f.pool.query("DROP TRIGGER reject_commerce_audit ON audit_events");
    await f.pool.query("DROP FUNCTION reject_commerce_audit()");
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
      `Only ${waiting}/${operations.length} commerce operations reached the lock`,
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
    assert(
      result.status === "fulfilled",
      result.status === "rejected" ? String(result.reason) : undefined,
    );
    return result.value;
  });
}

async function balances(f: Fixture, s: Setup, itemId: number) {
  return (
    await f.owner.ok<Page<StockBalance>>(
      "GET",
      `${s.path}/stock-balances?itemId=${itemId}`,
    )
  ).items;
}

async function movements(f: Fixture, s: Setup, itemId: number) {
  return (
    await f.owner.ok<Page<StockMovement>>(
      "GET",
      `${s.path}/stock-movements?itemId=${itemId}`,
    )
  ).items;
}

async function assertBalanced(f: Fixture, companyId: number) {
  const result = await f.pool.query<{
    id: number;
    lines: number;
    debit: string;
    credit: string;
    base_debit: string;
    base_credit: string;
  }>(
    `SELECT d.id, count(l.id)::int AS lines,
      sum(l.debit)::text AS debit, sum(l.credit)::text AS credit,
      sum(l.base_debit)::text AS base_debit, sum(l.base_credit)::text AS base_credit
     FROM financial_documents d JOIN financial_document_lines l ON l.document_id=d.id AND l.company_id=d.company_id
     WHERE d.company_id=$1 AND d.status IN ('posted','reversed') GROUP BY d.id ORDER BY d.id`,
    [companyId],
  );
  assert(result.rows.length > 0);
  for (const row of result.rows) {
    assert(row.lines >= 2, `Document ${row.id} needs at least two lines`);
    assert.equal(
      row.debit,
      row.credit,
      `Document ${row.id} unbalanced in document currency`,
    );
    assert.equal(
      row.base_debit,
      row.base_credit,
      `Document ${row.id} unbalanced in base currency`,
    );
  }
  return result.rows;
}

function invoiceBody(
  s: Setup,
  itemId: number,
  overrides: Partial<InvoiceInput> = {},
): InvoiceInput {
  return {
    idempotencyKey: randomUUID(),
    kind: "purchase",
    documentDate: "2026-10-12",
    currencyId: s.yer.id,
    branchId: s.branch.id,
    locationId: s.showroom.id,
    counterpartyAccountId: s.supplier.id,
    supplierAccountId: overrides.kind === "sale" ? null : s.supplier.id,
    description: "Commerce integration invoice",
    discount: "0",
    lines: [
      {
        itemId,
        unit: 1,
        quantity: "2",
        unitPrice: "800",
        expiryDate: "2027-01-31",
      },
    ],
    ...overrides,
  };
}

async function invoice(
  f: Fixture,
  s: Setup,
  body: InvoiceInput,
  client = f.owner,
) {
  const { invoice: saved } = await client.ok<{ invoice: Invoice }>(
    "POST", `${s.path}/invoices`, body, [200, 201],
  );
  // Unit test harness has no interval worker. Drain durable follow-ups
  // explicitly before legacy tests inspect completed wallet projections.
  for (let i = 0; i < 100; i++) {
    if (!await processInvoicePostFollowup(f.pool)) break;
  }
  return saved;
}

async function stockSnapshot(f: Fixture, companyId: number) {
  const result: Record<string, unknown[]> = {};
  for (const table of [
    "invoice_counters",
    "invoices",
    "invoice_lines",
    "stock_balances",
    "stock_item_valuations",
    "stock_movements",
    "stock_operations",
    "financial_document_counters",
    "financial_documents",
    "financial_document_lines",
    "audit_events",
  ])
    result[table] = (
      await f.pool.query(
        `SELECT to_jsonb(t) AS value FROM ${table} t WHERE company_id=$1 ORDER BY to_jsonb(t)::text`,
        [companyId],
      )
    ).rows.map((row) => row.value as unknown);
  return result;
}

async function inventorySnapshot(f: Fixture, companyId: number) {
  const result: Record<string, unknown[]> = {};
  for (const table of [
    "inventory_settings",
    "stock_balances",
    "stock_item_valuations",
    "stock_movements",
    "stock_operations",
    "financial_document_counters",
    "financial_documents",
    "financial_document_lines",
    "audit_events",
  ])
    result[table] = (
      await f.pool.query(
        `SELECT to_jsonb(t) AS value FROM ${table} t WHERE company_id=$1 ORDER BY to_jsonb(t)::text`,
        [companyId],
      )
    ).rows.map((row) => row.value as unknown);
  return result;
}

async function transfer(
  f: Fixture,
  s: Setup,
  itemId: number,
  overrides: Partial<StockTransferInput> = {},
  client = f.owner,
) {
  return (
    await client.ok<{ operation: StockOperation }>(
      "POST",
      `${s.path}/stock-transfers`,
      {
        idempotencyKey: randomUUID(),
        documentDate: "2026-10-12",
        itemId,
        fromLocationId: s.showroom.id,
        toLocationId: s.warehouse.id,
        quantity: "1",
        unit: 1,
        expiryDate: null,
        description: "Test transfer",
        ...overrides,
      },
      [200, 201],
    )
  ).operation;
}

async function adjust(
  f: Fixture,
  s: Setup,
  itemId: number,
  overrides: Partial<StockAdjustmentInput> = {},
  client = f.owner,
) {
  const existing = (await balances(f, s, itemId)).find(
    (value) =>
      value.locationId === (overrides.locationId ?? s.showroom.id) &&
      value.expiryDate === (overrides.expiryDate ?? null),
  );
  return (
    await client.ok<{ operation: StockOperation }>(
      "POST",
      `${s.path}/stock-adjustments`,
      {
        idempotencyKey: randomUUID(),
        documentDate: "2026-10-12",
        itemId,
        locationId: s.showroom.id,
        countedQuantity: "0",
        expectedQuantitySmallest: existing?.quantitySmallest ?? "0",
        unit: 1,
        expiryDate: null,
        unitCostBase: "0",
        description: "Test physical count",
        ...overrides,
      },
      [200, 201],
    )
  ).operation;
}

function minorUnits(value: string): bigint {
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  return (
    (BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"))) *
    (negative ? -1n : 1n)
  );
}

test("doctor cards and positive/negative sales referral are company-scoped and enforce the control limit", async (t) => {
  const f = await fixture(t), s = await setup(f), stockItem = await s.item();
  const other = await f.company("Doctor referral isolation");
  const root = `${s.path}/doctors`;
  const newDoctor=(name:string,kind:"doctor"|"nurse"|"entity",department:string,active=true)=>({
    name,kind,department,phone:"777888555",searchKeys:"النابهي",notes:"عيادة",active,
  });
  const first=(await f.owner.ok<{doctor:{id:number;revision:number;name:string}}>(
    "POST",root,newDoctor("الدكتور محمد علي","doctor","قسم الحروق"),201)).doctor;
  const nurse=(await f.owner.ok<{doctor:{id:number}}>(
    "POST",root,newDoctor("محمد عبده","nurse","قسم الجراحة"),201)).doctor;
  const entity=(await f.owner.ok<{doctor:{id:number}}>(
    "POST",root,newDoctor("المستشفى الجمهوري","entity","المستشفى الجمهوري"),201)).doctor;
  const departments=await f.owner.ok<{items:string[]}>("GET",root+"/departments");
  assert(departments.items.includes("قسم الحروق"));
  assert(departments.items.includes("قسم الجراحة"));
  assert(departments.items.includes("المستشفى الجمهوري"));
  const searchable=await f.owner.ok<{items:{id:number}[];total:number}>(
    "GET",root+"?active=true&q=%D8%A7%D9%84%D9%86%D8%A7%D8%A8%D9%87%D9%8A");
  assert.equal(searchable.total,3,"Search keys are searchable as well as names");
  assert.equal((await f.owner.ok<{items:unknown[]}>(
    "GET",`/companies/${other.id}/doctors`)).items.length,0);
  assert.equal((await f.owner.request("GET",
    `/companies/${other.id}/doctors/${first.id}`)).status,404);
  assert.equal((await f.owner.request("POST",root,{
    ...newDoctor("Bad","pharmacist" as "doctor",""), })).status,400);
  await f.owner.ok("PUT",`${s.path}/control/sales_doctor_threshold`,
    {value:1000,employeeId:null,revision:1});
  assert.equal((await f.owner.request("PUT",
    `${s.path}/control/sales_doctor_threshold`,
    {value:-1,employeeId:null,revision:2})).status,400);
  await invoice(f,s,invoiceBody(s,stockItem.id));
  const saleBody=invoiceBody(s,stockItem.id,{
    kind:"sale",counterpartyAccountId:s.customer.id,
    lines:[{itemId:stockItem.id,unit:1,quantity:"2",expiryDate:null,originalLineId:null}],
  });
  const missingDoctor=await f.owner.request("POST",`${s.path}/invoices`,saleBody);
  assert.equal(missingDoctor.status,400,JSON.stringify(missingDoctor.body));
  const validSale={...saleBody,doctorId:first.id};
  const sale=await invoice(f,s,validSale);
  assert.equal(sale.doctorId,first.id);
  assert.equal(sale.doctorName,"الدكتور محمد علي");
  assert.equal((await invoice(f,s,validSale)).id,sale.id,
    "UUID retry replays original doctor reference");
  assert.equal((await f.owner.request("POST",`${s.path}/invoices`,{
    ...validSale,doctorId:nurse.id,
  })).status,409,"Same invoice key cannot be switched to another doctor");
  const archived=(await f.owner.ok<{doctor:{id:number;active:boolean}}>(
    "PATCH",`${root}/${first.id}`,{
      ...newDoctor("الدكتور محمد علي","doctor","قسم الحروق",false),revision:first.revision,
    })).doctor;
  assert.equal(archived.active,false);
  assert.equal((await f.owner.ok<{items:{id:number}[]}>("GET",root+"?active=true"))
    .items.some(row=>row.id===first.id),false);
  const bad=await f.owner.request("POST",`${s.path}/invoices`,{
    ...saleBody,idempotencyKey:randomUUID(),doctorId:first.id,
  });
  assert.equal(bad.status,400,"Archived doctor is not selectable for new invoices");
  const refund=invoiceBody(s,stockItem.id,{
    kind:"sale",counterpartyAccountId:s.customer.id,doctorId:entity.id,
    lines:[{itemId:stockItem.id,unit:1,quantity:"-2",originalLineId:sale.lines[0]!.id,expiryDate:null}],
  });
  const noDoctorRefund=await f.owner.request("POST",`${s.path}/invoices`,{
    ...refund,doctorId:null,
  });
  assert.equal(noDoctorRefund.status,400,
    "A sale refund below negative threshold must also require a doctor");
  const returned=await invoice(f,s,refund);
  assert.equal(returned.doctorId,entity.id);
  assert.equal(returned.total,"-2000");
  // Unlisted names are permitted; keep an invoice snapshot without creating a card.
  const manualBody={...saleBody,idempotencyKey:randomUUID(),
    doctorId:null,doctorName:"  الدكتورة سعاد الخاصة  "};
  const manual=await invoice(f,s,manualBody);
  assert.equal(manual.doctorId,null);
  assert.equal(manual.doctorName,"الدكتورة سعاد الخاصة");
  assert.equal((await invoice(f,s,manualBody)).id,manual.id,
    "Retry of manually-entered doctor reuses the original posted invoice");
  assert.equal((await f.owner.request("POST",`${s.path}/invoices`,{
    ...manualBody,doctorName:"طبيب مختلف",
  })).status,409,"Idempotency does not allow changing a manually entered name");
  assert.equal((await f.owner.request("POST",`${s.path}/invoices`,{
    ...saleBody,idempotencyKey:randomUUID(),doctorId:null,doctorName:"   ",
  })).status,400,"Whitespace alone cannot bypass the mandatory doctor name");
  assert.equal((await f.owner.request("POST",`${s.path}/invoices`,{
    ...saleBody,idempotencyKey:randomUUID(),doctorId:null,doctorName:"س".repeat(241),
  })).status,400,"Unlisted doctor names are bounded to 240 characters");
  const allDoctors=await f.owner.ok<{items:{id:number}[];total:number}>(
    "GET",root+"?active=true");
  assert.equal(allDoctors.total,2,"Typing a name on an invoice never creates a directory card");
  const stillLinked=await f.owner.ok<{invoice:Invoice}>(
    "GET",`${s.path}/invoices/${sale.id}`);
  assert.equal(stillLinked.invoice.doctorName,"الدكتور محمد علي",
    "Invoice keeps original name after doctor is archived");
});
test("purchase and sale atomically post exact stock and balanced discounted revenue/COGS with locked independent unit prices", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    item = await s.item();
  const purchase = await invoice(
    f,
    s,
    invoiceBody(s, item.id, { discount: "100" }),
  );
  assert.equal(purchase.gross, "1600");
  assert.equal(purchase.discount, "100");
  assert.equal(purchase.total, "1500");
  assert.equal(
    purchase.lines[0]!.smallestQuantity,
    "48",
    "purchaseFactor must not multiply the three unit conversion again",
  );
  assert.equal(purchase.lines[0]!.costBase, "1500");
  assert.equal(purchase.status, "posted");
  const initial = await balances(f, s, item.id);
  assert.equal(initial[0]!.quantitySmallest, "48");
  assert.equal(initial[0]!.pooledValueBase, "1500");
  const saleBody = invoiceBody(s, item.id, {
    kind: "sale",
    counterpartyAccountId: s.customer.id,
    discount: "50",
    lines: [{ itemId: item.id, unit: 2, quantity: "1" }],
  });
  const sale = await invoice(f, s, saleBody);
  assert.equal(sale.lines[0]!.unitPrice, "500");
  assert.equal(sale.lines[0]!.smallestQuantity, "12");
  assert.equal(sale.total, "450");
  assert.equal(sale.lines[0]!.costBase, "375");
  assert.notEqual(sale.costDocumentId, null);
  const after = await balances(f, s, item.id);
  assert.equal(after[0]!.quantitySmallest, "36");
  assert.equal(after[0]!.pooledValueBase, "1125");
  const beforeTamper = await stockSnapshot(f, s.company.id);
  const tamper = await f.owner.request("POST", `${s.path}/invoices`, {
    ...saleBody,
    idempotencyKey: randomUUID(),
    discount: "0",
    lines: [{ itemId: item.id, unit: 2, quantity: "1", unitPrice: "499" }],
  });
  assert.equal(tamper.status, 409);
  assert.deepEqual(await stockSnapshot(f, s.company.id), beforeTamper);
  await assertBalanced(f, s.company.id);
  const inventory = await f.owner.ok<{ totals: { closingBalance: string } }>(
    "GET",
    `${s.path}/account-ledger?accountId=${s.accounts.inventory!.id}`,
  );
  assert.equal(inventory.totals.closingBalance, "1125");
  const cogs = await f.owner.ok<{ totals: { closingBalance: string } }>(
    "GET",
    `${s.path}/account-ledger?accountId=${s.accounts.costOfGoodsSold!.id}`,
  );
  assert.equal(cogs.totals.closingBalance, "375");
  assert.equal(
    (
      await f.owner.ok<Page<Invoice>>(
        "GET",
        `${s.path}/invoices?branchId=${s.branch.id}&locationId=${s.showroom.id}`,
      )
    ).total,
    2,
  );
  assert.equal(
    (
      await f.owner.ok<Page<Invoice>>(
        "GET",
        `${s.path}/invoices?locationId=${s.warehouse.id}`,
      )
    ).total,
    0,
  );
  assert.equal(
    (await f.owner.request("GET", `${s.path}/invoices?branchId=1&branchId=2`))
      .status,
    400,
  );
});

test("invoice quantities above 2^53 and Arabic digits keep exact stock, money and smallest-unit conversion", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    item = await s.item({ hasExpiry: false });
  const quantity = "9007199254740993";
  const purchase = await invoice(
    f,
    s,
    invoiceBody(s, item.id, {
      lines: [
        {
          itemId: item.id,
          unit: 3,
          quantity: "٩٠٠٧١٩٩٢٥٤٧٤٠٩٩٣",
          unitPrice: "٠٫٠١",
        },
      ],
    }),
  );
  assert.equal(purchase.total, "90071992547409.93");
  assert.equal(purchase.lines[0]!.quantity, quantity);
  assert.equal(purchase.lines[0]!.smallestQuantity, quantity);
  const sale = await invoice(
    f,
    s,
    invoiceBody(s, item.id, {
      kind: "sale",
      counterpartyAccountId: s.customer.id,
      lines: [{ itemId: item.id, unit: 3, quantity: "2" }],
    }),
  );
  assert.equal(sale.total, "100");
  assert.equal(sale.lines[0]!.costBase, "0.02");
  const stock = await balances(f, s, item.id);
  assert.equal(stock[0]!.quantitySmallest, "9007199254740991");
  assert.equal(stock[0]!.pooledValueBase, "90071992547409.91");
  await assertBalanced(f, s.company.id);
});

test("partial sale returns preserve original prices, discounts and cost exactly through the final unit", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    item = await s.item({
      factor2: 1,
      factor3: 1,
      hasExpiry: false,
      salePrice1: "1",
    });
  await invoice(
    f,
    s,
    invoiceBody(s, item.id, {
      lines: [{ itemId: item.id, unit: 1, quantity: "3", unitPrice: "0.01" }],
    }),
  );
  const sale = await invoice(
    f,
    s,
    invoiceBody(s, item.id, {
      kind: "sale",
      counterpartyAccountId: s.customer.id,
      discount: "0.01",
      lines: [{ itemId: item.id, unit: 1, quantity: "3" }],
    }),
  );
  assert.equal(sale.total, "2.99");
  assert.equal(sale.lines[0]!.costBase, "0.03");
  const {
    id: _id,
    companyId: _companyId,
    code: _code,
    revision,
    createdBy: _creator,
    createdAt: _created,
    updatedAt: _updated,
    agentName: _agentName,
    agentActive: _agentActive,
    currencyCode: _currencyCode,
    currencyName: _currencyName,
    currencyDecimalPlaces: _currencyDecimalPlaces,
    currencyActive: _currencyActive,
    ...fields
  } = item;
  await f.owner.ok("PATCH", `${s.path}/items/${item.id}`, {
    ...fields,
    revision,
    name: "Renamed item",
    salePrice1: "9",
  });
  const returned: Invoice[] = [];
  for (let index = 0; index < 3; index++)
    returned.push(
      await invoice(
        f,
        s,
        invoiceBody(s, item.id, {
          kind: "sale",
          counterpartyAccountId: s.customer.id,
          lines: [
            {
              itemId: item.id,
              unit: 1,
              quantity: "-1",
              originalLineId: sale.lines[0]!.id,
            },
          ],
        }),
      ),
    );
  assert.equal(
    returned.reduce((sum, value) => sum + minorUnits(value.total), 0n),
    minorUnits("-2.99"),
  );
  assert.equal(
    returned.reduce(
      (sum, value) => sum + minorUnits(value.lines[0]!.costBase),
      0n,
    ),
    minorUnits("-0.03"),
  );
  assert.equal(
    returned.reduce((sum, value) => sum + minorUnits(value.discount), 0n),
    minorUnits("-0.01"),
  );
  for (const value of returned) {
    assert.equal(value.lines[0]!.unitPrice, "1");
    assert.equal(value.lines[0]!.itemName, sale.lines[0]!.itemName);
  }
  const stock = await balances(f, s, item.id);
  assert.equal(stock[0]!.pooledQuantitySmallest, "3");
  assert.equal(stock[0]!.pooledValueBase, "0.03");
  const before = await stockSnapshot(f, s.company.id);
  assert.equal(
    (
      await f.owner.request(
        "POST",
        `${s.path}/invoices`,
        invoiceBody(s, item.id, {
          kind: "sale",
          counterpartyAccountId: s.customer.id,
          lines: [
            {
              itemId: item.id,
              unit: 1,
              quantity: "-1",
              originalLineId: sale.lines[0]!.id,
            },
          ],
        }),
      )
    ).status,
    409,
  );
  assert.deepEqual(await stockSnapshot(f, s.company.id), before);
  const cogs = await f.owner.ok<{ totals: { closingBalance: string } }>(
    "GET",
    `${s.path}/account-ledger?accountId=${s.accounts.costOfGoodsSold!.id}`,
  );
  assert.equal(cogs.totals.closingBalance, "0");
  await assertBalanced(f, s.company.id);
});

test("batch FEFO and per-location availability prevent expiry bypass and take lots in expiry order", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    item = await s.item({ factor2: 1, factor3: 1, salePrice1: "2" });
  for (const expiryDate of ["2027-02-28", "2027-01-31"])
    await invoice(
      f,
      s,
      invoiceBody(s, item.id, {
        lines: [
          {
            itemId: item.id,
            unit: 1,
            quantity: "3",
            unitPrice: "1",
            expiryDate,
          },
        ],
      }),
    );
  const before = await stockSnapshot(f, s.company.id);
  for (const body of [
    invoiceBody(s, item.id, {
      lines: [{ itemId: item.id, unit: 1, quantity: "1", unitPrice: "1" }],
    }),
    invoiceBody(s, item.id, {
      kind: "sale",
      counterpartyAccountId: s.customer.id,
      locationId: s.warehouse.id,
      lines: [{ itemId: item.id, unit: 1, quantity: "1" }],
    }),
    invoiceBody(s, item.id, {
      kind: "sale",
      counterpartyAccountId: s.customer.id,
      documentDate: "2026-10-11",
      lines: [{ itemId: item.id, unit: 1, quantity: "1" }],
    }),
  ])
    assert.equal(
      (await f.owner.request("POST", `${s.path}/invoices`, body)).status,
      409,
    );
  assert.deepEqual(await stockSnapshot(f, s.company.id), before);
  const sale = await invoice(
    f,
    s,
    invoiceBody(s, item.id, {
      kind: "sale",
      counterpartyAccountId: s.customer.id,
      lines: [{ itemId: item.id, unit: 1, quantity: "4" }],
    }),
  );
  const allocations = (await movements(f, s, item.id)).filter(
    (value) => value.invoiceId === sale.id,
  );
  assert.equal(allocations.length, 2);
  assert.equal(
    allocations.find((value) => value.expiryDate === "2027-01-31")!
      .quantitySmallest,
    "-3",
  );
  assert.equal(
    allocations.find((value) => value.expiryDate === "2027-02-28")!
      .quantitySmallest,
    "-1",
  );
  const stock = await balances(f, s, item.id);
  assert.equal(
    stock.find((value) => value.expiryDate === "2027-02-28")!.quantitySmallest,
    "2",
  );
  assert.equal(stock[0]!.pooledValueBase, "2");
  await assertBalanced(f, s.company.id);
});

test("stock transfers without expiry entry move existing dated source batches in FEFO order", async (t) => {
  const f = await fixture(t);
  const s = await setup(f);
  const item = await s.item({ factor2: 1, factor3: 1, hasExpiry: true });
  for (const expiryDate of ["2027-03-01", "2027-01-01"]) {
    await invoice(f, s, invoiceBody(s, item.id, {
      lines: [{ itemId: item.id, unit: 1, quantity: "4", unitPrice: "10", expiryDate }],
    }));
  }
  const before = (await f.owner.ok<{item:Item}>("GET", `${s.path}/items/${item.id}`)).item.nearestExpiryDate;
  const response = await f.owner.ok<{operation:StockOperation}>(
    "POST", `${s.path}/stock-transfers`, {
      documentDate: "2026-10-12",
      itemId: item.id,
      fromLocationId: s.showroom.id,
      toLocationId: s.warehouse.id,
      unit: 1, quantity: "6",
      description: "مناقلة دون إدخال تاريخ انتهاء",
      idempotencyKey: randomUUID(),
    }, 201,
  );
  const moved = response.operation.movements;
  assert.equal(moved.length, 4);
  for (const [expiryDate, quantity] of [["2027-01-01", "4"], ["2027-03-01", "2"]] as const) {
    const inbound = moved.find(value => value.kind === "transfer_in" && value.expiryDate === expiryDate);
    const outbound = moved.find(value => value.kind === "transfer_out" && value.expiryDate === expiryDate);
    assert.equal(inbound?.quantitySmallest, quantity);
    assert.equal(outbound?.quantitySmallest, "-"+quantity);
  }
  const after = await balances(f, s, item.id);
  assert.equal(after.find(v => v.locationId === s.warehouse.id && v.expiryDate === "2027-01-01")?.quantitySmallest, "4");
  assert.equal(after.find(v => v.locationId === s.warehouse.id && v.expiryDate === "2027-03-01")?.quantitySmallest, "2");
  assert.equal((await f.owner.ok<{item:Item}>("GET", `${s.path}/items/${item.id}`)).item.nearestExpiryDate, before);
  await assertBalanced(f, s.company.id);
});

test("transfer location balances show all sites including zero and returns in first unit", async (t) => {
  const f = await fixture(t);
  const s = await setup(f);
  const item = await s.item({ factor2: 2, factor3: 3, hasExpiry: true });
  const returns = (await f.owner.ok<{location:Location}>(
    "POST", `${s.path}/locations`,
    {branchId:s.branch.id,name:"موقع المرتجعات",kind:"returns"},201,
  )).location;
  for(const [quantity,expiryDate] of [["5","2027-01-01"],["3","2027-03-01"]] as const) {
    await invoice(f,s,invoiceBody(s,item.id,{
      lines:[{itemId:item.id,unit:1,quantity,unitPrice:"10",expiryDate}],
    }));
  }
  const snap = async () => f.owner.ok<ItemLocationBalances>(
    "GET",`${s.path}/item-location-balances?itemId=${item.id}`,
  );
  const first = await snap();
  const showroom = first.items.find(v=>v.location.id===s.showroom.id);
  const warehouse = first.items.find(v=>v.location.id===s.warehouse.id);
  const returnSite = first.items.find(v=>v.location.id===returns.id);
  assert.equal(showroom?.quantityUnit1.decimal,"8");
  assert.equal(showroom?.quantitySmallest,"48");
  assert.equal(warehouse?.quantityUnit1.decimal,"0","Show empty warehouses");
  assert.equal(returnSite?.quantityUnit1.decimal,"0","Show empty returns");
  assert.equal(returnSite?.location.kind,"returns");
  assert(first.items.length>=3);
  await transfer(f,s,item.id,{toLocationId:returns.id,quantity:"2",unit:1});
  const after = await snap();
  assert.equal(after.items.find(v=>v.location.id===s.showroom.id)?.quantityUnit1.decimal,"6");
  assert.equal(after.items.find(v=>v.location.id===returns.id)?.quantityUnit1.decimal,"2");
  assert.equal(after.items.find(v=>v.location.id===s.warehouse.id)?.quantityUnit1.decimal,"0");
});

test("transfers conserve company quantity/value and counted adjustments reconcile exact valuation with ledger", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    item = await s.item({ factor2: 1, factor3: 1, hasExpiry: false });
  await invoice(
    f,
    s,
    invoiceBody(s, item.id, {
      lines: [{ itemId: item.id, unit: 1, quantity: "10", unitPrice: "10" }],
    }),
  );
  const operation = await transfer(f, s, item.id, { quantity: "4" });
  assert.equal(operation.financialDocumentId, null);
  assert.equal(operation.movements.length, 2);
  assert.equal(
    operation.movements.reduce(
      (sum, value) => sum + BigInt(value.quantitySmallest),
      0n,
    ),
    0n,
  );
  assert.equal(
    operation.movements.reduce(
      (sum, value) => sum + minorUnits(value.costBase),
      0n,
    ),
    0n,
  );
  let stock = await balances(f, s, item.id);
  assert.equal(
    stock.find((value) => value.locationId === s.showroom.id)!.quantitySmallest,
    "6",
  );
  assert.equal(
    stock.find((value) => value.locationId === s.warehouse.id)!
      .quantitySmallest,
    "4",
  );
  assert.equal(stock[0]!.pooledQuantitySmallest, "10");
  assert.equal(stock[0]!.pooledValueBase, "100");
  const shortage = await adjust(f, s, item.id, {
    locationId: s.warehouse.id,
    countedQuantity: "2",
  });
  assert.equal(shortage.movements[0]!.quantitySmallest, "-2");
  assert.equal(shortage.movements[0]!.costBase, "-20");
  assert.notEqual(shortage.financialDocumentId, null);
  const surplus = await adjust(f, s, item.id, {
    locationId: s.warehouse.id,
    countedQuantity: "5",
    unitCostBase: "12",
  });
  assert.equal(surplus.movements[0]!.quantitySmallest, "3");
  assert.equal(surplus.movements[0]!.costBase, "36");
  stock = await balances(f, s, item.id);
  assert.equal(stock[0]!.pooledQuantitySmallest, "11");
  assert.equal(stock[0]!.pooledValueBase, "116");
  const inventory = await f.owner.ok<{ totals: { closingBalance: string } }>(
    "GET",
    `${s.path}/account-ledger?accountId=${s.accounts.inventory!.id}`,
  );
  assert.equal(inventory.totals.closingBalance, "116");
  await assertBalanced(f, s.company.id);
});

test("foreign sale revenue uses historical FX while COGS uses base currency and full depletion clears pooled value", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    item = await s.item({
      currencyId: s.usd.id,
      factor2: 1,
      factor3: 1,
      hasExpiry: false,
      salePrice1: "1",
    });
  await f.owner.ok(
    "POST",
    `${s.path}/exchange-rates`,
    {
      currencyId: s.usd.id,
      rate: "2.5",
      effectiveAt: "2026-10-12T00:00:00Z",
      source: "Exact commerce test FX",
    },
    201,
  );
  await adjust(f, s, item.id, { countedQuantity: "3", unitCostBase: "0.01" });
  const sale = await invoice(
    f,
    s,
    invoiceBody(s, item.id, {
      kind: "sale",
      currencyId: s.usd.id,
      counterpartyAccountId: s.customer.id,
      lines: [{ itemId: item.id, unit: 1, quantity: "3" }],
    }),
  );
  assert.equal(sale.total, "3");
  assert.equal(sale.baseTotal, "7.5");
  assert.equal(sale.exchangeRate, "2.5");
  assert.equal(sale.lines[0]!.costBase, "0.03");
  const documents = await f.pool.query<{
    id: number;
    currency_id: number;
    total_debit: string;
  }>(
    "SELECT id,currency_id,total_debit::text FROM financial_documents WHERE company_id=$1 AND id=ANY($2::int[])",
    [s.company.id, [sale.financialDocumentId, sale.costDocumentId]],
  );
  assert.equal(
    documents.rows.find((row) => row.id === sale.financialDocumentId)!
      .currency_id,
    s.usd.id,
  );
  assert.equal(
    documents.rows.find((row) => row.id === sale.costDocumentId)!.currency_id,
    s.yer.id,
  );
  const valuation = (
    await f.pool.query<{ quantity: string; value: string }>(
      "SELECT quantity_smallest::text AS quantity,value_base::text AS value FROM stock_item_valuations WHERE company_id=$1 AND item_id=$2",
      [s.company.id, item.id],
    )
  ).rows[0]!;
  assert.equal(BigInt(valuation.quantity), 0n);
  assert.equal(minorUnits(valuation.value), 0n);
  await assertBalanced(f, s.company.id);
  for (const documentId of [sale.financialDocumentId, sale.costDocumentId]) {
    const before = await stockSnapshot(f, s.company.id);
    const result = await f.owner.request(
      "POST",
      `${s.path}/financial-documents/${documentId}/reverse`,
      {
        reason: "Must use invoice return",
        documentDate: "2026-10-12",
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(result.status, 409);
    assert.deepEqual(await stockSnapshot(f, s.company.id), before);
  }
});

test("linked purchase returns consume current weighted-average stock and post the cost variance", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    item = await s.item({ factor2: 1, factor3: 1, hasExpiry: false });
  const first = await invoice(
    f,
    s,
    invoiceBody(s, item.id, {
      lines: [{ itemId: item.id, unit: 1, quantity: "2", unitPrice: "10" }],
    }),
  );
  await invoice(
    f,
    s,
    invoiceBody(s, item.id, {
      lines: [{ itemId: item.id, unit: 1, quantity: "2", unitPrice: "20" }],
    }),
  );
  const returned = await invoice(
    f,
    s,
    invoiceBody(s, item.id, {
      lines: [
        {
          itemId: item.id,
          unit: 1,
          quantity: "-2",
          originalLineId: first.lines[0]!.id,
        },
      ],
    }),
  );
  assert.equal(returned.total, "-20");
  assert.equal(returned.lines[0]!.unitPrice, "10");
  assert.equal(returned.lines[0]!.costBase, "-30");
  assert.notEqual(returned.varianceDocumentId, null);
  const stock = await balances(f, s, item.id);
  assert.equal(stock[0]!.pooledQuantitySmallest, "2");
  assert.equal(stock[0]!.pooledValueBase, "30");
  const inventory = await f.owner.ok<{ totals: { closingBalance: string } }>(
    "GET",
    `${s.path}/account-ledger?accountId=${s.accounts.inventory!.id}`,
  );
  assert.equal(inventory.totals.closingBalance, "30");
  await assertBalanced(f, s.company.id);
});

test("invoice and stock operation retries are idempotent while changed payloads fail without effects", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    item = await s.item({ factor2: 1, factor3: 1, hasExpiry: false });
  const body = invoiceBody(s, item.id, {
    lines: [{ itemId: item.id, unit: 1, quantity: "4", unitPrice: "10" }],
  });
  const concurrent = await blockedOperations(f, s.company.id, [
    () =>
      f.owner.request<{ invoice: Invoice }>("POST", `${s.path}/invoices`, body),
    () =>
      f.owner.request<{ invoice: Invoice }>("POST", `${s.path}/invoices`, body),
  ]);
  for (const result of concurrent) assert([200, 201].includes(result.status));
  assert.equal(concurrent[0]!.body.invoice.id, concurrent[1]!.body.invoice.id);
  const before = await stockSnapshot(f, s.company.id);
  assert.equal((await invoice(f, s, body)).id, concurrent[0]!.body.invoice.id);
  assert.deepEqual(await stockSnapshot(f, s.company.id), before);
  assert.equal(
    (
      await f.owner.request("POST", `${s.path}/invoices`, {
        ...body,
        description: "Changed retry",
      })
    ).status,
    409,
  );
  assert.deepEqual(await stockSnapshot(f, s.company.id), before);
  const key = randomUUID();
  const moved = await transfer(f, s, item.id, {
    idempotencyKey: key,
    quantity: "2",
  });
  const transferBefore = await stockSnapshot(f, s.company.id);
  assert.equal(
    (await transfer(f, s, item.id, { idempotencyKey: key, quantity: "2" })).id,
    moved.id,
  );
  assert.deepEqual(await stockSnapshot(f, s.company.id), transferBefore);
  assert.equal(
    (
      await f.owner.request("POST", `${s.path}/stock-transfers`, {
        idempotencyKey: key,
        documentDate: "2026-10-12",
        itemId: item.id,
        fromLocationId: s.showroom.id,
        toLocationId: s.warehouse.id,
        quantity: "1",
        unit: 1,
        expiryDate: null,
        description: "Test transfer",
      })
    ).status,
    409,
  );
  assert.deepEqual(await stockSnapshot(f, s.company.id), transferBefore);
});

test("simultaneous sales serialize stock depletion and cannot oversell or leave an extra ledger posting", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    item = await s.item({
      factor2: 1,
      factor3: 1,
      hasExpiry: false,
      salePrice1: "2",
    });
  await invoice(
    f,
    s,
    invoiceBody(s, item.id, {
      lines: [{ itemId: item.id, unit: 1, quantity: "5", unitPrice: "1" }],
    }),
  );
  const alice = await f.member(
    s.company.id,
    ["commerce.manage", "finance.post"],
    1,
  );
  const bob = await f.member(
    s.company.id,
    ["commerce.manage", "finance.post"],
    2,
  );
  const sell = (client: Client) =>
    client.request<{ invoice: Invoice }>(
      "POST",
      `${s.path}/invoices`,
      invoiceBody(s, item.id, {
        kind: "sale",
        counterpartyAccountId: s.customer.id,
        lines: [{ itemId: item.id, unit: 1, quantity: "4" }],
      }),
    );
  const results = await blockedOperations(f, s.company.id, [
    () => sell(alice.client),
    () => sell(bob.client),
  ]);
  assert.deepEqual(results.map((value) => value.status).sort(), [201, 409]);
  const stock = await balances(f, s, item.id);
  assert.equal(stock[0]!.pooledQuantitySmallest, "1");
  assert.equal(stock[0]!.pooledValueBase, "1");
  const counts = (
    await f.pool.query<{ invoices: number; financial: number; sales: number }>(
      "SELECT (SELECT count(*)::int FROM invoices WHERE company_id=$1) AS invoices,(SELECT count(*)::int FROM financial_documents WHERE company_id=$1) AS financial,(SELECT count(*)::int FROM stock_movements WHERE company_id=$1 AND kind='sale') AS sales",
      [s.company.id],
    )
  ).rows[0]!;
  assert.deepEqual(counts, { invoices: 2, financial: 3, sales: 1 });
  await assertBalanced(f, s.company.id);
});

test("audit failure rolls back invoice, stock, costing, generated finance and operation counters together", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    item = await s.item({ factor2: 1, factor3: 1, hasExpiry: false });
  await invoice(
    f,
    s,
    invoiceBody(s, item.id, {
      lines: [{ itemId: item.id, unit: 1, quantity: "10", unitPrice: "10" }],
    }),
  );
  for (const [path, body] of [
    [
      "invoices",
      invoiceBody(s, item.id, {
        lines: [{ itemId: item.id, unit: 1, quantity: "2", unitPrice: "800" }],
      }),
    ],
    [
      "invoices",
      invoiceBody(s, item.id, {
        kind: "sale",
        counterpartyAccountId: s.customer.id,
        lines: [{ itemId: item.id, unit: 1, quantity: "1" }],
      }),
    ],
    [
      "stock-transfers",
      {
        idempotencyKey: randomUUID(),
        documentDate: "2026-10-12",
        itemId: item.id,
        fromLocationId: s.showroom.id,
        toLocationId: s.warehouse.id,
        quantity: "1",
        unit: 1,
      },
    ],
    [
      "stock-adjustments",
      {
        idempotencyKey: randomUUID(),
        documentDate: "2026-10-12",
        itemId: item.id,
        locationId: s.showroom.id,
        countedQuantity: "5",
        expectedQuantitySmallest: "10",
        unit: 1,
      },
    ],
  ] as [string, unknown][]) {
    const before = await stockSnapshot(f, s.company.id);
    await rejectAudit(f, async () => {
      assert.equal(
        (await f.owner.request("POST", `${s.path}/${path}`, body)).status,
        500,
      );
    });
    assert.deepEqual(
      await stockSnapshot(f, s.company.id),
      before,
      `${path} must roll back every table`,
    );
  }
});

test("sales return entered expiry updates item card only when earlier, including linked returns", async (t) => {
  const f = await fixture(t);
  const s = await setup(f,"Sales return nearest expiry precedence");
  const item = await s.item({
    hasExpiry:true,factor2:1,factor3:1,
    purchasePrice:"20",salePrice1:"30",nearestExpiryDate:"2028-01-01",
  });
  const card = async () => (await f.owner.ok<{item:Item}>(
    "GET",`${s.path}/items/${item.id}`,
  )).item;
  await invoice(f,s,invoiceBody(s,item.id,{
    lines:[{itemId:item.id,unit:1,quantity:"5",unitPrice:"20",expiryDate:"2027-09-01"}],
  }));
  assert.equal((await card()).nearestExpiryDate,"2027-09-01");
  const sale = await invoice(f,s,invoiceBody(s,item.id,{
    kind:"sale",counterpartyAccountId:s.customer.id,
    lines:[{itemId:item.id,unit:1,quantity:"2"}],
  }));
  const afterSale = (await card()).revision;
  const noDate = await invoice(f,s,invoiceBody(s,item.id,{
    kind:"sale",counterpartyAccountId:s.customer.id,
    lines:[{itemId:item.id,unit:1,quantity:"-1",originalLineId:sale.lines[0]!.id,expiryDate:null}],
  }));
  assert.equal(noDate.lines[0]!.expiryDate,"2027-09-01",
    "linked return inherits its original batch for stock accounting");
  assert.equal((await card()).revision,afterSale,
    "inherited original batch without a date entered must not rewrite item card");

  await invoice(f,s,invoiceBody(s,item.id,{
    kind:"sale",counterpartyAccountId:s.customer.id,
    lines:[{itemId:item.id,unit:1,quantity:"-1",expiryDate:"2027-05-01"}],
  }));
  assert.equal((await card()).nearestExpiryDate,"2027-05-01");
  const afterEarly = (await card()).revision;
  await invoice(f,s,invoiceBody(s,item.id,{
    kind:"sale",counterpartyAccountId:s.customer.id,
    lines:[{itemId:item.id,unit:1,quantity:"-1",expiryDate:"2027-12-01"}],
  }));
  assert.equal((await card()).nearestExpiryDate,"2027-05-01");
  assert.equal((await card()).revision,afterEarly,
    "later direct sales return must not overwrite nearest item expiry");

  const linkedPayload = invoiceBody(s,item.id,{
    kind:"sale",counterpartyAccountId:s.customer.id,
    lines:[{itemId:item.id,unit:1,quantity:"-1",originalLineId:sale.lines[0]!.id,expiryDate:"2027-03-01"}],
  });
  const linked = await invoice(f,s,linkedPayload);
  assert.equal(linked.lines[0]!.expiryDate,"2027-03-01");
  assert.equal((await card()).nearestExpiryDate,"2027-03-01");
  const afterLinked = (await card()).revision;
  const replay = await invoice(f,s,linkedPayload);
  assert.equal(replay.id,linked.id);
  assert.equal((await card()).revision,afterLinked,
    "idempotent invoice replay must not modify the card");
  await assertBalanced(f,s.company.id);
});

test("purchase saving changes only the item card's nearest expiry, while reconciliation overrides it", async (t) => {
  const f = await fixture(t);
  const s = await setup(f, "Card nearest expiry save precedence");
  const item = await s.item({
    hasExpiry: true, factor2: 1, factor3: 1, purchasePrice: "20",
    nearestExpiryDate: null,
  });
  const card = async () => (await f.owner.ok<{item:Item}>(
    "GET", `${s.path}/items/${item.id}`,
  )).item;
  const purchase = async (dates: string[]) => invoice(f, s, invoiceBody(s, item.id, {
    lines: dates.map(expiryDate => ({
      itemId: item.id, unit: 1 as const, quantity: "1",
      unitPrice: "20", expiryDate,
    })),
  }));
  const first = await purchase(["2027-09-01", "2027-07-01"]);
  assert.equal((await card()).nearestExpiryDate, "2027-07-01",
    "the earliest purchase line becomes the single card date");
  const savedRevision = (await card()).revision;
  await invoice(f, s, invoiceBody(s, item.id, {
    ...{idempotencyKey: randomUUID()},
    lines: [{itemId: item.id,unit:1,quantity:"1",unitPrice:"20",expiryDate:"2027-12-01"}],
  }));
  assert.equal((await card()).nearestExpiryDate, "2027-07-01");
  assert.equal((await card()).revision, savedRevision,
    "later purchases must not needlessly update item card revision");
  await purchase(["2027-04-01"]);
  assert.equal((await card()).nearestExpiryDate, "2027-04-01");
  const preview = await f.owner.ok<{quantitySmallest:string}>("GET",
    `${s.path}/stock-count-snapshot?itemId=${item.id}&locationId=${s.showroom.id}`);
  const settled = await f.owner.ok<{operation:StockOperation}>(
    "POST", `${s.path}/stock-adjustments`,{
      documentDate:"2026-10-12",itemId:item.id,locationId:s.showroom.id,
      countedQuantity:preview.quantitySmallest,
      expectedQuantitySmallest:preview.quantitySmallest,
      unit:1,nearestExpiryDate:"2028-08-01",idempotencyKey:randomUUID(),
    },201);
  assert.equal(settled.operation.movements.length,0);
  assert.equal((await card()).nearestExpiryDate,"2028-08-01",
    "reconciliation overrides the item card even with a later date and no stock movement");
  await purchase(["2028-10-01"]);
  assert.equal((await card()).nearestExpiryDate,"2028-08-01");
  await purchase(["2028-03-01"]);
  assert.equal((await card()).nearestExpiryDate,"2028-03-01");
  assert.equal(first.lines.length,2);
  await assertBalanced(f,s.company.id);
});

async function createTestComposition(f:Fixture,s:Setup,name="Count test composition") {
  return (await f.owner.ok<{composition:{id:number}}>("POST",
    `${s.path}/item-compositions`,{
      idempotencyKey:randomUUID(),arabicName:name,englishName:name,
      active:true,
    },201)).composition;
}

test("zero selected stock location bypasses shelf/expiry requirements and preserves item card", async t => {
  const f=await fixture(t), s=await setup(f,"Zero location physical count");
  const item=await s.item({
    factor2:1,factor3:1,hasExpiry:true,purchasePrice:"20",
    nearestExpiryDate:"2027-05-01",
  });
  await invoice(f,s,invoiceBody(s,item.id,{
    lines:[{itemId:item.id,unit:1,quantity:"5",unitPrice:"20",expiryDate:"2027-09-01"}],
  }));
  const card=()=>f.owner.ok<{item:Item}>("GET",`${s.path}/items/${item.id}`);
  const before=(await card()).item;
  const basic={
    documentDate:"2026-10-12",itemId:item.id,locationId:s.showroom.id,
    countedUnits:{unit1:"0"},expectedQuantitySmallest:"5",unit:1,
  };
  assert.equal((await f.owner.request("POST",`${s.path}/stock-adjustments`,{
    ...basic,nearestExpiryDate:"2027-04-01",idempotencyKey:randomUUID(),
  })).status,409,"normal counting must require a shelf");
  const shelf=(await f.pool.query(
    "SELECT id FROM item_shelves WHERE company_id=$1 AND NOT archived LIMIT 1",
    [s.company.id],
  )).rows[0]!.id as number;
  assert.equal((await f.owner.request("POST",`${s.path}/stock-adjustments`,{
    ...basic,shelfId:shelf,idempotencyKey:randomUUID(),
  })).status,409,"normal counting must require an expiry for expiring items");
  const body={...basic,zeroLocation:true,idempotencyKey:randomUUID()};
  const zero=await f.owner.ok<{operation:StockOperation}>(
    "POST",`${s.path}/stock-adjustments`,body,201);
  assert.equal(zero.operation.movements.reduce(
    (sum,move)=>sum+BigInt(move.quantitySmallest),0n),-5n);
  assert.equal((await f.owner.ok<{quantitySmallest:string}>(
    "GET",`${s.path}/stock-count-snapshot?itemId=${item.id}&locationId=${s.showroom.id}`,
  )).quantitySmallest,"0");
  const after=(await card()).item;
  assert.equal(after.nearestExpiryDate,before.nearestExpiryDate);
  assert.equal(after.shelfId,before.shelfId);
  assert.equal(after.revision,before.revision,
    "zeroing must not write shelf, composition or expiry into the item card");
  assert.equal(after.compositionId,null,
    "zeroing must never require or set a composition");
  const repeated=await f.owner.ok<{operation:StockOperation}>(
    "POST",`${s.path}/stock-adjustments`,body,200);
  assert.equal(repeated.operation.id,zero.operation.id);
  // Ordinary count cannot proceed without choosing composition, even when
  // shelf and date are provided. Linking a valid active composition is atomic.
  const withoutComposition=await f.owner.request("POST",`${s.path}/stock-adjustments`,{
    ...basic,countedUnits:{unit1:"1"},expectedQuantitySmallest:"0",
    shelfId:shelf,nearestExpiryDate:"2027-04-01",idempotencyKey:randomUUID(),
  });
  assert.equal(withoutComposition.status,409);
  const composition=await createTestComposition(f,s,"Zero test follow-up composition");
  const regular=await f.owner.ok<{operation:StockOperation}>("POST",
    `${s.path}/stock-adjustments`,{
      ...basic,countedUnits:{unit1:"1"},expectedQuantitySmallest:"0",
      shelfId:shelf,nearestExpiryDate:"2027-04-01",
      compositionId:composition.id,idempotencyKey:randomUUID(),
    },201);
  assert.equal(regular.operation.movements[0]?.quantitySmallest,"1");
  assert.equal((await card()).item.compositionId,composition.id,
    "ordinary counted stock must persist selected composition to item card");
  await assertBalanced(f,s.company.id);
});

test("physical reconciliation accepts a previously negative balance and counts packs plus loose ampoules", async t => {
  const f=await fixture(t),s=await setup(f,"Negative stock physical count");
  const updated=await f.owner.ok<{settings:InventorySettings}>(
    "PUT",`${s.path}/inventory-settings`,{
      inventoryAccountId:s.accounts.inventory!.id,
      salesAccountId:s.accounts.salesRevenue!.id,
      cogsAccountId:s.accounts.costOfGoodsSold!.id,
      surplusAccountId:s.accounts.stockSurplus!.id,
      shortageAccountId:s.accounts.stockShortage!.id,
      costingMethod:"weighted_average",allowNegative:true,
      revision:s.settings.revision,
    },
  );
  assert.equal(updated.settings.allowNegative,true);
  const composition=await createTestComposition(f,s,"Ampoules count composition");
  const item=await s.item({
    factor2:3,factor3:1,
    unit1Name:"باكت",unit2Name:"أمبولة",unit3Name:"—",
    purchasePrice:"30",salePrice1:"40",hasExpiry:false,
  });
  await invoice(f,s,invoiceBody(s,item.id,{
    kind:"sale",counterpartyAccountId:s.customer.id,
    lines:[{itemId:item.id,unit:1,quantity:"1"}],
  }));
  const snapshot=await f.owner.ok<{quantitySmallest:string}>(
    "GET",`${s.path}/stock-count-snapshot?itemId=${item.id}&locationId=${s.showroom.id}`,
  );
  assert.equal(snapshot.quantitySmallest,"-3");
  const shelves=(await f.pool.query<{id:number}>(
    "SELECT id FROM item_shelves WHERE company_id=$1 AND NOT archived ORDER BY id LIMIT 1",
    [s.company.id],
  )).rows;
  assert(shelves.length>0);
  const counted=await f.owner.ok<{operation:StockOperation}>(
    "POST",`${s.path}/stock-adjustments`,{
      idempotencyKey:randomUUID(),documentDate:"2026-10-19",
      itemId:item.id,locationId:s.showroom.id,
      countedUnits:{unit1:"2",unit2:"2"},
      expectedQuantitySmallest:"-3",
      shelfId:shelves[0]!.id,compositionId:composition.id,unit:1,
    },201,
  );
  assert.equal(counted.operation.movements.reduce(
    (sum,movement)=>sum+BigInt(movement.quantitySmallest),0n),11n,
    "moving from minus three to eight pieces needs a +11 adjustment");
  const after=await f.owner.ok<{quantitySmallest:string}>(
    "GET",`${s.path}/stock-count-snapshot?itemId=${item.id}&locationId=${s.showroom.id}`,
  );
  assert.equal(after.quantitySmallest,"8");
  assert.equal((await f.owner.ok<{item:Item}>("GET",
    `${s.path}/items/${item.id}`)).item.compositionId,composition.id);
  await assertBalanced(f,s.company.id);
});

test("adjustment auto-prices from the item card and atomically changes its shelf and nearest expiry", async (t) => {
  const f=await fixture(t),s=await setup(f);
  const composition=await createTestComposition(f,s,"Auto priced count composition");
  const shelfRows=await f.pool.query(
    "SELECT id,name FROM item_shelves WHERE company_id=$1 AND NOT archived ORDER BY id LIMIT 2",
    [s.company.id],
  );
  assert(shelfRows.rows.length>=2,"company seeded shelves");
  const firstShelf=shelfRows.rows[0],secondShelf=shelfRows.rows[1];
  const item=await s.item({
    factor2:1,factor3:1,hasExpiry:true,purchasePrice:"25",nearestExpiryDate:null,
  });
  const base={
    documentDate:"2026-10-12",itemId:item.id,locationId:s.showroom.id,
    unit:1 as const,expiryDate:"2027-03-01",
    countedUnits:{unit1:"3"},expectedQuantitySmallest:"0",
    nearestExpiryDate:"2027-01-01",shelfId:firstShelf.id,
    compositionId:composition.id,
    description:"جرد تلقائي",idempotencyKey:randomUUID(),
  };
  const response=await f.owner.ok<{operation:StockOperation}>(
    "POST",`${s.path}/stock-adjustments`,base,201,
  );
  assert.equal(response.operation.movements[0]?.costBase,"75",
    "cost should be three first units × the item card purchase price");
  let updated=(await f.owner.ok<{item:Item}>(
    "GET",`${s.path}/items/${item.id}`)).item;
  assert.equal(updated.shelfId,firstShelf.id);
  assert.equal(updated.shelf,firstShelf.name);
  assert.equal(updated.compositionId,composition.id);
  assert.equal(updated.nearestExpiryDate,"2027-01-01");
  const repeated=await f.owner.ok<{operation:StockOperation}>(
    "POST",`${s.path}/stock-adjustments`,base,200);
  assert.equal(repeated.operation.id,response.operation.id);
  const unchanged=(await f.owner.ok<{item:Item}>(
    "GET",`${s.path}/items/${item.id}`)).item;
  assert.equal(unchanged.revision,updated.revision);

  const next={
    ...base,expectedQuantitySmallest:"3",countedUnits:{unit1:"3"},
    nearestExpiryDate:"2027-02-01",shelfId:secondShelf.id,idempotencyKey:randomUUID(),
  };
  const noMovement=await f.owner.ok<{operation:StockOperation}>(
    "POST",`${s.path}/stock-adjustments`,next,201);
  assert.equal(noMovement.operation.movements.length,0);
  updated=(await f.owner.ok<{item:Item}>(
    "GET",`${s.path}/items/${item.id}`)).item;
  assert.equal(updated.shelfId,secondShelf.id);
  assert.equal(updated.nearestExpiryDate,"2027-02-01");
  const beforeRevision=updated.revision;
  assert.equal((await f.owner.request("POST",`${s.path}/stock-adjustments`,{
    ...next,shelfId:99999999,idempotencyKey:randomUUID(),
  })).status,409);
  assert.equal((await f.owner.ok<{item:Item}>(
    "GET",`${s.path}/items/${item.id}`)).item.revision,beforeRevision);
  await assertBalanced(f,s.company.id);
});

test("inventory slice counts establish exact opening stock, transfer units conserve value and shortage/surplus counts balance the ledger", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    item = await s.item({ hasExpiry: false });
  const opening = await adjust(f, s, item.id, {
    countedQuantity: "2",
    unit: 1,
    unitCostBase: "600",
  });
  assert.equal(opening.movements[0]!.quantitySmallest, "48");
  assert.equal(opening.movements[0]!.costBase, "1200");
  const moved = await transfer(f, s, item.id, { quantity: "1", unit: 2 });
  assert.equal(
    moved.movements.reduce(
      (sum, value) => sum + BigInt(value.quantitySmallest),
      0n,
    ),
    0n,
  );
  assert.equal(
    moved.movements.reduce(
      (sum, value) => sum + minorUnits(value.costBase),
      0n,
    ),
    0n,
  );
  let stock = await balances(f, s, item.id);
  assert.equal(
    stock.find((value) => value.locationId === s.showroom.id)!.quantitySmallest,
    "36",
  );
  assert.equal(
    stock.find((value) => value.locationId === s.warehouse.id)!
      .quantitySmallest,
    "12",
  );
  assert.equal(stock[0]!.pooledQuantitySmallest, "48");
  assert.equal(stock[0]!.pooledValueBase, "1200");
  const shortage = await adjust(f, s, item.id, {
    locationId: s.warehouse.id,
    countedQuantity: "6",
    unit: 3,
  });
  assert.equal(shortage.movements[0]!.quantitySmallest, "-6");
  assert.equal(shortage.movements[0]!.costBase, "-150");
  const surplus = await adjust(f, s, item.id, {
    locationId: s.warehouse.id,
    countedQuantity: "8",
    unit: 3,
    unitCostBase: "30",
  });
  assert.equal(surplus.movements[0]!.quantitySmallest, "2");
  assert.equal(surplus.movements[0]!.costBase, "60");
  stock = await balances(f, s, item.id);
  assert.equal(stock[0]!.pooledQuantitySmallest, "44");
  assert.equal(stock[0]!.pooledValueBase, "1110");
  const inventory = await f.owner.ok<{ totals: { closingBalance: string } }>(
    "GET",
    `${s.path}/account-ledger?accountId=${s.accounts.inventory!.id}`,
  );
  assert.equal(inventory.totals.closingBalance, "1110");
  await assertBalanced(f, s.company.id);
});

test("inventory slice stale counts reject, no-op counts are audited and retries preserve the original operation", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    item = await s.item({ factor2: 1, factor3: 1, hasExpiry: false });
  const key = randomUUID();
  const original = await adjust(f, s, item.id, {
    countedQuantity: "10",
    expectedQuantitySmallest: "0",
    unitCostBase: "1",
    idempotencyKey: key,
  });
  const before = await inventorySnapshot(f, s.company.id);
  const retry = await adjust(f, s, item.id, {
    countedQuantity: "10",
    expectedQuantitySmallest: "0",
    unitCostBase: "1",
    idempotencyKey: key,
  });
  assert.equal(retry.id, original.id);
  assert.deepEqual(await inventorySnapshot(f, s.company.id), before);
  const stale = await f.owner.request("POST", `${s.path}/stock-adjustments`, {
    idempotencyKey: randomUUID(),
    documentDate: "2026-10-12",
    itemId: item.id,
    locationId: s.showroom.id,
    countedQuantity: "5",
    expectedQuantitySmallest: "0",
    unit: 1,
    unitCostBase: "1",
  });
  assert.equal(stale.status, 409);
  assert.deepEqual(await inventorySnapshot(f, s.company.id), before);
  const noop = await adjust(f, s, item.id, {
    countedQuantity: "10",
    expectedQuantitySmallest: "10",
  });
  assert.equal(noop.financialDocumentId, null);
  assert.equal(noop.movements.length, 0);
  assert.equal(
    (
      await f.pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM audit_events WHERE company_id=$1 AND target_type='stockOperation' AND target_id=$2",
        [s.company.id, noop.id],
      )
    ).rows[0]!.count,
    1,
  );
  const settingsBody = {
    ...s.settings,
    inventoryAccountId: s.accounts.inventory!.id,
    salesAccountId: s.accounts.salesRevenue!.id,
    cogsAccountId: s.accounts.costOfGoodsSold!.id,
    surplusAccountId: s.accounts.stockSurplus!.id,
    shortageAccountId: s.accounts.stockShortage!.id,
    costingMethod: "weighted_average",
    allowNegative: false,
  };
  delete (settingsBody as Partial<InventorySettings>).companyId;
  delete (settingsBody as Partial<InventorySettings>).baseCurrencyId;
  delete (settingsBody as Partial<InventorySettings>).baseCurrencyCode;
  delete (settingsBody as Partial<InventorySettings>).baseDecimalPlaces;
  const updated = await f.owner.ok<{ settings: InventorySettings }>(
    "PUT",
    `${s.path}/inventory-settings`,
    settingsBody,
  );
  assert.equal(updated.settings.revision, s.settings.revision + 1);
  assert.equal(
    (await f.owner.request("PUT", `${s.path}/inventory-settings`, settingsBody))
      .status,
    409,
  );
});

test("inventory slice permissions enforce independent read/manage/post and company-scoped references at HTTP and database layers", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    other = await setup(f, "Other company");
  const item = await s.item({ factor2: 1, factor3: 1, hasExpiry: false }),
    otherItem = await other.item({ hasExpiry: false });
  const opening = await adjust(f, s, item.id, {
    countedQuantity: "10",
    unitCostBase: "1",
  });
  const reader = await f.member(s.company.id, ["inventory.view"], 1);
  const manager = await f.member(s.company.id, ["inventory.manage"], 2);
  const mover = await f.member(s.company.id, ["inventory.post"], 3);
  const accountant = await f.member(s.company.id, ["finance.post"], 4);
  const counter = await f.member(
    s.company.id,
    ["inventory.post", "finance.post"],
    5,
  );
  const outsider = await f.member(
    other.company.id,
    ["inventory.view", "inventory.post", "finance.post"],
    6,
  );
  for (const client of [reader.client, manager.client, mover.client]) {
    for (const endpoint of [
      "inventory-settings",
      "stock-balances",
      "stock-movements",
      `stock-operations/${opening.id}`,
    ])
      await client.ok("GET", `${s.path}/${endpoint}`);
    for (const master of ["accounts", "currencies", "items", "branches"])
      assert.equal(
        (await client.request("GET", `${s.path}/${master}`)).status,
        403,
      );
  }
  const transferBody = {
    idempotencyKey: randomUUID(),
    documentDate: "2026-10-12",
    itemId: item.id,
    fromLocationId: s.showroom.id,
    toLocationId: s.warehouse.id,
    quantity: "1",
    unit: 1,
  };
  for (const client of [
    reader.client,
    manager.client,
    accountant.client,
    outsider.client,
  ])
    assert.equal(
      (await client.request("POST", `${s.path}/stock-transfers`, transferBody))
        .status,
      403,
    );
  await transfer(f, s, item.id, {}, mover.client);
  const countBody = {
    idempotencyKey: randomUUID(),
    documentDate: "2026-10-12",
    itemId: item.id,
    locationId: s.showroom.id,
    countedQuantity: "8",
    expectedQuantitySmallest: "9",
    unit: 1,
  };
  for (const client of [
    reader.client,
    manager.client,
    mover.client,
    accountant.client,
  ])
    assert.equal(
      (await client.request("POST", `${s.path}/stock-adjustments`, countBody))
        .status,
      403,
    );
  await adjust(f, s, item.id, { countedQuantity: "8" }, counter.client);
  assert.equal(
    (await f.anonymous().request("GET", `${s.path}/stock-balances`)).status,
    401,
  );
  assert.equal(
    (await outsider.client.request("GET", `${s.path}/stock-balances`)).status,
    403,
  );
  assert.equal(
    (
      await f.owner.request(
        "GET",
        `${other.path}/stock-operations/${opening.id}`,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await outsider.client.request(
        "GET",
        `${s.path}/stock-operations/${opening.id}`,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f
        .anonymous()
        .request("GET", `${s.path}/stock-operations/${opening.id}`)
    ).status,
    401,
  );
  for (const body of [
    { ...transferBody, idempotencyKey: randomUUID(), itemId: otherItem.id },
    {
      ...transferBody,
      idempotencyKey: randomUUID(),
      toLocationId: other.showroom.id,
    },
  ])
    assert.equal(
      (await f.owner.request("POST", `${s.path}/stock-transfers`, body)).status,
      409,
    );
  await assert.rejects(
    f.pool.query("UPDATE stock_balances SET item_id=$1 WHERE company_id=$2", [
      otherItem.id,
      s.company.id,
    ]),
    (error: unknown) =>
      !!error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "23503",
  );
  await assert.rejects(
    f.pool.query(
      "UPDATE stock_balances SET location_id=$1 WHERE company_id=$2 AND location_id=$3",
      [other.showroom.id, s.company.id, s.showroom.id],
    ),
    (error: unknown) =>
      !!error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "23503",
  );
  await assertBalanced(f, s.company.id);
});

test("inventory slice exact large opening, concurrent transfers and failed audit preserve complete stock and financial state", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    item = await s.item({ hasExpiry: false });
  const quantity = "9007199254740993";
  const opening = await adjust(f, s, item.id, {
    countedQuantity: quantity,
    unit: 3,
    unitCostBase: "0.01",
  });
  assert.equal(opening.movements[0]!.quantitySmallest, quantity);
  assert.equal(opening.movements[0]!.costBase, "90071992547409.93");
  const before = await inventorySnapshot(f, s.company.id);
  const beforeAuditCount = (
    await f.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM audit_events WHERE company_id=$1",
      [s.company.id],
    )
  ).rows[0]!.count;
  await rejectAudit(f, async () => {
    assert.equal(
      (
        await f.owner.request("POST", `${s.path}/stock-transfers`, {
          idempotencyKey: randomUUID(),
          documentDate: "2026-10-12",
          itemId: item.id,
          fromLocationId: s.showroom.id,
          toLocationId: s.warehouse.id,
          quantity: "1",
          unit: 3,
        })
      ).status,
      500,
    );
  });
  assert.deepEqual(await inventorySnapshot(f, s.company.id), before);
  const alice = await f.member(s.company.id, ["inventory.post"], 1);
  const bob = await f.member(s.company.id, ["inventory.post"], 2);
  const body = {
    idempotencyKey: randomUUID(),
    documentDate: "2026-10-12",
    itemId: item.id,
    fromLocationId: s.showroom.id,
    toLocationId: s.warehouse.id,
    quantity,
    unit: 3,
  };
  const results = await blockedOperations(f, s.company.id, [
    () => alice.client.request("POST", `${s.path}/stock-transfers`, body),
    () =>
      bob.client.request("POST", `${s.path}/stock-transfers`, {
        ...body,
        idempotencyKey: randomUUID(),
      }),
  ]);
  assert.deepEqual(results.map((value) => value.status).sort(), [201, 409]);
  const stock = await balances(f, s, item.id);
  assert.equal(
    stock.find((value) => value.locationId === s.warehouse.id)!
      .quantitySmallest,
    quantity,
  );
  assert.equal(stock[0]!.pooledQuantitySmallest, quantity);
  assert.equal(stock[0]!.pooledValueBase, "90071992547409.93");
  assert(beforeAuditCount > 0);
  await assertBalanced(f, s.company.id);
});

test("commerce permissions require posting authority independently and never widen master or tenant access", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    other = await setup(f, "Other company"),
    item = await s.item({ hasExpiry: false });
  const reader = await f.member(s.company.id, ["commerce.view"], 1);
  const manager = await f.member(s.company.id, ["commerce.manage"], 2);
  const poster = await f.member(s.company.id, ["finance.post"], 3);
  const writer = await f.member(
    s.company.id,
    ["commerce.manage", "finance.post"],
    4,
  );
  const oldEmployee = await f.member(
    s.company.id,
    ["accounts.manage", "items.manage"],
    5,
  );
  const outsider = await f.member(
    other.company.id,
    ["commerce.manage", "finance.post"],
    6,
  );
  const body = invoiceBody(s, item.id, {
    lines: [{ itemId: item.id, unit: 1, quantity: "2", unitPrice: "10" }],
  });
  for (const client of [reader.client, manager.client]) {
    await client.ok("GET", `${s.path}/invoices`);
    for (const type of [
      "items",
      "accounts",
      "currencies",
      "branches",
      "locations",
    ])
      await client.ok("GET", `${s.path}/commerce-options?type=${type}`);
    for (const master of ["accounts", "currencies", "items", "branches"])
      assert.equal(
        (await client.request("GET", `${s.path}/${master}`)).status,
        403,
      );
  }
  for (const client of [
    reader.client,
    manager.client,
    poster.client,
    oldEmployee.client,
    outsider.client,
  ])
    assert.equal(
      (await client.request("POST", `${s.path}/invoices`, body)).status,
      403,
    );
  const purchase = await invoice(f, s, body, writer.client);
  await reader.client.ok("GET", `${s.path}/invoices/${purchase.id}`);
  for (const client of [oldEmployee.client, outsider.client, poster.client])
    assert.equal(
      (await client.request("GET", `${s.path}/invoices`)).status,
      403,
    );
  assert.equal(
    (await f.anonymous().request("GET", `${s.path}/invoices`)).status,
    401,
  );
  const stored = (
    await f.pool.query<{ permissions: string[] }>(
      "SELECT permissions FROM employees WHERE id=$1",
      [oldEmployee.employee.id],
    )
  ).rows[0]!.permissions;
  assert.deepEqual(stored, ["accounts.manage", "items.manage"]);
});

test("invoice validation, cross-company references, missing FX and expiry guards fail without partial stock or ledger", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    other = await setup(f, "Other company"),
    item = await s.item(),
    otherItem = await other.item();
  const before = await stockSnapshot(f, s.company.id);
  for (const quantity of [
    0,
    1.5,
    "0",
    "-0",
    "1.5",
    "1e3",
    "+1",
    "10000000000000000000000",
  ])
    assert.equal(
      (
        await f.owner.request(
          "POST",
          `${s.path}/invoices`,
          invoiceBody(s, item.id, {
            lines: [
              {
                itemId: item.id,
                unit: 1,
                quantity: quantity as string,
                unitPrice: "10",
                expiryDate: "2027-01-31",
              },
            ],
          }),
        )
      ).status,
      400,
      `Invalid quantity ${String(quantity)}`,
    );
  for (const overrides of [
    { currencyId: other.yer.id },
    { branchId: other.branch.id },
    { locationId: other.showroom.id },
    { counterpartyAccountId: other.supplier.id },
    {
      lines: [
        {
          itemId: otherItem.id,
          unit: 1 as const,
          quantity: "1",
          unitPrice: "10",
          expiryDate: "2027-01-31",
        },
      ],
    },
    {
      lines: [
        {
          itemId: item.id,
          unit: 1 as const,
          quantity: "1",
          unitPrice: "10",
          expiryDate: "2026-10-11",
        },
      ],
    },
  ] satisfies Partial<InvoiceInput>[]) {
    const result = await f.owner.request(
      "POST",
      `${s.path}/invoices`,
      invoiceBody(s, item.id, overrides),
    );
    assert.equal(result.status, 409);
  }
  assert.deepEqual(await stockSnapshot(f, s.company.id), before);
  const foreign = await s.item({ currencyId: s.usd.id, hasExpiry: false });
  const afterItem = await stockSnapshot(f, s.company.id);
  assert.equal(
    (
      await f.owner.request(
        "POST",
        `${s.path}/invoices`,
        invoiceBody(s, foreign.id, {
          currencyId: s.usd.id,
          lines: [
            { itemId: foreign.id, unit: 1, quantity: "1", unitPrice: "10" },
          ],
        }),
      )
    ).status,
    409,
  );
  assert.deepEqual(await stockSnapshot(f, s.company.id), afterItem);
  const purchase = await invoice(
    f,
    s,
    invoiceBody(s, item.id, {
      lines: [
        {
          itemId: item.id,
          unit: 1,
          quantity: "1",
          unitPrice: "10",
          expiryDate: "2026-10-12",
        },
      ],
    }),
  );
  const afterPurchase = await stockSnapshot(f, s.company.id);
  assert.equal(
    (
      await f.owner.request(
        "POST",
        `${s.path}/invoices`,
        invoiceBody(s, item.id, {
          kind: "sale",
          documentDate: "2026-10-13",
          counterpartyAccountId: s.customer.id,
          lines: [{ itemId: item.id, unit: 1, quantity: "1" }],
        }),
      )
    ).status,
    409,
  );
  assert.deepEqual(await stockSnapshot(f, s.company.id), afterPurchase);
  await assert.rejects(
    f.pool.query(
      "UPDATE invoices SET counterparty_account_id=$1 WHERE company_id=$2 AND id=$3",
      [other.supplier.id, s.company.id, purchase.id],
    ),
    (error: unknown) =>
      !!error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "23514",
  );
  await assert.rejects(
    f.pool.query(
      "DELETE FROM invoice_lines WHERE company_id=$1 AND invoice_id=$2",
      [s.company.id, purchase.id],
    ),
    (error: unknown) =>
      !!error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "23514",
  );
});

test("sales returns restore archived items into their original batch at historical cost even after expiry", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    item = await s.item({ factor2: 1, factor3: 1, salePrice1: "20" });
  await invoice(
    f,
    s,
    invoiceBody(s, item.id, {
      lines: [
        {
          itemId: item.id,
          unit: 1,
          quantity: "2",
          unitPrice: "10",
          expiryDate: "2026-10-13",
        },
      ],
    }),
  );
  const sale = await invoice(
    f,
    s,
    invoiceBody(s, item.id, {
      kind: "sale",
      counterpartyAccountId: s.customer.id,
      lines: [{ itemId: item.id, unit: 1, quantity: "1" }],
    }),
  );
  const {
    id: _id,
    companyId: _companyId,
    code: _code,
    revision,
    createdBy: _creator,
    createdAt: _created,
    updatedAt: _updated,
    agentName: _agentName,
    agentActive: _agentActive,
    currencyCode: _currencyCode,
    currencyName: _currencyName,
    currencyDecimalPlaces: _currencyDecimalPlaces,
    currencyActive: _currencyActive,
    ...fields
  } = item;
  assert.equal(
    (
      await f.owner.request("PATCH", `${s.path}/items/${item.id}`, {
        ...fields,
        revision,
        factor2: 2,
      })
    ).status,
    409,
  );
  await f.owner.ok("PATCH", `${s.path}/items/${item.id}`, {
    ...fields,
    revision,
    active: false,
    salePrice1: "99",
  });
  const returned = await invoice(
    f,
    s,
    invoiceBody(s, item.id, {
      kind: "sale",
      documentDate: "2026-10-14",
      counterpartyAccountId: s.customer.id,
      lines: [
        {
          itemId: item.id,
          unit: 1,
          quantity: "-1",
          originalLineId: sale.lines[0]!.id,
        },
      ],
    }),
  );
  assert.equal(returned.total, "-20");
  assert.equal(returned.lines[0]!.unitPrice, "20");
  assert.equal(returned.lines[0]!.costBase, "-10");
  const restored = (await movements(f, s, item.id)).find(
    (value) => value.invoiceId === returned.id,
  )!;
  assert.equal(restored.expiryDate, "2026-10-13");
  assert.equal(restored.locationId, s.showroom.id);
  assert.equal(restored.quantitySmallest, "1");
  assert.equal(restored.costBase, "10");
  assert.notEqual(restored.originalMovementId, null);
  const stock = await balances(f, s, item.id);
  assert.equal(stock[0]!.pooledQuantitySmallest, "2");
  assert.equal(stock[0]!.pooledValueBase, "20");
  await assertBalanced(f, s.company.id);
});

test("configured purchase receipt requirement applies only to matching header account choice",async t=>{
  const f=await fixture(t),s=await setup(f,"Required receipt by header account");
  const item=await s.item({hasExpiry:false,factor2:1,factor3:1});
  await f.owner.ok("PATCH",`${s.path}/accounts/${s.supplier.id}`,{accountChoice:"wholesale"});
  const initial=invoiceBody(s,item.id,{
    lines:[{itemId:item.id,unit:1,quantity:"1",unitPrice:"12",expiryDate:null}],
  });
  // The default is opt-in. Before enabling any requirement the blank receipt is valid.
  const unregulated=await invoice(f,s,initial);
  assert.equal(unregulated.supplierReceiptNumber,"");
  await f.owner.ok("PUT",`${s.path}/control/purchase_receipt_required_choices`,{
    value:["wholesale","pharmacy","company"],employeeId:null,revision:null,
  });
  const missing=await f.owner.request("POST",`${s.path}/invoices`,{
    ...initial,idempotencyKey:randomUUID(),
  });
  assert.equal(missing.status,409);
  const withReceipt=await invoice(f,s,{
    ...initial,idempotencyKey:randomUUID(),supplierReceiptNumber:"INV-2026-17",
  });
  assert.equal(withReceipt.supplierReceiptNumber,"INV-2026-17");
  // An asset/cash header account is not classified wholesale. The choice of
  // supplier must not mistakenly trigger the requirement for the header.
  const cashPurchase=await invoice(f,s,{
    ...initial,idempotencyKey:randomUUID(),
    counterpartyAccountId:s.cash.id,supplierAccountId:s.supplier.id,
  });
  assert.equal(cashPurchase.supplierReceiptNumber,"");
  await assertBalanced(f,s.company.id);
});

test("linked sales returns keep original valuation while recording an edited expiry batch", async (t) => {
  const f = await fixture(t);
  const s = await setup(f);
  const item = await s.item({ factor2: 1, factor3: 1, salePrice1: "20" });
  await invoice(f, s, invoiceBody(s, item.id, {
    lines: [{ itemId: item.id, unit: 1, quantity: "2", unitPrice: "10", expiryDate: "2027-01-01" }],
  }));
  const sale = await invoice(f, s, invoiceBody(s, item.id, {
    kind: "sale",
    counterpartyAccountId: s.customer.id,
    lines: [{ itemId: item.id, unit: 1, quantity: "1" }],
  }));
  const returned = await invoice(f, s, invoiceBody(s, item.id, {
    kind: "sale",
    counterpartyAccountId: s.customer.id,
    lines: [{
      itemId: item.id, unit: 1, quantity: "-1",
      originalLineId: sale.lines[0]!.id, expiryDate: "2027-06-01",
    }],
  }));
  assert.equal(returned.lines[0]!.expiryDate, "2027-06-01");
  assert.equal(returned.lines[0]!.costBase, "-10");
  const restored = (await movements(f, s, item.id)).find(
    movement => movement.invoiceId === returned.id,
  )!;
  assert.equal(restored.expiryDate, "2027-06-01");
  assert.equal(restored.costBase, "10");
  assert.notEqual(restored.originalMovementId, null);
  await assertBalanced(f, s.company.id);
});

test("zero-net sales and their returns keep stock, cost and discount journals without charging the counterparty", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    item = await s.item({
      factor2: 1,
      factor3: 1,
      hasExpiry: false,
      salePrice1: "1",
    });
  await invoice(
    f,
    s,
    invoiceBody(s, item.id, {
      lines: [{ itemId: item.id, unit: 1, quantity: "3", unitPrice: "2" }],
    }),
  );
  const sale = await invoice(
    f,
    s,
    invoiceBody(s, item.id, {
      kind: "sale",
      counterpartyAccountId: s.customer.id,
      discount: "3",
      lines: [{ itemId: item.id, unit: 1, quantity: "3" }],
    }),
  );
  assert.equal(sale.total, "0");
  assert.equal(sale.baseTotal, "0");
  assert.equal(sale.returning, false);
  assert(sale.financialDocumentId);
  assert(sale.costDocumentId);
  assert.equal(sale.lines[0]!.costBase, "6");
  const returns: Invoice[] = [];
  for (let index = 0; index < 3; index++)
    returns.push(
      await invoice(
        f,
        s,
        invoiceBody(s, item.id, {
          kind: "sale",
          counterpartyAccountId: s.customer.id,
          lines: [
            {
              itemId: item.id,
              unit: 1,
              quantity: "-1",
              originalLineId: sale.lines[0]!.id,
            },
          ],
        }),
      ),
    );
  for (const returned of returns) {
    assert.equal(returned.total, "0");
    assert.equal(returned.returning, true);
    assert.equal(returned.lines[0]!.costBase, "-2");
  }
  assert.equal(
    (
      await f.owner.ok<Page<Invoice>>(
        "GET",
        `${s.path}/invoices?kind=sale&returning=true`,
      )
    ).total,
    3,
  );
  assert.equal(
    (
      await f.owner.ok<Page<Invoice>>(
        "GET",
        `${s.path}/invoices?kind=sale&returning=false`,
      )
    ).total,
    1,
  );
  const party = await f.owner.ok<{ totals: { closingBalance: string } }>(
    "GET",
    `${s.path}/account-ledger?accountId=${s.customer.id}`,
  );
  assert.equal(party.totals.closingBalance, "0");
  const stock = await balances(f, s, item.id);
  assert.equal(stock[0]!.pooledQuantitySmallest, "3");
  assert.equal(stock[0]!.pooledValueBase, "6");
  await assertBalanced(f, s.company.id);
});

test("zero-net partial returns caused by minor-unit rounding complete the exact original refund and remain idempotent", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    item = await s.item({
      factor2: 1,
      factor3: 1,
      hasExpiry: false,
      salePrice1: "0.01",
    });
  await invoice(
    f,
    s,
    invoiceBody(s, item.id, {
      lines: [{ itemId: item.id, unit: 1, quantity: "3", unitPrice: "0.01" }],
    }),
  );
  const sale = await invoice(
    f,
    s,
    invoiceBody(s, item.id, {
      kind: "sale",
      counterpartyAccountId: s.customer.id,
      discount: "0.02",
      lines: [{ itemId: item.id, unit: 1, quantity: "3" }],
    }),
  );
  const body = invoiceBody(s, item.id, {
    kind: "sale",
    counterpartyAccountId: s.customer.id,
    lines: [
      {
        itemId: item.id,
        unit: 1,
        quantity: "-1",
        originalLineId: sale.lines[0]!.id,
      },
    ],
  });
  const first = await invoice(f, s, body);
  assert.equal(first.total, "0");
  assert.equal(first.discount, "-0.01");
  const after = await stockSnapshot(f, s.company.id);
  assert.equal((await invoice(f, s, body)).id, first.id);
  assert.deepEqual(await stockSnapshot(f, s.company.id), after);
  const second = await invoice(f, s, { ...body, idempotencyKey: randomUUID() });
  const last = await invoice(f, s, { ...body, idempotencyKey: randomUUID() });
  assert.equal(second.total, "0");
  assert.equal(last.total, "-0.01");
  assert.equal(
    [first, second, last].reduce(
      (sum, value) => sum + minorUnits(value.discount),
      0n,
    ),
    -minorUnits("0.02"),
  );
  assert.equal(
    [first, second, last].reduce(
      (sum, value) => sum + minorUnits(value.total),
      0n,
    ),
    -minorUnits(sale.total),
  );
  assert.equal((await balances(f, s, item.id))[0]!.pooledValueBase, "0.03");
  assert.equal(
    (
      await f.owner.request("POST", `${s.path}/invoices`, {
        ...body,
        idempotencyKey: randomUUID(),
      })
    ).status,
    409,
  );
  await assertBalanced(f, s.company.id);
});

test("zero-net purchases and free sale returns finalize without dummy journals and preserve current cost variance", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    item = await s.item({
      factor2: 1,
      factor3: 1,
      hasExpiry: false,
      salePrice1: "0",
    });
  const free = await invoice(
    f,
    s,
    invoiceBody(s, item.id, {
      discount: "20",
      lines: [{ itemId: item.id, unit: 1, quantity: "2", unitPrice: "10" }],
    }),
  );
  assert.equal(free.total, "0");
  assert.equal(free.financialDocumentId, null);
  assert.equal(free.costDocumentId, null);
  assert.equal(
    (await stockSnapshot(f, s.company.id)).financial_documents!.length,
    0,
  );
  await invoice(
    f,
    s,
    invoiceBody(s, item.id, {
      lines: [{ itemId: item.id, unit: 1, quantity: "2", unitPrice: "10" }],
    }),
  );
  const returned = await invoice(
    f,
    s,
    invoiceBody(s, item.id, {
      lines: [
        {
          itemId: item.id,
          unit: 1,
          quantity: "-1",
          originalLineId: free.lines[0]!.id,
        },
      ],
    }),
  );
  assert.equal(returned.total, "0");
  assert.equal(returned.financialDocumentId, null);
  assert(returned.varianceDocumentId);
  assert.equal(returned.lines[0]!.costBase, "-5");
  const sale = await invoice(
    f,
    s,
    invoiceBody(s, item.id, {
      kind: "sale",
      counterpartyAccountId: s.customer.id,
      lines: [{ itemId: item.id, unit: 1, quantity: "1" }],
    }),
  );
  assert.equal(sale.total, "0");
  assert.equal(sale.gross, "0");
  assert.equal(sale.financialDocumentId, null);
  assert(sale.costDocumentId);
  const restored = await invoice(
    f,
    s,
    invoiceBody(s, item.id, {
      kind: "sale",
      counterpartyAccountId: s.customer.id,
      lines: [
        {
          itemId: item.id,
          unit: 1,
          quantity: "-1",
          originalLineId: sale.lines[0]!.id,
        },
      ],
    }),
  );
  assert.equal(restored.total, "0");
  assert.equal(restored.financialDocumentId, null);
  assert(restored.costDocumentId);
  const stock = await balances(f, s, item.id);
  assert.equal(stock[0]!.pooledQuantitySmallest, "3");
  assert.equal(stock[0]!.pooledValueBase, "15");
  const inventory = await f.owner.ok<{ totals: { closingBalance: string } }>(
    "GET",
    `${s.path}/account-ledger?accountId=${s.accounts.inventory!.id}`,
  );
  assert.equal(inventory.totals.closingBalance, "15");
  for (const query of [
    [
      "UPDATE invoices SET description='tampered' WHERE company_id=$1 AND id=$2",
      [s.company.id, free.id],
    ],
    [
      "UPDATE invoice_lines SET cost_base=1 WHERE company_id=$1 AND invoice_id=$2",
      [s.company.id, free.id],
    ],
    [
      "INSERT INTO stock_movements(company_id,item_id,location_id,batch_key,quantity_smallest,cost_base,kind,invoice_id,invoice_line_id,document_date,created_by) SELECT company_id,item_id,location_id,batch_key,quantity_smallest,cost_base,kind,invoice_id,invoice_line_id,document_date,created_by FROM stock_movements WHERE company_id=$1 AND invoice_id=$2",
      [s.company.id, free.id],
    ],
  ] as const)
    await assert.rejects(
      f.pool.query(query[0], [...query[1]]),
      (error: unknown) =>
        !!error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "23514",
    );
  await assertBalanced(f, s.company.id);
});

test("invoice follow-ups are deferred, durable and processed exactly once after save", async (t) => {
  const f = await fixture(t);
  const s = await setup(f, "Durable invoice followup company");
  const product = await s.item();
  const cashier = await f.member(s.company.id,
    ["commerce.manage", "commerce.view", "finance.post"], 970);
  const path = `${s.path}/wallet?employeeId=${cashier.employee.id}`;
  const task = (await f.owner.ok<{tasks:{code:string;revision:number|null}[]}>(
    "GET", `${s.path}/reward-tasks`
  )).tasks.find(task => task.code === "PURCHASE_SAVED")!;
  await f.owner.ok("PUT", `${s.path}/reward-tasks/PURCHASE_SAVED`, {
    points:"12",repeatRule:"per-document",enabled:true,
    roleIds:[],pageKey:null,revision:task.revision,
  });
  const body = invoiceBody(s, product.id);
  const first = (await cashier.client.ok<{invoice:Invoice}>(
    "POST", `${s.path}/invoices`, body, 201
  )).invoice;
  const pending = await f.pool.query(
    "SELECT processed_at FROM invoice_post_followups WHERE company_id=$1 AND invoice_id=$2",
    [s.company.id, first.id],
  );
  assert.equal(pending.rowCount, 1);
  assert.equal(pending.rows[0].processed_at, null);
  assert.equal((await f.owner.ok<{wallet:{points:string}}>("GET",path)).wallet.points,
    "0", "The cashier receives success before deferred work runs");
  assert.equal(await processInvoicePostFollowup(f.pool), true);
  assert.equal((await f.owner.ok<{wallet:{points:string}}>("GET",path)).wallet.points,"12");
  assert.equal((await f.pool.query(
    "SELECT processed_at IS NOT NULL AS done FROM invoice_post_followups WHERE company_id=$1 AND invoice_id=$2",
    [s.company.id,first.id],
  )).rows[0].done,true);
  assert.equal(await processInvoicePostFollowup(f.pool), false);
  const replay = (await cashier.client.ok<{invoice:Invoice}>(
    "POST", `${s.path}/invoices`, body, 201
  )).invoice;
  assert.equal(replay.id, first.id);
  assert.equal((await f.owner.ok<{wallet:{points:string}}>("GET",path)).wallet.points,"12");
});

test("invoice reward tasks are opt-in, grouped by logical lines, idempotent and shared with posting", async (t) => {
  const f = await fixture(t);
  const s = await setup(f, "Invoice-rewards company");
  const item = await s.item();
  const staff = await f.member(s.company.id, ["commerce.manage", "commerce.view", "finance.post"], 77);
  const walletUrl = `${s.path}/wallet?employeeId=${staff.employee.id}`;
  const points = async () =>
    (await f.owner.ok<{ wallet: { points: string } }>("GET", walletUrl)).wallet.points;
  const configure = async (code: string, value: string, enabled = true) => {
    const { tasks } = await f.owner.ok<{ tasks: { code: string; revision: number | null }[] }>("GET", `${s.path}/reward-tasks`);
    const task = tasks.find((entry) => entry.code === code)!;
    return f.owner.ok("PUT", `${s.path}/reward-tasks/${code}`, {
      points: value, repeatRule: "per-document", enabled, roleIds: [], pageKey: null, revision: task.revision,
    });
  };

  const beforeBody = invoiceBody(s, item.id);
  const before = await invoice(f, s, beforeBody, staff.client);
  assert.equal(await points(), "0", "Tasks must not award before explicit activation");
  await configure("PURCHASE_SAVED", "10");
  await configure("PURCHASE_LINES", "3");
  const replayBefore = await invoice(f, s, beforeBody, staff.client);
  assert.equal(replayBefore.id, before.id);
  assert.equal(await points(), "0", "Old invoice replay must not award retroactively");

  const body = invoiceBody(s, item.id, {
    lines: [
      { itemId: item.id, unit: 1, quantity: "1", unitPrice: "800", expiryDate: "2027-01-31" },
      { itemId: item.id, unit: 1, quantity: "2", unitPrice: "800", expiryDate: "2027-01-31" },
      { itemId: item.id, unit: 1, quantity: "1", unitPrice: "700", expiryDate: "2027-01-31" },
    ],
  });
  const saved = await invoice(f, s, body, staff.client);
  assert.equal(await points(), "16", "10 invoice + 2 distinct item/unit/price/batch groups * 3");
  assert.equal((await invoice(f, s, body, staff.client)).id, saved.id);
  assert.equal(await points(), "16", "Retry must not award again");
  let rewards = await f.pool.query(
    "SELECT task_code,points::text,logical_line_count,invoice_id,task_revision FROM employee_wallet_entries WHERE company_id=$1 AND invoice_id=$2 ORDER BY task_code",
    [s.company.id, saved.id],
  );
  assert.deepEqual(rewards.rows.map((row) => [row.task_code, row.points, row.logical_line_count]), [
    ["PURCHASE_LINES", "6", 2],
    ["PURCHASE_SAVED", "10", 1],
  ]);
  assert(rewards.rows.every((row) => row.invoice_id === saved.id && row.task_revision > 0));

  await configure("SALE_SAVED", "5");
  await configure("SALE_LINES", "2");
  const sale = await invoice(f, s, invoiceBody(s, item.id, {
    kind: "sale", counterpartyAccountId: s.customer.id,
    lines: [
      { itemId: item.id, unit: 1, quantity: "1", unitPrice: "1000" },
      { itemId: item.id, unit: 1, quantity: "1", unitPrice: "1000" },
    ],
  }), staff.client);
  assert.equal(await points(), "23", "5 sale + 2 grouped lines; previous purchase points remain");

  await invoice(f, s, invoiceBody(s, item.id, {
    kind: "sale", counterpartyAccountId: s.customer.id,
    lines: [{ itemId: item.id, unit: 1, quantity: "-1", originalLineId: sale.lines[0]!.id }],
  }), staff.client);
  assert.equal(await points(), "30", "A sale return earns positive work points");

  await configure("PURCHASE_SAVED", "20");
  assert.equal(await points(), "30", "Changing task settings cannot reprice past awards");
  await invoice(f, s, invoiceBody(s, item.id, {
    lines: [{ itemId: item.id, unit: 1, quantity: "-1", originalLineId: saved.lines[0]!.id }],
  }), staff.client);
  assert.equal(await points(), "53", "Purchase return earns the new 20+3 points");

  const originalEntry = (await f.pool.query(
    "SELECT id FROM employee_wallet_entries WHERE company_id=$1 AND invoice_id=$2 AND task_code='PURCHASE_SAVED'",
    [s.company.id, saved.id],
  )).rows[0]!.id as number;
  await f.owner.ok("POST", `${s.path}/wallet/reversals`, {
    entryId: originalEntry, reason: "تصحيح مكافأة فاتورة", idempotencyKey: randomUUID(),
  });
  assert.equal(await points(), "43", "Original automatic award remains immutable after a compensating reversal");

  const snapshot = await stockSnapshot(f, s.company.id);
  await rejectAudit(f, async () => {
    const failed = invoiceBody(s, item.id);
    const response = await staff.client.request("POST", `${s.path}/invoices`, failed);
    assert.equal(response.status, 500);
  });
  assert.deepEqual(await stockSnapshot(f, s.company.id), snapshot, "Audit failure must undo all invoice/stock/accounting writes");
  assert.equal(await points(), "43", "Audit failure must not leave wallet credits");
});


test("mixed signed sale and purchase rows preserve each direction for positive, negative and zero nets", async (t) => {
  const f = await fixture(t);
  const s = await setup(f);
  const item = await s.item({
    factor2: 1,
    factor3: 1,
    hasExpiry: false,
    salePrice1: "10",
  });
  await invoice(
    f,
    s,
    invoiceBody(s, item.id, {
      lines: [{ itemId: item.id, unit: 1, quantity: "20", unitPrice: "4" }],
    }),
  );
  let expectedQuantity = 20n;
  for (const kind of ["sale", "purchase"] as const) {
    for (const quantities of [
      ["3", "-1"],
      ["-1", "1"],
      ["-3", "1"],
    ]) {
      const signedQuantity = quantities.reduce(
        (sum, quantity) => sum + BigInt(quantity),
        0n,
      );
      const price = kind === "sale" ? 10n : 4n;
      const body = invoiceBody(s, item.id, {
        kind,
        counterpartyAccountId: kind === "sale" ? s.customer.id : s.supplier.id,
        lines: quantities.map((quantity) => ({
          itemId: item.id,
          unit: 1 as const,
          quantity,
          ...(kind === "purchase" ? { unitPrice: "4" } : {}),
        })),
      });
      const saved = await invoice(f, s, body);
      assert.equal(
        saved.returning,
        false,
        "A negative first row or net must not change positive rows",
      );
      assert.equal(saved.mixed, true);
      assert.equal(saved.total, (signedQuantity * price).toString());
      assert.equal(saved.gross, saved.total);
      assert.equal(saved.baseTotal, saved.total);
      assert.deepEqual(
        saved.lines.map((line) => line.quantity),
        quantities,
      );
      assert.deepEqual(
        saved.lines.map((line) => line.costBase),
        quantities.map((quantity) => (BigInt(quantity) * 4n).toString()),
      );
      expectedQuantity += kind === "sale" ? -signedQuantity : signedQuantity;
      const stock = (await balances(f, s, item.id))[0]!;
      assert.equal(stock.pooledQuantitySmallest, expectedQuantity.toString());
      assert.equal(stock.pooledValueBase, (expectedQuantity * 4n).toString());
      const ownMovements = (await movements(f, s, item.id)).filter(
        (row) => row.invoiceId === saved.id,
      );
      assert.deepEqual(
        ownMovements.map((row) => row.kind).sort(),
        kind === "sale"
          ? ["sale", "sales_return"]
          : ["purchase", "purchase_return"],
      );
      if (signedQuantity === 0n) assert.equal(saved.financialDocumentId, null);
      else assert(saved.financialDocumentId);
      const snapshot = await stockSnapshot(f, s.company.id);
      assert.equal((await invoice(f, s, body)).id, saved.id);
      assert.deepEqual(await stockSnapshot(f, s.company.id), snapshot);
      assert.equal(
        (
          await f.owner.request("POST", `${s.path}/invoices`, {
            ...body,
            description: "Different signed retry",
          })
        ).status,
        409,
      );
      assert.deepEqual(await stockSnapshot(f, s.company.id), snapshot);
    }
  }
  const beforeFailure = await stockSnapshot(f, s.company.id);
  await rejectAudit(f, async () => {
    const failed = await f.owner.request(
      "POST",
      `${s.path}/invoices`,
      invoiceBody(s, item.id, {
        kind: "sale",
        counterpartyAccountId: s.customer.id,
        lines: [
          { itemId: item.id, unit: 1, quantity: "-1" },
          { itemId: item.id, unit: 1, quantity: "2" },
        ],
      }),
    );
    assert.equal(failed.status, 500);
  });
  assert.deepEqual(await stockSnapshot(f, s.company.id), beforeFailure);
  await assertBalanced(f, s.company.id);
});

test("mixed linked returns retain original discount cost commission and limits independently of positive rows", async (t) => {
  const f = await fixture(t);
  const s = await setup(f);
  const item = await s.item({
    factor2: 1,
    factor3: 1,
    hasExpiry: false,
    salePrice1: "10",
    commissionRate: "5",
    clearanceFrom: "2026-10-01",
    clearanceTo: "2026-10-31",
  });
  await invoice(
    f,
    s,
    invoiceBody(s, item.id, {
      lines: [{ itemId: item.id, unit: 1, quantity: "20", unitPrice: "4" }],
    }),
  );
  const original = await invoice(
    f,
    s,
    invoiceBody(s, item.id, {
      kind: "sale",
      counterpartyAccountId: s.customer.id,
      discount: "4",
      lines: [{ itemId: item.id, unit: 1, quantity: "2" }],
    }),
  );
  const mixed = await invoice(
    f,
    s,
    invoiceBody(s, item.id, {
      kind: "sale",
      counterpartyAccountId: s.customer.id,
      discount: "1",
      lines: [
        {
          itemId: item.id,
          unit: 1,
          quantity: "-1",
          originalLineId: original.lines[0]!.id,
        },
        { itemId: item.id, unit: 1, quantity: "1" },
      ],
    }),
  );
  assert.equal(mixed.mixed, true);
  assert.equal(mixed.gross, "0");
  assert.equal(mixed.discount, "-1");
  assert.equal(mixed.total, "1");
  assert.deepEqual(
    mixed.lines.map((line) => [
      line.total,
      line.discount,
      line.costBase,
      line.commissionAmount,
    ]),
    [
      ["-8", "-2", "-4", "-0.4"],
      ["9", "1", "4", "0.45"],
    ],
  );
  assert(
    mixed.financialDocumentId,
    "A zero gross with a nonzero signed discount still posts a balanced journal",
  );
  assert.equal(mixed.costDocumentId, null);
  const returnFromMixed = await invoice(
    f,
    s,
    invoiceBody(s, item.id, {
      kind: "sale",
      counterpartyAccountId: s.customer.id,
      lines: [
        {
          itemId: item.id,
          unit: 1,
          quantity: "-1",
          originalLineId: mixed.lines[1]!.id,
        },
      ],
    }),
  );
  assert.equal(returnFromMixed.total, "-9");
  assert.equal(returnFromMixed.lines[0]!.commissionAmount, "-0.45");
  const beforeOverreturn = await stockSnapshot(f, s.company.id);
  const overreturn = await f.owner.request(
    "POST",
    `${s.path}/invoices`,
    invoiceBody(s, item.id, {
      kind: "sale",
      counterpartyAccountId: s.customer.id,
      lines: [
        { itemId: item.id, unit: 1, quantity: "1" },
        {
          itemId: item.id,
          unit: 1,
          quantity: "-2",
          originalLineId: original.lines[0]!.id,
        },
      ],
    }),
  );
  assert.equal(overreturn.status, 409);
  assert.deepEqual(await stockSnapshot(f, s.company.id), beforeOverreturn);

  const purchasedItem = await s.item({
    factor2: 1,
    factor3: 1,
    hasExpiry: true,
  });
  const purchased = await invoice(
    f,
    s,
    invoiceBody(s, purchasedItem.id, {
      lines: [
        {
          itemId: purchasedItem.id,
          unit: 1,
          quantity: "2",
          unitPrice: "4",
          expiryDate: "2027-01-31",
        },
      ],
    }),
  );
  await invoice(
    f,
    s,
    invoiceBody(s, purchasedItem.id, {
      lines: [
        {
          itemId: purchasedItem.id,
          unit: 1,
          quantity: "2",
          unitPrice: "6",
          expiryDate: "2027-01-31",
        },
      ],
    }),
  );
  const purchaseMixed = await invoice(
    f,
    s,
    invoiceBody(s, purchasedItem.id, {
      lines: [
        {
          itemId: purchasedItem.id,
          unit: 1,
          quantity: "-1",
          originalLineId: purchased.lines[0]!.id,
        },
        {
          itemId: purchasedItem.id,
          unit: 1,
          quantity: "1",
          unitPrice: "6",
          expiryDate: "2027-01-31",
        },
      ],
    }),
  );
  assert.equal(purchaseMixed.total, "2");
  assert.equal(purchaseMixed.mixed, true);
  assert.deepEqual(
    purchaseMixed.lines.map((line) => line.costBase),
    ["-5", "6"],
  );
  assert(purchaseMixed.varianceDocumentId);
  const stock = (await balances(f, s, purchasedItem.id))[0]!;
  assert.equal(stock.pooledQuantitySmallest, "4");
  assert.equal(stock.pooledValueBase, "21");
  const beforeInvalid = await stockSnapshot(f, s.company.id);
  assert.equal(
    (
      await f.owner.request(
        "POST",
        `${s.path}/invoices`,
        invoiceBody(s, purchasedItem.id, {
          lines: [
            {
              itemId: purchasedItem.id,
              unit: 1,
              quantity: "-2",
              originalLineId: purchased.lines[0]!.id,
            },
            {
              itemId: purchasedItem.id,
              unit: 1,
              quantity: "1",
              unitPrice: "6",
              expiryDate: "2027-01-31",
            },
          ],
        }),
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await f.owner.request(
        "POST",
        `${s.path}/invoices`,
        invoiceBody(s, purchasedItem.id, {
          lines: [
            {
              itemId: purchasedItem.id,
              unit: 1,
              quantity: "-1",
              unitPrice: "4",
            },
            {
              itemId: purchasedItem.id,
              unit: 1,
              quantity: "1",
              unitPrice: "6",
              expiryDate: "2027-01-31",
            },
          ],
        }),
      )
    ).status,
    409,
  );
  assert.deepEqual(await stockSnapshot(f, s.company.id), beforeInvalid);
  await assertBalanced(f, s.company.id);
});

test("mixed invoice work rewards remain positive and direct purchase returns use explicit price expiry", async (t) => {
  const f = await fixture(t);
  const s = await setup(f);
  const item = await s.item({
    factor2: 1,
    factor3: 1,
    hasExpiry: true,
    salePrice1: "10",
  });
  await invoice(
    f,
    s,
    invoiceBody(s, item.id, {
      lines: [
        {
          itemId: item.id,
          unit: 1,
          quantity: "10",
          unitPrice: "4",
          expiryDate: "2027-01-31",
        },
      ],
    }),
  );
  const staff = await f.member(
    s.company.id,
    ["commerce.manage", "commerce.view", "finance.post"],
    78,
  );
  for (const [code, points] of [
    ["SALE_SAVED", "5"],
    ["SALE_LINES", "2"],
    ["PURCHASE_SAVED", "10"],
    ["PURCHASE_LINES", "3"],
  ]) {
    const { tasks } = await f.owner.ok<{
      tasks: { code: string; revision: number | null }[];
    }>("GET", `${s.path}/reward-tasks`);
    const task = tasks.find((entry) => entry.code === code)!;
    await f.owner.ok("PUT", `${s.path}/reward-tasks/${code}`, {
      points,
      repeatRule: "per-document",
      enabled: true,
      roleIds: [],
      pageKey: null,
      revision: task.revision,
    });
  }
  const points = async () =>
    (
      await f.owner.ok<{ wallet: { points: string } }>(
        "GET",
        `${s.path}/wallet?employeeId=${staff.employee.id}`,
      )
    ).wallet.points;
  const saleBody = invoiceBody(s, item.id, {
    kind: "sale",
    counterpartyAccountId: s.customer.id,
    lines: [
      { itemId: item.id, unit: 1, quantity: "-1", expiryDate: "2027-01-31" },
      { itemId: item.id, unit: 1, quantity: "1" },
    ],
  });
  const sale = await invoice(f, s, saleBody, staff.client);
  assert.equal(sale.lines[0]!.costBase, "-4");
  assert.equal(sale.total, "0");
  assert.equal(
    await points(),
    "9",
    "Both expiry-distinct work groups earn positive points",
  );
  assert.equal((await invoice(f, s, saleBody, staff.client)).id, sale.id);
  assert.equal(await points(), "9");
  const purchaseBody = invoiceBody(s, item.id, {
    lines: [
      {
        itemId: item.id,
        unit: 1,
        quantity: "-2",
        unitPrice: "4",
        expiryDate: "2027-01-31",
      },
      {
        itemId: item.id,
        unit: 1,
        quantity: "1",
        unitPrice: "6",
        expiryDate: "2027-01-31",
      },
    ],
  });
  const purchase = await invoice(f, s, purchaseBody, staff.client);
  assert.equal(purchase.total, "-2");
  assert.equal(purchase.returning, false);
  assert.equal(purchase.lines[0]!.unitPrice, "4");
  assert.equal(purchase.lines[0]!.costBase, "-8");
  assert.equal(
    await points(),
    "25",
    "10 save + two distinct purchase work groups * 3",
  );
  assert.equal(
    (await invoice(f, s, purchaseBody, staff.client)).id,
    purchase.id,
  );
  assert.equal(await points(), "25");
  await assertBalanced(f, s.company.id);
});

test("dated item clearance commissions snapshot net sales and reverse linked returns without repricing", async (t) => {
  const f = await fixture(t);
  const s = await setup(f);
  const product = await s.item({
    name: "Dated commission product",
    commissionRate: "5",
    clearanceFrom: "2026-10-10",
    clearanceTo: "2026-10-12",
  });
  assert.equal(product.commissionRate, "5");
  assert.equal(product.clearanceFrom, "2026-10-10");
  assert.equal(product.clearanceTo, "2026-10-12");
  await invoice(f, s, invoiceBody(s, product.id, {
    documentDate: "2026-10-01",
    lines: [{itemId:product.id,unit:1,quantity:"20",unitPrice:"800",expiryDate:"2027-12-31"}],
  }));
  async function sell(date: string, quantity = "1", discount = "0") {
    return invoice(f, s, invoiceBody(s, product.id, {
      kind: "sale",
      documentDate: date,
      counterpartyAccountId: s.customer.id,
      discount,
      lines: [{itemId:product.id,unit:1,quantity,expiryDate:null}],
    }));
  }
  const before = await sell("2026-10-09");
  assert.equal(before.lines[0]!.commissionRate, "0");
  assert.equal(before.lines[0]!.commissionAmount, "0");
  const opening = await sell("2026-10-10", "2", "100");
  assert.equal(opening.lines[0]!.total, "1900");
  assert.equal(opening.lines[0]!.commissionRate, "5");
  assert.equal(opening.lines[0]!.commissionAmount, "95");
  const ending = await sell("2026-10-12");
  assert.equal(ending.lines[0]!.commissionAmount, "50");
  const after = await sell("2026-10-13");
  assert.equal(after.lines[0]!.commissionAmount, "0");
  assert.equal(after.lines[0]!.commissionRate, "0");
  await f.pool.query(
    "UPDATE items SET commission_rate=12,clearance_from='2026-11-01',clearance_to='2026-11-30',revision=revision+1 WHERE company_id=$1 AND id=$2",
    [s.company.id, product.id],
  );
  const history = await f.owner.ok<{invoice:Invoice}>(
    "GET", s.path + "/invoices/" + opening.id,
  );
  assert.equal(history.invoice.lines[0]!.commissionRate, "5");
  assert.equal(history.invoice.lines[0]!.commissionAmount, "95");
  const firstReturn = await invoice(f, s, invoiceBody(s, product.id, {
    kind: "sale",
    documentDate: "2026-10-14",
    counterpartyAccountId: s.customer.id,
    discount: "0",
    lines: [{itemId: product.id,unit:1,quantity:"-1",originalLineId:opening.lines[0]!.id,expiryDate:null}],
  }));
  assert.equal(firstReturn.lines[0]!.commissionRate, "5");
  assert.equal(firstReturn.lines[0]!.commissionAmount, "-47.5");
  const finalReturn = await invoice(f, s, invoiceBody(s, product.id, {
    kind: "sale",
    documentDate: "2026-10-15",
    counterpartyAccountId: s.customer.id,
    discount: "0",
    lines: [{itemId: product.id,unit:1,quantity:"-1",originalLineId:opening.lines[0]!.id,expiryDate:null}],
  }));
  assert.equal(finalReturn.lines[0]!.commissionAmount, "-47.5");
  assert.equal(
    (await f.owner.request("POST", s.path + "/items", {
      idempotencyKey: randomUUID(),name:"Bad percentage",currencyId:s.yer.id,
      commissionRate:"101",clearanceFrom:"2026-10-10",clearanceTo:"2026-10-20",
    })).status, 400,
  );
  assert.equal(
    (await f.owner.request("POST", s.path + "/items", {
      idempotencyKey: randomUUID(),name:"Bad interval",currencyId:s.yer.id,
      commissionRate:"5",clearanceFrom:"2026-10-20",clearanceTo:"2026-10-10",
    })).status, 400,
  );
  assert.equal(
    (await f.owner.request("POST", s.path + "/items", {
      idempotencyKey: randomUUID(),name:"Unbounded commission",currencyId:s.yer.id,
      commissionRate:"5",
    })).status, 400,
  );
  await assertBalanced(f, s.company.id);
});

test("purchase supplier is independent from cash settlement but matches credit liability and immutable snapshots", async (t) => {
  const f = await fixture(t);
  const s = await setup(f, "Supplier separation test");
  const product = await s.item();
  const cashPayload = invoiceBody(s, product.id, {
    counterpartyAccountId: s.cash.id,
    supplierAccountId: s.supplier.id,
  });
  const cashInvoice = await invoice(f, s, cashPayload);
  assert.equal(cashInvoice.counterpartyAccountId, s.cash.id);
  assert.equal(cashInvoice.supplierAccountId, s.supplier.id);
  assert.equal(cashInvoice.supplierAccountCode, s.supplier.code);
  assert.equal(cashInvoice.supplierAccountName, s.supplier.name);
  const rows = await f.pool.query(
    "SELECT account_id, debit::text AS debit, credit::text AS credit FROM financial_document_lines WHERE company_id=$1 AND document_id=$2",
    [s.company.id, cashInvoice.financialDocumentId],
  );
  assert(rows.rows.some((row) => row.account_id === s.cash.id && Number(row.credit) === 1600));
  assert(!rows.rows.some((row) => row.account_id === s.supplier.id));
  const accountOptions = await f.owner.ok<{items:{id:number}[];total:number}>(
    "GET",s.path+"/commerce-options?type=accounts&page=1&pageSize=100&sort=name:asc");
  for(const account of [s.cash,s.customer,s.supplier])
    assert(accountOptions.items.some(row=>row.id===account.id),
      "Account lookup must include cash, customer credit, and supplier liabilities");
  const itemOptions = await f.owner.ok<{items:{id:number;availableSmallest?:string|null;salePrice1:string}[]}>(
    "GET",s.path+"/commerce-options?type=items&page=1&pageSize=10&sort=saleTimes:desc,code:asc");
  const matchingItem=itemOptions.items.find(row=>row.id===product.id);
  assert(matchingItem,"Item is searchable in invoice lookup");
  const storedStock=await f.pool.query(
    "SELECT stock_total::text AS available FROM item_statistics WHERE company_id=$1 AND item_id=$2",
    [s.company.id,product.id]);
  assert.equal(matchingItem.availableSmallest,storedStock.rows[0]?.available??"0",
    "First-unit lookup stock is based on actual pooled inventory statistics");
  assert(matchingItem.salePrice1,
    "Invoice item search includes the sale price even in purchase invoices");
  const cashDetail = await f.owner.ok<{ invoice: Invoice }>("GET", s.path + "/invoices/" + cashInvoice.id);
  assert.equal(cashDetail.invoice.supplierAccountName, s.supplier.name);

  const creditInvoice = await invoice(f, s, invoiceBody(s, product.id, {
    counterpartyAccountId: s.supplier.id,
    supplierAccountId: null,
  }));
  assert.equal(creditInvoice.counterpartyAccountId, s.supplier.id);
  assert.equal(creditInvoice.supplierAccountId, s.supplier.id);
  const creditRows = await f.pool.query(
    "SELECT account_id, credit::text AS credit FROM financial_document_lines WHERE company_id=$1 AND document_id=$2",
    [s.company.id, creditInvoice.financialDocumentId],
  );
  assert(creditRows.rows.some((row) => row.account_id === s.supplier.id && Number(row.credit) === 1600));

  const supplierSearch = await f.owner.ok<{ items: Invoice[]; total: number }>(
    "GET", s.path + "/invoices?kind=purchase&supplierQ=Supplier&payerQ=Cash",
  );
  assert.equal(supplierSearch.total, 1);
  assert.equal(supplierSearch.items[0]?.id, cashInvoice.id);
  const creditSearch = await f.owner.ok<{ items: Invoice[]; total: number }>(
    "GET", s.path + "/invoices?kind=purchase&supplierQ=Supplier&payerQ=Supplier",
  );
  assert.equal(creditSearch.total, 1);
  assert.equal(creditSearch.items[0]?.id, creditInvoice.id);

  assert.equal((await f.owner.request("POST", s.path + "/invoices", invoiceBody(s, product.id, {
    counterpartyAccountId: s.supplier.id,
    supplierAccountId: s.customer.id,
  }))).status, 409);
  const arbitrarySupplier = await invoice(f, s, invoiceBody(s, product.id, {
    counterpartyAccountId: s.cash.id,
    supplierAccountId: s.cash.id,
  }));
  assert.equal(arbitrarySupplier.supplierAccountId, s.cash.id,
    "The informative actual supplier field accepts all active posting accounts");
  assert.equal(arbitrarySupplier.counterpartyAccountId, s.cash.id);
  assert.equal((await f.owner.request("POST", s.path + "/invoices", invoiceBody(s, product.id, {
    kind: "sale",
    counterpartyAccountId: s.customer.id,
    supplierAccountId: s.supplier.id,
  }))).status, 400);

  const blankCash = await f.owner.request("POST", s.path + "/invoices", invoiceBody(s, product.id, {
    counterpartyAccountId: s.cash.id,
    supplierAccountId: null,
  }));
  assert.equal(blankCash.status, 409, "A cash purchase cannot omit the actual supplier");
  const cashRetry = await invoice(f, s, cashPayload);
  assert.equal(cashRetry.id, cashInvoice.id);
  await assertBalanced(f, s.company.id);
});

test("supplier receipt reference preserves external purchase invoice numbers", async (t) => {
  const f = await fixture(t), s = await setup(f);
  const item = await s.item();
  const payload = invoiceBody(s, item.id, { supplierReceiptNumber: "  00077-A/26  " });
  const saved = await invoice(f, s, payload);
  assert.equal(saved.supplierReceiptNumber, "00077-A/26");
  const loaded = await f.owner.ok<{ invoice: Invoice }>(
    "GET", `${s.path}/invoices/${saved.id}`,
  );
  assert.equal(loaded.invoice.supplierReceiptNumber, "00077-A/26");
  const searched = await f.owner.ok<{ items: Invoice[]; total: number }>(
    "GET", `${s.path}/invoices?kind=purchase&q=00077-A`,
  );
  assert.equal(searched.total, 1);
  assert.equal(searched.items[0]?.supplierReceiptNumber, "00077-A/26");
  assert.notEqual(saved.number, saved.supplierReceiptNumber);
  const replay = await invoice(f, s, payload);
  assert.equal(replay.id, saved.id);
  const bad = await f.owner.request(
    "POST", `${s.path}/invoices`,
    invoiceBody(s, item.id, { kind: "sale", supplierReceiptNumber: "MUST-REJECT" }),
  );
  assert.equal(bad.status, 400);
  await assertBalanced(f, s.company.id);
});


test("clearance earnings credit saver only and returns require admin review without deduction", async (t) => {
  const f = await fixture(t);
  const s = await setup(f, "Clearance employee posting company");
  const seller = await f.member(s.company.id, ["commerce.manage","commerce.view","finance.post"], 491);
  const receiver = await f.member(s.company.id, ["commerce.manage","commerce.view","finance.post"], 492);
  const product = await s.item({
    name: "صنف تصريف 10%",
    commissionRate: "10",
    clearanceFrom: "2026-10-10",
    clearanceTo: "2026-10-19",
  });
  await invoice(f, s, invoiceBody(s, product.id, {
    kind: "purchase", documentDate: "2026-10-09",
    lines: [{itemId:product.id,unit:1,quantity:"30",unitPrice:"700",expiryDate:"2027-11-30"}],
  }));
  const sell = (date: string, qty = "1", discount = "0") =>
    invoice(f, s, invoiceBody(s, product.id, {
      kind:"sale", documentDate:date, discount,
      counterpartyAccountId:s.customer.id,
      lines:[{itemId:product.id,unit:1,quantity:qty,unitPrice:"1000",expiryDate:null}],
    }), seller.client);
  const outside = await sell("2026-10-09");
  assert.equal(outside.lines[0]!.commissionAmount,"0");
  const originalBody = invoiceBody(s, product.id, {
    kind:"sale",documentDate:"2026-10-10",discount:"100",
    counterpartyAccountId:s.customer.id,
    lines:[{itemId:product.id,unit:1,quantity:"2",unitPrice:"1000",expiryDate:null}],
  });
  const first = await invoice(f,s,originalBody,seller.client);
  assert.equal(first.lines[0]!.commissionAmount,"190");
  assert.equal((await invoice(f,s,originalBody,seller.client)).id,first.id);
  const last = await sell("2026-10-19");
  assert.equal(last.lines[0]!.commissionAmount,"100");
  const tooLate = await sell("2026-10-20");
  assert.equal(tooLate.lines[0]!.commissionAmount,"0");

  const wallet = await f.owner.ok<{
    clearanceTotals:{amount:string;currencyCode:string}[];
    clearanceHistory:{amount:string;invoiceId:number}[];
  }>("GET", `${s.path}/wallet?employeeId=${seller.employee.id}`);
  assert.deepEqual(wallet.clearanceTotals.map(x=>[x.amount,x.currencyCode]), [["290.000000","YER"]]);
  assert.deepEqual(wallet.clearanceHistory.map(x=>x.invoiceId), [last.id,first.id]);
  const unified = await f.owner.ok<{
    wallet:{points:string;totalPoints:string};
    items:{kind:string;points:string;invoiceId:number}[];
  }>("GET", `${s.path}/wallet?employeeId=${seller.employee.id}`);
  assert.equal(unified.wallet.points,"290");
  assert.equal(unified.wallet.totalPoints,"290");
  assert.deepEqual(unified.items.filter(x=>x.kind==="clearance")
    .map(x=>[x.points,x.invoiceId]), [["100",last.id],["190",first.id]]);

  const earnings = await f.pool.query(
    "SELECT invoice_line_id,amount::text FROM employee_clearance_earnings WHERE company_id=$1 AND employee_id=$2 ORDER BY id",
    [s.company.id,seller.employee.id],
  );
  assert.equal(earnings.rowCount,2,"Replaying a posted invoice must not duplicate earnings");
  const otherWallet = await f.owner.ok<{clearanceTotals:unknown[]}>(
    "GET", `${s.path}/wallet?employeeId=${receiver.employee.id}`);
  assert.equal(otherWallet.clearanceTotals.length,0);

  const returned = await invoice(f,s,invoiceBody(s,product.id,{
    kind:"sale",documentDate:"2026-10-20",counterpartyAccountId:s.customer.id,
    lines:[{itemId:product.id,unit:1,quantity:"-1",originalLineId:first.lines[0]!.id,expiryDate:null}],
  }),receiver.client);
  assert.equal(returned.lines[0]!.commissionAmount,"-95",
    "Keep the original commission candidate only for management review");
  const afterReturn = await f.owner.ok<{
    clearanceTotals:{amount:string}[];
    pendingReturnReviews:{id:number;originalEmployeeName:string|null;candidateAmount:string;originalInvoiceId:number}[];
  }>("GET", `${s.path}/wallet?employeeId=${seller.employee.id}`);
  assert.equal(afterReturn.clearanceTotals[0]!.amount,"290.000000",
    "The return must never debit the salesperson's commission");
  const unifiedAfterReturn = await f.owner.ok<{wallet:{points:string}}>(
    "GET",`${s.path}/wallet?employeeId=${seller.employee.id}`);
  assert.equal(unifiedAfterReturn.wallet.points,"290",
    "Return by another employee cannot debit the unified wallet");

  assert.equal(afterReturn.pendingReturnReviews.length,1);
  const review = afterReturn.pendingReturnReviews[0]!;
  assert.equal(review.originalInvoiceId,first.id);
  assert.equal(review.candidateAmount,"95.000000");
  assert.equal(review.originalEmployeeName,seller.employee.name);
  assert.equal((await receiver.client.request("POST",
    `${s.path}/wallet/clearance-returns/${review.id}/review`,
    {note:"Unauthorized employee review"})).status,403);
  await f.owner.ok("POST",`${s.path}/wallet/clearance-returns/${review.id}/review`,
    {note:"تمت المراجعة ولا تخصم عمولة الموظف"});
  assert.equal((await f.owner.request("POST",
    `${s.path}/wallet/clearance-returns/${review.id}/review`,
    {note:"Repeated review"})).status,409);
  const final = await f.owner.ok<{
    clearanceTotals:{amount:string}[];pendingReturnReviews:unknown[]
  }>("GET",`${s.path}/wallet?employeeId=${seller.employee.id}`);
  assert.equal(final.clearanceTotals[0]!.amount,"290.000000");
  assert.equal(final.pendingReturnReviews.length,0);
  assert.equal((await f.pool.query(
    "SELECT count(*)::int AS count FROM employee_clearance_earnings WHERE company_id=$1",
    [s.company.id],
  )).rows[0].count,2);
  await assertBalanced(f,s.company.id);
});

test("foreign-currency clearance is posted exactly once to the shared YER wallet at invoice rate", async (t) => {
  const f = await fixture(t);
  const s = await setup(f, "Foreign currency unified wallet");
  const seller = await f.member(s.company.id,
    ["commerce.manage","commerce.view","finance.post"], 498);
  const product = await s.item({
    name:"Imported clearance item", hasExpiry:false, currencyId:s.usd.id,
    commissionRate:"10",clearanceFrom:"2026-10-10",clearanceTo:"2026-10-19",
    salePrice1:"100",purchasePrice:"70",
  });
  await f.owner.ok("POST",`${s.path}/exchange-rates`,{
    currencyId:s.usd.id, rate:"2.5",
    effectiveAt:"2026-10-12T00:00:00Z",source:"Unified wallet FX test"
  },201);
  await invoice(f,s,invoiceBody(s,product.id,{
    kind:"purchase",currencyId:s.usd.id,documentDate:"2026-10-12",
    lines:[{itemId:product.id,unit:1,quantity:"5",unitPrice:"70",expiryDate:null}],
  }));
  const body=invoiceBody(s,product.id,{
    kind:"sale",currencyId:s.usd.id,documentDate:"2026-10-12",
    counterpartyAccountId:s.customer.id,
    lines:[{itemId:product.id,unit:1,quantity:"2",unitPrice:"100",expiryDate:null}]
  });
  const sold=await invoice(f,s,body,seller.client);
  assert.equal(sold.lines[0]!.commissionAmount,"20");
  assert.equal(sold.exchangeRate,"2.5");
  assert.equal((await invoice(f,s,body,seller.client)).id,sold.id);
  const wallet=await f.owner.ok<{
    wallet:{points:string};items:{kind:string;points:string;clearanceEarningId:number|null}[];
  }>("GET",`${s.path}/wallet?employeeId=${seller.employee.id}`);
  assert.equal(wallet.wallet.points,"50");
  const lines=wallet.items.filter(x=>x.kind==="clearance");
  assert.equal(lines.length,1);
  assert.equal(lines[0]!.points,"50");
  assert(lines[0]!.clearanceEarningId);
  const ledger=await f.pool.query(
    "SELECT points::text AS points,request_payload FROM employee_wallet_entries WHERE company_id=$1 AND employee_id=$2 AND kind='clearance'",
    [s.company.id,seller.employee.id]
  );
  assert.equal(ledger.rows[0].points,"50");
  assert.equal(ledger.rows[0].request_payload.currency,"USD");
  assert.equal(ledger.rows[0].request_payload.invoiceExchangeRate,"2.500000000000");
  assert.equal(ledger.rowCount,1);
  await assertBalanced(f,s.company.id);
});


test("sales header cashbox shortcuts post pouch transfers, phone-wallet payments, shortage and overage exactly once", async t => {
  const f=await fixture(t),s=await setup(f,"Employee till shortcuts company");
  const seller=await f.member(s.company.id,["commerce.manage","commerce.view","finance.post"],821);
  const other=await f.member(s.company.id,["commerce.manage","commerce.view","finance.post"],822);
  await f.owner.ok("POST",`${s.path}/employees/${seller.employee.id}/accounts`,
    {createSalesCashbox:true});
  const snapshot=(await f.owner.ok<{
    accounts:{links:{kind:string;accountId:number;code:string}[]}
  }>("GET",`${s.path}/employees/${seller.employee.id}/accounts`)).accounts;
  const cash=snapshot.links.find(x=>x.kind==="sales_cash")!;
  const pouch=snapshot.links.find(x=>x.kind==="sales_pouch")!;
  assert(cash&&pouch);
  const ewallet=(await f.owner.ok<{account:Account}>("POST",`${s.path}/accounts`,{
    code:"1112999100",name:"Company electronic wallet",parentId:null,
    kind:"posting",category:"asset",normalSide:"debit",cashOrBank:false,
  },201)).account;
  const links=await f.owner.ok<{items:{purpose:string;accountId:number|null}[]}>(
    "GET",`${s.path}/account-links`);
  const variance=links.items.find(x=>x.purpose==="cashVariance");
  assert(variance?.accountId,"Existing companies must receive the default variance account");
  assert(links.items.some(x=>x.purpose==="electronicWallet"&&x.accountId===null));
  await f.owner.ok("PUT",`${s.path}/account-links/electronicWallet`,{
    accountId:ewallet.id,
  });
  const cashBalance=async(id:number)=>
    (await f.pool.query<{balance:string}>(`SELECT COALESCE(sum(l.base_debit-l.base_credit),0)::text AS balance
      FROM financial_document_lines l JOIN financial_documents d
      ON d.company_id=l.company_id AND d.id=l.document_id
      WHERE l.company_id=$1 AND l.account_id=$2 AND d.status<>'draft'`,
      [s.company.id,id])).rows[0]!.balance;
  const product=await s.item({hasExpiry:false,factor2:1,factor3:1,salePrice1:"1000"});
  await invoice(f,s,invoiceBody(s,product.id,{
    lines:[{itemId:product.id,unit:1,quantity:"120",unitPrice:"600",expiryDate:null}],
  }));
  await invoice(f,s,invoiceBody(s,product.id,{
    kind:"sale",counterpartyAccountId:cash.accountId,
    lines:[{itemId:product.id,unit:1,quantity:"51",unitPrice:"1000",expiryDate:null}],
  }),seller.client);
  assert.equal(await cashBalance(cash.accountId),"51000.000000");
  const endpoint=`${s.path}/sales/cashbox-operations`;
  const send=(kind:"pouch"|"electronic"|"close",amount:string,notes="")=>({
    kind,amount,notes,idempotencyKey:randomUUID()
  });
  const employeeDisallowed=await other.client.request("POST",endpoint,
    send("pouch","100"));
  assert.equal(employeeDisallowed.status,409,"Cannot move a different employee's linked till");
  const pouchIn=send("pouch","5000","نهاية الوردية");
  const saved=await seller.client.ok<{operationId:number;documentId:number}>(
    "POST",endpoint,pouchIn,201);
  assert.deepEqual(await seller.client.ok("POST",endpoint,pouchIn,201),saved);
  assert.equal(await cashBalance(cash.accountId),"46000.000000");
  assert.equal(await cashBalance(pouch.accountId),"5000.000000");
  assert.equal((await seller.client.request("POST",endpoint,
    {...pouchIn,amount:"100"})).status,409,"UUID replay with changed value rejected");
  await seller.client.ok("POST",endpoint,send("pouch","-2000","سحب من الحافظة"),201);
  assert.equal(await cashBalance(cash.accountId),"48000.000000");
  assert.equal(await cashBalance(pouch.accountId),"3000.000000");
  await seller.client.ok("POST",endpoint,send("electronic","3000","دفع عبر الهاتف"),201);
  assert.equal(await cashBalance(cash.accountId),"45000.000000");
  assert.equal(await cashBalance(ewallet.id),"3000.000000");
  // Electronic transfers now only move positive amounts into the company wallet.
  const electronicReceipt=send("electronic","-1000","محاولة ممنوعة");
  assert.equal((await seller.client.request("POST",endpoint,electronicReceipt)).status,409);
  assert.equal(await cashBalance(cash.accountId),"45000.000000");
  assert.equal(await cashBalance(ewallet.id),"3000.000000");
  await seller.client.ok("POST",endpoint,
    send("electronic","1000","مبلغ إضافي للمحفظة"),201);
  assert.equal(await cashBalance(cash.accountId),"44000.000000");
  assert.equal(await cashBalance(ewallet.id),"4000.000000");
  assert.equal((await seller.client.request("POST",endpoint,
    send("close","-1","لا يمكن إدخال جرد نقدي فعلي بالسالب"))).status,409);
  const shortage=await seller.client.ok<{difference:string;bookBalance:string}>(
    "POST",endpoint,send("close","43000","إغلاق الوردية"),201);
  assert.equal(shortage.bookBalance,"44000");
  assert.equal(shortage.difference,"1000");
  assert.equal(await cashBalance(cash.accountId),"0.000000");
  assert.equal(await cashBalance(pouch.accountId),"46000.000000");
  assert.equal(await cashBalance(variance.accountId!),"1000.000000");
  // New positive sales repopulate the same till after the completed closure.
  await invoice(f,s,invoiceBody(s,product.id,{
    kind:"sale",counterpartyAccountId:cash.accountId,
    lines:[{itemId:product.id,unit:1,quantity:"49",unitPrice:"1000",expiryDate:null}],
  }),seller.client);
  const surplus=await seller.client.ok<{difference:string}>(
    "POST",endpoint,send("close","50000","زيادة صندوق"),201);
  assert.equal(surplus.difference,"-1000");
  assert.equal(await cashBalance(cash.accountId),"0.000000");
  assert.equal(await cashBalance(variance.accountId!),"0.000000");
  assert.equal(await cashBalance(pouch.accountId),"96000.000000");

  // Receiving from the electronic wallet must use the dedicated receipt
  // workflow. Neither a negative nor an overdrawn electronic transfer posts.
  assert.equal((await seller.client.request("POST",endpoint,
    send("electronic","-4000","لا ترحيل بالسالب"))).status,409);
  assert.equal(await cashBalance(ewallet.id),"4000.000000");
  assert.equal(await cashBalance(cash.accountId),"0.000000");

  await seller.client.ok("POST",endpoint,
    send("pouch","-98000","استلام أكبر من رصيد الحافظة"),201);
  assert.equal(await cashBalance(pouch.accountId),"-2000.000000");
  assert.equal(await cashBalance(cash.accountId),"98000.000000");

  await seller.client.ok("POST",endpoint,
    send("pouch","103000","ترحيل أكبر من رصيد الصندوق"),201);
  assert.equal(await cashBalance(cash.accountId),"-5000.000000");
  assert.equal(await cashBalance(pouch.accountId),"101000.000000");

  // Closing with a negative book balance must zero the till. Counted cash
  // remains nonnegative, and the offset is recorded as a credit overage.
  const negativeClose=send("close","5","إغلاق صندوق رصيده الدفتري سالب");
  const closed=await seller.client.ok<{
    operationId:number;documentId:number;bookBalance:string;difference:string
  }>("POST",endpoint,negativeClose,201);
  assert.equal(closed.bookBalance,"-5000");
  assert.equal(closed.difference,"-5005");
  assert.deepEqual(await seller.client.ok("POST",endpoint,negativeClose,201),closed);
  assert.equal(await cashBalance(cash.accountId),"0.000000");
  assert.equal(await cashBalance(pouch.accountId),"101005.000000");
  assert.equal(await cashBalance(variance.accountId!),"-5005.000000");
  assert.equal(await cashBalance(ewallet.id),"4000.000000");
  const history=await f.pool.query(
    "SELECT book_balance::text AS book, variance_amount::text AS diff FROM employee_cashbox_operations WHERE company_id=$1 AND id=$2",
    [s.company.id,closed.operationId],
  );
  assert.equal(history.rows[0].book,"-5000.000000");
  assert.equal(history.rows[0].diff,"-5005.000000");

  const audits=await f.pool.query(
    "SELECT count(*)::integer AS n FROM employee_cashbox_operations WHERE company_id=$1",
    [s.company.id],
  );
  assert.equal(audits.rows[0].n,9);
  await assertBalanced(f,s.company.id);
});


test("pouch receipt register posts exactly once, supports zero/full shortage and signed surplus", async t => {
  const f=await fixture(t),s=await setup(f,"Pouch reconciliation company");
  const seller=await f.member(s.company.id,["commerce.manage","commerce.view","finance.post","finance.view"],901);
  const cashier=await f.member(s.company.id,["commerce.manage","commerce.view","finance.post","finance.view"],902);
  for (const member of [seller,cashier]) {
    await f.owner.ok("POST",`${s.path}/employees/${member.employee.id}/accounts`,
      {createSalesCashbox:true});
  }
  const accounts=async(employeeId:number)=>(await f.owner.ok<{
    accounts:{links:{kind:string;accountId:number}[]}
  }>("GET",`${s.path}/employees/${employeeId}/accounts`)).accounts.links;
  const sellerLinks=await accounts(seller.employee.id);
  const receiverLinks=await accounts(cashier.employee.id);
  const cash=sellerLinks.find(x=>x.kind==="sales_cash")!.accountId;
  const pouch=sellerLinks.find(x=>x.kind==="sales_pouch")!.accountId;
  const receivedCash=receiverLinks.find(x=>x.kind==="sales_cash")!.accountId;
  const linkDirectory=await f.owner.ok<{
    items:{purpose:string;accountId:number|null}[]
  }>("GET",`${s.path}/account-links`);
  const variance=linkDirectory.items.find(x=>x.purpose==="cashVariance")!.accountId!;
  const product=await s.item({hasExpiry:false,salePrice1:"1000"});
  await invoice(f,s,invoiceBody(s,product.id,{
    kind:"purchase",lines:[{itemId:product.id,unit:1,quantity:"30",unitPrice:"700",expiryDate:null}],
  }));
  await invoice(f,s,invoiceBody(s,product.id,{
    kind:"sale",counterpartyAccountId:cash,
    lines:[{itemId:product.id,unit:1,quantity:"15",unitPrice:"1000",expiryDate:null}],
  }),seller.client);
  const cashBalance=async (accountId:number)=>(await f.pool.query<{n:string}>(
    `SELECT COALESCE(sum(l.base_debit-l.base_credit),0)::text AS n
      FROM financial_document_lines l JOIN financial_documents d
        ON d.company_id=l.company_id AND d.id=l.document_id
      WHERE l.company_id=$1 AND l.account_id=$2 AND d.status<>'draft'`,
    [s.company.id,accountId],
  )).rows[0]!.n;
  const transfer=(kind:"pouch"|"close",amount:string)=>seller.client.ok<{
    operationId:number
  }>("POST",`${s.path}/sales/cashbox-operations`,{
    kind,amount,notes:"حركة للاختبار",idempotencyKey:randomUUID(),
  },201);
  const exact=await transfer("pouch","1000");
  const zeroShortage=await transfer("pouch","3000");
  const partial=await transfer("pouch","500");
  const negative=await transfer("pouch","-400");
  const negativeExtra=await transfer("pouch","-200");
  const endpoint=`${s.path}/pouch-receipts`;
  const list=async(status:"pending"|"received"|"all")=>cashier.client.ok<{
    total:number;items:{id:number;receiptId:number|null;receivedAmount:string|null}[]
  }>("GET",`${endpoint}?status=${status}&page=1&pageSize=50`);
  const pending=await list("pending");
  assert.equal(pending.total,5);
  assert(pending.items.some(x=>x.id===negative.operationId));
  const receipt=async(id:number,mode:"exact"|"difference",amount?:string,key=randomUUID())=>{
    const body=mode==="exact"
      ? {sourceOperationId:id,mode,notes:"استلام مطابق",idempotencyKey:key}
      : {sourceOperationId:id,mode,receivedAmount:amount,notes:"استلام غير مطابق",idempotencyKey:key};
    return cashier.client.ok<{
      receipt:{id:number;documentId:number;expected:string;received:string;difference:string}
    }>("POST",endpoint,body,201);
  };
  const key=randomUUID();
  const match=await receipt(exact.operationId,"exact",undefined,key);
  assert.deepEqual(match,await receipt(exact.operationId,"exact",undefined,key));
  assert.equal(match.receipt.received,"1000");
  assert.equal(match.receipt.difference,"0");
  assert.equal((await cashier.client.request("POST",endpoint,{
    sourceOperationId:exact.operationId,mode:"exact",notes:"",
    idempotencyKey:randomUUID(),
  })).status,409,"Cannot acknowledge a previously received transfer twice");
  const zero=await receipt(zeroShortage.operationId,"difference","0");
  assert.equal(zero.receipt.difference,"3000");
  const part=await receipt(partial.operationId,"difference","300");
  assert.equal(part.receipt.difference,"200");
  const surplus=await receipt(negative.operationId,"difference","0");
  assert.equal(surplus.receipt.difference,"-400");
  const signedPartial=await receipt(negativeExtra.operationId,"difference","-300");
  assert.equal(signedPartial.receipt.difference,"100");
  assert.equal((await list("pending")).total,0);
  // Five pouch transfers were settled; the electronic test below has only
  // three. Keep the two source registers independent.
  assert.equal((await list("received")).total,5);
  assert.equal((await list("all")).items.filter(x=>x.receiptId!==null).length,5);
  assert.equal(await cashBalance(receivedCash),"1000.000000");
  // The signed partials cancel in the receiving till: +300 and -300.
  assert.equal(await cashBalance(pouch),"0.000000");
  assert.equal(await cashBalance(variance),"2900.000000");
  assert.equal((await f.pool.query(
    "SELECT count(*)::int AS n FROM employee_pouch_receipts WHERE company_id=$1",
    [s.company.id],
  )).rows[0].n,5);
  // A new close-to-pouch transfer must also be visible as a receivable movement.
  const closed=await transfer("close","5");
  assert((await list("pending")).items.some(x=>x.id===closed.operationId));
  const closedReceipt=await receipt(closed.operationId,"exact");
  assert.equal(closedReceipt.receipt.received,"5");
  assert.equal((await list("pending")).total,0);
  assert.equal(await cashBalance(receivedCash),"1005.000000");
  await assertBalanced(f,s.company.id);
});


test("electronic wallet receipt register posts exact, partial, zero and negative amounts once", async t => {
  const f=await fixture(t),s=await setup(f,"Digital wallet receipt company");
  const seller=await f.member(s.company.id,["commerce.manage","commerce.view","finance.post","finance.view"],911);
  const cashier=await f.member(s.company.id,["commerce.manage","commerce.view","finance.post","finance.view"],912);
  for (const member of [seller,cashier]) {
    await f.owner.ok("POST",`${s.path}/employees/${member.employee.id}/accounts`,
      {createSalesCashbox:true});
  }
  const getAccounts=async(employeeId:number)=>(await f.owner.ok<{
    accounts:{links:{kind:string;accountId:number}[]}
  }>("GET",`${s.path}/employees/${employeeId}/accounts`)).accounts.links;
  const sellerAccounts=await getAccounts(seller.employee.id);
  const cashierAccounts=await getAccounts(cashier.employee.id);
  const sellerCash=sellerAccounts.find(x=>x.kind==="sales_cash")!.accountId;
  const cashierCash=cashierAccounts.find(x=>x.kind==="sales_cash")!.accountId;
  const wallet=(await f.owner.ok<{account:Account}>("POST",`${s.path}/accounts`,{
    code:"1112999161",name:"Company wallet for electronic receipt",
    parentId:null,kind:"posting",category:"asset",normalSide:"debit",
    cashOrBank:false,
  },201)).account;
  const accountLinks=await f.owner.ok<{
    items:{purpose:string;accountId:number|null}[]
  }>("GET",`${s.path}/account-links`);
  const variance=accountLinks.items.find(x=>x.purpose==="cashVariance")!.accountId!;
  await f.owner.ok("PUT",`${s.path}/account-links/electronicWallet`,{
    accountId:wallet.id,
  });
  const book=async(accountId:number)=>(await f.pool.query<{value:string}>(
    `SELECT COALESCE(sum(l.base_debit-l.base_credit),0)::text AS value
      FROM financial_document_lines l JOIN financial_documents d
      ON d.company_id=l.company_id AND d.id=l.document_id
      WHERE l.company_id=$1 AND l.account_id=$2 AND d.status<>'draft'`,
    [s.company.id,accountId],
  )).rows[0]!.value;
  const transfer=async(kind:"electronic"|"pouch",amount:string)=>
    seller.client.ok<{operationId:number}>(
      "POST",`${s.path}/sales/cashbox-operations`,{
        kind,amount,notes:"عملية إلكترونية مسجلة",idempotencyKey:randomUUID(),
      },201);
  const exact=await transfer("electronic","1000");
  const fullShortage=await transfer("electronic","2000");
  const partial=await transfer("electronic","500");
  assert.equal((await seller.client.request("POST",`${s.path}/sales/cashbox-operations`,{
    kind:"electronic",amount:"-400",notes:"لا للسالب",idempotencyKey:randomUUID(),
  })).status,409);
  const unrelatedPouch=await transfer("pouch","50");
  assert.equal(await book(wallet.id),"3500.000000");
  const endpoint=`${s.path}/electronic-receipts`;
  const list=async(status:"pending"|"received"|"all")=>
    cashier.client.ok<{
      total:number;items:{id:number;kind:string;walletName:string;
        receiptId:number|null;receivedAmount:string|null}[]
    }>("GET",`${endpoint}?status=${status}&page=1&pageSize=50`);
  const before=await list("pending");
  assert.equal(before.total,3,"The unrelated pouch movement is excluded");
  assert(before.items.every(x=>x.kind==="electronic"&&x.walletName===wallet.name));
  const settle=async(id:number,mode:"exact"|"difference",amount?:string,key=randomUUID())=>{
    const body=mode==="exact"
      ? {sourceOperationId:id,mode,notes:"مطابق",idempotencyKey:key}
      : {sourceOperationId:id,mode,receivedAmount:amount,notes:"غير مطابق",
         idempotencyKey:key};
    return cashier.client.ok<{
      receipt:{id:number;documentId:number;expected:string;
        received:string;difference:string}
    }>("POST",endpoint,body,201);
  };
  assert.equal((await cashier.client.request("POST",endpoint,{
    sourceOperationId:unrelatedPouch.operationId,mode:"exact",notes:"",
    idempotencyKey:randomUUID(),
  })).status,409,"A pouch movement must not be received via electronic wallet");
  const repeatedKey=randomUUID();
  const match=await settle(exact.operationId,"exact",undefined,repeatedKey);
  assert.deepEqual(await settle(exact.operationId,"exact",undefined,repeatedKey),match);
  assert.equal(match.receipt.received,"1000");
  assert.equal(match.receipt.difference,"0");
  assert.equal((await cashier.client.request("POST",endpoint,{
    sourceOperationId:exact.operationId,mode:"exact",notes:"",
    idempotencyKey:randomUUID(),
  })).status,409,"Each electronic receipt may only be settled once");
  assert.equal((await settle(fullShortage.operationId,"difference","0")).receipt.difference,"2000");
  assert.equal((await settle(partial.operationId,"difference","300")).receipt.difference,"200");
  assert.equal((await list("pending")).total,0);
  // Three electronic transfers were made and settled; the unrelated
  // pouch transfer must never increase the electronic receipt count.
  assert.equal((await list("received")).total,3);
  assert.equal((await list("all")).items.filter(x=>x.receiptId!==null).length,3);
  assert.equal(await book(cashierCash),"1300.000000");
  assert.equal(await book(wallet.id),"0.000000");
  assert.equal(await book(variance),"2200.000000");
  assert.equal(await book(sellerCash),"-3550.000000");
  const recorded=await f.pool.query(
    "SELECT count(*)::int AS n FROM employee_electronic_receipts WHERE company_id=$1",
    [s.company.id],
  );
  assert.equal(recorded.rows[0].n,3);
  await assertBalanced(f,s.company.id);
});


test("cashier optional receipt voucher remains atomic, signed, scoped and idempotent", async t => {
  const f=await fixture(t),s=await setup(f,"Cashier modal companion vouchers");
  const seller=await f.member(s.company.id,
    ["commerce.manage","commerce.view","finance.view","finance.post"],1121);
  const cashier=await f.member(s.company.id,
    ["finance.view","finance.post"],1122);
  for(const member of [seller,cashier]) {
    await f.owner.ok("POST",`${s.path}/employees/${member.employee.id}/accounts`,
      {createSalesCashbox:true});
  }
  const accounts=async(employeeId:number)=>(await f.owner.ok<{
    accounts:{links:{kind:string;accountId:number}[]}
  }>("GET",`${s.path}/employees/${employeeId}/accounts`)).accounts.links;
  const cashierCash=(await accounts(cashier.employee.id))
    .find(link=>link.kind==="sales_cash")!.accountId;
  const account=(await f.owner.ok<{account:Account}>(
    "POST",`${s.path}/accounts`,{
      code:"1120009911",name:"Counterparty from cashier popup",
      parentId:null,kind:"posting",category:"asset",
      normalSide:"debit",cashOrBank:false,
    },201)).account;
  const rows=await cashier.client.ok<{items:{id:number;name:string}[]}>(
    "GET",`${s.path}/receipt-counterpart-accounts?q=Counterparty`);
  assert(rows.items.some(x=>x.id===account.id));
  const transfer=async(kind:"pouch"|"electronic"|"close",amount:string)=>{
    const saved=await seller.client.ok<{operationId:number}>(
      "POST",`${s.path}/sales/cashbox-operations`,{
        kind,amount,notes:"مبلغ أعطي للجهة",idempotencyKey:randomUUID(),
      },201);
    return saved.operationId;
  };
  const endpoint=`${s.path}/pouch-receipts`;
  const voucher=(accountId=account.id)=>({
    counterpartyAccountId:accountId,
    notes:"تسليم المبلغ للحساب المقابل",
    receiptNumber:"REC-321",
  });
  const receive=async(id:number,key:string,v:{counterpartyAccountId:number;notes:string;receiptNumber:string}|undefined,
    path=endpoint)=>{
    const payload={sourceOperationId:id,mode:"exact",notes:"تسوية التحويل",
      idempotencyKey:key,...(v?{voucher:v}:{})};
    return cashier.client.ok<{receipt:{documentId:number;
      voucherDocumentId:number|null;received:string}}>(
      "POST",path,payload,201);
  };
  const positive=await transfer("pouch","250");
  const saved=await receive(positive,randomUUID(),voucher());
  const savedVoucher=await f.pool.query(
    "SELECT kind,status,cash_account_id,supplier_receipt_number FROM financial_documents WHERE company_id=$1 AND id=$2",
    [s.company.id,saved.receipt.voucherDocumentId],
  );
  assert.equal(savedVoucher.rows[0].kind,"payment");
  assert.equal(savedVoucher.rows[0].status,"posted");
  assert.equal(savedVoucher.rows[0].cash_account_id,cashierCash);
  assert.equal(savedVoucher.rows[0].supplier_receipt_number,"REC-321");
  const originals=await f.pool.query(
    "SELECT kind,status FROM financial_documents WHERE company_id=$1 AND id=$2",
    [s.company.id,saved.receipt.documentId],
  );
  assert.equal(originals.rows[0].kind,"journal");
  assert.equal(originals.rows[0].status,"posted");
  const signed=await transfer("pouch","-80");
  const key=randomUUID();
  const negative=await receive(signed,key,voucher());
  assert.deepEqual(await receive(signed,key,voucher()),negative);
  const negativeVoucher=await f.pool.query(
    "SELECT kind,status,description FROM financial_documents WHERE company_id=$1 AND id=$2",
    [s.company.id,negative.receipt.voucherDocumentId],
  );
  assert.equal(negativeVoucher.rows[0].kind,"receipt");
  assert.match(negativeVoucher.rows[0].description,/REC-321/);
  const noVoucherId=await transfer("pouch","75");
  const noVoucher=await receive(noVoucherId,randomUUID(),undefined);
  assert.equal(noVoucher.receipt.voucherDocumentId,null);
  // An invalid company-scoped account must roll back BOTH the voucher and
  // the receipt journal, leaving the original operation pending.
  const invalidId=await transfer("pouch","16");
  assert.equal((await cashier.client.request("POST",endpoint,{
    sourceOperationId:invalidId,mode:"exact",notes:"rollback",
    idempotencyKey:randomUUID(),voucher:voucher(999999999),
  })).status,400);
  assert.equal((await f.pool.query(
    "SELECT count(*)::int AS n FROM employee_pouch_receipts WHERE company_id=$1 AND source_operation_id=$2",
    [s.company.id,invalidId],
  )).rows[0].n,0);
  const repaired=await receive(invalidId,randomUUID(),voucher());
  assert(repaired.receipt.voucherDocumentId);
  const wallet=(await f.owner.ok<{account:Account}>(
    "POST",`${s.path}/accounts`,{
      code:"1112999178",name:"Receipt companion wallet",
      parentId:null,kind:"posting",category:"asset",
      normalSide:"debit",cashOrBank:false,
    },201)).account;
  await f.owner.ok("PUT",`${s.path}/account-links/electronicWallet`,{
    accountId:wallet.id,
  });
  const electronic=await transfer("electronic","44");
  const electronicPath=`${s.path}/electronic-receipts`;
  assert.equal((await cashier.client.request("POST",electronicPath,{
    sourceOperationId:electronic,mode:"exact",notes:"لا سند إلكتروني",
    idempotencyKey:randomUUID(),voucher:voucher(),
  })).status,400,"Electronic receipts must reject optional vouchers");
  const digital=await receive(electronic,randomUUID(),undefined,electronicPath);
  assert.equal(digital.receipt.voucherDocumentId,null);
  const digitalDocument=await f.pool.query(
    "SELECT kind,status FROM financial_documents WHERE company_id=$1 AND id=$2",
    [s.company.id,digital.receipt.documentId],
  );
  assert.deepEqual(digitalDocument.rows.map(x=>x.kind),["journal"]);
  assert.equal(digitalDocument.rows[0].status,"posted");
  await assertBalanced(f,s.company.id);
});


test("reconciliation uses nearest expiry only and preserves the existing batch date", async (t) => {
  const f=await fixture(t),s=await setup(f,"Nearest only reconciliation");
  const item=await s.item({
    hasExpiry:true,factor2:1,factor3:1,purchasePrice:"15",
    nearestExpiryDate:"2027-01-01",
  });
  const post=async(count:string,expected:string,nearest:string,key=randomUUID())=>{
    const payload={
      itemId:item.id,locationId:s.showroom.id,documentDate:"2026-10-12",
      countedQuantity:count,expectedQuantitySmallest:expected,unit:1 as const,
      nearestExpiryDate:nearest,idempotencyKey:key,
    };
    return f.owner.ok<{operation:StockOperation}>(
      "POST",`${s.path}/stock-adjustments`,payload,201,
    );
  };
  const first=await post("3","0","2027-02-01");
  assert.equal(first.operation.movements[0]?.expiryDate,"2027-02-01");
  assert.equal(first.operation.movements[0]?.costBase,"45");
  const second=await post("4","3","2027-04-01");
  assert.equal(second.operation.movements[0]?.expiryDate,"2027-02-01",
    "Changing the nearest card expiry must not rebatch historical stock");
  assert.equal(second.operation.movements[0]?.costBase,"15");
  const card=(await f.owner.ok<{item:Item}>("GET",`${s.path}/items/${item.id}`)).item;
  assert.equal(card.nearestExpiryDate,"2027-04-01");
  const quantity=(await balances(f,s,item.id)).find(x=>
    x.locationId===s.showroom.id&&x.expiryDate==="2027-02-01");
  assert.equal(quantity?.quantitySmallest,"4");

  await invoice(f,s,invoiceBody(s,item.id,{
    lines:[{itemId:item.id,unit:1,quantity:"2",unitPrice:"15",expiryDate:"2027-03-01"}],
  }));
  const countPreview=await f.owner.ok<{quantitySmallest:string;batchCount:number}>(
    "GET",`${s.path}/stock-count-snapshot?itemId=${item.id}&locationId=${s.showroom.id}`,
  );
  assert.equal(countPreview.quantitySmallest,"6");
  assert.equal(countPreview.batchCount,2);
  const stale=await f.owner.request("POST",`${s.path}/stock-adjustments`,{
    itemId:item.id,locationId:s.showroom.id,documentDate:"2026-10-12",
    countedQuantity:"5",expectedQuantitySmallest:"4",unit:1,
    nearestExpiryDate:"2027-04-01",idempotencyKey:randomUUID(),
  });
  assert.equal(stale.status,409,"Stale total is rejected even with multiple batches");
  const shortage=await f.owner.ok<{operation:StockOperation}>("POST",
    `${s.path}/stock-adjustments`,{
      itemId:item.id,locationId:s.showroom.id,documentDate:"2026-10-12",
      countedQuantity:"5",expectedQuantitySmallest:"6",unit:1,
      nearestExpiryDate:"2027-04-01",idempotencyKey:randomUUID(),
    },201);
  assert.equal(shortage.operation.movements[0]?.expiryDate,"2027-02-01");
  assert.equal(shortage.operation.movements[0]?.quantitySmallest,"-1");
  const afterShortage=await balances(f,s,item.id);
  assert.equal(afterShortage.find(x=>x.expiryDate==="2027-02-01")?.quantitySmallest,"3");
  assert.equal(afterShortage.find(x=>x.expiryDate==="2027-03-01")?.quantitySmallest,"2");
  const surplus=await f.owner.ok<{operation:StockOperation}>("POST",
    `${s.path}/stock-adjustments`,{
      itemId:item.id,locationId:s.showroom.id,documentDate:"2026-10-12",
      countedQuantity:"7",expectedQuantitySmallest:"5",unit:1,
      nearestExpiryDate:"2027-04-01",idempotencyKey:randomUUID(),
    },201);
  assert.equal(surplus.operation.movements[0]?.expiryDate,"2027-02-01");
  assert.equal(surplus.operation.movements[0]?.quantitySmallest,"2");
  const afterSurplus=await balances(f,s,item.id);
  assert.equal(afterSurplus.find(x=>x.expiryDate==="2027-02-01")?.quantitySmallest,"5");
  assert.equal(afterSurplus.find(x=>x.expiryDate==="2027-03-01")?.quantitySmallest,"2");
  assert.equal((await f.owner.ok<{item:Item}>(
    "GET",`${s.path}/items/${item.id}`)).item.nearestExpiryDate,"2027-04-01");
  await assertBalanced(f,s.company.id);
});


test("sale alerts include item and composition notes, clearance alternatives and controlled expiry window",async(t)=>{
  const f=await fixture(t);
  const s=await setup(f,"Sell-side notes and alternatives");
  const composition=(await f.owner.ok<{composition:{id:number;saleNotes:string}}>(
    "POST",`${s.path}/item-compositions`,{
      arabicName:"تركيب التنبيه",englishName:"Alert composition",
      description:"",saleNotes:"راجع الجرعة قبل البيع",
      active:true,identicalAlternative:true,nonInterchangeable:false,
      idempotencyKey:randomUUID(),
    },201)).composition;
  assert.equal(composition.saleNotes,"راجع الجرعة قبل البيع");
  const product=await s.item({
    name:"الصنف المطلوب",compositionId:composition.id,
    saleNotes:"يحتاج تبريدًا عند البيع",
  });
  const altClearance=await s.item({
    name:"البديل للتصريف",compositionId:composition.id,
    commissionRate:"5",clearanceFrom:"2020-01-01",clearanceTo:"2099-12-31",
  });
  const date=(await f.pool.query(
    "SELECT ((clock_timestamp() AT TIME ZONE 'Asia/Aden')::date + INTERVAL '1 month')::date::text AS soon"
  )).rows[0].soon as string;
  const altExpiry=await s.item({
    name:"البديل قصير الصلاحية",compositionId:composition.id,
    nearestExpiryDate:date,hasExpiry:true,
  });
  const other=await s.item({name:"غير مرتبط",saleNotes:"ملاحظة خاصة"});
  type Alerts={saleNotes:string;compositionSaleNotes:string;
    alternatives:{id:number;clearance:boolean;nearExpiry:boolean}[]};
  const alerts=await f.owner.ok<Alerts>("GET",
    `${s.path}/sales-item-alerts/${product.id}`);
  assert.equal(alerts.saleNotes,"يحتاج تبريدًا عند البيع");
  assert.equal(alerts.compositionSaleNotes,"راجع الجرعة قبل البيع");
  assert(alerts.alternatives.some(x=>x.id===altClearance.id&&x.clearance));
  assert(alerts.alternatives.some(x=>x.id===altExpiry.id&&x.nearExpiry));
  assert(!alerts.alternatives.some(x=>x.id===other.id));
  await f.owner.ok("PUT",`${s.path}/control/sales_near_expiry_months`,{
    value:0,employeeId:null,revision:null,
  });
  const after=await f.owner.ok<Alerts>("GET",`${s.path}/sales-item-alerts/${product.id}`);
  assert(!after.alternatives.some(x=>x.id===altExpiry.id));
  assert(after.alternatives.some(x=>x.id===altClearance.id));
  const s2=await setup(f,"Another company's restricted notes");
  assert.equal((await f.owner.request("GET",
    `${s2.path}/sales-item-alerts/${product.id}`)).status,404);
});

test("product form choices are independent and discrepancy report separates mismatch from general",async(t)=>{
  const f=await fixture(t),s=await setup(f,"Form mismatch monitor company");
  const comp=(await f.owner.ok<{composition:{id:number;productForm:string;revision:number}}>(
    "POST",`${s.path}/item-compositions`,{
      arabicName:"تركيب للمقارنة",englishName:"Form compare",
      description:"",saleNotes:"",active:true,identicalAlternative:false,
      nonInterchangeable:false,productForm:"شراب",idempotencyKey:randomUUID(),
    },201)).composition;
  assert.equal(comp.productForm,"شراب");
  const mismatch=await s.item({
    name:"صنف للمراجعة رقم واحد",compositionId:comp.id,productForm:"اقراص",
  });
  const unclassified=await s.item({
    name:"صنف عام",compositionId:comp.id,productForm:"عام",
  });
  const match=await s.item({
    name:"صنف شراب",compositionId:comp.id,productForm:"شراب",
  });
  const url=`${s.path}/item-form-differences`;
  const review=await f.owner.ok<{items:{itemId:number;itemForm:string;compositionForm:string}[];total:number}>(
    "GET",url);
  assert(review.items.some(row=>row.itemId===mismatch.id && row.itemForm==="اقراص" && row.compositionForm==="شراب"));
  assert(review.items.some(row=>row.itemId===unclassified.id));
  assert(!review.items.some(row=>row.itemId===match.id));
  // Both stored product-form fields are searchable, not only product names.
  const itemFormMatches=await f.owner.ok<{items:{itemId:number}[]}>(
    "GET",url+"?status=all&q="+encodeURIComponent("اقراص"));
  assert(itemFormMatches.items.some(row=>row.itemId===mismatch.id));
  const compositionFormMatches=await f.owner.ok<{items:{itemId:number}[]}>(
    "GET",url+"?status=different&q="+encodeURIComponent("شراب"));
  assert(compositionFormMatches.items.some(row=>row.itemId===mismatch.id));
  const differences=await f.owner.ok<{items:{itemId:number}[]}>(
    "GET",url+"?status=different");
  assert(differences.items.some(row=>row.itemId===mismatch.id));
  assert(!differences.items.some(row=>row.itemId===unclassified.id));
  const unknown=await f.owner.ok<{items:{itemId:number}[]}>(
    "GET",url+"?status=unclassified");
  assert(unknown.items.some(row=>row.itemId===unclassified.id));
  assert(!unknown.items.some(row=>row.itemId===mismatch.id));
  const listed=await f.owner.ok<{items:{itemId:number}[]}>(
    "GET",url+"?status=all");
  assert(listed.items.some(row=>row.itemId===match.id));
  const detail=(await f.owner.ok<{item:Item}>(
    "GET",`${s.path}/items/${mismatch.id}`)).item;
  assert.equal(detail.productForm,"اقراص");
  await f.pool.query(
    "UPDATE items SET product_form='شراب',revision=revision+1 WHERE company_id=$1 AND id=$2",
    [s.company.id,mismatch.id],
  );
  const after=await f.owner.ok<{items:{itemId:number}[]}>("GET",url+"?status=different");
  assert(!after.items.some(row=>row.itemId===mismatch.id));
  const other=await setup(f,"Different company cannot list forms");
  assert.equal((await f.owner.ok<{items:unknown[]}>("GET",
    `${other.path}/item-form-differences`)).items.length,0);
});

test("central employee positions and per-company view/edit rules preserve old access",async(t)=>{
  const f=await fixture(t),s=await setup(f,"Central permission test company");
  const staff=await f.member(s.company.id,["items.view"],888);
  // The old role is a migration detail, not a single-select job title anymore.
  const before=staff.employee;
  const patch=await f.owner.ok<{employee:Employee}>("PATCH",
    `${s.path}/employees/${before.id}`,{
      positions:["sales","cashier","memo-followup"],
    });
  assert.deepEqual(patch.employee.positions,["sales","cashier","memo-followup"]);
  assert.equal(patch.employee.role,before.role);
  assert.deepEqual(patch.employee.permissions,before.permissions);
  const employees=await f.owner.ok<{items:Employee[]}>("GET",
    `${s.path}/employees?position=cashier`);
  assert(employees.items.some(e=>e.id===before.id));
  const noPage=await staff.client.request("GET",`${s.path}/central-access`);
  assert.equal(noPage.status,403,"non-general staff cannot edit central grants");
  const catalog=await f.owner.ok<{
    positions:{key:string}[];
    resources:{key:string;policy:unknown}[];
  }>("GET",`${s.path}/central-access`);
  assert(catalog.positions.some(r=>r.key==="sales"));
  assert(catalog.resources.some(r=>r.key==="field:items.purchase-price"));
  assert(catalog.resources.some(r=>r.key==="button:sales.post"));
  assert(catalog.resources.some(r=>r.key==="page:company.items"));
  const path=`${s.path}/central-access/field%3Aitems.purchase-price`;
  const created=await f.owner.ok<{
    policy:{revision:number;viewPositions:string[];editPositions:string[]}
  }>("PUT",path,{
    viewPositions:["accountant","purchase-entry"],
    editPositions:["purchase-entry"],revision:null,
  });
  assert.equal(created.policy.revision,1);
  assert.deepEqual(created.policy.editPositions,["purchase-entry"]);
  assert.equal((await staff.client.request("PUT",path,{
    viewPositions:["sales"],editPositions:["sales"],revision:1,
  })).status,403);
  assert.equal((await f.owner.request("PUT",path,{
    viewPositions:["sales"],editPositions:["accountant"],revision:1,
  })).status,400,"edit position must also be able to view");
  assert.equal((await f.owner.request("PUT",path,{
    viewPositions:["sales"],editPositions:["sales"],revision:null,
  })).status,409,"stale revision must not silently overwrite");
  const next=await f.owner.ok<{policy:{revision:number}}>("PUT",path,{
    viewPositions:["sales","cashier"],editPositions:["sales"],revision:1,
  });
  assert.equal(next.policy.revision,2);
  // Policies are stored without granting/denying legacy operations yet.
  const profile=await f.owner.ok<{employee:Employee}>("PATCH",
    `${s.path}/employees/${before.id}`,{positions:["sales"]});
  assert(profile.employee.permissions.includes("items.view"));
  const another=await setup(f,"Second company, separate policies");
  const other=await f.owner.ok<{
    resources:{key:string;policy:unknown}[]
  }>("GET",`${another.path}/central-access`);
  assert.equal(other.resources.find(r=>r.key==="field:items.purchase-price")?.policy,null);
  await f.owner.ok("DELETE",path,{revision:2});
  const reset=await f.owner.ok<{resources:{key:string;policy:unknown}[]}>(
    "GET",`${s.path}/central-access`);
  assert.equal(reset.resources.find(r=>r.key==="field:items.purchase-price")?.policy,null);
});

test("form differences sorts all matching rows before paginating for each column",async(t)=>{
  const f=await fixture(t),s=await setup(f,"Sorted form differences");
  const definitions=[
    {composition:"Zeta composition",item:"Alpha item",form:"شراب",itemForm:"عام"},
    {composition:"Alpha composition",item:"Charlie item",form:"عام",itemForm:"كبسول"},
    {composition:"Beta composition",item:"Bravo item",form:"اقراص",itemForm:"مرهم"},
  ] as const;
  for(const row of definitions){
    const composition=(await f.owner.ok<{composition:{id:number}}>(
      "POST",`${s.path}/item-compositions`,{
        arabicName:row.composition,englishName:row.composition,
        description:"",saleNotes:"",active:true,identicalAlternative:false,
        nonInterchangeable:false,productForm:row.form,idempotencyKey:randomUUID(),
      },201)).composition;
    await s.item({
      name:row.item,compositionId:composition.id,productForm:row.itemForm,
    });
  }
  type Result={items:{itemId:number;itemName:string;itemForm:string;
    compositionName:string;compositionForm:string}[];total:number};
  const base=`${s.path}/item-form-differences?status=all&pageSize=1`;
  for(const field of ["itemName","itemForm","compositionName","compositionForm"] as const){
    const collect=async(direction:"asc"|"desc")=>{
      const result=[] as Result["items"];
      for(let page=1;page<=3;page++){
        const url=`${base}&sort=${field}&direction=${direction}&page=${page}`;
        const response=await f.owner.ok<Result>("GET",url);
        assert.equal(response.total,3);
        assert.equal(response.items.length,1);
        result.push(...response.items);
      }
      assert.equal(new Set(result.map(x=>x.itemId)).size,3,"No row may repeat between pages");
      return result.map(x=>x.itemId);
    };
    const asc=await collect("asc");
    const desc=await collect("desc");
    assert.deepEqual(asc,[...desc].reverse(),
      `Sort on ${field} must reverse the entire result set, not only one page`);
  }
  const wrong=await f.owner.request("GET",`${base}&sort=i.id;DROP TABLE items`);
  assert.equal(wrong.status,400,"Untrusted SQL sorting inputs must be rejected");
});

test("required stock-count reconciliations credit configured points once per new operation", async (t) => {
  const f = await fixture(t);
  const s = await setup(f, "Due stock counting rewards");
  const staff = await f.member(s.company.id, ["inventory.post", "finance.post"], 841);
  const wallet = async () => (await f.owner.ok<{
    wallet: { points: string };
  }>("GET", s.path + "/wallet?employeeId=" + staff.employee.id)).wallet;
  const card = (await f.owner.ok<{
    tasks: {code:string;points:string;enabled:boolean;revision:number;repeatRule:string;roleIds:number[];pageKey:string|null}[];
  }>("GET", s.path + "/reward-tasks")).tasks.find((row) => row.code === "STOCK_COUNT_REQUIRED");
  assert(card, "Required-count reward appears in task reward cards");
  assert.equal(card.points, "10");
  assert.equal(card.enabled, true);

  const countItem = async (fromTask: boolean) => {
    const item = await s.item({ hasExpiry: false });
    await invoice(f, s, invoiceBody(s, item.id, {
      lines: [{ itemId: item.id, unit: 1, quantity: "2", unitPrice: "800", expiryDate: null }],
    }));
    await f.pool.query(
      "UPDATE items SET stocktake_required_at=clock_timestamp(),revision=revision+1 WHERE company_id=$1 AND id=$2",
      [s.company.id, item.id],
    );
    const body = {
      documentDate: new Date().toLocaleDateString("sv-SE", {timeZone:"Asia/Aden"}),
      itemId: item.id,
      locationId: s.showroom.id,
      countedQuantity: "2",
      expectedQuantitySmallest: "48",
      unit: 1,
      expiryDate: null,
      idempotencyKey: randomUUID(),
    };
    const dueList = async () => (await f.owner.ok<{items:{id:number}[]}>(
      "GET", s.path + "/settlement-follow-up?dueOnly=1&pageSize=100"
    )).items.some(row => row.id === item.id);
    assert.equal(await dueList(), true, "The item must appear under the report's due-only filter");
    const path = s.path + "/stock-adjustments" + (fromTask ? "?taskSource=required-count" : "");
    const first = await staff.client.ok<{ operation: { id: number } }>("POST", path, body, 201);
    await staff.client.ok("POST", path, body, 200);
    const diagnostic = (await f.pool.query(
      "SELECT i.stocktake_required_at, s.stock_showroom, s.last_adjustment_operation_id, o.document_date, o.created_at AS last_count_at, clock_timestamp() AS now FROM items i LEFT JOIN item_statistics s ON s.company_id=i.company_id AND s.item_id=i.id LEFT JOIN stock_operations o ON o.company_id=s.company_id AND o.id=s.last_adjustment_operation_id WHERE i.company_id=$1 AND i.id=$2",
      [s.company.id,item.id],
    )).rows[0];
    assert.equal(await dueList(), false, "After count, item must leave due-only list: "+JSON.stringify(diagnostic));
    return {operationId:first.operation.id,body,path};
  };
  const {operationId:firstId} = await countItem(true);
  assert.equal((await wallet()).points, "10");
  const firstEntry = await f.pool.query(
    "SELECT stock_operation_id,task_code,points::text AS points FROM employee_wallet_entries WHERE company_id=$1 AND stock_operation_id=$2",
    [s.company.id, firstId],
  );
  assert.equal(firstEntry.rowCount, 1);
  assert.equal(firstEntry.rows[0].points, "10");

  await f.owner.ok("PUT", s.path + "/reward-tasks/STOCK_COUNT_REQUIRED", {
    revision: card.revision,
    points: "17",
    repeatRule: "per-document",
    enabled: true,
    roleIds: [],
    pageKey: null,
    dailyLimit: null,
  });
  await countItem(true);
  assert.equal((await wallet()).points, "27", "The edited reward card applies only to later counts");
  const outsideTask = await countItem(false);
  assert.equal((await wallet()).points, "44",
    "Any due item earns regardless of the navigation or taskSource parameter");
  const noLongerDue = await staff.client.ok<{operation:{id:number}}>(
    "POST", outsideTask.path,
    {...outsideTask.body,idempotencyKey:randomUUID()},201,
  );
  assert(noLongerDue.operation.id > 0);
  assert.equal((await wallet()).points, "44",
    "A repeated count of a no-longer-due item earns no new reward");
});
