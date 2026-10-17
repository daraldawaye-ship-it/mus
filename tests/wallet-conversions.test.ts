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
  Permission,
  SessionResponse,
  WalletConversion,
  WalletConversionPreview,
  WalletDirectory,
  WalletEntry,
  WalletPolicy,
} from "../packages/contracts/src/index.ts";

const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const origin = "http://localhost";
const password = "wallet-conversion-test-passphrase";

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
  const schema = `wallet_conversions_${randomUUID().replaceAll("-", "")}`;
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
    name: "Wallet conversion owner",
    displayName: "Owner",
    email: "wallet-conversion-owner@example.test",
    password,
  });
  await owner.ok("POST", "/auth/login", { email: user.email, password });
  async function company(name = "Wallet conversion company") {
    return (
      await owner.ok<{ company: Company }>(
        "POST",
        "/companies",
        { name, phone: "", address: "" },
        201,
      )
    ).company;
  }
  async function staff(
    companyId: number,
    name: string,
    permissions: Permission[] = [],
  ) {
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
        permissions,
      },
      201,
    );
    return { client, employee };
  }
  async function account(
    companyId: number,
    code: string,
    category: "asset" | "expense",
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
  async function configure(
    companyId: number,
    employeeId: number,
    approvalMode: "direct" | "approval",
    pointValue = "1",
    useAutoAdvance = false,
  ) {
    const base = `/companies/${companyId}`;
    const originalBinding = (
      await owner.ok<{ binding: EmployeeWalletAccount }>(
        "GET", base + "/wallet-settings/employee-accounts/" + employeeId,
      )
    ).binding;
    assert.equal(originalBinding.account?.code.startsWith("114"), true);
    const accountForEmployee = useAutoAdvance
      ? originalBinding.account!
      : await account(companyId, "9810000001", "asset");
    const expense = await account(companyId, "9850000001", "expense");
    const currencies = await owner.ok<Page<CompanyCurrency>>(
      "GET",
      base + "/currencies",
    );
    const currency = currencies.items.find((row) => row.code === "YER")!;
    const { policy: initialPolicy } = await owner.ok<{ policy: WalletPolicy }>(
      "GET", base + "/wallet-settings",
    );
    const { policy } = await owner.ok<{ policy: WalletPolicy }>(
      "PUT",
      base + "/wallet-settings",
      {
        pointValue,
        currencyId: currency.id,
        expenseAccountId: expense.id,
        approvalMode,
        revision: initialPolicy.revision,
      },
    );
    const binding = useAutoAdvance
      ? originalBinding
      : (
        await owner.ok<{ binding: EmployeeWalletAccount }>(
          "PUT",
          base + "/wallet-settings/employee-accounts/" + employeeId,
          { accountId: accountForEmployee.id, revision: originalBinding.revision },
        )
      ).binding;
    return {
      base,
      policy,
      binding,
      account: accountForEmployee,
      expense,
      currency,
    };
  }
  async function award(companyId: number, employeeId: number, points: string) {
    return (
      await owner.ok<{ entry: WalletEntry }>(
        "POST",
        `/companies/${companyId}/wallet/awards`,
        {
          employeeId,
          points,
          reason: "Conversion fixture reward",
          idempotencyKey: randomUUID(),
        },
      )
    ).entry;
  }
  async function quote(client: Client, companyId: number, employeeId?: number) {
    const { preview } = await client.ok<{ preview: WalletConversionPreview }>(
      "GET",
      `/companies/${companyId}/wallet/conversion-preview` +
        (employeeId === undefined ? "" : `?employeeId=${employeeId}`),
    );
    return {
      employeeId: preview.employeeId,
      expectedPoints: preview.points,
      expectedAmount: preview.amount!,
      policyRevision: preview.policyRevision!,
      accountRevision: preview.accountRevision!,
      idempotencyKey: randomUUID(),
    };
  }
  async function snapshot(companyId: number, employeeId: number) {
    const wallet = await owner.ok<WalletDirectory>(
      "GET",
      `/companies/${companyId}/wallet?employeeId=${employeeId}`,
    );
    const conversions = await owner.ok<Page<WalletConversion>>(
      "GET",
      `/companies/${companyId}/wallet-conversions?employeeId=${employeeId}`,
    );
    const rows = (
      await runtime.pool.query(
        `SELECT (SELECT count(*)::integer FROM financial_documents WHERE company_id=$1) AS documents,
      (SELECT count(*)::integer FROM financial_document_lines WHERE company_id=$1) AS lines`,
        [companyId],
      )
    ).rows[0];
    return {
      wallet: wallet.wallet,
      entries: wallet.total,
      conversions: conversions.total,
      documents: rows.documents,
      lines: rows.lines,
    };
  }
  async function journal(companyId: number, documentId: number) {
    return (
      await runtime.pool.query(
        `SELECT account_id,debit::text,credit::text,base_debit::text,base_credit::text
       FROM financial_document_lines WHERE company_id=$1 AND document_id=$2 ORDER BY line_number`,
        [companyId, documentId],
      )
    ).rows.map((row) => ({
      accountId: row.account_id,
      debit: row.debit.replace(/\.?0+$/, "") || "0",
      credit: row.credit.replace(/\.?0+$/, "") || "0",
      baseDebit: row.base_debit.replace(/\.?0+$/, "") || "0",
      baseCredit: row.base_credit.replace(/\.?0+$/, "") || "0",
    }));
  }
  return {
    pool: runtime.pool,
    owner,
    company,
    staff,
    account,
    configure,
    award,
    quote,
    snapshot,
    journal,
  };
}

type ConversionResponse = { conversion: WalletConversion };
const transition = (
  conversion: WalletConversion,
  reason = "Reviewed conversion",
) => ({ revision: conversion.revision, reason, idempotencyKey: randomUUID() });
const policyInput = (policy: WalletPolicy) => ({
  pointValue: policy.pointValue,
  currencyId: policy.currencyId,
  expenseAccountId: policy.expenseAccountId,
  approvalMode: policy.approvalMode,
  revision: policy.revision,
});

test("direct conversion posts one exact balanced journal and point debit; retries and audit failure are atomic", async (t) => {
  const f = await fixture(t);
  const company = await f.company();
  const recipient = await f.staff(company.id, "Direct recipient");
  const setup = await f.configure(company.id, recipient.employee.id, "direct");
  await f.award(company.id, recipient.employee.id, "9007199254740993");
  const path = setup.base + "/wallet-conversions";
  const input = await f.quote(recipient.client, company.id);
  assert.equal(input.expectedAmount, "9007199254740993");
  const results = await Promise.all([
    recipient.client.ok<ConversionResponse>("POST", path, input),
    recipient.client.ok<ConversionResponse>("POST", path, input),
  ]);
  const conversion = results[0]!.conversion;
  assert.deepEqual(results[1]!.conversion, conversion);
  assert.equal(conversion.status, "posted");
  assert.equal(conversion.points, input.expectedPoints);
  assert.equal(conversion.amount, input.expectedAmount);
  assert(conversion.financialDocumentId);
  assert.deepEqual(
    await f.journal(company.id, conversion.financialDocumentId),
    [
      {
        accountId: setup.expense.id,
        debit: input.expectedAmount,
        credit: "0",
        baseDebit: input.expectedAmount,
        baseCredit: "0",
      },
      {
        accountId: setup.account.id,
        debit: "0",
        credit: input.expectedAmount,
        baseDebit: "0",
        baseCredit: input.expectedAmount,
      },
    ],
  );
  const after = await f.snapshot(company.id, recipient.employee.id);
  assert.equal(after.wallet!.points, "0");
  assert.equal(after.wallet!.totalPoints, "0");
  assert.equal(after.wallet!.reservedPoints, "0");
  assert.equal(after.entries, 2);
  assert.equal(after.documents, 1);
  assert.equal(after.lines, 2);
  assert.equal(after.conversions, 1);
  const ledger = await recipient.client.ok<WalletDirectory>(
    "GET",
    setup.base + "/wallet",
  );
  assert.equal(
    ledger.items.find((row) => row.kind === "conversion")!.points,
    "-9007199254740993",
  );
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::integer AS total FROM audit_events WHERE company_id=$1 AND action='wallet.conversion.request'",
        [company.id],
      )
    ).rows[0].total,
    1,
    "Accepted retries create one audit event",
  );
  assert.equal(
    (
      await recipient.client.request("POST", path, {
        ...input,
        expectedAmount: "1",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await recipient.client.request("POST", path, {
        ...input,
        idempotencyKey: randomUUID(),
      })
    ).status,
    409,
    "Another concurrent request cannot spend the accepted balance again",
  );

  const { document } = await f.owner.ok<{
    document: { revision: number; documentDate: string };
  }>(
    "GET",
    setup.base + "/financial-documents/" + conversion.financialDocumentId,
  );
  assert.equal(
    (
      await f.owner.request(
        "POST",
        setup.base +
          "/financial-documents/" +
          conversion.financialDocumentId +
          "/reverse",
        {
          documentDate: document.documentDate,
          reason: "Cannot detach wallet journal",
          idempotencyKey: randomUUID(),
        },
      )
    ).status,
    409,
    "A wallet journal cannot be reversed without its point effect",
  );
  assert.deepEqual(await f.snapshot(company.id, recipient.employee.id), after);

  await f.award(company.id, recipient.employee.id, "57");
  const failedInput = await f.quote(recipient.client, company.id);
  const beforeFailure = await f.snapshot(company.id, recipient.employee.id);
  await f.pool
    .query(`CREATE FUNCTION reject_conversion_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='wallet.conversion.request' THEN RAISE EXCEPTION 'isolated conversion audit failure'; END IF;
    RETURN NEW; END $$;
    CREATE TRIGGER reject_conversion_audit BEFORE INSERT ON audit_events
    FOR EACH ROW EXECUTE FUNCTION reject_conversion_audit()`);
  assert.equal(
    (await recipient.client.request("POST", path, failedInput)).status,
    500,
  );
  await f.pool.query("DROP TRIGGER reject_conversion_audit ON audit_events");
  assert.deepEqual(
    await f.snapshot(company.id, recipient.employee.id),
    beforeFailure,
    "Audit failure leaves no journal, debit, conversion or reserved balance",
  );
  const retried = await recipient.client.ok<ConversionResponse>(
    "POST",
    path,
    failedInput,
  );
  assert.equal(retried.conversion.amount, "57");
  assert.equal(retried.conversion.status, "posted");
  assert.equal(
    (await f.snapshot(company.id, recipient.employee.id)).wallet!.points,
    "0",
  );
});

test("a new employee redeems wallet points directly into the auto-created advance account", async (t) => {
  const f = await fixture(t);
  const company = await f.company("Auto wallet advance company");
  const recipient = await f.staff(company.id, "Advance recipient");
  const setup = await f.configure(company.id, recipient.employee.id, "direct", "1", true);
  assert.match(setup.account.code, /^1140/);
  assert.equal(setup.binding.accountId, setup.account.id);
  assert.equal(setup.binding.revision, 1);
  await f.award(company.id, recipient.employee.id, "100");
  const input = await f.quote(recipient.client, company.id);
  assert.equal(input.expectedPoints, "100");
  assert.equal(input.expectedAmount, "100");
  const conversion = (
    await recipient.client.ok<ConversionResponse>(
      "POST", setup.base + "/wallet-conversions", input,
    )
  ).conversion;
  assert.equal(conversion.status, "posted");
  assert.equal(conversion.accountId, setup.account.id);
  assert.equal(conversion.accountCode, setup.account.code);
  assert(conversion.financialDocumentId);
  assert.deepEqual(await f.journal(company.id, conversion.financialDocumentId), [
    { accountId: setup.expense.id, debit: "100", credit: "0", baseDebit: "100", baseCredit: "0" },
    { accountId: setup.account.id, debit: "0", credit: "100", baseDebit: "0", baseCredit: "100" },
  ]);
  const state = await f.snapshot(company.id, recipient.employee.id);
  assert.equal(state.wallet!.points, "0");
  assert.equal(state.entries, 2);
  assert.equal(state.documents, 1);
  assert.equal(state.lines, 2);
});

test("approval reserves only quoted points, protects them, and releases or consumes them exactly once", async (t) => {
  const f = await fixture(t);
  const company = await f.company();
  const recipient = await f.staff(company.id, "Approval recipient");
  const peer = await f.staff(company.id, "Peer administrator", [
    "accounts.manage",
    "finance.view",
    "finance.post",
    "company.edit",
  ]);
  const setup = await f.configure(
    company.id,
    recipient.employee.id,
    "approval",
  );
  const path = setup.base + "/wallet-conversions";
  const award = await f.award(company.id, recipient.employee.id, "100");
  const input = await f.quote(recipient.client, company.id);
  const { conversion: pending } = await recipient.client.ok<ConversionResponse>(
    "POST",
    path,
    input,
  );
  assert.equal(pending.status, "pending");
  assert.equal(pending.financialDocumentId, null);
  let state = await f.snapshot(company.id, recipient.employee.id);
  assert.equal(state.wallet!.points, "0");
  assert.equal(state.wallet!.totalPoints, "100");
  assert.equal(state.wallet!.reservedPoints, "100");
  assert.equal(state.documents, 0);
  assert.equal(state.entries, 1, "Reserving points is not a ledger debit");
  assert.deepEqual(
    await recipient.client.ok<ConversionResponse>("POST", path, input),
    { conversion: pending },
  );
  const reversal = await f.owner.request(
    "POST",
    setup.base + "/wallet/reversals",
    {
      entryId: award.id,
      reason: "Must not spend reserved points",
      idempotencyKey: randomUUID(),
    },
  );
  assert(
    [400, 409].includes(reversal.status),
    "Reversing an award cannot consume points reserved for approval",
  );
  assert.deepEqual(await f.snapshot(company.id, recipient.employee.id), state);
  for (const action of ["approve", "reject"]) {
    assert.equal(
      (
        await recipient.client.request(
          "POST",
          `${path}/${pending.id}/${action}`,
          transition(pending),
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await peer.client.request(
          "POST",
          `${path}/${pending.id}/${action}`,
          transition(pending),
        )
      ).status,
      403,
      "Finance and account administration do not grant conversion approval",
    );
  }
  assert.equal(
    (
      await peer.client.request(
        "GET",
        path + "?employeeId=" + recipient.employee.id,
      )
    ).status,
    403,
    "Ordinary administrators cannot inspect another employee's conversions",
  );
  assert.equal(
    (
      await peer.client.request(
        "POST",
        `${path}/${pending.id}/cancel`,
        transition(pending),
      )
    ).status,
    403,
  );

  await f.award(company.id, recipient.employee.id, "7");
  state = await f.snapshot(company.id, recipient.employee.id);
  assert.equal(state.wallet!.points, "7");
  assert.equal(state.wallet!.totalPoints, "107");
  assert.equal(state.wallet!.reservedPoints, "100");
  const approval = transition(pending);
  const approved = await Promise.all([
    f.owner.ok<ConversionResponse>(
      "POST",
      `${path}/${pending.id}/approve`,
      approval,
    ),
    f.owner.ok<ConversionResponse>(
      "POST",
      `${path}/${pending.id}/approve`,
      approval,
    ),
  ]);
  assert.deepEqual(approved[0], approved[1]);
  assert.equal(approved[0]!.conversion.status, "posted");
  assert.equal(approved[0]!.conversion.amount, "100");
  state = await f.snapshot(company.id, recipient.employee.id);
  assert.equal(
    state.wallet!.points,
    "7",
    "Later earnings are not included in the reserved debit",
  );
  assert.equal(state.wallet!.totalPoints, "7");
  assert.equal(state.wallet!.reservedPoints, "0");
  assert.equal(state.documents, 1);
  assert.equal(state.entries, 3);
  assert.equal(
    (
      await f.owner.request(
        "POST",
        `${path}/${pending.id}/reject`,
        transition(pending),
      )
    ).status,
    409,
  );

  const { conversion: toReject } =
    await recipient.client.ok<ConversionResponse>(
      "POST",
      path,
      await f.quote(recipient.client, company.id),
    );
  assert.equal(
    (await f.snapshot(company.id, recipient.employee.id)).wallet!.points,
    "0",
  );
  const rejection = transition(toReject, "Request needs correction");
  const rejected = await f.owner.ok<ConversionResponse>(
    "POST",
    `${path}/${toReject.id}/reject`,
    rejection,
  );
  assert.equal(rejected.conversion.status, "rejected");
  assert.deepEqual(
    await f.owner.ok<ConversionResponse>(
      "POST",
      `${path}/${toReject.id}/reject`,
      rejection,
    ),
    rejected,
  );
  state = await f.snapshot(company.id, recipient.employee.id);
  assert.equal(state.wallet!.points, "7");
  assert.equal(state.wallet!.reservedPoints, "0");
  assert.equal(state.documents, 1);
  assert.equal(state.entries, 3);

  const { conversion: toCancel } =
    await recipient.client.ok<ConversionResponse>(
      "POST",
      path,
      await f.quote(recipient.client, company.id),
    );
  const cancellation = transition(toCancel, "Employee withdrew request");
  const cancelled = await recipient.client.ok<ConversionResponse>(
    "POST",
    `${path}/${toCancel.id}/cancel`,
    cancellation,
  );
  assert.equal(cancelled.conversion.status, "cancelled");
  assert.deepEqual(
    await recipient.client.ok<ConversionResponse>(
      "POST",
      `${path}/${toCancel.id}/cancel`,
      cancellation,
    ),
    cancelled,
  );
  state = await f.snapshot(company.id, recipient.employee.id);
  assert.equal(state.wallet!.points, "7");
  assert.equal(state.wallet!.reservedPoints, "0");
  assert.equal(state.documents, 1);
  assert.equal(state.entries, 3);
});

test("a general manager cannot approve their own wallet conversion; independent approval is required", async (t) => {
  const f = await fixture(t);
  const company = await f.company("Separation of duties company");
  const manager = await f.staff(company.id, "General manager and recipient");
  const setup = await f.configure(company.id, manager.employee.id, "approval");
  await f.owner.ok(
    "PATCH",
    setup.base + "/employees/" + manager.employee.id + "/manager",
    { isGeneralManager: true },
  );
  await f.award(company.id, manager.employee.id, "80");
  const path = setup.base + "/wallet-conversions";
  const { conversion: pending } = await manager.client.ok<ConversionResponse>(
    "POST",
    path,
    await f.quote(manager.client, company.id),
  );
  assert.equal(pending.status, "pending");
  const original = await f.snapshot(company.id, manager.employee.id);
  const response = await manager.client.request(
    "POST",
    path + "/" + pending.id + "/approve",
    transition(pending, "Try approving own reward"),
  );
  assert.equal(response.status, 403, "Manager cannot credit their own payable");
  assert.deepEqual(
    await f.snapshot(company.id, manager.employee.id),
    original,
    "Self-approval has no journal, point debit or audit side effect",
  );
  const { conversion: approved } = await f.owner.ok<ConversionResponse>(
    "POST",
    path + "/" + pending.id + "/approve",
    transition(pending, "Independent owner approval"),
  );
  assert.equal(approved.status, "posted");
  assert.equal(approved.amount, "80");
  assert(approved.financialDocumentId);
  assert.deepEqual(
    await f.journal(company.id, approved.financialDocumentId),
    [
      {
        accountId: setup.expense.id,
        debit: "80",
        credit: "0",
        baseDebit: "80",
        baseCredit: "0",
      },
      {
        accountId: setup.account.id,
        debit: "0",
        credit: "80",
        baseDebit: "0",
        baseCredit: "80",
      },
    ],
  );
  assert.equal(
    (await f.snapshot(company.id, manager.employee.id)).wallet!.points,
    "0",
  );
});

test("conversion rejects changed quotes, foreign and archived references, and disabled new work while confirming accepted UUIDs", async (t) => {
  const f = await fixture(t);
  const company = await f.company();
  const other = await f.company("Foreign conversion company");
  const recipient = await f.staff(company.id, "Scoped conversion recipient");
  const foreign = await f.staff(other.id, "Foreign recipient");
  const setup = await f.configure(company.id, recipient.employee.id, "direct");
  const path = setup.base + "/wallet-conversions";
  await f.award(company.id, recipient.employee.id, "20");
  const staleBalance = await f.quote(recipient.client, company.id);
  await f.award(company.id, recipient.employee.id, "1");
  const before = await f.snapshot(company.id, recipient.employee.id);
  assert.equal(
    (await recipient.client.request("POST", path, staleBalance)).status,
    409,
  );
  const stalePolicy = await f.quote(recipient.client, company.id);
  const { policy } = await f.owner.ok<{ policy: WalletPolicy }>(
    "PUT",
    setup.base + "/wallet-settings",
    { ...policyInput(setup.policy), approvalMode: "direct" },
  );
  assert.equal(
    (await recipient.client.request("POST", path, stalePolicy)).status,
    409,
  );
  const staleBinding = await f.quote(recipient.client, company.id);
  await f.owner.ok(
    "PUT",
    setup.base + "/wallet-settings/employee-accounts/" + recipient.employee.id,
    { accountId: setup.account.id, revision: setup.binding.revision },
  );
  assert.equal(
    (await recipient.client.request("POST", path, staleBinding)).status,
    409,
  );
  const latest = await f.quote(recipient.client, company.id);
  assert.equal(latest.expectedAmount, "21");
  assert.equal(latest.policyRevision, policy.revision);
  assert.equal(
    (
      await recipient.client.request("POST", path, {
        ...latest,
        employeeId: foreign.employee.id,
      })
    ).status,
    403,
  );
  assert.equal(
    (await foreign.client.request("POST", path, latest)).status,
    403,
  );
  assert.equal(
    (
      await recipient.client.request("POST", path, {
        ...latest,
        expectedAmount: "20",
      })
    ).status,
    409,
  );
  await f.owner.ok("PATCH", setup.base + "/accounts/" + setup.account.id, {
    active: false,
  });
  assert.equal(
    (await recipient.client.request("POST", path, latest)).status,
    409,
  );
  await f.owner.ok("PATCH", setup.base + "/accounts/" + setup.account.id, {
    active: true,
  });
  assert.deepEqual(await f.snapshot(company.id, recipient.employee.id), before);
  const { page: disabledWallet } = await f.owner.ok<{
    page: { revision: number };
  }>("PUT", "/page-catalog/company.wallet/settings", {
    companyId: company.id,
    visible: true,
    enabled: false,
    order: 100,
    revision: null,
  });
  assert.equal(
    (await recipient.client.request("POST", path, latest)).status,
    403,
    "A new conversion cannot bypass a disabled source wallet page",
  );
  await f.owner.ok("PUT", "/page-catalog/company.wallet/settings", {
    companyId: company.id,
    visible: true,
    enabled: true,
    order: 100,
    revision: disabledWallet.revision,
  });
  const accepted = await recipient.client.ok<ConversionResponse>(
    "POST",
    path,
    latest,
  );
  await f.owner.ok("PUT", "/page-catalog/company.wallet-conversions/settings", {
    companyId: company.id,
    visible: true,
    enabled: false,
    order: 100,
    revision: null,
  });
  assert.deepEqual(
    await recipient.client.ok<ConversionResponse>("POST", path, latest),
    accepted,
  );
  assert.equal(
    (
      await recipient.client.request("POST", path, {
        ...latest,
        idempotencyKey: randomUUID(),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await foreign.client.request(
        "GET",
        path + "?employeeId=" + recipient.employee.id,
      )
    ).status,
    403,
  );
});
