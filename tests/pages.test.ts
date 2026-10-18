import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";
import {
  pageDefinitions,
  pageKeyForLocation,
  type Company,
  type Employee,
  type Item,
  type PageDirectory,
  type PageEntry,
  type Permission,
  type ResolvedPage,
  type SessionResponse,
} from "../packages/contracts/src/index.ts";

// Disposable PostgreSQL schemas and declared fake credentials only.
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const password = "Page-directory-test-password-2026",
  origin = "http://localhost";
class Client {
  cookie = "";
  csrf: string | null = null;
  constructor(readonly baseUrl: string) {}
  async request<T>(method: string, path: string, body?: unknown) {
    const response = await fetch(this.baseUrl + "/api" + path, {
      method,
      headers: {
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
    for (const cookie of response.headers.getSetCookie())
      this.cookie = cookie.split(";")[0]!;
    const result = (await response.json()) as T;
    if (result && typeof result === "object" && "csrf" in result)
      this.csrf = (result as unknown as SessionResponse).csrf;
    return { status: response.status, body: result };
  }
  async ok<T>(
    method: string,
    path: string,
    body?: unknown,
    expected = 200,
  ): Promise<T> {
    const response = await this.request<T>(method, path, body);
    assert.equal(
      response.status,
      expected,
      path + ": " + JSON.stringify(response.body),
    );
    return response.body;
  }
}
async function fixture(t: TestContext) {
  const schema = "page_test_" + randomUUID().replaceAll("-", "");
  const runtime = await createApp({
    databaseUrl,
    schema,
    appOrigin: origin,
    production: false,
    serveStatic: false,
  });
  const server = runtime.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.close();
    const cleanup = new Pool({ connectionString: databaseUrl });
    try {
      await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await cleanup.end();
    }
  });
  const ownerUser = await provisionOwner(runtime.pool, {
    name: "Page test owner",
    displayName: "Owner",
    email: "owner@pages.test",
    password,
  });
  const owner = new Client(baseUrl);
  await owner.ok("POST", "/auth/login", { email: ownerUser.email, password });
  const company = async (name = "Page company") =>
    (
      await owner.ok<{ company: Company }>(
        "POST",
        "/companies",
        { name, phone: "", address: "" },
        201,
      )
    ).company;
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
        name: "Catalog employee",
        displayName: "Employee",
        email: `employee${index}@pages.test`,
        phone: "",
        password,
      },
      201,
    );
    const employee = (
      await owner.ok<{ employee: Employee }>(
        "POST",
        `/companies/${companyId}/employees`,
        {
          userId: session.user!.id,
          name: "Employee",
          phone: "",
          role: "employee",
          active: true,
          permissions,
        },
        201,
      )
    ).employee;
    return { client, employee, user: session.user! };
  }
  async function settings(
    client: Client,
    key: string,
    companyId: number | null,
    values: Partial<{
      visible: boolean;
      enabled: boolean;
      order: number;
      revision: number | null;
    }> = {},
  ) {
    return client.request<{ page: PageEntry }>(
      "PUT",
      `/page-catalog/${key}/settings`,
      {
        companyId,
        visible: true,
        enabled: true,
        order: 100,
        revision: null,
        ...values,
      },
    );
  }
  const entries = (client: Client, companyId?: number, extra = "") =>
    client.ok<PageDirectory>(
      "GET",
      `/page-catalog?pageSize=100${companyId ? `&companyId=${companyId}` : ""}${extra}`,
    );
  async function itemInput(companyId: number) {
    let currency = (
      await owner.ok<{ items: { id: number }[] }>(
        "GET",
        `/companies/${companyId}/currencies`,
      )
    ).items[0];
    if (!currency)
      currency = (
        await owner.ok<{ currency: { id: number } }>(
          "POST",
          `/companies/${companyId}/currencies`,
          { code: "YER", name: "ريال يمني", decimalPlaces: 2 },
          201,
        )
      ).currency;
    return {
      idempotencyKey: randomUUID(),
      name: "Reference item",
      currencyId: currency.id,
      unit1Name: "حبة",
      salePrice1: "10",
      purchasePrice: "7",
    };
  }
  return {
    owner,
    ownerUser,
    company,
    member,
    settings,
    entries,
    itemInput,
    pool: runtime.pool,
    baseUrl,
  };
}

test("letterhead is a dedicated company page without company.edit and owner-only upload remains protected", async (t) => {
  const f=await fixture(t);
  const company=await f.company("Standalone company letterhead");
  const other=await f.company("Unrelated company");
  const staff=await f.member(company.id,[],35);
  const registry=await f.pool.query(
    "SELECT key FROM permission_definitions WHERE page_key='company.letterhead'",
  );
  assert.deepEqual(registry.rows.map(row=>row.key),["company.letterhead:view"]);
  const directory=await f.entries(staff.client,company.id);
  const entry=directory.items.find(item=>item.key==="company.letterhead");
  assert(entry);
  assert.equal(entry.href,`/companies/${company.id}/letterhead`);
  assert.equal(entry.actionAccess.view,true);
  assert.equal(entry.navigation,true);
  const old=directory.items.find(item=>item.key==="company.settings");
  assert(old);
  assert.equal(old.actionAccess.view,false,"No implicit company.edit for staff");
  assert.equal(
    (await staff.client.ok<{mediaId:string|null}>(
      "GET",`/companies/${company.id}/letterhead`,
    )).mediaId,null,
  );
  assert.equal((await staff.client.request("GET",`/companies/${other.id}/letterhead`)).status,403);
  assert.equal((await staff.client.request("PUT",`/companies/${company.id}/letterhead`,{mediaId:null})).status,403);
  const ownerEntry=(await f.entries(f.owner,company.id)).items.find(item=>item.key==="company.letterhead");
  assert.equal(ownerEntry?.actionAccess.view,true);
  assert.equal((await f.owner.request("GET",`/companies/${company.id}/letterhead`)).status,200);
});

test("page registry covers stable actual routes, Arabic search, reports, pagination and independent action permissions", async (t) => {
  const f = await fixture(t),
    company = await f.company();
  assert.equal(
    new Set(pageDefinitions.map((page) => page.key)).size,
    pageDefinitions.length,
  );
  assert.deepEqual(
    (await f.pool.query("SELECT key FROM page_registry ORDER BY key")).rows.map(
      (row) => row.key,
    ),
    pageDefinitions.map((page) => page.key).sort(),
  );
  assert.equal(
    pageKeyForLocation(
      `/companies/${company.id}/invoices/new`,
      "?kind=purchase",
    ),
    "company.purchase-new",
  );
  assert.equal(
    pageKeyForLocation(`/companies/${company.id}/items/new`, ""),
    "company.item-new",
  );
  assert.equal(
    pageKeyForLocation(`/companies/${company.id}/items/123`, ""),
    "company.item-card",
  );
  const clerk = await f.member(company.id, ["commerce.view"]);
  const directory = await f.entries(clerk.client, company.id);
  const sale = directory.items.find((page) => page.key === "company.sales")!;
  assert(sale.visible && sale.enabled && sale.actionAccess.view);
  assert.equal(sale.actionAccess.create, false);
  assert.deepEqual(sale.actions.create!.permissions, [
    "commerce.manage",
    "finance.post",
  ]);
  const invoice = directory.items.find(
    (page) => page.key === "company.invoice",
  )!;
  assert(invoice.actionAccess.print);
  assert.equal(invoice.actions.edit, undefined);
  const results = await f.entries(
    f.owner,
    company.id,
    "&q=" + encodeURIComponent("الأَصْناف"),
  );
  assert(results.items.some((page) => page.key === "company.items"));
  const reports = await f.entries(f.owner, company.id, "&type=report");
  assert(reports.total >= 4);
  assert(reports.items.every((page) => page.type === "report"));
  const first = await f.owner.ok<PageDirectory>(
    "GET",
    `/page-catalog?companyId=${company.id}&pageSize=10&sort=section:asc,name:desc`,
  );
  const second = await f.owner.ok<PageDirectory>(
    "GET",
    `/page-catalog?companyId=${company.id}&pageSize=10&page=2&sort=section:asc,name:desc`,
  );
  assert.equal(first.items.length, 10);
  assert.equal(second.items.length, 10);
  assert(
    !first.items.some((page) =>
      second.items.some((next) => next.key === page.key),
    ),
  );
  for (const suffix of [
    "&status=unexpected",
    "&sort=unknown:asc",
    "&pageSize=101",
    "&section=unknown",
  ])
    assert.equal(
      (await f.owner.request("GET", "/page-catalog?" + suffix.slice(1))).status,
      400,
    );
});

test("page management or visibility grants never authorize company data, mutations or another company's metadata", async (t) => {
  const f = await fixture(t),
    company = await f.company(),
    other = await f.company("Other company");
  const manager = await f.member(company.id, ["pages.manage"]);
  assert.equal(
    (await f.settings(manager.client, "company.items", company.id)).status,
    200,
  );
  const page = (await f.entries(manager.client, company.id)).items.find(
    (page) => page.key === "company.items",
  )!;
  assert(page.visible && page.enabled && page.canConfigure);
  assert.equal(page.actionAccess.view, false);
  assert.equal(
    (await manager.client.request("GET", `/companies/${company.id}/items`))
      .status,
    403,
  );
  assert.equal(
    (
      await manager.client.request(
        "POST",
        `/companies/${company.id}/items`,
        await f.itemInput(company.id),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await manager.client.request(
        "GET",
        `/page-catalog/company.items/resolve?companyId=${company.id}`,
      )
    ).status,
    403,
  );
  assert.equal(
    (await manager.client.request("GET", `/page-catalog?companyId=${other.id}`))
      .status,
    403,
  );
  assert.equal(
    (await f.settings(manager.client, "company.items", other.id)).status,
    403,
  );
  assert.equal(
    (await f.settings(manager.client, "public.users", null)).status,
    403,
  );
  assert.equal(
    (await f.settings(f.owner, "public.users", company.id)).status,
    400,
  );
});

test("hidden pages retain authorized direct access while disabled pages block all data routes and new actions within their scope", async (t) => {
  const f = await fixture(t),
    a = await f.company(),
    b = await f.company("B");
  const member = await f.member(a.id, ["items.view", "commerce.view"]);
  const hide = await f.settings(f.owner, "company.items", a.id, {
    visible: false,
  });
  assert.equal(hide.status, 200);
  const directory = await f.entries(member.client, a.id),
    item = directory.items.find((page) => page.key === "company.items")!;
  assert.equal(item.visible, false);
  assert(item.enabled && item.actionAccess.view);
  assert.equal(
    (await member.client.request("GET", `/companies/${a.id}/items`)).status,
    200,
  );
  assert.equal(
    (
      await member.client.request(
        "GET",
        `/page-catalog/company.items/resolve?companyId=${a.id}`,
      )
    ).status,
    200,
  );
  const disable = await f.settings(f.owner, "company.items", a.id, {
    visible: false,
    enabled: false,
    revision: hide.body.page.revision,
  });
  assert.equal(disable.status, 200);
  for (const route of [
    "items",
    "item-options?type=currencies",
    "commerce-options?type=items",
  ])
    assert.equal(
      (await member.client.request("GET", `/companies/${a.id}/${route}`))
        .status,
      403,
    );
  assert.equal(
    (
      await f.owner.request(
        "POST",
        `/companies/${a.id}/items`,
        await f.itemInput(a.id),
      )
    ).status,
    403,
  );
  assert.equal(
    (await f.owner.request("GET", `/companies/${b.id}/items`)).status,
    200,
  );
  const current = (await f.entries(f.owner, a.id)).items.find(
    (page) => page.key === "company.item-new",
  )!;
  assert.equal(current.enabled, false);
  const history = (
    await f.pool.query(
      "SELECT before_value,after_value FROM audit_events WHERE action='page.settings' AND company_id=$1 ORDER BY id",
      [a.id],
    )
  ).rows;
  assert.equal(history.length, 2);
  assert.equal(history[0].before_value, null);
  assert.equal(history[1].before_value.visible, false);
  assert.equal(history[1].after_value.enabled, false);
});

test("global disables cannot be overridden by company settings and essential access pages stay protected", async (t) => {
  const f = await fixture(t),
    a = await f.company();
  assert.equal(
    (await f.settings(f.owner, "company.accounts", null, { enabled: false }))
      .status,
    200,
  );
  assert.equal(
    (await f.settings(f.owner, "company.accounts", a.id)).status,
    200,
  );
  const page = (await f.entries(f.owner, a.id)).items.find(
    (page) => page.key === "company.accounts",
  )!;
  assert(page.configuredEnabled);
  assert.equal(page.enabled, false);
  assert.equal(page.globalEnabled, false);
  assert.equal(
    (await f.owner.request("GET", `/companies/${a.id}/accounts`)).status,
    403,
  );
  for (const key of [
    "public.login",
    "public.companies",
    "public.pages",
    "company.pages",
    "company.overview",
  ])
    assert.equal(
      (
        await f.settings(
          f.owner,
          key,
          key.startsWith("company") ? a.id : null,
          { enabled: false },
        )
      ).status,
      403,
    );
  assert.equal(
    (
      await f.settings(f.owner, "company.financial-documents", a.id, {
        enabled: false,
      })
    ).status,
    200,
  );
  const child = (await f.entries(f.owner, a.id)).items.find(
    (page) => page.key === "company.journals",
  )!;
  assert.equal(child.enabled, false);
});

test("stable references validate actual record ownership, required identifiers and current permissions before resolving", async (t) => {
  const f = await fixture(t),
    a = await f.company(),
    b = await f.company("B"),
    input = await f.itemInput(a.id);
  const item = (
    await f.owner.ok<{ item: Item }>(
      "POST",
      `/companies/${a.id}/items`,
      input,
      201,
    )
  ).item;
  const member = await f.member(a.id, ["items.view"]);
  const resolved = await member.client.ok<ResolvedPage>(
    "GET",
    `/page-catalog/company.item-card/resolve?companyId=${a.id}&recordId=${item.id}`,
  );
  assert.equal(resolved.href, `/companies/${a.id}/items/${item.id}`);
  assert.deepEqual(resolved.reference, {
    pageKey: "company.item-card",
    companyId: a.id,
    recordId: item.id,
  });
  assert.equal(
    (
      await f.owner.request(
        "GET",
        `/page-catalog/company.item-card/resolve?companyId=${b.id}&recordId=${item.id}`,
      )
    ).status,
    404,
  );
  for (const query of [
    `company.items/resolve?companyId=${a.id}&recordId=1`,
    "company.items/resolve",
    `company.item-card/resolve?companyId=${a.id}`,
    `public.profile/resolve?companyId=${a.id}`,
  ])
    assert.equal(
      (await f.owner.request("GET", "/page-catalog/" + query)).status,
      400,
    );
  assert.equal(
    (
      await f.owner.request(
        "GET",
        "/page-catalog/company.unknown/resolve?companyId=" + a.id,
      )
    ).status,
    404,
  );
  await f.owner.ok(
    "PATCH",
    `/companies/${a.id}/employees/${member.employee.id}`,
    { permissions: [] },
  );
  assert.equal(
    (
      await member.client.request(
        "GET",
        `/page-catalog/company.item-card/resolve?companyId=${a.id}&recordId=${item.id}`,
      )
    ).status,
    403,
  );
});

test("page settings serialize concurrent initial writes, reject stale revisions and roll back together with audit", async (t) => {
  const f = await fixture(t),
    a = await f.company(),
    manager = await f.member(a.id, ["pages.manage"]);
  const results = await Promise.all([
    f.settings(f.owner, "company.items", a.id),
    f.settings(manager.client, "company.items", a.id, { visible: false }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::int AS count FROM audit_events WHERE action='page.settings'",
      )
    ).rows[0].count,
    1,
  );
  await f.pool.query(
    `CREATE FUNCTION reject_page_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='page.settings' THEN RAISE EXCEPTION 'test rejects page audit'; END IF; RETURN NEW; END $$`,
  );
  await f.pool.query(
    "CREATE TRIGGER fail_page_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_page_audit()",
  );
  const revision = (await f.entries(f.owner, a.id)).items.find(
    (page) => page.key === "company.items",
  )!.revision;
  assert.equal(
    (
      await f.settings(f.owner, "company.items", a.id, {
        enabled: false,
        revision,
      })
    ).status,
    500,
  );
  const after = (await f.entries(f.owner, a.id)).items.find(
    (page) => page.key === "company.items",
  )!;
  assert.equal(after.revision, revision);
  assert.equal(after.enabled, true);
});

test("queued master creation rechecks a newly disabled page and exact accepted UUID confirmation remains safe", async (t) => {
  const f = await fixture(t),
    a = await f.company();
  const input = await f.itemInput(a.id);
  const existing = (
    await f.owner.ok<{ item: Item }>(
      "POST",
      `/companies/${a.id}/items`,
      input,
      201,
    )
  ).item;
  const worker = await f.member(a.id, ["items.manage"]);
  const blocker = await f.pool.connect();
  let committed = false;
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT key FROM page_registry WHERE key='company.items' FOR UPDATE",
    );
    const pending = worker.client.request("POST", `/companies/${a.id}/items`, {
      ...input,
      idempotencyKey: randomUUID(),
      name: "Queued item",
    });
    const blockerPid = (await blocker.query("SELECT pg_backend_pid() AS pid"))
      .rows[0].pid;
    let waiting = false;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (
        (
          await f.pool.query(
            "SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))",
            [blockerPid],
          )
        ).rowCount
      ) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert(
      waiting,
      "master action must be waiting inside the transaction's page gate",
    );
    await blocker.query(
      "INSERT INTO page_settings(page_key,company_id,visible,enabled,sort_order,updated_by) VALUES('company.items',NULL,true,false,100,$1)",
      [f.ownerUser.id],
    );
    await blocker.query("COMMIT");
    committed = true;
    assert.equal((await pending).status, 403);
    const retry = await f.owner.ok<{ item: Item }>(
      "POST",
      `/companies/${a.id}/items`,
      input,
      200,
    );
    assert.equal(retry.item.id, existing.id);
    assert.equal(
      (
        await f.owner.request("POST", `/companies/${a.id}/items`, {
          ...input,
          name: "Changed retry",
        })
      ).status,
      409,
    );
    assert.equal(
      (await f.pool.query("SELECT count(*)::int AS count FROM items")).rows[0]
        .count,
      1,
    );
  } finally {
    if (!committed) await blocker.query("ROLLBACK");
    blocker.release();
  }
});
