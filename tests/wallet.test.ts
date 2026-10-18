import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import type {
  Company,
  Employee,
  SessionResponse,
  RewardTask,
  RewardTaskDirectory,
  WalletDirectory,
  WalletEntry,
  WalletSummary,
} from "../packages/contracts/src/index.ts";

// Two focused cases cover exact point accounting and current scoped access.
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const origin = "http://localhost";
const password = "wallet-test-passphrase";

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
  const schema = `wallet_${randomUUID().replaceAll("-", "")}`;
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
  const ownerUser = await provisionOwner(runtime.pool, {
    name: "Wallet owner",
    displayName: "Owner",
    email: "wallet-owner@example.test",
    password,
  });
  await owner.ok("POST", "/auth/login", { email: ownerUser.email, password });
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
        role: "employee",
        active: true,
        permissions: [],
      },
      201,
    );
    return { client, user: session.user, employee };
  }
  return { pool: runtime.pool, owner, ownerUser, company, staff };
}

const taskSettings = (task: RewardTask) => ({
  points: task.points,
  repeatRule: task.repeatRule,
  enabled: task.enabled,
  roleIds: task.roleIds,
  pageKey: task.pageKey,
  revision: task.revision,
});

test("wallet awards and reversals are exact, transactional, immutable and idempotent", async (t) => {
  const f = await fixture(t);
  const company = await f.company("Exact wallet company");
  const staff = await f.staff(company.id, "Point recipient");
  const base = "/companies/" + company.id;
  const walletPath = base + "/wallet?employeeId=" + staff.employee.id;
  const balance = async () =>
    (await f.owner.ok<WalletDirectory>("GET", walletPath)).wallet!;
  assert.equal((await balance()).points, "0");
  assert.equal((await balance()).money, "0");
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::integer AS total FROM employee_wallets WHERE company_id=$1 AND employee_id=$2",
        [company.id, staff.employee.id],
      )
    ).rows[0]!.total,
    1,
    "Employee creation automatically initializes one zero wallet",
  );
  const award = {
    employeeId: staff.employee.id,
    points: "9007199254740993",
    reason: "  مكافأة دقيقة  ",
    idempotencyKey: randomUUID(),
  };
  const results = await Promise.all([
    f.owner.ok<{ entry: WalletEntry }>("POST", base + "/wallet/awards", award),
    f.owner.ok<{ entry: WalletEntry }>("POST", base + "/wallet/awards", award),
  ]);
  const entry = results[0]!.entry;
  assert.deepEqual(results[1]!.entry, entry);
  assert.equal(entry.points, award.points);
  assert.equal(entry.reason, "مكافأة دقيقة");
  assert.equal((await balance()).points, award.points);
  assert.equal(
    (
      await f.owner.request("POST", base + "/wallet/awards", {
        ...award,
        points: "20",
      })
    ).status,
    409,
    "An accepted key cannot acquire a different reward",
  );
  for (const invalid of [
    { points: "1e3" },
    { points: "-1" },
    { money: "50" },
  ]) {
    assert.equal(
      (
        await f.owner.request("POST", base + "/wallet/awards", {
          ...award,
          idempotencyKey: randomUUID(),
          ...invalid,
        })
      ).status,
      400,
    );
  }
  const reversal = {
    entryId: entry.id,
    reason: "تصحيح المكافأة",
    idempotencyKey: randomUUID(),
  };
  const reversals = await Promise.all([
    f.owner.ok<{ entry: WalletEntry }>(
      "POST",
      base + "/wallet/reversals",
      reversal,
    ),
    f.owner.ok<{ entry: WalletEntry }>(
      "POST",
      base + "/wallet/reversals",
      reversal,
    ),
  ]);
  assert.deepEqual(reversals[0]!.entry, reversals[1]!.entry);
  assert.equal(reversals[0]!.entry.referenceId, entry.id);
  assert.equal(reversals[0]!.entry.points, "-" + award.points);
  assert.equal((await balance()).points, "0");
  assert.equal(
    (
      await f.owner.request("POST", base + "/wallet/reversals", {
        ...reversal,
        idempotencyKey: randomUUID(),
      })
    ).status,
    409,
    "An original reward has at most one inverse",
  );
  const ledger = await f.owner.ok<WalletDirectory>("GET", walletPath);
  assert.equal(ledger.total, 2);
  assert.equal(
    ledger.items.find((row) => row.id === entry.id)!.reversedByEntryId,
    reversals[0]!.entry.id,
  );
  const audit = await f.pool.query(
    "SELECT action,before_value,after_value FROM audit_events WHERE company_id=$1 AND action IN ('wallet.award','wallet.reverse') ORDER BY id",
    [company.id],
  );
  assert.equal(audit.rowCount, 2, "Retries do not duplicate audit events");
  assert(audit.rows.every((row) => row.after_value !== null));
  for (const mutation of [
    "UPDATE employee_wallet_entries SET reason='tampered' WHERE id=$1",
    "DELETE FROM employee_wallet_entries WHERE id=$1",
  ]) {
    await assert.rejects(
      f.pool.query(mutation, [entry.id]),
      (error: { code?: string }) => error.code === "23514",
    );
  }
  await assert.rejects(
    f.pool.query(
      "UPDATE employee_wallets SET points=-1 WHERE company_id=$1 AND employee_id=$2",
      [company.id, staff.employee.id],
    ),
    (error: { code?: string }) => error.code === "23514",
  );

  // An audit failure rolls back both the ledger and its cached balance.
  await f.pool.query(
    "CREATE FUNCTION reject_wallet_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='wallet.award' THEN RAISE EXCEPTION 'isolated audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER wallet_audit_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_wallet_audit()",
  );
  const failed = { ...award, points: "25", idempotencyKey: randomUUID() };
  assert.equal(
    (await f.owner.request("POST", base + "/wallet/awards", failed)).status,
    500,
  );
  await f.pool.query("DROP TRIGGER wallet_audit_failure ON audit_events");
  assert.equal((await balance()).points, "0");
  assert.equal((await f.owner.ok<WalletDirectory>("GET", walletPath)).total, 2);

  await f.owner.ok("PUT", "/page-catalog/company.wallet/settings", {
    companyId: company.id,
    visible: true,
    enabled: false,
    order: 100,
    revision: null,
  });
  const retried = await f.owner.ok<{ entry: WalletEntry }>(
    "POST",
    base + "/wallet/awards",
    award,
  );
  assert.equal(retried.entry.id, entry.id);
  assert.equal(retried.entry.points, award.points);
  assert.deepEqual(
    await f.owner.ok("POST", base + "/wallet/reversals", reversal),
    reversals[0],
  );
  assert.equal(
    (
      await f.owner.request("POST", base + "/wallet/awards", {
        ...award,
        idempotencyKey: randomUUID(),
      })
    ).status,
    403,
    "Disabling the page blocks new rewards but confirms accepted requests",
  );
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::integer AS total FROM employee_wallet_entries WHERE company_id=$1",
        [company.id],
      )
    ).rows[0]!.total,
    2,
  );
});

test("wallet access is self-only unless general, company isolated and reward tasks remain guarded", async (t) => {
  const f = await fixture(t);
  const company = await f.company("Scoped wallet company");
  const other = await f.company("Foreign wallet company");
  const staff = await f.staff(company.id, "Own employee");
  const peer = await f.staff(company.id, "Peer employee");
  const foreign = await f.staff(other.id, "Foreign employee");
  const base = "/companies/" + company.id,
    otherBase = "/companies/" + other.id;
  const { employee: otherEmployee } = await f.owner.ok<{ employee: Employee }>(
    "POST",
    otherBase + "/employees",
    {
      userId: staff.user.id,
      name: "Own employee in another company",
      phone: "",
      role: "employee",
      active: true,
      permissions: [],
    },
    201,
  );
  const award = {
    employeeId: staff.employee.id,
    points: "20",
    reason: "مكافأة شركة واحدة",
    idempotencyKey: randomUUID(),
  };
  const { entry } = await f.owner.ok<{ entry: WalletEntry }>(
    "POST",
    base + "/wallet/awards",
    award,
  );
  const own = await staff.client.ok<WalletDirectory>("GET", base + "/wallet");
  assert.equal(own.wallet!.points, "20");
  assert.equal(own.wallet!.employeeId, staff.employee.id);
  assert.equal(own.canManage, false);
  assert.equal(own.items.length, 1);
  assert(own.employees.every((row) => row.id === staff.employee.id));
  assert.equal(
    (
      await staff.client.ok<{ wallet: WalletSummary | null }>(
        "GET",
        base + "/wallet/summary",
      )
    ).wallet!.points,
    "20",
  );
  assert.equal(
    (
      await staff.client.ok<{ wallet: WalletSummary | null }>(
        "GET",
        otherBase + "/wallet/summary",
      )
    ).wallet!.points,
    "0",
  );
  assert.equal(
    (await staff.client.ok<WalletDirectory>("GET", otherBase + "/wallet"))
      .wallet!.employeeId,
    otherEmployee.id,
  );
  assert.equal(
    (await peer.client.ok<WalletDirectory>("GET", base + "/wallet")).total,
    0,
  );
  assert.equal(
    (
      await staff.client.request(
        "GET",
        base + "/wallet?employeeId=" + peer.employee.id,
      )
    ).status,
    403,
  );
  assert.equal(
    (await foreign.client.request("GET", base + "/wallet")).status,
    403,
  );
  assert.equal(
    (await staff.client.request("POST", base + "/wallet/awards", award)).status,
    403,
  );
  assert.equal(
    (
      await f.owner.request("POST", base + "/wallet/awards", {
        ...award,
        employeeId: foreign.employee.id,
        idempotencyKey: randomUUID(),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.owner.request("POST", otherBase + "/wallet/reversals", {
        entryId: entry.id,
        reason: "مرجع شركة أخرى",
        idempotencyKey: randomUUID(),
      })
    ).status,
    404,
  );
  const directory = await f.owner.ok<RewardTaskDirectory>(
    "GET",
    base + "/reward-tasks",
  );
  assert.equal(directory.tasks.length, 8);
  assert(directory.tasks.every((row) => !row.enabled));
  assert.deepEqual(
    directory.tasks.filter((row) => row.implemented).map((row) => row.code).sort(),
    ["DAILY_LOGIN", "PAGE_VISIT", "PAYMENT_PRINT", "PURCHASE_LINES", "PURCHASE_SAVED", "RECEIPT_PRINT", "SALE_LINES", "SALE_SAVED"],
  );
  assert.equal(
    (await staff.client.request("GET", base + "/reward-tasks")).status,
    403,
  );
  const task = directory.tasks.find((row) => row.code === "PAGE_VISIT")!;
  const foreignRole = (
    await f.owner.ok<{ role: { id: number } }>(
      "POST",
      otherBase + "/configuration/roles",
      { key: "foreign-wallet-role", name: "Foreign role", description: "" },
      201,
    )
  ).role;
  for (const invalid of [
    { enabled: true },
    { roleIds: [foreignRole.id] },
    { pageKey: "public.dashboard" },
    { pageKey: "company.nonexistent" },
  ]) {
    assert.equal(
      (
        await f.owner.request("PUT", base + "/reward-tasks/PAGE_VISIT", {
          ...taskSettings(task),
          ...invalid,
        })
      ).status,
      400,
    );
  }
  await f.owner.ok("PUT", base + "/reward-tasks/PAGE_VISIT", {
    ...taskSettings(task),
    points: "3",
    pageKey: "company.items",
    repeatRule: "rolling-seven-days",
  });
  assert.equal(
    (
      await f.owner.request(
        "PUT",
        base + "/reward-tasks/PAGE_VISIT",
        taskSettings(task),
      )
    ).status,
    409,
  );
  const saved = (
    await f.owner.ok<RewardTaskDirectory>("GET", base + "/reward-tasks")
  ).tasks.find((row) => row.code === task.code)!;
  assert.equal(saved.points, "3");
  assert.equal(saved.pageKey, "company.items");
  assert.equal(saved.enabled, false);
  await f.owner.ok("PUT", base + "/configuration/employee-rules", {
    employeeId: staff.employee.id,
    permissionKey: "company.wallet:view",
    effect: "deny",
    revision: null,
  });
  assert.equal(
    (await staff.client.request("GET", base + "/wallet")).status,
    403,
  );
  assert.equal(
    (await staff.client.request("GET", base + "/wallet/summary")).status,
    403,
  );
  assert.equal(
    (await staff.client.request("GET", otherBase + "/wallet")).status,
    200,
  );
  await f.owner.ok(
    "PATCH",
    base + "/employees/" + peer.employee.id + "/manager",
    { isGeneralManager: true },
  );
  assert.equal(
    (
      await peer.client.ok<WalletDirectory>(
        "GET",
        base + "/wallet?employeeId=" + staff.employee.id,
      )
    ).canManage,
    true,
  );
  await f.owner.ok(
    "PATCH",
    base + "/employees/" + peer.employee.id + "/manager",
    { isGeneralManager: false },
  );
  assert.equal(
    (
      await peer.client.request(
        "GET",
        base + "/wallet?employeeId=" + staff.employee.id,
      )
    ).status,
    403,
  );
  await f.owner.ok("PATCH", base + "/employees/" + staff.employee.id, {
    active: false,
  });
  assert.equal(
    (await staff.client.request("GET", base + "/wallet")).status,
    403,
  );
  assert.equal(
    (
      await f.owner.request("POST", base + "/wallet/awards", {
        ...award,
        idempotencyKey: randomUUID(),
      })
    ).status,
    400,
  );
  assert.equal(
    (await staff.client.request("GET", otherBase + "/wallet")).status,
    200,
  );
  await f.owner.ok("PATCH", "/users/" + staff.user.id, { archived: true });
  assert.equal(
    (await staff.client.request("GET", otherBase + "/wallet")).status,
    401,
  );
});


test("company page-visit rewards require an admitted configured page, role and time-window", async (t) => {
  const f = await fixture(t), co = await f.company("Page points company");
  const staff = await f.staff(co.id, "Page visitor");
  const peer = await f.staff(co.id, "Peer visitor");
  const base = "/companies/" + co.id;
  const wallet = async (id: number) =>
    f.owner.ok<WalletDirectory>("GET", base + "/wallet?employeeId=" + id);
  const visit = async (client: Client, pageKey = "company.wallet") =>
    client.ok<{ rewarded: boolean }>("POST", base + "/reward-events/page-visit", {
      pageKey, idempotencyKey: randomUUID(),
    });
  const task = (await f.owner.ok<RewardTaskDirectory>("GET", base + "/reward-tasks"))
    .tasks.find((row) => row.code === "PAGE_VISIT")!;
  assert.equal(task.implemented, true);
  assert.equal(task.enabled, false);
  assert.equal((await visit(staff.client)).rewarded, false);
  assert.equal((await wallet(staff.employee.id)).wallet?.points, "0");
  for (const invalid of [
    { enabled: true, points: "2", pageKey: null, repeatRule: "daily" },
    { enabled: true, points: "0", pageKey: "company.wallet", repeatRule: "daily" },
    { enabled: true, points: "2", pageKey: "company.wallet", repeatRule: "per-document" },
  ]) {
    assert.equal((await f.owner.request("PUT", base + "/reward-tasks/PAGE_VISIT", {
      ...taskSettings(task), ...invalid,
    })).status, 400);
  }
  const role = (await f.pool.query<{ id: number }>(
    "SELECT id FROM company_roles WHERE company_id=$1 AND key='employee'",
    [co.id],
  )).rows[0]!;
  await f.owner.ok("PUT", base + "/reward-tasks/PAGE_VISIT", {
    ...taskSettings(task),
    points: "4", enabled: true, repeatRule: "daily",
    roleIds: [role.id], pageKey: "company.wallet", dailyLimit: null,
  });
  assert.equal((await visit(staff.client)).rewarded, false, "Unassigned role denies reward");
  await f.pool.query(
    "INSERT INTO employee_role_assignments(company_id,employee_id,role_id,active) VALUES($1,$2,$3,true)",
    [co.id, staff.employee.id, role.id],
  );
  assert.equal((await visit(staff.client, "company.accounts")).rewarded, false, "Only configured page");
  const acceptedVisit = { pageKey: "company.wallet", idempotencyKey: randomUUID() };
  const first = await staff.client.ok<{ rewarded: boolean }>(
    "POST", base + "/reward-events/page-visit", acceptedVisit,
  );
  assert.equal(first.rewarded, true);
  assert.equal((await staff.client.ok<{ rewarded: boolean }>(
    "POST", base + "/reward-events/page-visit", acceptedVisit,
  )).rewarded, false, "An accepted event retry never adds points again");
  for (const [client, input] of [
    [staff.client, { ...acceptedVisit, pageKey: "company.accounts" }],
    [peer.client, acceptedVisit],
  ] as const) {
    const replay = await client.request<{ error: { code: string } }>(
      "POST", base + "/reward-events/page-visit", input,
    );
    assert.equal(replay.status, 409, "An accepted UUID cannot change actor or target page");
    assert.equal(replay.body.error.code, "idempotency_conflict");
  }
  assert.equal((await wallet(staff.employee.id)).wallet?.points, "4");
  assert.equal((await visit(staff.client)).rewarded, false, "Daily repeat in Asia/Aden blocked");
  assert.equal((await wallet(staff.employee.id)).items[0]!.pageKey, "company.wallet");
  assert.equal((await wallet(peer.employee.id)).wallet?.points, "0");

  const task2 = (await f.owner.ok<RewardTaskDirectory>("GET", base + "/reward-tasks"))
    .tasks.find((row) => row.code === "PAGE_VISIT")!;
  await f.owner.ok("PUT", base + "/reward-tasks/PAGE_VISIT", {
    ...taskSettings(task2), repeatRule: "rolling-seven-days", roleIds: [],
  });
  assert.equal((await visit(peer.client)).rewarded, true, "Independent employee wallet");
  assert.equal((await visit(peer.client)).rewarded, false, "Rolling seven days blocks repeat");
  assert.equal((await visit(staff.client)).rewarded, false, "Previous daily event counts for rolling window");

  const task3 = (await f.owner.ok<RewardTaskDirectory>("GET", base + "/reward-tasks"))
    .tasks.find((row) => row.code === "PAGE_VISIT")!;
  await f.owner.ok("PUT", base + "/reward-tasks/PAGE_VISIT", {
    ...taskSettings(task3), repeatRule: "unlimited", dailyLimit: 2,
  });
  const third = await f.staff(co.id, "Unlimited visitor");
  assert.equal((await visit(third.client)).rewarded, true);
  assert.equal((await visit(third.client)).rewarded, false, "Distinct immediate request is throttled");
  assert.equal((await wallet(third.employee.id)).wallet?.points, "4");
  assert.equal((await wallet(staff.employee.id)).wallet?.money, "0");
});

test("daily company entry rewards are opt-in, scoped, role-limited and once per Aden day", async (t) => {
  const f = await fixture(t);
  const first = await f.company("First daily entry company");
  const second = await f.company("Second daily entry company");
  const staff = await f.staff(first.id, "Daily staff");
  const peer = await f.staff(first.id, "Other company member");
  const { employee: secondEmployee } = await f.owner.ok<{ employee: Employee }>(
    "POST", `/companies/${second.id}/employees`,
    { userId: staff.user.id, name: "Same staff second company", phone: "",
      role: "employee", active: true, permissions: [] }, 201,
  );
  const firstBase = `/companies/${first.id}`;
  const secondBase = `/companies/${second.id}`;
  const task = (await f.owner.ok<RewardTaskDirectory>(
    "GET", firstBase + "/reward-tasks"
  )).tasks.find((item) => item.code === "DAILY_LOGIN")!;
  assert.equal(task.enabled, false);
  assert.equal(task.implemented, true);
  assert.equal(task.repeatRule, "daily");
  await staff.client.ok("POST", firstBase + "/activate");
  assert.equal(
    (await f.owner.ok<WalletDirectory>(
      "GET", firstBase + "/wallet?employeeId=" + staff.employee.id
    )).wallet?.points, "0", "An inactive task does not pay on entry",
  );
  for (const invalid of [
    { repeatRule: "unlimited", enabled: true, points: "50" },
    { repeatRule: "daily", enabled: true, points: "0" },
  ]) {
    assert.equal((await f.owner.request(
      "PUT", firstBase + "/reward-tasks/DAILY_LOGIN", {
        ...taskSettings(task), ...invalid,
      }
    )).status, 400);
  }
  const role = (await f.pool.query<{ id: number }>(
    "SELECT id FROM company_roles WHERE company_id=$1 AND key='employee'",
    [first.id],
  )).rows[0]!;
  await f.owner.ok("PUT", firstBase + "/reward-tasks/DAILY_LOGIN", {
    ...taskSettings(task),
    points: "50", enabled: true, repeatRule: "daily", roleIds: [role.id],
  });
  await staff.client.ok("POST", firstBase + "/activate");
  assert.equal((await f.owner.ok<WalletDirectory>(
    "GET", firstBase + "/wallet?employeeId=" + staff.employee.id,
  )).wallet?.points, "0", "Unassigned roles receive no points");
  await f.pool.query(
    "INSERT INTO employee_role_assignments(company_id,employee_id,role_id,active) VALUES($1,$2,$3,true)",
    [first.id, staff.employee.id, role.id],
  );
  await Promise.all(
    Array.from({ length: 4 }, () =>
      staff.client.ok("POST", firstBase + "/activate")
    ),
  );
  const earned = await f.owner.ok<WalletDirectory>(
    "GET", firstBase + "/wallet?employeeId=" + staff.employee.id,
  );
  assert.equal(earned.wallet?.points, "50");
  assert.equal(earned.total, 1, "Concurrent tabs must not create duplicate rewards");
  assert.equal(earned.items[0]?.taskCode, "DAILY_LOGIN");
  assert.equal(earned.items[0]?.logicalLineCount, 1);
  assert.equal(earned.items[0]?.money, "0");
  await staff.client.ok("POST", firstBase + "/activate");
  await f.owner.ok("PUT", firstBase + "/reward-tasks/DAILY_LOGIN", {
    ...taskSettings((await f.owner.ok<RewardTaskDirectory>(
      "GET", firstBase + "/reward-tasks",
    )).tasks.find((item) => item.code === "DAILY_LOGIN")!),
    points: "80", enabled: true, roleIds: [],
  });
  await staff.client.ok("POST", firstBase + "/activate");
  const unchanged = await f.owner.ok<WalletDirectory>(
    "GET", firstBase + "/wallet?employeeId=" + staff.employee.id,
  );
  assert.equal(unchanged.wallet?.points, "50", "Changing task points never alters an earned day");
  assert.equal(unchanged.total, 1, "Re-entering company the same day is not a new event");
  assert.equal((await f.owner.ok<WalletDirectory>(
    "GET", firstBase + "/wallet?employeeId=" + peer.employee.id,
  )).wallet?.points, "0");

  await staff.client.ok("POST", secondBase + "/activate");
  assert.equal((await f.owner.ok<WalletDirectory>(
    "GET", secondBase + "/wallet?employeeId=" + secondEmployee.id,
  )).wallet?.points, "0", "One company's settings never pay another company");
  const otherTask = (await f.owner.ok<RewardTaskDirectory>(
    "GET", secondBase + "/reward-tasks",
  )).tasks.find((item) => item.code === "DAILY_LOGIN")!;
  await f.owner.ok("PUT", secondBase + "/reward-tasks/DAILY_LOGIN", {
    ...taskSettings(otherTask), enabled: true, points: "7", roleIds: [],
  });
  await staff.client.ok("POST", secondBase + "/activate");
  assert.equal((await f.owner.ok<WalletDirectory>(
    "GET", secondBase + "/wallet?employeeId=" + secondEmployee.id,
  )).wallet?.points, "7", "Only the entered company receives its configured reward");
  assert.equal((await f.owner.ok<WalletDirectory>(
    "GET", firstBase + "/wallet?employeeId=" + staff.employee.id,
  )).wallet?.points, "50");
  assert.equal(
    (await peer.client.request("POST", secondBase + "/activate")).status,
    403,
  );
});


test("pledge creation uses account 1120, persists limit, and awards staff only once", async t => {
  const f=await fixture(t);
  const company=await f.company("Pledge test company");
  const employee=await f.staff(company.id,"Pledge cashier");
  const base=`/companies/${company.id}`;
  await f.pool.query("UPDATE employees SET permissions=ARRAY['commerce.view','commerce.manage','accounts.view']::text[] WHERE company_id=$1 AND id=$2",[company.id,employee.employee.id]);
  const input={
    idempotencyKey:randomUUID(), customerName:"محمد محمد صلاح قاسم",
    phone:"770731624", collateral:"خاتم ذهب", durationDays:2, limit:"12000",
  };
  const first=await employee.client.ok<{account:{id:number;code:string;accountChoice:string;accountLimit:string;ownerPhone:string;name:string};awardedPoints:number}>(
    "POST",base+"/pledges",input,201
  );
  assert.equal(first.account.accountChoice,"pledges");
  assert.match(first.account.code,/^1120[0-9]{6}$/);
  assert.equal(Number(first.account.accountLimit),12000);
  assert.equal(first.account.ownerPhone,input.phone);
  assert.match(first.account.name,/خاتم ذهب/);
  assert.equal(first.awardedPoints,50);
  const repeated=await employee.client.ok<{account:{id:number};awardedPoints:number}>(
    "POST",base+"/pledges",input,200
  );
  assert.equal(repeated.account.id,first.account.id);
  assert.equal(repeated.awardedPoints,50);
  const list=await employee.client.ok<{items:{accountId:number;phone:string}[]}>("GET",base+"/pledges?q=خاتم");
  assert.equal(list.items.length,1);
  assert.equal(list.items[0]?.phone,input.phone);
  const wallet=await f.owner.ok<WalletDirectory>("GET",base+"/wallet?employeeId="+employee.employee.id);
  assert.equal(wallet.wallet?.points,"50");
  await employee.client.ok<{account:{accountLimit:string}}>("PATCH",base+"/accounts/"+first.account.id,{accountLimit:"15000"});
  const updated=await employee.client.ok<{account:{accountLimit:string}}>("GET",base+"/accounts/"+first.account.id);
  assert.equal(Number(updated.account.accountLimit),15000);
  const count=await f.pool.query(
    "SELECT count(*)::integer AS n FROM employee_wallet_entries WHERE company_id=$1 AND pledge_account_id=$2",
    [company.id,first.account.id]
  );
  assert.equal(count.rows[0]?.n,1);
});
