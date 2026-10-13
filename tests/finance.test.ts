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
  AccountBalance,
  AccountLedgerLine,
  AccountLedgerTotals,
  Branch,
  Company,
  CompanyCurrency,
  Employee,
  ExchangeRate,
  FinancialDocument,
  FinancialDocumentInput,
  Page,
  Permission,
  SessionResponse,
} from "../packages/contracts/src/index.ts";

// The accounts and credentials in this file exist only in disposable schemas.
const password = "Finance-only-test-passphrase-2026";
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const origin = "http://localhost";
type DocumentResponse = { document: FinancialDocument };
type ReverseResponse = DocumentResponse & {
  reversalDocument: FinancialDocument;
};
type LedgerResponse = Page<AccountLedgerLine> & { totals: AccountLedgerTotals };

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
    const result = await this.request<T>(method, path, body);
    assert.equal(
      result.status,
      status,
      `${method} ${path}: ${JSON.stringify(result.body)}`,
    );
    return result.body;
  }
}

async function fixture(t: TestContext) {
  const schema = `finance_${randomUUID().replaceAll("-", "")}`;
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
    name: "Finance owner",
    displayName: "Finance owner",
    email: "owner@finance.test",
    password,
  });
  const owner = new Client(baseUrl);
  await owner.ok("POST", "/auth/login", { email: user.email, password });
  async function company(name = "Finance test company") {
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
        name: "Finance employee",
        displayName: "Employee",
        email: `employee-${index}@finance.test`,
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
  await f.owner.ok(
    "POST",
    `${path}/currencies/initialize`,
    { baseCurrency: "YER" },
    201,
  );
  const currencies = (
    await f.owner.ok<Page<CompanyCurrency>>("GET", `${path}/currencies`)
  ).items;
  const yer = currencies.find((item) => item.code === "YER")!;
  const usd = currencies.find((item) => item.code === "USD")!;
  const sar = currencies.find((item) => item.code === "SAR")!;
  const makeAccount = async (
    code: string,
    name: string,
    overrides: Record<string, unknown> = {},
  ) =>
    (
      await f.owner.ok<{ account: Account }>(
        "POST",
        `${path}/accounts`,
        {
          code,
          name,
          parentId: null,
          kind: "posting",
          category: "asset",
          normalSide: "debit",
          cashOrBank: false,
          ...overrides,
        },
        201,
      )
    ).account;
  const cash = await makeAccount("1000000001", "Cash", { cashOrBank: true });
  const bank = await makeAccount("1000000002", "Bank", { cashOrBank: true });
  const counter = await makeAccount("1000000003", "Customer");
  const income = await makeAccount("4000000001", "Income", {
    category: "income",
    normalSide: "credit",
  });
  const group = await makeAccount("1000000000", "Assets group", {
    kind: "group",
  });
  const branch = (
    await f.owner.ok<{ branch: Branch }>(
      "POST",
      `${path}/branches`,
      {
        code: "FINANCE",
        name: "Finance branch",
        phone: "",
        address: "",
      },
      201,
    )
  ).branch;
  function input(
    overrides: Partial<FinancialDocumentInput> = {},
  ): FinancialDocumentInput {
    return {
      idempotencyKey: randomUUID(),
      kind: "journal",
      documentDate: "2026-10-11",
      currencyId: yer.id,
      branchId: branch.id,
      cashAccountId: null,
      description: "Test journal",
      lines: [
        {
          accountId: cash.id,
          debit: "100.25",
          credit: "0",
          description: "Debit",
        },
        {
          accountId: counter.id,
          debit: "0",
          credit: "100.25",
          description: "Credit",
        },
      ],
      ...overrides,
    };
  }
  async function draft(
    overrides: Partial<FinancialDocumentInput> = {},
    client = f.owner,
  ) {
    return (
      await client.ok<DocumentResponse>(
        "POST",
        `${path}/financial-documents`,
        input(overrides),
        201,
      )
    ).document;
  }
  async function post(document: FinancialDocument, client = f.owner) {
    return (
      await client.ok<DocumentResponse>(
        "POST",
        `${path}/financial-documents/${document.id}/post`,
        { revision: document.revision },
      )
    ).document;
  }
  async function ledger(accountId: number, query = "") {
    return f.owner.ok<LedgerResponse>(
      "GET",
      `${path}/account-ledger?accountId=${accountId}${query}`,
    );
  }
  return {
    company,
    path,
    currencies,
    yer,
    usd,
    sar,
    cash,
    bank,
    counter,
    income,
    group,
    branch,
    input,
    draft,
    post,
    ledger,
  };
}

async function quote(
  f: Fixture,
  path: string,
  currencyId: number,
  rate: string,
  effectiveAt: string,
  source = "Manual finance quote",
) {
  return (
    await f.owner.ok<{ exchangeRate: ExchangeRate }>(
      "POST",
      `${path}/exchange-rates`,
      { currencyId, rate, effectiveAt, source },
      201,
    )
  ).exchangeRate;
}
async function snapshot(f: Fixture, companyId: number) {
  const result: Record<string, unknown[]> = {};
  for (const table of [
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
async function rejectAudit(f: Fixture, operation: () => Promise<void>) {
  await f.pool.query(
    "CREATE FUNCTION reject_finance_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test rejects financial audit'; END $$",
  );
  await f.pool.query(
    "CREATE TRIGGER reject_finance_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_finance_audit()",
  );
  try {
    await operation();
  } finally {
    await f.pool.query("DROP TRIGGER reject_finance_audit ON audit_events");
    await f.pool.query("DROP FUNCTION reject_finance_audit()");
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
      `Only ${waiting}/${operations.length} financial operations reached the lock`,
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

test("finance permissions separate drafting, posting and reading, with scoped selectors and no unrelated master access", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    other = await setup(f, "Other");
  const reader = await f.member(s.company.id, ["finance.view"]);
  const drafter = await f.member(s.company.id, ["finance.manage"], 2);
  const poster = await f.member(s.company.id, ["finance.post"], 3);
  const oldAccountant = await f.member(
    s.company.id,
    ["accounts.manage", "currencies.manage"],
    4,
  );
  const outsider = await f.member(other.company.id, [], 5);
  await f.owner.ok("PATCH", `/users/${outsider.user.id}`, {
    kind: "admin",
    editor: true,
    monitor: true,
  });
  const document = await s.draft();
  for (const client of [reader.client, drafter.client, poster.client]) {
    for (const path of [
      "financial-documents",
      `financial-documents/${document.id}`,
      "account-balances",
      `account-ledger?accountId=${s.cash.id}`,
      "financial-options?type=accounts",
      "financial-options?type=currencies",
      "financial-options?type=branches",
    ])
      await client.ok("GET", `${s.path}/${path}`);
    for (const master of ["accounts", "currencies", "branches"])
      assert.equal(
        (await client.request("GET", `${s.path}/${master}`)).status,
        403,
        "Finance selectors must not grant master administration access",
      );
  }
  for (const client of [reader.client, poster.client])
    assert.equal(
      (await client.request("POST", `${s.path}/financial-documents`, s.input()))
        .status,
      403,
    );
  const drafted = await s.draft({}, drafter.client);
  assert.equal(
    (
      await drafter.client.request(
        "POST",
        `${s.path}/financial-documents/${drafted.id}/post`,
        { revision: drafted.revision },
      )
    ).status,
    403,
  );
  await s.post(drafted, poster.client);
  for (const client of [reader.client, drafter.client])
    assert.equal(
      (
        await client.request(
          "POST",
          `${s.path}/financial-documents/${drafted.id}/reverse`,
          {
            reason: "Denied reversal",
            documentDate: "2026-10-12",
            idempotencyKey: randomUUID(),
          },
        )
      ).status,
      403,
    );
  for (const path of [
    "financial-documents",
    "account-balances",
    "financial-options?type=accounts",
  ])
    for (const client of [outsider.client, oldAccountant.client])
      assert.equal(
        (await client.request("GET", `${s.path}/${path}`)).status,
        403,
      );
  assert.equal(
    (await f.anonymous().request("GET", `${s.path}/financial-documents`))
      .status,
    401,
  );
  const stored = (
    await f.pool.query("SELECT permissions FROM employees WHERE id=$1", [
      oldAccountant.employee.id,
    ])
  ).rows[0]!.permissions;
  assert.deepEqual(stored, ["accounts.manage", "currencies.manage"]);
});

test("journals keep exact large decimals, drafts have no ledger effect, and stale edits cannot replace a newer revision", async (t) => {
  const f = await fixture(t),
    s = await setup(f);
  const amount = "9007199254740993.01";
  const body = s.input({
    description: "  Precise journal  ",
    lines: [
      {
        accountId: s.cash.id,
        debit: "٩٠٠٧١٩٩٢٥٤٧٤٠٩٩٣٫٠١",
        credit: "0",
        description: "  Exact debit  ",
      },
      {
        accountId: s.counter.id,
        debit: "0",
        credit: amount,
        description: "Exact credit",
      },
    ],
  });
  const document = (
    await f.owner.ok<DocumentResponse>(
      "POST",
      `${s.path}/financial-documents`,
      body,
      201,
    )
  ).document;
  assert.equal(document.status, "draft");
  assert.equal(document.description, "Precise journal");
  assert.equal(document.lines[0]?.debit, amount);
  assert.equal(document.totalDebit, amount);
  assert.equal(document.totalCredit, amount);
  assert.equal(document.createdBy, f.user.id);
  assert.equal(document.postedAt, null);
  assert.equal((await s.ledger(s.cash.id)).total, 0);
  const { idempotencyKey: _key, ...fields } = body;
  const update = {
    ...fields,
    revision: document.revision,
    description: "Updated draft",
  };
  const updated = (
    await f.owner.ok<DocumentResponse>(
      "PATCH",
      `${s.path}/financial-documents/${document.id}`,
      update,
    )
  ).document;
  assert.equal(updated.revision, document.revision + 1);
  assert.equal(updated.createdAt, document.createdAt);
  const before = await snapshot(f, s.company.id);
  assert.equal(
    (
      await f.owner.request(
        "PATCH",
        `${s.path}/financial-documents/${document.id}`,
        { ...update, description: "Stale overwrite" },
      )
    ).status,
    409,
  );
  assert.deepEqual(await snapshot(f, s.company.id), before);
  const posted = await s.post(updated);
  assert.equal(posted.status, "posted");
  assert.equal(posted.exchangeRate, "1");
  assert.equal(posted.exchangeRateId, null);
  assert.equal(posted.totalBaseDebit, amount);
  assert.equal(posted.totalBaseCredit, amount);
  const ledger = await s.ledger(s.cash.id);
  assert.equal(ledger.total, 1);
  assert.equal(ledger.totals.closingBalance, amount);
  assert.equal(ledger.items[0]?.baseDebit, amount);
  const stored = (
    await f.pool.query(
      "SELECT debit::text FROM financial_document_lines WHERE document_id=$1 AND line_number=1",
      [document.id],
    )
  ).rows[0]!;
  assert.equal(stored.debit, `${amount}0000`);
  assert.equal(
    (
      await f.owner.request(
        "PATCH",
        `${s.path}/financial-documents/${document.id}`,
        { ...update, revision: posted.revision },
      )
    ).status,
    409,
  );
});

test("amount validation rejects numbers, exponentials, signs, overflow and excess currency precision without mutations", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    before = await snapshot(f, s.company.id);
  for (const amount of [
    1.25,
    -1,
    "-1",
    "+1",
    "1e3",
    "NaN",
    "Infinity",
    "1,000",
    "10000000000000000000000",
    "0.001",
    "0.0000001",
    "",
  ]) {
    const input = s.input();
    input.lines[0] = {
      accountId: s.cash.id,
      debit: amount as string,
      credit: "0",
      description: "Invalid",
    };
    const response = await f.owner.request(
      "POST",
      `${s.path}/financial-documents`,
      input,
    );
    assert.equal(response.status, 400, `Invalid amount ${String(amount)}`);
  }
  for (const documentDate of [
    "0000-01-01",
    "2026-02-30",
    "2026-10-11T00:00:00Z",
  ])
    assert.equal(
      (
        await f.owner.request(
          "POST",
          `${s.path}/financial-documents`,
          s.input({ documentDate }),
        )
      ).status,
      400,
    );
  assert.deepEqual(await snapshot(f, s.company.id), before);
});

test("zero- and six-place currencies enforce their own quantum while FX overflow cannot reach the ledger", async (t) => {
  const f = await fixture(t),
    s = await setup(f);
  const makeCurrency = async (code: string, decimalPlaces: number) =>
    (
      await f.owner.ok<{ currency: CompanyCurrency }>(
        "POST",
        `${s.path}/currencies`,
        { code, name: code, decimalPlaces },
        201,
      )
    ).currency;
  const integer = await makeCurrency("JPY", 0);
  const precise = await makeCurrency("EUR", 6);
  for (const currency of [integer, precise])
    await quote(f, s.path, currency.id, "1", "2026-10-11T00:00:00Z");
  const whole = await s.post(
    await s.draft({
      currencyId: integer.id,
      lines: [
        { accountId: s.cash.id, debit: "1.000000", credit: "0" },
        { accountId: s.counter.id, debit: "0", credit: "1" },
      ],
    }),
  );
  assert.equal(whole.totalDebit, "1");
  assert.equal(whole.decimalPlaces, 0);
  assert.equal(
    (
      await f.owner.request(
        "POST",
        `${s.path}/financial-documents`,
        s.input({
          currencyId: integer.id,
          lines: [
            { accountId: s.cash.id, debit: "0.1", credit: "0" },
            { accountId: s.counter.id, debit: "0", credit: "0.1" },
          ],
        }),
      )
    ).status,
    400,
  );
  const fraction = await s.post(
    await s.draft({
      currencyId: precise.id,
      lines: [
        { accountId: s.cash.id, debit: "0.123456", credit: "0" },
        { accountId: s.counter.id, debit: "0", credit: "0.123456" },
      ],
    }),
  );
  assert.equal(fraction.totalDebit, "0.123456");
  assert.equal(fraction.totalBaseDebit, "0.12");
  await quote(f, s.path, s.usd.id, "9999999999999999", "2026-10-11T00:00:00Z");
  const amount = "9999999999999999999999.99";
  const overflow = await s.draft({
    currencyId: s.usd.id,
    lines: [
      { accountId: s.cash.id, debit: amount, credit: "0" },
      { accountId: s.counter.id, debit: "0", credit: amount },
    ],
  });
  const before = await snapshot(f, s.company.id);
  assert.equal(
    (
      await f.owner.request(
        "POST",
        `${s.path}/financial-documents/${overflow.id}/post`,
        { revision: overflow.revision },
      )
    ).status,
    400,
  );
  assert.deepEqual(await snapshot(f, s.company.id), before);
  assert.equal((await s.ledger(s.cash.id)).totals.closingBalance, "1.12");
});

test("unbalanced drafts are editable but posting rejects unequal, zero or double-sided lines atomically", async (t) => {
  const f = await fixture(t),
    s = await setup(f);
  for (const lines of [
    [
      { accountId: s.cash.id, debit: "10", credit: "0" },
      { accountId: s.counter.id, debit: "0", credit: "9" },
    ],
    [
      { accountId: s.cash.id, debit: "0", credit: "0" },
      { accountId: s.counter.id, debit: "0", credit: "0" },
    ],
    [
      { accountId: s.cash.id, debit: "10", credit: "5" },
      { accountId: s.counter.id, debit: "5", credit: "10" },
    ],
  ]) {
    const document = await s.draft({ lines });
    const before = await snapshot(f, s.company.id);
    assert.equal(
      (
        await f.owner.request(
          "POST",
          `${s.path}/financial-documents/${document.id}/post`,
          { revision: document.revision },
        )
      ).status,
      400,
    );
    assert.deepEqual(await snapshot(f, s.company.id), before);
  }
  assert.equal((await s.ledger(s.cash.id)).total, 0);
});

test("receipt and payment vouchers require an explicit cash or bank asset and exactly two correctly directed lines", async (t) => {
  const f = await fixture(t),
    s = await setup(f);
  for (const kind of ["receipt", "payment"] as const) {
    const debit = kind === "receipt" ? s.cash.id : s.counter.id;
    const credit = kind === "receipt" ? s.counter.id : s.cash.id;
    const lines = [
      { accountId: debit, debit: "125.5", credit: "0" },
      { accountId: credit, debit: "0", credit: "125.5" },
    ];
    const posted = await s.post(
      await s.draft({ kind, cashAccountId: s.cash.id, lines }),
    );
    assert.equal(posted.kind, kind);
    assert.equal(posted.cashAccountId, s.cash.id);
    for (const invalid of [
      { cashAccountId: null },
      { cashAccountId: s.counter.id },
      { cashAccountId: s.income.id },
      { cashAccountId: s.bank.id },
      {
        lines: [...lines]
          .reverse()
          .map((line) => ({ ...line, debit: line.credit, credit: line.debit })),
      },
      { lines: [...lines, { accountId: s.bank.id, debit: "0", credit: "0" }] },
      {
        lines: [
          { accountId: s.cash.id, debit: "125.5", credit: "0" },
          { accountId: s.cash.id, debit: "0", credit: "125.5" },
        ],
      },
    ]) {
      const draft = await f.owner.request<DocumentResponse>(
        "POST",
        `${s.path}/financial-documents`,
        s.input({ kind, cashAccountId: s.cash.id, lines, ...invalid }),
      );
      if (draft.status === 201)
        assert.equal(
          (
            await f.owner.request(
              "POST",
              `${s.path}/financial-documents/${draft.body.document.id}/post`,
              { revision: draft.body.document.revision },
            )
          ).status,
          400,
        );
      else
        assert([400, 409].includes(draft.status), JSON.stringify(draft.body));
    }
  }
  assert.equal((await s.ledger(s.cash.id)).totals.closingBalance, "0");
});

test("financial references reject groups, inactive and foreign records, and revalidate masters before posting", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    other = await setup(f, "Foreign");
  for (const accountId of [s.group.id, other.cash.id]) {
    const body = s.input();
    body.lines[0]!.accountId = accountId;
    assert(
      [400, 409].includes(
        (await f.owner.request("POST", `${s.path}/financial-documents`, body))
          .status,
      ),
    );
  }
  for (const body of [
    s.input({ currencyId: other.yer.id }),
    s.input({ branchId: other.branch.id }),
  ])
    assert(
      [400, 409].includes(
        (await f.owner.request("POST", `${s.path}/financial-documents`, body))
          .status,
      ),
    );
  const document = await s.draft();
  for (const [path, body] of [
    [`accounts/${s.cash.id}`, { active: false }],
    [`branches/${s.branch.id}`, { active: false }],
  ] as const) {
    await f.owner.ok("PATCH", `${s.path}/${path}`, body);
    const before = await snapshot(f, s.company.id);
    assert.equal(
      (
        await f.owner.request(
          "POST",
          `${s.path}/financial-documents/${document.id}/post`,
          { revision: document.revision },
        )
      ).status,
      409,
    );
    assert.deepEqual(await snapshot(f, s.company.id), before);
    await f.owner.ok("PATCH", `${s.path}/${path}`, { active: true });
  }
  await s.post(document);
  assert.equal(
    (
      await f.owner.request(
        "GET",
        `${other.path}/financial-documents/${document.id}`,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await f.owner.request(
        "POST",
        `${other.path}/financial-documents/${document.id}/post`,
        { revision: document.revision },
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await f.owner.request(
        "GET",
        `${s.path}/account-ledger?accountId=${other.cash.id}`,
      )
    ).status,
    404,
  );
});

test("foreign posting chooses the dated UTC quote, rounds exactly and retains immutable currency and rate snapshots", async (t) => {
  const f = await fixture(t),
    s = await setup(f);
  await quote(f, s.path, s.usd.id, "100", "2026-10-10T00:00:00Z");
  const effective = await quote(
    f,
    s.path,
    s.usd.id,
    "100.125",
    "2026-10-11T23:59:59.999Z",
    "Day-end quote",
  );
  await quote(f, s.path, s.usd.id, "999", "2026-10-12T00:00:00Z");
  const document = await s.post(
    await s.draft({
      currencyId: s.usd.id,
      lines: [
        { accountId: s.cash.id, debit: "0.04", credit: "0" },
        { accountId: s.counter.id, debit: "0", credit: "0.04" },
      ],
    }),
  );
  assert.equal(document.exchangeRate, "100.125");
  assert.equal(document.exchangeRateId, effective.id);
  assert.equal(document.exchangeRateSource, "Day-end quote");
  assert.equal(
    document.totalBaseDebit,
    "4.01",
    "4.005 rounds half up using exact arithmetic",
  );
  assert.equal(document.totalBaseCredit, "4.01");
  assert.equal(document.baseCurrencyCode, "YER");
  await f.owner.ok("PATCH", `${s.path}/exchange-rates/${effective.id}`, {
    active: false,
  });
  await f.owner.ok("PATCH", `${s.path}/currencies/${s.usd.id}`, {
    name: "Renamed dollar",
  });
  const reread = (
    await f.owner.ok<DocumentResponse>(
      "GET",
      `${s.path}/financial-documents/${document.id}`,
    )
  ).document;
  assert.equal(reread.exchangeRate, document.exchangeRate);
  assert.equal(reread.exchangeRateSource, document.exchangeRateSource);
  assert.equal(reread.currencyName, document.currencyName);
  assert.equal(reread.totalBaseDebit, "4.01");
  assert.equal(
    (
      await f.owner.request("PATCH", `${s.path}/finance-settings`, {
        baseCurrencyId: s.sar.id,
      })
    ).status,
    409,
  );
});

test("missing exchange rates and conversion rounding imbalance prevent posting without inventing quotes or residual lines", async (t) => {
  const f = await fixture(t),
    s = await setup(f);
  const missing = await s.draft({ currencyId: s.usd.id });
  let before = await snapshot(f, s.company.id);
  assert.equal(
    (
      await f.owner.request(
        "POST",
        `${s.path}/financial-documents/${missing.id}/post`,
        { revision: missing.revision },
      )
    ).status,
    409,
  );
  assert.deepEqual(await snapshot(f, s.company.id), before);
  await quote(f, s.path, s.usd.id, "1.5", "2026-10-11T00:00:00Z");
  const unroundable = await s.draft({
    currencyId: s.usd.id,
    lines: [
      { accountId: s.cash.id, debit: "0.01", credit: "0" },
      { accountId: s.bank.id, debit: "0.01", credit: "0" },
      { accountId: s.counter.id, debit: "0", credit: "0.02" },
    ],
  });
  before = await snapshot(f, s.company.id);
  assert.equal(
    (
      await f.owner.request(
        "POST",
        `${s.path}/financial-documents/${unroundable.id}/post`,
        { revision: unroundable.revision },
      )
    ).status,
    400,
  );
  assert.deepEqual(await snapshot(f, s.company.id), before);
  assert.equal((await s.ledger(s.cash.id)).total, 0);
});

test("draft creation is idempotent under simultaneous requests and conflicting payloads do not reuse a key", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    input = s.input();
  const responses = await blockedOperations(f, s.company.id, [
    () =>
      f.owner.request<DocumentResponse>(
        "POST",
        `${s.path}/financial-documents`,
        input,
      ),
    () =>
      f.owner.request<DocumentResponse>(
        "POST",
        `${s.path}/financial-documents`,
        input,
      ),
  ]);
  assert.deepEqual(responses.map((result) => result.status).sort(), [200, 201]);
  assert.equal(responses[0]!.body.document.id, responses[1]!.body.document.id);
  const before = await snapshot(f, s.company.id);
  assert.equal(
    (
      await f.owner.request("POST", `${s.path}/financial-documents`, {
        ...input,
        description: "Conflicting replay",
      })
    ).status,
    409,
  );
  assert.deepEqual(await snapshot(f, s.company.id), before);
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::int AS count FROM financial_documents WHERE company_id=$1",
        [s.company.id],
      )
    ).rows[0]!.count,
    1,
  );
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::int AS count FROM audit_events WHERE company_id=$1 AND action='financialDocument.create'",
        [s.company.id],
      )
    ).rows[0]!.count,
    1,
  );
});

test("simultaneous posting and reversal each execute once and the ledger includes original reversed entries plus their counter-entry", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    document = await s.draft();
  const path = `${s.path}/financial-documents/${document.id}`;
  const posts = await blockedOperations(f, s.company.id, [
    () =>
      f.owner.request<DocumentResponse>("POST", `${path}/post`, {
        revision: document.revision,
      }),
    () =>
      f.owner.request<DocumentResponse>("POST", `${path}/post`, {
        revision: document.revision,
      }),
  ]);
  assert(posts.every((result) => result.status === 200));
  assert.equal(posts[0]!.body.document.revision, document.revision + 1);
  assert.equal((await s.ledger(s.cash.id)).total, 1);
  const reverse = {
    reason: "  Correct erroneous entry  ",
    documentDate: "2026-10-12",
    idempotencyKey: randomUUID(),
  };
  const reversals = await blockedOperations(f, s.company.id, [
    () => f.owner.request<ReverseResponse>("POST", `${path}/reverse`, reverse),
    () => f.owner.request<ReverseResponse>("POST", `${path}/reverse`, reverse),
  ]);
  assert(reversals.every((result) => result.status === 200));
  const reversed = reversals[0]!.body;
  assert.equal(reversed.document.status, "reversed");
  assert.equal(
    reversed.document.reversalDocumentId,
    reversed.reversalDocument.id,
  );
  assert.equal(reversed.reversalDocument.status, "posted");
  assert.equal(reversed.reversalDocument.kind, "journal");
  assert.equal(reversed.reversalDocument.reversesDocumentId, document.id);
  assert.equal(
    reversals[1]!.body.reversalDocument.id,
    reversed.reversalDocument.id,
  );
  const ledger = await s.ledger(s.cash.id);
  assert.equal(ledger.total, 2);
  assert.deepEqual(
    ledger.items.map((item) => item.status),
    ["reversed", "posted"],
  );
  assert.equal(ledger.totals.debit, "100.25");
  assert.equal(ledger.totals.credit, "100.25");
  assert.equal(ledger.totals.closingBalance, "0");
  const before = await snapshot(f, s.company.id);
  assert.equal(
    (
      await f.owner.request("POST", `${path}/reverse`, {
        ...reverse,
        reason: "Changed replay",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.owner.request("POST", `${path}/reverse`, {
        ...reverse,
        idempotencyKey: randomUUID(),
      })
    ).status,
    409,
  );
  assert.deepEqual(await snapshot(f, s.company.id), before);
  for (const action of ["financialDocument.post", "financialDocument.reverse"])
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int AS count FROM audit_events WHERE company_id=$1 AND action=$2",
          [s.company.id, action],
        )
      ).rows[0]!.count,
      1,
    );
});

test("reversals preserve original FX and negate the ledger even after linked masters are archived", async (t) => {
  const f = await fixture(t),
    s = await setup(f);
  const rate = await quote(
    f,
    s.path,
    s.usd.id,
    "251.125",
    "2026-10-11T00:00:00Z",
  );
  const original = await s.post(await s.draft({ currencyId: s.usd.id }));
  await quote(f, s.path, s.usd.id, "999", "2026-10-12T00:00:00Z");
  for (const path of [
    `exchange-rates/${rate.id}`,
    `currencies/${s.usd.id}`,
    `accounts/${s.cash.id}`,
    `branches/${s.branch.id}`,
  ])
    await f.owner.ok("PATCH", `${s.path}/${path}`, { active: false });
  const reversed = await f.owner.ok<ReverseResponse>(
    "POST",
    `${s.path}/financial-documents/${original.id}/reverse`,
    {
      reason: "Reverse original historical snapshot",
      documentDate: "2026-10-12",
      idempotencyKey: randomUUID(),
    },
  );
  assert.equal(reversed.reversalDocument.exchangeRate, original.exchangeRate);
  assert.equal(
    reversed.reversalDocument.exchangeRateId,
    original.exchangeRateId,
  );
  assert.equal(
    reversed.reversalDocument.totalBaseCredit,
    original.totalBaseDebit,
  );
  assert.equal((await s.ledger(s.cash.id)).totals.closingBalance, "0");
});

test("balances and ledgers respect natural sides, date ranges, opening balances and deterministic page order", async (t) => {
  const f = await fixture(t),
    s = await setup(f);
  for (const [date, amount] of [
    ["2026-10-01", "10"],
    ["2026-10-02", "20"],
    ["2026-10-03", "30"],
  ] as const)
    await s.post(
      await s.draft({
        documentDate: date,
        lines: [
          { accountId: s.cash.id, debit: amount, credit: "0" },
          { accountId: s.income.id, debit: "0", credit: amount },
        ],
      }),
    );
  const balances = await f.owner.ok<Page<AccountBalance>>(
    "GET",
    `${s.path}/account-balances?pageSize=100`,
  );
  const cash = balances.items.find((item) => item.accountId === s.cash.id)!;
  const income = balances.items.find((item) => item.accountId === s.income.id)!;
  assert.equal(cash.balance, "60");
  assert.equal(income.normalSide, "credit");
  assert.equal(
    income.balance,
    "-60",
    "Balances use signed debit minus credit; the natural side is separate metadata",
  );
  const ledger = await s.ledger(
    s.cash.id,
    "&dateFrom=2026-10-02&dateTo=2026-10-02",
  );
  assert.equal(ledger.total, 1);
  assert.equal(ledger.totals.openingBalance, "10");
  assert.equal(ledger.totals.debit, "20");
  assert.equal(ledger.totals.closingBalance, "30");
  assert.equal(ledger.items[0]!.runningBalance, "30");
  const first = await s.ledger(s.cash.id, "&page=1&pageSize=1");
  const second = await s.ledger(s.cash.id, "&page=2&pageSize=1");
  assert.equal(first.items[0]!.documentDate, "2026-10-01");
  assert.equal(second.items[0]!.documentDate, "2026-10-02");
  assert.equal(second.items[0]!.runningBalance, "30");
  for (const query of [
    "accountId=-1",
    `accountId=${s.cash.id}&dateFrom=2026-10-04&dateTo=2026-10-01`,
    `accountId=${s.cash.id}&dateFrom=2026-02-30`,
    `accountId=${s.cash.id}&pageSize=101`,
  ])
    assert.equal(
      (await f.owner.request("GET", `${s.path}/account-ledger?${query}`))
        .status,
      400,
    );
});

test("ledger default order and running balances follow document order after an earlier draft replaces its lines", async (t) => {
  const f = await fixture(t),
    s = await setup(f);
  const firstInput = s.input({
    lines: [
      { accountId: s.cash.id, debit: "10", credit: "0" },
      { accountId: s.counter.id, debit: "0", credit: "10" },
    ],
  });
  const first = (
    await f.owner.ok<DocumentResponse>(
      "POST",
      `${s.path}/financial-documents`,
      firstInput,
      201,
    )
  ).document;
  const second = await s.draft({
    lines: [
      { accountId: s.cash.id, debit: "20", credit: "0" },
      { accountId: s.counter.id, debit: "0", credit: "20" },
    ],
  });
  const { idempotencyKey: _key, ...fields } = firstInput;
  const updated = (
    await f.owner.ok<DocumentResponse>(
      "PATCH",
      `${s.path}/financial-documents/${first.id}`,
      {
        ...fields,
        description: "Earlier document edited after later draft",
        revision: first.revision,
      },
    )
  ).document;
  assert(
    updated.lines[0]!.id > second.lines[0]!.id,
    "The edit must recreate lines after the later document's lines",
  );
  await s.post(updated);
  await s.post(second);
  const ledger = await s.ledger(s.cash.id);
  assert.deepEqual(
    ledger.items.map((line) => line.documentId),
    [first.id, second.id],
  );
  assert.deepEqual(
    ledger.items.map((line) => line.runningBalance),
    ["10", "30"],
  );
  assert.equal(ledger.totals.closingBalance, "30");
  const page = await s.ledger(s.cash.id, "&pageSize=1&page=2");
  assert.equal(page.total, 2);
  assert.equal(page.items[0]!.documentId, second.id);
  assert.equal(page.items[0]!.runningBalance, "30");
});

test("financial creation, editing, posting and reversal roll back all document, line and audit changes on audit failure", async (t) => {
  const f = await fixture(t),
    s = await setup(f);
  let before = await snapshot(f, s.company.id);
  await rejectAudit(f, async () =>
    assert.equal(
      (
        await f.owner.request(
          "POST",
          `${s.path}/financial-documents`,
          s.input(),
        )
      ).status,
      500,
    ),
  );
  assert.deepEqual(await snapshot(f, s.company.id), before);
  const input = s.input();
  const document = (
    await f.owner.ok<DocumentResponse>(
      "POST",
      `${s.path}/financial-documents`,
      input,
      201,
    )
  ).document;
  const { idempotencyKey: _key, ...fields } = input;
  for (const [method, path, body] of [
    [
      "PATCH",
      `${s.path}/financial-documents/${document.id}`,
      { ...fields, revision: document.revision, description: "Must roll back" },
    ],
    [
      "POST",
      `${s.path}/financial-documents/${document.id}/post`,
      { revision: document.revision },
    ],
  ] as const) {
    before = await snapshot(f, s.company.id);
    await rejectAudit(f, async () =>
      assert.equal((await f.owner.request(method, path, body)).status, 500),
    );
    assert.deepEqual(await snapshot(f, s.company.id), before);
  }
  await s.post(document);
  before = await snapshot(f, s.company.id);
  await rejectAudit(f, async () =>
    assert.equal(
      (
        await f.owner.request(
          "POST",
          `${s.path}/financial-documents/${document.id}/reverse`,
          {
            reason: "Failed reversal",
            documentDate: "2026-10-12",
            idempotencyKey: randomUUID(),
          },
        )
      ).status,
      500,
    ),
  );
  assert.deepEqual(await snapshot(f, s.company.id), before);
  const events = (
    await f.pool.query(
      "SELECT action,before_value,after_value FROM audit_events WHERE company_id=$1 AND target_id=$2 AND target_type='financialDocument' ORDER BY id",
      [s.company.id, document.id],
    )
  ).rows;
  assert.deepEqual(
    events.map((row) => row.action),
    ["financialDocument.create", "financialDocument.post"],
  );
  assert.equal(events[0]!.before_value, null);
  assert.equal(events[0]!.after_value.status, "draft");
  assert.equal(events[1]!.before_value.status, "draft");
  assert.equal(events[1]!.after_value.status, "posted");
  assert.equal(events[1]!.after_value.lines[0].baseDebit, "100.25");
});

test("database composite foreign keys reject cross-company document references beneath the API", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    other = await setup(f, "Foreign");
  const document = await s.draft(),
    foreign = await other.draft();
  const before = await snapshot(f, s.company.id);
  for (const [sql, values, expectedCode] of [
    [
      "UPDATE financial_documents SET currency_id=$1 WHERE id=$2",
      [other.yer.id, document.id],
      "23503",
    ],
    [
      "UPDATE financial_documents SET branch_id=$1 WHERE id=$2",
      [other.branch.id, document.id],
      "23503",
    ],
    [
      "UPDATE financial_document_lines SET account_id=$1 WHERE document_id=$2",
      [other.cash.id, document.id],
      "23503",
    ],
    [
      "UPDATE financial_document_lines SET document_id=$1 WHERE document_id=$2",
      [foreign.id, document.id],
      // The immutable-line trigger rejects a destination that is absent from
      // this company before the composite foreign key is evaluated.
      "23514",
    ],
  ] as const)
    await assert.rejects(
      f.pool.query(sql, [...values]),
      (error: unknown) =>
        Boolean(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === expectedCode,
        ),
      sql,
    );
  assert.deepEqual(await snapshot(f, s.company.id), before);
});

test("permission revocation while a financial mutation is waiting is rechecked inside its transaction", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    member = await f.member(s.company.id, ["finance.manage"]);
  const before = await snapshot(f, s.company.id);
  const [response] = await blockedOperations(
    f,
    s.company.id,
    [
      () =>
        member.client.request(
          "POST",
          `${s.path}/financial-documents`,
          s.input(),
        ),
    ],
    async () => {
      await f.pool.query("UPDATE employees SET permissions='{}' WHERE id=$1", [
        member.employee.id,
      ]);
    },
  );
  assert.equal(response!.status, 403);
  assert.deepEqual(await snapshot(f, s.company.id), before);
});

test("posted documents and master financial meaning remain immutable even through direct database updates", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    document = await s.post(await s.draft());
  const before = await snapshot(f, s.company.id);
  for (const [sql, values] of [
    [
      "UPDATE financial_documents SET description='Tampered' WHERE id=$1",
      [document.id],
    ],
    [
      "UPDATE financial_documents SET document_date='2026-10-12' WHERE id=$1",
      [document.id],
    ],
    [
      "UPDATE financial_document_lines SET debit=1 WHERE document_id=$1 AND line_number=1",
      [document.id],
    ],
    [
      "DELETE FROM financial_document_lines WHERE document_id=$1",
      [document.id],
    ],
    ["DELETE FROM financial_documents WHERE id=$1", [document.id]],
    ["UPDATE accounts SET cash_or_bank=false WHERE id=$1", [s.cash.id]],
    ["UPDATE accounts SET normal_side='credit' WHERE id=$1", [s.cash.id]],
    ["UPDATE company_currencies SET decimal_places=3 WHERE id=$1", [s.yer.id]],
    [
      "UPDATE finance_settings SET base_currency_id=$1 WHERE company_id=$2",
      [s.sar.id, s.company.id],
    ],
  ] as const)
    await assert.rejects(
      f.pool.query(sql, [...values]),
      (error: unknown) =>
        Boolean(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "23514",
        ),
      sql,
    );
  assert.equal(
    (
      await f.owner.request("PATCH", `${s.path}/accounts/${s.cash.id}`, {
        cashOrBank: false,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.owner.request("PATCH", `${s.path}/finance-settings`, {
        baseCurrencyId: s.sar.id,
      })
    ).status,
    409,
    "A base-currency-only posting also locks the base definition",
  );
  assert.deepEqual(await snapshot(f, s.company.id), before);
  assert.equal((await s.ledger(s.cash.id)).totals.closingBalance, "100.25");
});

test("concurrent document numbering is unique per company and deterministic filters cannot include other companies", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    other = await setup(f, "Other numbering");
  const created = await blockedOperations(f, s.company.id, [
    () =>
      f.owner.request<DocumentResponse>(
        "POST",
        `${s.path}/financial-documents`,
        s.input({ description: "Listed first" }),
      ),
    () =>
      f.owner.request<DocumentResponse>(
        "POST",
        `${s.path}/financial-documents`,
        s.input({ description: "Listed second" }),
      ),
  ]);
  assert(created.every((result) => result.status === 201));
  const numbers = created.map((result) => result.body.document.number).sort();
  assert.deepEqual(numbers, ["0000000001", "0000000002"]);
  const foreign = await other.draft({ description: "Listed foreign" });
  assert.equal(foreign.number, "0000000001");
  const page = await f.owner.ok<Page<FinancialDocument>>(
    "GET",
    `${s.path}/financial-documents?q=Listed&kind=journal&status=draft&pageSize=1&page=2&sort=number:asc`,
  );
  assert.equal(page.total, 2);
  assert.equal(page.items[0]!.number, "0000000002");
  assert(page.items.every((item) => item.companyId === s.company.id));
  for (const query of [
    "kind=unsupported",
    "status=unknown",
    "page=0",
    "pageSize=101",
    "sort=password:asc",
  ])
    assert.equal(
      (await f.owner.request("GET", `${s.path}/financial-documents?${query}`))
        .status,
      400,
      query,
    );
});


test("posted receipt/payment print requests reward eligible employees once per voucher", async (t) => {
  const f = await fixture(t), s = await setup(f, "Print reward company");
  const first = await f.member(s.company.id, ["finance.view"], 951);
  const second = await f.member(s.company.id, ["finance.view"], 952);
  const base = s.path;
  const wallet = async (employeeId: number) =>
    f.owner.ok<{ wallet: { points: string; money: string }; items: { kind: string; points: string; taskCode: string | null; financialDocumentId: number | null }[] }>(
      "GET", base + "/wallet?employeeId=" + employeeId + "&pageSize=100",
    );
  const reward = async (client: Client, id: number) =>
    client.ok<{ rewarded: boolean; entryId: number | null }>(
      "POST", base + `/financial-documents/${id}/print-request`,
    );
  const receiptDraft = await s.draft({
    kind: "receipt", cashAccountId: s.cash.id,
  });
  const receipt = await s.post(receiptDraft);
  assert.equal((await reward(first.client, receipt.id)).rewarded, false, "Not enabled by default");
  assert.equal((await wallet(first.employee.id)).wallet.points, "0");

  const tasks = await f.owner.ok<{ tasks: { code: string; revision: number | null }[] }>("GET", base + "/reward-tasks");
  const receiptTask = tasks.tasks.find((row) => row.code === "RECEIPT_PRINT")!;
  assert.equal((await f.owner.request("PUT", base + "/reward-tasks/RECEIPT_PRINT", {
    points: "5", enabled: true, repeatRule: "daily",
    roleIds: [], pageKey: null, revision: receiptTask.revision,
  })).status, 400, "Voucher rewards are per document");
  await f.owner.ok("PUT", base + "/reward-tasks/RECEIPT_PRINT", {
    points: "5", enabled: true, repeatRule: "per-document",
    roleIds: [], pageKey: null, revision: receiptTask.revision,
  });
  const firstRequest = await reward(first.client, receipt.id);
  assert.equal(firstRequest.rewarded, true);
  assert.equal((await wallet(first.employee.id)).wallet.points, "5");
  assert.equal((await reward(first.client, receipt.id)).rewarded, false);
  assert.equal((await wallet(first.employee.id)).items.length, 1);
  assert.equal((await wallet(first.employee.id)).items[0]!.financialDocumentId, receipt.id);
  assert.equal((await wallet(second.employee.id)).wallet.points, "0");
  assert.equal((await reward(second.client, receipt.id)).rewarded, true);
  assert.equal((await wallet(second.employee.id)).wallet.points, "5");

  const paymentDraft = await s.draft({
    kind: "payment", cashAccountId: s.cash.id,
    lines: [
      { accountId: s.counter.id, debit: "100.25", credit: "0", description: "recipient" },
      { accountId: s.cash.id, debit: "0", credit: "100.25", description: "paid" },
    ],
  });
  const payment = await s.post(paymentDraft);
  assert.equal((await reward(first.client, payment.id)).rewarded, false, "Payment task still disabled");
  const paymentTask = (await f.owner.ok<{ tasks: { code: string; revision: number | null }[] }>(
    "GET", base + "/reward-tasks",
  )).tasks.find((row) => row.code === "PAYMENT_PRINT")!;
  const role = (await f.pool.query<{ id: number }>(
    "SELECT id FROM company_roles WHERE company_id=$1 AND key='accountant'",
    [s.company.id],
  )).rows[0]!;
  await f.owner.ok("PUT", base + "/reward-tasks/PAYMENT_PRINT", {
    points: "7", enabled: true, repeatRule: "per-document",
    roleIds: [role.id], pageKey: null, revision: paymentTask.revision,
  });
  assert.equal((await reward(first.client, payment.id)).rewarded, false, "Role restrictions");
  await f.pool.query(
    "INSERT INTO employee_role_assignments(company_id,employee_id,role_id,active) VALUES($1,$2,$3,true)",
    [s.company.id, first.employee.id, role.id],
  );
  assert.equal((await reward(first.client, payment.id)).rewarded, true);
  assert.equal((await wallet(first.employee.id)).wallet.points, "12");
  assert.equal((await reward(first.client, payment.id)).rewarded, false);

  // A draft receipt and a posted journal cannot generate voucher-print rewards.
  const otherDraft = await s.draft({ kind: "receipt", cashAccountId: s.cash.id });
  assert.equal((await reward(first.client, otherDraft.id)).rewarded, false);
  const journal = await s.post(await s.draft());
  assert.equal((await reward(first.client, journal.id)).rewarded, false);
  assert.equal((await first.client.request("POST", base + "/financial-documents/999999/print-request")).status, 404);
  assert.equal((await wallet(first.employee.id)).wallet.money, "0");
  assert.equal((await wallet(first.employee.id)).wallet.points, "12");

  // A failed ledger write must not credit balance or leave an orphan request.
  await f.pool.query(
    `CREATE FUNCTION fail_print_reward() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.financial_document_id IS NOT NULL THEN RAISE EXCEPTION 'reject print'; END IF;
      RETURN NEW; END $$;
     CREATE TRIGGER fail_print_reward BEFORE INSERT ON employee_wallet_entries
     FOR EACH ROW EXECUTE FUNCTION fail_print_reward()`,
  );
  const newReceipt = await s.post(await s.draft({kind:"receipt",cashAccountId:s.cash.id}));
  try {
    assert.equal((await first.client.request("POST", base + `/financial-documents/${newReceipt.id}/print-request`)).status, 500);
  } finally {
    await f.pool.query("DROP TRIGGER fail_print_reward ON employee_wallet_entries");
    await f.pool.query("DROP FUNCTION fail_print_reward()");
  }
  assert.equal((await wallet(first.employee.id)).wallet.points, "12");
});
