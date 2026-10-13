import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import type {
  Account,
  Company,
  CompanyCurrency,
  Employee,
  EmployeeWalletAccount,
  Page,
  SessionResponse,
  WalletConversionPreview,
  WalletPolicy,
} from "../packages/contracts/src/index.ts";

const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const origin = "http://localhost";
const password = "wallet-policy-test-passphrase";

class Client {
  private cookie = "";
  private csrf: string | null = null;
  constructor(private readonly baseUrl: string) {}

  async request<T>(method: string, path: string, body?: unknown) {
    const headers = new Headers({ accept: "application/json" });
    if (this.cookie) headers.set("cookie", this.cookie);
    if (method !== "GET") {
      headers.set("origin", origin);
      headers.set("content-type", "application/json");
      if (this.csrf) headers.set("x-csrf-token", this.csrf);
    }
    const response = await fetch(this.baseUrl + "/api" + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const cookie of response.headers.getSetCookie())
      this.cookie = /max-age=0/i.test(cookie) ? "" : cookie.split(";", 1)[0]!;
    const parsed = (await response.json()) as T;
    if (parsed && typeof parsed === "object" && "csrf" in parsed)
      this.csrf = (parsed as { csrf: string | null }).csrf;
    return { status: response.status, body: parsed };
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
  const schema = `wallet_policy_${randomUUID().replaceAll("-", "")}`;
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
      await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await cleanup.end();
    }
  });
  const owner = new Client(baseUrl);
  const user = await provisionOwner(runtime.pool, {
    name: "Wallet policy owner",
    displayName: "Owner",
    email: "wallet-policy-owner@example.test",
    password,
  });
  await owner.ok("POST", "/auth/login", { email: user.email, password });
  async function company(name: string) {
    return (
      await owner.ok<{ company: Company }>(
        "POST",
        "/companies",
        { name, phone: "", address: "" },
        201,
      )
    ).company;
  }
  async function staff(companyId: number, name: string) {
    const client = new Client(baseUrl);
    const session = await client.ok<SessionResponse>(
      "POST",
      "/auth/register",
      {
        name,
        displayName: name,
        email: `${randomUUID()}@example.test`,
        phone: "",
        password,
      },
      201,
    );
    assert(session.user);
    const { employee } = await owner.ok<{ employee: Employee }>(
      "POST",
      `/companies/${companyId}/employees`,
      {
        userId: session.user.id,
        name,
        phone: "",
        role: "administrative",
        active: true,
        permissions: ["accounts.manage", "company.edit"],
      },
      201,
    );
    return { client, employee };
  }
  async function account(
    companyId: number,
    code: string,
    category: "asset" | "expense" = "asset",
  ) {
    return (
      await owner.ok<{ account: Account }>(
        "POST",
        `/companies/${companyId}/accounts`,
        {
          code,
          name: category === "expense" ? "Reward expense" : "Employee account",
          parentId: null,
          kind: "posting",
          category,
          normalSide: "debit",
          cashOrBank: false,
        },
        201,
      )
    ).account;
  }
  return { pool: runtime.pool, owner, company, staff, account };
}

const policyInput = (policy: WalletPolicy) => ({
  pointValue: policy.pointValue,
  currencyId: policy.currencyId,
  expenseAccountId: policy.expenseAccountId,
  approvalMode: policy.approvalMode,
  revision: policy.revision,
});

test("wallet policies and employee bindings are scoped, revisioned and produce exact read-only previews", async (t) => {
  const f = await fixture(t);
  const company = await f.company("Policy company");
  const other = await f.company("Foreign policy company");
  const recipient = await f.staff(company.id, "Reward recipient");
  const peer = await f.staff(company.id, "Peer administrator");
  const base = `/companies/${company.id}`;
  const policyPath = base + "/wallet-settings";
  const bindingPath =
    policyPath + "/employee-accounts/" + recipient.employee.id;
  const previewPath = base + "/wallet/conversion-preview";
  const employeeAccount = await f.account(company.id, "9810000001");
  const expenseAccount = await f.account(company.id, "9850000001", "expense");
  const foreignAccount = await f.account(other.id, "9810000001");
  const currencies = await f.owner.ok<Page<CompanyCurrency>>(
    "GET",
    base + "/currencies",
  );
  const yer = currencies.items.find((currency) => currency.code === "YER")!;
  const sar = currencies.items.find((currency) => currency.code === "SAR")!;
  const foreignCurrencies = await f.owner.ok<Page<CompanyCurrency>>(
    "GET",
    `/companies/${other.id}/currencies`,
  );
  const foreignYer = foreignCurrencies.items.find(
    (currency) => currency.code === "YER",
  )!;
  assert.equal(yer.decimalPlaces, 2);

  const { policy: empty } = await f.owner.ok<{ policy: WalletPolicy }>(
    "GET",
    policyPath,
  );
  assert.equal(empty.pointValue, null, "No value per point is invented");
  assert.equal(empty.currencyId, null);
  assert.equal(empty.expenseAccountId, null);
  assert.equal(empty.approvalMode, null);
  assert.equal(empty.revision, null);
  const ownEmpty = (
    await recipient.client.ok<{ preview: WalletConversionPreview }>(
      "GET",
      previewPath,
    )
  ).preview;
  assert.equal(ownEmpty.employeeId, recipient.employee.id);
  assert.equal(ownEmpty.configurationComplete, false);
  assert.equal(ownEmpty.amount, null);
  assert.equal(ownEmpty.canConvert, false);
  assert.equal(
    (await peer.client.request("GET", policyPath)).status,
    403,
    "Company and account administration do not confer wallet policy management",
  );
  assert.equal(
    (
      await peer.client.request("PUT", policyPath, {
        ...policyInput(empty),
        pointValue: "1",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await recipient.client.request(
        "GET",
        previewPath + "?employeeId=" + peer.employee.id,
      )
    ).status,
    403,
  );

  for (const invalid of [
    { currencyId: sar.id },
    { currencyId: foreignYer.id },
    { expenseAccountId: employeeAccount.id },
    { expenseAccountId: foreignAccount.id },
    { pointValue: "1e3" },
    { pointValue: "0" },
  ]) {
    assert.equal(
      (
        await f.owner.request("PUT", policyPath, {
          pointValue: "0.125",
          currencyId: yer.id,
          expenseAccountId: expenseAccount.id,
          approvalMode: "direct",
          revision: empty.revision,
          ...invalid,
        })
      ).status,
      400,
    );
  }
  const { policy } = await f.owner.ok<{ policy: WalletPolicy }>(
    "PUT",
    policyPath,
    {
      pointValue: "٠٫١٢٥",
      currencyId: yer.id,
      expenseAccountId: expenseAccount.id,
      approvalMode: "direct",
      revision: empty.revision,
    },
  );
  assert.equal(policy.pointValue, "0.125");
  assert.equal(policy.currencyId, yer.id);
  assert.equal(policy.approvalMode, "direct");
  assert.equal(
    (
      await f.owner.request("PUT", policyPath, {
        ...policyInput(policy),
        revision: empty.revision,
      })
    ).status,
    409,
    "Stale policy writers cannot replace a newer policy",
  );
  const { binding: emptyBinding } = await f.owner.ok<{
    binding: EmployeeWalletAccount;
  }>("GET", bindingPath);
  // Newly created employee wallets are linked to their own advance by default.
  const linked = await f.pool.query<{account_id:number;code:string}>(
    "SELECT l.account_id,a.code FROM employee_account_links l JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id WHERE l.company_id=$1 AND l.employee_id=$2 AND l.account_kind='advance'",
    [company.id,recipient.employee.id],
  );
  assert.equal(emptyBinding.accountId, linked.rows[0]?.account_id);
  assert.equal(emptyBinding.account?.code, linked.rows[0]?.code);
  assert.equal(emptyBinding.revision, 1);
  for (const accountId of [foreignAccount.id, expenseAccount.id]) {
    assert.equal(
      (
        await f.owner.request("PUT", bindingPath, {
          accountId,
          revision: emptyBinding.revision,
        })
      ).status,
      400,
    );
  }
  const { binding } = await f.owner.ok<{ binding: EmployeeWalletAccount }>(
    "PUT",
    bindingPath,
    { accountId: employeeAccount.id, revision: emptyBinding.revision },
  );
  assert.equal(binding.accountId, employeeAccount.id);
  assert.equal(
    (
      await f.owner.request("PUT", bindingPath, {
        accountId: null,
        revision: emptyBinding.revision,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await recipient.client.request("PUT", bindingPath, {
        accountId: null,
        revision: binding.revision,
      })
    ).status,
    403,
  );

  await f.owner.ok("POST", base + "/wallet/awards", {
    employeeId: recipient.employee.id,
    points: "9007199254740993",
    reason: "Exact preview balance",
    idempotencyKey: randomUUID(),
  });
  const financialSnapshot = async () =>
    (
      await f.pool.query(
        `SELECT w.points::text AS points,w.money::text AS money,
         (SELECT count(*)::integer FROM employee_wallet_entries WHERE company_id=$1) AS entries,
         (SELECT count(*)::integer FROM financial_documents WHERE company_id=$1) AS documents,
         (SELECT count(*)::integer FROM financial_document_lines WHERE company_id=$1) AS journal_lines
         FROM employee_wallets w WHERE w.company_id=$1 AND w.employee_id=$2`,
        [company.id, recipient.employee.id],
      )
    ).rows[0];
  const before = await financialSnapshot();
  const preview = (
    await recipient.client.ok<{ preview: WalletConversionPreview }>(
      "GET",
      previewPath,
    )
  ).preview;
  assert.equal(preview.points, "9007199254740993");
  assert.equal(preview.pointValue, "0.125");
  assert.equal(
    preview.amount,
    "1125899906842624.13",
    "Exact multiplication rounds half up to the two-decimal YER quantum",
  );
  assert.equal(preview.currency?.id, yer.id);
  assert.equal(preview.account?.id, employeeAccount.id);
  assert.equal(preview.configurationComplete, true);
  assert.equal(preview.canConvert, true);
  assert.equal(preview.unavailableReason, "");
  const ownerPreview = (
    await f.owner.ok<{ preview: WalletConversionPreview }>(
      "GET",
      previewPath + "?employeeId=" + recipient.employee.id,
    )
  ).preview;
  assert.deepEqual(ownerPreview, {
    ...preview,
    canConvert: false,
    unavailableReason: ownerPreview.unavailableReason,
  });
  assert.deepEqual(
    await financialSnapshot(),
    before,
    "Preview neither spends points nor writes wallet entries or journals",
  );

  await f.owner.ok(
    "PATCH",
    base + "/employees/" + peer.employee.id + "/manager",
    { isGeneralManager: true },
  );
  const generalPreview = (
    await peer.client.ok<{ preview: WalletConversionPreview }>(
      "GET",
      previewPath + "?employeeId=" + recipient.employee.id,
    )
  ).preview;
  assert.deepEqual(generalPreview, {
    ...preview,
    canConvert: false,
    unavailableReason: generalPreview.unavailableReason,
  });
  const concurrent = await Promise.all([
    f.owner.request<{ policy: WalletPolicy }>("PUT", policyPath, {
      ...policyInput(policy),
      approvalMode: "approval",
    }),
    peer.client.request<{ policy: WalletPolicy }>("PUT", policyPath, {
      ...policyInput(policy),
      approvalMode: "approval",
    }),
  ]);
  assert.deepEqual(
    concurrent.map((result) => result.status).sort(),
    [200, 409],
    "Concurrent updates sharing a revision produce one committed policy",
  );
  assert.equal(
    (await f.owner.ok<{ policy: WalletPolicy }>("GET", policyPath)).policy
      .approvalMode,
    "approval",
  );

  await f.owner.ok("PATCH", base + "/accounts/" + employeeAccount.id, {
    active: false,
  });
  const staleAccountPreview = (
    await recipient.client.ok<{ preview: WalletConversionPreview }>(
      "GET",
      previewPath,
    )
  ).preview;
  assert.equal(staleAccountPreview.configurationComplete, false);
  assert.equal(staleAccountPreview.canConvert, false);
  assert.deepEqual(await financialSnapshot(), before);
});
