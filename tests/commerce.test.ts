import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
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
  return (
    await client.ok<{ invoice: Invoice }>(
      "POST",
      `${s.path}/invoices`,
      body,
      [200, 201],
    )
  ).invoice;
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
  assert.equal((await f.owner.request("POST", s.path + "/invoices", invoiceBody(s, product.id, {
    counterpartyAccountId: s.cash.id,
    supplierAccountId: s.cash.id,
  }))).status, 409);
  assert.equal((await f.owner.request("POST", s.path + "/invoices", invoiceBody(s, product.id, {
    kind: "sale",
    counterpartyAccountId: s.customer.id,
    supplierAccountId: s.supplier.id,
  }))).status, 400);

  const blankCash = await invoice(f, s, invoiceBody(s, product.id, {
    counterpartyAccountId: s.cash.id,
    supplierAccountId: null,
  }));
  assert.equal(blankCash.supplierAccountId, null);
  assert.equal(blankCash.supplierAccountName, null);
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
