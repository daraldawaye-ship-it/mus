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
  AccountBalanceApproval as Approval,
  AccountBalanceFollowUp as FollowUp,
  AccountBalanceStatistics as Statistics,
  Company,
  CompanyCurrency,
  Employee,
  FinancialDocument,
  FinancialDocumentInput,
  Page,
  Permission,
  SessionResponse,
} from "../packages/contracts/src/index.ts";

// Never inherit the application's DATABASE_URL. Every case uses an isolated,
// disposable schema on an explicitly local test database only.
const databaseUrl =
  process.env.ACCOUNT_BALANCE_STATISTICS_TEST_DATABASE_URL ??
  process.env.ACCOUNT_STATISTICS_TEST_DATABASE_URL ??
  DEFAULT_DATABASE_URL;
const target = new URL(databaseUrl);
const localHosts = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "/workspace/.tools/postgresql/socket",
]);
const configuredHosts = [
  target.hostname,
  ...target.searchParams.getAll("host"),
  ...target.searchParams.getAll("hostaddr"),
].filter(Boolean);
assert(
  ["postgres:", "postgresql:"].includes(target.protocol) &&
    configuredHosts.length > 0 &&
    configuredHosts.every((host) => localHosts.has(host)),
  "Account-balance statistics tests require an explicitly local PostgreSQL target",
);

const origin = "http://localhost";
const password = "Local-balance-statistics-passphrase-2026";
const readerPermissions: Permission[] = ["accounts.view", "finance.view"];
const actionPermissions: Permission[] = [
  ...readerPermissions,
  "accounts.balance-followup",
  "accounts.balance-approve",
];

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
  const schema = `balance_stats_${randomUUID().replaceAll("-", "")}`;
  let runtime: Awaited<ReturnType<typeof createApp>> | undefined;
  let server: Server | undefined;
  t.after(async () => {
    try {
      if (server?.listening)
        await new Promise<void>((resolve, reject) =>
          server!.close((error) => (error ? reject(error) : resolve())),
        );
      await runtime?.close();
    } finally {
      const cleanup = new Pool({ connectionString: databaseUrl });
      try {
        await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await cleanup.end();
      }
    }
  });
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
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const ownerUser = await provisionOwner(runtime.pool, {
    name: "Balance statistics owner",
    displayName: "Balance statistics owner",
    email: "owner@balance-statistics.test",
    password,
  });
  const owner = new Client(baseUrl);
  await owner.ok("POST", "/auth/login", { email: ownerUser.email, password });
  const company = async (name = "Balance statistics company") =>
    (
      await owner.ok<{ company: Company }>(
        "POST",
        "/companies",
        { name, phone: "", address: "" },
        201,
      )
    ).company;
  const member = async (companyId: number, permissions: Permission[]) => {
    const client = new Client(baseUrl);
    const session = await client.ok<SessionResponse>(
      "POST",
      "/auth/register",
      {
        name: "Balance statistics employee",
        displayName: "Balance employee",
        email: `${randomUUID()}@balance-statistics.test`,
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
          name: "Balance employee",
          phone: "",
          role: "employee",
          active: true,
          permissions,
        },
        201,
      )
    ).employee;
    return { client, employee, user: session.user };
  };
  return {
    schema,
    owner,
    ownerUser,
    pool: runtime.pool,
    company,
    member,
    anonymous: () => new Client(baseUrl),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function setup(f: Fixture, name?: string) {
  const company = await f.company(name);
  const base = `/companies/${company.id}`;
  const currencies = (
    await f.owner.ok<Page<CompanyCurrency>>("GET", `${base}/currencies`)
  ).items;
  const yer = currencies.find((currency) => currency.code === "YER")!;
  const usd = currencies.find((currency) => currency.code === "USD")!;
  assert(yer && usd);
  const account = async (name: string, group = false) =>
    (
      await f.owner.ok<{ account: Account }>(
        "POST",
        `${base}/accounts`,
        {
          name,
          parentId: null,
          kind: group ? "group" : "posting",
          category: "asset",
          normalSide: "debit",
          cashOrBank: false,
        },
        201,
      )
    ).account;
  const target = await account("Statistics target");
  const counter = await account("Statistics counterpart");
  const group = await account("Statistics group", true);
  const path = (id = target.id) => `${base}/accounts/${id}`;
  const stats = async (
    date?: string,
    client = f.owner,
    accountId = target.id,
  ) =>
    (
      await client.ok<{ statistics: Statistics }>(
        "GET",
        `${path(accountId)}/statistics${date ? `?asOfDate=${date}` : ""}`,
      )
    ).statistics;
  const draft = async (date: string, amount: string, currencyId = yer.id) =>
    (
      await f.owner.ok<{ document: FinancialDocument }>(
        "POST",
        `${base}/financial-documents`,
        {
          idempotencyKey: randomUUID(),
          kind: "journal",
          documentDate: date,
          currencyId,
          branchId: null,
          cashAccountId: null,
          description: "Balance source",
          lines: [
            { accountId: target.id, debit: amount, credit: "0" },
            { accountId: counter.id, debit: "0", credit: amount },
          ],
        } satisfies FinancialDocumentInput,
        201,
      )
    ).document;
  const post = async (date: string, amount: string, currencyId = yer.id) => {
    const document = await draft(date, amount, currencyId);
    return (
      await f.owner.ok<{ document: FinancialDocument }>(
        "POST",
        `${base}/financial-documents/${document.id}/post`,
        { revision: document.revision },
      )
    ).document;
  };
  const reverse = async (document: FinancialDocument, documentDate: string) =>
    f.owner.ok("POST", `${base}/financial-documents/${document.id}/reverse`, {
      idempotencyKey: randomUUID(),
      reason: "Dated statistics reversal",
      documentDate,
    });
  const rule = (
    employeeId: number,
    permissionKey: string,
    effect: "allow" | "deny",
    revision: number | null = null,
  ) =>
    f.owner.ok("PUT", `${base}/configuration/employee-rules`, {
      employeeId,
      permissionKey,
      effect,
      revision,
    });
  return {
    company,
    base,
    yer,
    usd,
    target,
    counter,
    group,
    path,
    stats,
    draft,
    post,
    reverse,
    rule,
  };
}

async function actionCounts(f: Fixture, companyId: number) {
  const result = await f.pool.query<{ followups: string; approvals: string }>(
    `SELECT (SELECT count(*)::text FROM account_balance_followups WHERE company_id=$1) AS followups,
      (SELECT count(*)::text FROM account_balance_approvals WHERE company_id=$1) AS approvals`,
    [companyId],
  );
  return result.rows[0]!;
}

async function blockedByCompany<T>(
  f: Fixture,
  companyId: number,
  operation: () => Promise<T>,
  during: () => Promise<void>,
) {
  const blocker = await f.pool.connect();
  let pending: Promise<T> | undefined;
  try {
    await blocker.query("BEGIN");
    const blockerPid = (
      await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0]!.pid;
    await blocker.query("SELECT id FROM companies WHERE id=$1 FOR UPDATE", [
      companyId,
    ]);
    pending = operation();
    const deadline = Date.now() + 5000;
    let reachedLock = false;
    do {
      const waiting = await f.pool.query<{ waiting: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity a
          WHERE a.wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(a.pid))
            AND a.query LIKE '%FROM companies%'
            AND EXISTS (SELECT 1 FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
              JOIN pg_namespace n ON n.oid=c.relnamespace
              WHERE l.pid=a.pid AND n.nspname=$2)
        ) AS waiting`,
        [blockerPid, f.schema],
      );
      reachedLock = waiting.rows[0]!.waiting;
      if (reachedLock) break;
      await delay(10);
    } while (Date.now() < deadline);
    assert(
      reachedLock,
      "The balance action must reach its company lock before permission revocation",
    );
    await during();
  } finally {
    await blocker.query("COMMIT");
    blocker.release();
  }
  assert(pending);
  return pending;
}

test("historical account balances use exact posted history, inclusive cutoffs and dated reversals", async (t) => {
  const f = await fixture(t),
    s = await setup(f);
  const large = "9007199254740993.25";
  await s.post("2021-12-31", large);
  await s.post("2022-01-01", "20");
  await s.post("2022-12-31", "30");
  const reversed = await s.post("2023-01-01", "40");
  await s.post("2023-03-01", "50");
  await s.post("2023-03-02", "60");
  await s.post("2023-12-31", "70");
  await s.post("2024-01-01", "80");
  await s.post("2024-02-29", "90");
  await s.post("2024-03-01", "100");
  await s.post("2024-03-02", "110");
  await s.draft("2024-01-01", "999999");
  await s.reverse(reversed, "2024-03-02");
  await f.owner.ok(
    "POST",
    `${s.base}/exchange-rates`,
    {
      currencyId: s.usd.id,
      rate: "2",
      effectiveAt: "2020-01-01T00:00:00Z",
      source: "Local exact historical rate",
    },
    201,
  );
  await s.post("2024-03-01", "0.50", s.usd.id);
  const before = await actionCounts(f, s.company.id);
  const historical = await s.stats("2024-03-01");
  assert.deepEqual(historical.balance, {
    currentBase: "9007199254741534.25",
    oneYearAgoBase: "9007199254741133.25",
    atCurrentYearStartBase: "9007199254741263.25",
    atPreviousYearStartBase: "9007199254741043.25",
    atTwoYearsAgoStartBase: large,
  });
  assert.equal(historical.coverage, "recorded_history_only");
  assert.equal(historical.asOfDate, "2024-03-01");
  assert.equal(historical.policyVersion, 1);
  assert.deepEqual(historical.currency, {
    id: s.yer.id,
    code: "YER",
    decimalPlaces: s.yer.decimalPlaces,
  });
  assert.equal(historical.components.balance.state, "ready");
  assert.equal(
    historical.components.balance.computedRevision,
    historical.sourceRevision,
  );
  assert.equal(historical.components.balance.asOfDate, "2024-03-01");
  for (const part of ["activity", "commerce"] as const)
    assert.equal(historical.components[part]?.state, "ready");
  assert.equal(historical.components.stock.state, "uncomputed");
  assert.equal(historical.lastFollowUp, null);
  assert.equal(historical.lastApproval, null);
  assert.deepEqual(historical.approvalQuote, {
    balanceDate: historical.asOfDate,
    expectedBalanceBase: historical.balance.currentBase,
    expectedCurrencyId: s.yer.id,
    expectedSourceRevision: historical.sourceRevision,
    expectedSourceGeneration: historical.sourceGeneration,
  });
  assert.match(historical.sourceRevision, /^(0|[1-9]\d*)$/);
  assert.match(historical.sourceGeneration, /^[0-9a-f-]{36}$/i);
  assert.equal(
    (await s.stats("2024-03-02")).balance.currentBase,
    "9007199254741604.25",
  );
  assert.equal(
    (await s.stats("2024-03-01", f.owner, s.counter.id)).balance.currentBase,
    "-9007199254741534.25",
    "The ledger sign is debit minus credit, without an absolute value",
  );
  await f.owner.ok(
    "POST",
    `${s.base}/exchange-rates`,
    {
      currencyId: s.usd.id,
      rate: "3",
      effectiveAt: "2024-03-01T00:00:00Z",
      source: "Later rate does not rewrite history",
    },
    201,
  );
  assert.equal(
    (await s.stats("2024-03-01")).balance.currentBase,
    historical.balance.currentBase,
  );
  assert.deepEqual(
    await actionCounts(f, s.company.id),
    before,
    "Reading historical/current statistics never creates human actions",
  );
});

test("follow-up and approval actions use the server clock, canonical retries and fresh exact quotes", async (t) => {
  const f = await fixture(t),
    s = await setup(f);
  await s.post("2024-03-01", "10.25");
  const actor = await f.member(s.company.id, actionPermissions);
  const peer = await f.member(s.company.id, actionPermissions);
  const followupPath = `${s.path()}/balance-followups`;
  const approvalPath = `${s.path()}/balance-approvals`;
  const followupPayload = {
    idempotencyKey: randomUUID(),
    note: "  Called about balance  ",
  };
  const beforeClock = Date.now();
  const followup = (
    await actor.client.ok<{ followUp: FollowUp }>(
      "POST",
      followupPath,
      followupPayload,
      201,
    )
  ).followUp;
  assert.equal(followup.note, "Called about balance");
  assert.equal(followup.createdBy, actor.user.id);
  assert.equal(followup.accountId, s.target.id);
  assert.equal(followup.companyId, s.company.id);
  assert(Date.parse(followup.followedUpAt) >= beforeClock - 1000);
  assert(Date.parse(followup.followedUpAt) <= Date.now() + 1000);
  assert.deepEqual(
    (
      await actor.client.ok<{ followUp: FollowUp }>(
        "POST",
        followupPath,
        { ...followupPayload, note: "Called about balance" },
        201,
      )
    ).followUp,
    followup,
  );
  for (const [client, path, payload] of [
    [peer.client, followupPath, followupPayload],
    [
      actor.client,
      `${s.path(s.counter.id)}/balance-followups`,
      followupPayload,
    ],
    [
      actor.client,
      followupPath,
      { ...followupPayload, note: "Different action" },
    ],
  ] as const)
    assert.equal((await client.request("POST", path, payload)).status, 409);
  assert.equal(
    (
      await actor.client.request("POST", followupPath, {
        idempotencyKey: randomUUID(),
        note: "Cannot supply the action time",
        followedUpAt: "2000-01-01T00:00:00Z",
      })
    ).status,
    400,
  );
  const quote = (await s.stats("2024-03-01", actor.client)).approvalQuote;
  const approvalPayload = {
    idempotencyKey: randomUUID(),
    note: "  Confirmed balance  ",
    ...quote,
    expectedSourceGeneration: quote.expectedSourceGeneration.toUpperCase(),
  };
  const approval = (
    await actor.client.ok<{ approval: Approval }>(
      "POST",
      approvalPath,
      approvalPayload,
      201,
    )
  ).approval;
  assert.equal(approval.balanceBase, "10.25");
  assert.equal(approval.balanceDate, "2024-03-01");
  assert.equal(approval.createdBy, actor.user.id);
  assert.equal(approval.note, "Confirmed balance");
  assert.equal(approval.sourceRevision, quote.expectedSourceRevision);
  assert.equal(approval.sourceGeneration, quote.expectedSourceGeneration);
  assert.deepEqual(
    (
      await actor.client.ok<{ approval: Approval }>(
        "POST",
        approvalPath,
        {
          ...approvalPayload,
          expectedBalanceBase: "00010.250000",
          note: "Confirmed balance",
          expectedSourceGeneration:
            quote.expectedSourceGeneration.toLowerCase(),
        },
        201,
      )
    ).approval,
    approval,
    "Equivalent decimal representations share one canonical receipt",
  );
  for (const [client, path, payload] of [
    [peer.client, approvalPath, approvalPayload],
    [
      actor.client,
      `${s.path(s.counter.id)}/balance-approvals`,
      approvalPayload,
    ],
    [
      actor.client,
      approvalPath,
      { ...approvalPayload, note: "Different approval" },
    ],
  ] as const)
    assert.equal((await client.request("POST", path, payload)).status, 409);
  assert.equal(
    (
      await actor.client.request("POST", approvalPath, {
        ...approvalPayload,
        idempotencyKey: randomUUID(),
        expectedBalanceBase: "10.26",
      })
    ).status,
    409,
  );
  await s.post("2024-03-01", "1");
  assert.equal(
    (
      await actor.client.request("POST", approvalPath, {
        ...approvalPayload,
        idempotencyKey: randomUUID(),
      })
    ).status,
    409,
    "A changed source invalidates the quote even when the account/date are the same",
  );
  assert.deepEqual(
    (
      await actor.client.ok<{ approval: Approval }>(
        "POST",
        approvalPath,
        approvalPayload,
        201,
      )
    ).approval,
    approval,
    "An accepted UUID confirms its original immutable snapshot",
  );
  const refreshed = await s.stats("2024-03-01", actor.client);
  assert.equal(refreshed.balance.currentBase, "11.25");
  assert(
    BigInt(refreshed.sourceRevision) > BigInt(quote.expectedSourceRevision),
  );
  assert.equal(
    (
      await actor.client.request("POST", approvalPath, {
        ...approvalPayload,
        idempotencyKey: randomUUID(),
        expectedBalanceBase: "11.25",
      })
    ).status,
    409,
    "Matching the new amount cannot rescue an outdated source revision",
  );
  assert.deepEqual(refreshed.lastFollowUp, followup);
  assert.deepEqual(refreshed.lastApproval, approval);
  assert.deepEqual(await actionCounts(f, s.company.id), {
    followups: "1",
    approvals: "1",
  });
});

test("statistics require current scoped read/action grants and reject malformed or foreign references", async (t) => {
  const f = await fixture(t),
    s = await setup(f),
    other = await setup(f, "Foreign statistics company");
  const reader = await f.member(s.company.id, readerPermissions);
  const poster = await f.member(s.company.id, [
    ...readerPermissions,
    "finance.post",
  ]);
  const accountsOnly = await f.member(s.company.id, ["accounts.view"]);
  const outsider = await f.member(other.company.id, actionPermissions);
  const statsPath = `${s.path()}/statistics?asOfDate=2024-03-01`;
  const reading = await s.stats("2024-03-01", reader.client);
  assert.deepEqual(reading.capabilities, {
    canFollowUp: false,
    canApprove: false,
  });
  assert.deepEqual(
    (await s.stats("2024-03-01", poster.client)).capabilities,
    { canFollowUp: false, canApprove: false },
    "Financial posting never grants the new human actions",
  );
  for (const client of [reader.client, poster.client]) {
    assert.equal(
      (
        await client.request("POST", `${s.path()}/balance-followups`, {
          idempotencyKey: randomUUID(),
          note: "Unauthorized follow-up",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await client.request("POST", `${s.path()}/balance-approvals`, {
          idempotencyKey: randomUUID(),
          ...reading.approvalQuote,
        })
      ).status,
      403,
    );
  }
  assert.equal(
    (await accountsOnly.client.request("GET", statsPath)).status,
    403,
  );
  assert.equal((await outsider.client.request("GET", statsPath)).status, 403);
  assert.equal((await f.anonymous().request("GET", statsPath)).status, 401);
  assert.equal(
    (await f.owner.request("GET", `${s.path(other.target.id)}/statistics`))
      .status,
    404,
  );
  assert.equal(
    (await f.owner.request("GET", `${s.path(s.group.id)}/statistics`)).status,
    409,
  );
  for (const query of [
    "asOfDate=0002-12-31",
    "asOfDate=9999-12-31",
    "asOfDate=2024-02-30",
    "asOfDate=2024-03-01&asOfDate=2024-03-02",
  ])
    assert.equal(
      (await f.owner.request("GET", `${s.path()}/statistics?${query}`)).status,
      400,
    );
  const defaultDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Aden",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  assert.equal((await s.stats()).asOfDate, defaultDate);
  const ownerQuote = (await s.stats("2024-03-01")).approvalQuote;
  for (const extra of [
    { expectedSourceRevision: "9223372036854775808" },
    { expectedSourceRevision: "-1" },
    { expectedSourceRevision: 0 },
    { expectedBalanceBase: "1e2" },
    { expectedBalanceBase: "0.0000001" },
    { balanceDate: "9999-12-31" },
    { createdBy: f.ownerUser.id },
  ])
    assert.equal(
      (
        await f.owner.request("POST", `${s.path()}/balance-approvals`, {
          idempotencyKey: randomUUID(),
          ...ownerQuote,
          ...extra,
        })
      ).status,
      400,
    );
  assert.equal(
    (
      await f.owner.request("POST", `${s.path()}/balance-approvals`, {
        idempotencyKey: randomUUID(),
        ...ownerQuote,
        expectedCurrencyId: other.yer.id,
      })
    ).status,
    409,
  );
  await s.rule(reader.employee.id, "company.account-statistics:view", "deny");
  assert.equal((await reader.client.request("GET", statsPath)).status, 403);
  assert.deepEqual(await actionCounts(f, s.company.id), {
    followups: "0",
    approvals: "0",
  });
  const follower = await f.member(s.company.id, [
    ...readerPermissions,
    "accounts.balance-followup",
  ]);
  const approver = await f.member(s.company.id, [
    ...readerPermissions,
    "accounts.balance-approve",
  ]);
  assert.deepEqual(
    (await s.stats("2024-03-01", follower.client)).capabilities,
    { canFollowUp: true, canApprove: false },
  );
  assert.deepEqual(
    (await s.stats("2024-03-01", approver.client)).capabilities,
    { canFollowUp: false, canApprove: true },
  );
  await follower.client.ok(
    "POST",
    `${s.path()}/balance-followups`,
    {
      idempotencyKey: randomUUID(),
      note: "Independent follow-up grant",
    },
    201,
  );
  assert.equal(
    (
      await follower.client.request("POST", `${s.path()}/balance-approvals`, {
        idempotencyKey: randomUUID(),
        ...ownerQuote,
      })
    ).status,
    403,
  );
  await approver.client.ok(
    "POST",
    `${s.path()}/balance-approvals`,
    {
      idempotencyKey: randomUUID(),
      ...ownerQuote,
    },
    201,
  );
  assert.equal(
    (
      await approver.client.request("POST", `${s.path()}/balance-followups`, {
        idempotencyKey: randomUUID(),
      })
    ).status,
    403,
  );
});

test("accepted action retries survive page disable while revoked grants and explicit denies still block them", async (t) => {
  const f = await fixture(t),
    s = await setup(f);
  const staff = await f.member(s.company.id, actionPermissions);
  const followupPath = `${s.path()}/balance-followups`;
  const approvalPath = `${s.path()}/balance-approvals`;
  const followupPayload = {
    idempotencyKey: randomUUID(),
    note: "Accepted before disable",
  };
  const approvalPayload = {
    idempotencyKey: randomUUID(),
    ...(await s.stats("2024-03-01", staff.client)).approvalQuote,
  };
  const followup = await staff.client.ok<{ followUp: FollowUp }>(
    "POST",
    followupPath,
    followupPayload,
    201,
  );
  const approval = await staff.client.ok<{ approval: Approval }>(
    "POST",
    approvalPath,
    approvalPayload,
    201,
  );
  for (const key of ["company.account-statistics", "company.accounts"])
    await f.owner.ok("PUT", `/page-catalog/${key}/settings`, {
      companyId: s.company.id,
      visible: true,
      enabled: false,
      order: 100,
      revision: null,
    });
  assert.deepEqual(
    await staff.client.ok("POST", followupPath, followupPayload, 201),
    followup,
  );
  assert.deepEqual(
    await staff.client.ok("POST", approvalPath, approvalPayload, 201),
    approval,
  );
  for (const [path, payload] of [
    [followupPath, followupPayload],
    [approvalPath, approvalPayload],
  ] as const)
    assert.equal(
      (
        await staff.client.request("POST", path, {
          ...payload,
          idempotencyKey: randomUUID(),
        })
      ).status,
      403,
    );
  assert.equal(
    (await staff.client.request("GET", `${s.path()}/statistics`)).status,
    403,
  );
  await s.rule(staff.employee.id, "company.account-statistics:create", "deny");
  assert.equal(
    (await staff.client.request("POST", followupPath, followupPayload)).status,
    403,
  );
  await f.owner.ok("PATCH", `${s.base}/employees/${staff.employee.id}`, {
    permissions: readerPermissions,
  });
  assert.equal(
    (await staff.client.request("POST", approvalPath, approvalPayload)).status,
    403,
    "Page retry exemptions never replace current permission checks",
  );
  assert.deepEqual(await actionCounts(f, s.company.id), {
    followups: "1",
    approvals: "1",
  });
});

test("explicit page rules authorize each required view and each action without changing legacy grants", async (t) => {
  const f = await fixture(t),
    s = await setup(f);
  const staff = await f.member(s.company.id, []);
  const statsPath = `${s.path()}/statistics?asOfDate=2024-03-01`;
  assert.equal((await staff.client.request("GET", statsPath)).status, 403);
  await s.rule(staff.employee.id, "company.account-statistics:view", "allow");
  assert.equal(
    (await staff.client.request("GET", statsPath)).status,
    403,
    "The statistics view rule does not replace the account and ledger views",
  );
  await s.rule(staff.employee.id, "company.accounts:view", "allow");
  assert.equal(
    (await staff.client.request("GET", statsPath)).status,
    403,
    "The ledger view remains independently required",
  );
  await s.rule(staff.employee.id, "company.account-ledger:view", "allow");
  const quote = (await s.stats("2024-03-01", staff.client)).approvalQuote;
  assert.deepEqual((await s.stats("2024-03-01", staff.client)).capabilities, {
    canFollowUp: false,
    canApprove: false,
  });
  await s.rule(staff.employee.id, "company.account-statistics:create", "allow");
  assert.deepEqual((await s.stats("2024-03-01", staff.client)).capabilities, {
    canFollowUp: true,
    canApprove: false,
  });
  await staff.client.ok(
    "POST",
    `${s.path()}/balance-followups`,
    {
      idempotencyKey: randomUUID(),
      note: "Granted only by the exact page rule",
    },
    201,
  );
  assert.equal(
    (
      await staff.client.request("POST", `${s.path()}/balance-approvals`, {
        idempotencyKey: randomUUID(),
        ...quote,
      })
    ).status,
    403,
  );
  await s.rule(staff.employee.id, "company.account-statistics:post", "allow");
  assert.deepEqual((await s.stats("2024-03-01", staff.client)).capabilities, {
    canFollowUp: true,
    canApprove: true,
  });
  await staff.client.ok(
    "POST",
    `${s.path()}/balance-approvals`,
    {
      idempotencyKey: randomUUID(),
      ...quote,
    },
    201,
  );
  assert.deepEqual(
    (
      await f.pool.query<{ permissions: Permission[] }>(
        "SELECT permissions FROM employees WHERE id=$1",
        [staff.employee.id],
      )
    ).rows[0]!.permissions,
    [],
    "Explicit action rules must not silently rewrite legacy employee grants",
  );
  assert.deepEqual(await actionCounts(f, s.company.id), {
    followups: "1",
    approvals: "1",
  });
});

test("audit failure rolls back both balance actions and concurrent same-key retries create one event each", async (t) => {
  const f = await fixture(t),
    s = await setup(f);
  await s.post("2024-03-01", "12.50");
  const quote = (await s.stats("2024-03-01")).approvalQuote;
  const followupPath = `${s.path()}/balance-followups`;
  const approvalPath = `${s.path()}/balance-approvals`;
  const followupPayload = {
    idempotencyKey: randomUUID(),
    note: "Atomic follow-up",
  };
  const approvalPayload = {
    idempotencyKey: randomUUID(),
    note: "Atomic approval",
    ...quote,
  };
  const snapshot = async () =>
    (
      await f.pool.query<{ snapshot: string }>(
        "SELECT to_jsonb(s)::text AS snapshot FROM account_statistics s WHERE company_id=$1 AND account_id=$2",
        [s.company.id, s.target.id],
      )
    ).rows[0]!.snapshot;
  const audits = async () =>
    (
      await f.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM audit_events WHERE company_id=$1 AND action IN ('accountBalance.followup','accountBalance.approve')",
        [s.company.id],
      )
    ).rows[0]!.count;
  const before = await snapshot();
  await f.pool
    .query(`CREATE FUNCTION reject_balance_action_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action IN ('accountBalance.followup','accountBalance.approve') THEN
      RAISE EXCEPTION 'test rejects balance action audit'; END IF; RETURN NEW; END $$`);
  await f.pool.query(
    "CREATE TRIGGER reject_balance_action_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_balance_action_audit()",
  );
  try {
    for (const [path, payload] of [
      [followupPath, followupPayload],
      [approvalPath, approvalPayload],
    ] as const) {
      assert.equal((await f.owner.request("POST", path, payload)).status, 500);
      assert.deepEqual(await actionCounts(f, s.company.id), {
        followups: "0",
        approvals: "0",
      });
      assert.equal(await audits(), "0");
      assert.equal(
        await snapshot(),
        before,
        "The failed action rolls back its projection refresh too",
      );
    }
  } finally {
    await f.pool.query(
      "DROP TRIGGER reject_balance_action_audit ON audit_events",
    );
    await f.pool.query("DROP FUNCTION reject_balance_action_audit()");
  }
  for (const [path, payload] of [
    [followupPath, followupPayload],
    [approvalPath, approvalPayload],
  ] as const) {
    const responses = await Promise.all([
      f.owner.request("POST", path, payload),
      f.owner.request("POST", path, payload),
    ]);
    assert.deepEqual(
      responses.map((response) => response.status),
      [201, 201],
    );
    assert.deepEqual(
      responses[0]!.body,
      responses[1]!.body,
      "Concurrent confirmations share exactly the same immutable action receipt",
    );
  }
  assert.deepEqual(await actionCounts(f, s.company.id), {
    followups: "1",
    approvals: "1",
  });
  assert.equal(
    await audits(),
    "2",
    "Retries never produce duplicate action audits",
  );
});

test("both actions recheck current permission after waiting for the company lock", async (t) => {
  const f = await fixture(t),
    s = await setup(f);
  const quote = (await s.stats("2024-03-01")).approvalQuote;
  for (const kind of ["balance-followups", "balance-approvals"] as const) {
    const staff = await f.member(s.company.id, actionPermissions);
    const body = {
      idempotencyKey: randomUUID(),
      note: "Must recheck permission",
      ...(kind === "balance-approvals" ? quote : {}),
    };
    const response = await blockedByCompany(
      f,
      s.company.id,
      () => staff.client.request("POST", `${s.path()}/${kind}`, body),
      async () => {
        await f.pool.query(
          "UPDATE employees SET permissions=$1::text[] WHERE company_id=$2 AND id=$3",
          [readerPermissions, s.company.id, staff.employee.id],
        );
      },
    );
    assert.equal(
      response.status,
      403,
      `${kind} must not use the grants seen before the lock wait`,
    );
  }
  assert.deepEqual(await actionCounts(f, s.company.id), {
    followups: "0",
    approvals: "0",
  });
});

test("transaction reset changes source generation, preserves action receipts and excludes old approval from current statistics", async (t) => {
  const f = await fixture(t),
    s = await setup(f);
  await s.post("2024-03-01", "25.50");
  const before = await s.stats("2024-03-01");
  const approvalPayload = {
    idempotencyKey: randomUUID(),
    note: "Snapshot before reset",
    ...before.approvalQuote,
  };
  const followupPayload = {
    idempotencyKey: randomUUID(),
    note: "Follow-up before reset",
  };
  const approvalPath = `${s.path()}/balance-approvals`;
  const followupPath = `${s.path()}/balance-followups`;
  const approval = await f.owner.ok<{ approval: Approval }>(
    "POST",
    approvalPath,
    approvalPayload,
    201,
  );
  const followup = await f.owner.ok<{ followUp: FollowUp }>(
    "POST",
    followupPath,
    followupPayload,
    201,
  );
  const preview = await f.owner.ok<{
    snapshotHash: string;
    companyName: string;
    blockers: string[];
  }>("GET", `${s.base}/transaction-reset`);
  assert.deepEqual(preview.blockers, []);
  await f.owner.ok("POST", `${s.base}/transaction-reset`, {
    idempotencyKey: randomUUID(),
    snapshotHash: preview.snapshotHash,
    confirmationCompanyName: preview.companyName,
    deleteAllTransactions: true,
  });
  const after = await s.stats("2024-03-01");
  assert.notEqual(after.sourceGeneration, before.sourceGeneration);
  assert.equal(after.balance.currentBase, "0");
  assert.equal(
    after.lastApproval,
    null,
    "An approval from a previous source generation remains historical only",
  );
  assert.deepEqual(after.lastFollowUp, followup.followUp);
  assert.deepEqual(
    await f.owner.ok("POST", approvalPath, approvalPayload, 201),
    approval,
  );
  assert.deepEqual(
    await f.owner.ok("POST", followupPath, followupPayload, 201),
    followup,
  );
  assert.equal(
    (
      await f.owner.request("POST", approvalPath, {
        ...approvalPayload,
        idempotencyKey: randomUUID(),
      })
    ).status,
    409,
    "A new UUID cannot approve a quote from the previous source generation",
  );
  await s.post("2024-03-01", "3");
  const latest = await s.stats("2024-03-01");
  const current = (
    await f.owner.ok<{ approval: Approval }>(
      "POST",
      approvalPath,
      {
        idempotencyKey: randomUUID(),
        note: "Current source generation",
        ...latest.approvalQuote,
      },
      201,
    )
  ).approval;
  assert.equal(current.balanceBase, "3");
  assert.equal(current.sourceGeneration, after.sourceGeneration);
  assert.deepEqual((await s.stats("2024-03-01")).lastApproval, current);
  assert.deepEqual(await actionCounts(f, s.company.id), {
    followups: "1",
    approvals: "2",
  });
});
