import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { test } from "node:test";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";
import { provisionOwner } from "../apps/api/src/services/auth.ts";

const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const origin = "http://localhost";

test("new companies get mapped salary, reward and commission accounts without financial postings", async (t) => {
  const schema = "operational_accounts_" + randomUUID().replaceAll("-", "");
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
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    await runtime.close();
    const cleanup = new Pool({ connectionString: databaseUrl });
    try { await cleanup.query('DROP SCHEMA "' + schema + '" CASCADE'); }
    finally { await cleanup.end(); }
  });
  const owner = await provisionOwner(runtime.pool, {
    name: "System accounts owner", displayName: "Owner",
    email: "system-accounts@test.example", password: "Strong-accounts-test-passphrase",
  });
  const url = "http://127.0.0.1:" + address.port;
  const login = await fetch(url + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email: owner.email, password: "Strong-accounts-test-passphrase" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
  const { csrf } = await login.json() as { csrf: string };
  const createCompany = async (name: string): Promise<number> => {
    const response = await fetch(url + "/api/companies", {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie, "x-csrf-token": csrf },
      body: JSON.stringify({ name, phone: "", address: "" }),
    });
    const data = await response.json() as { company?: { id: number }; error?: unknown };
    assert.equal(response.status, 201, JSON.stringify(data));
    assert(data.company);
    return data.company.id;
  };
  const first = await createCompany("A");
  const second = await createCompany("B");

  const expected: Record<string, [string, string]> = {
    "1113000000": ["group", "asset"],
    "1140000000": ["group", "asset"],
    "2120000000": ["group", "liability"],
    "2120000001": ["posting", "liability"],
    "2120000002": ["posting", "liability"],
    "2120000003": ["posting", "liability"],
    "2120000004": ["posting", "liability"],
    "5500000000": ["group", "expense"],
    "5500000001": ["posting", "expense"],
    "5500000002": ["posting", "expense"],
    "5500000003": ["posting", "expense"],
    "5500000004": ["posting", "expense"],
    "5500000005": ["posting", "expense"],
    "5600000000": ["group", "expense"],
    "5600000001": ["posting", "expense"],
    "5600000002": ["posting", "expense"],
    "5600000003": ["posting", "expense"],
    "5600000004": ["posting", "expense"],
  };
  const purposes: Record<string, string> = {
    salaryExpense: "5500000001", salaryPayable: "2120000001",
    rewardExpense: "5500000002", rewardPayable: "2120000002",
    commissionExpense: "5500000003", commissionPayable: "2120000003",
    allowanceExpense: "5500000004", allowancePayable: "2120000004",
    overtimeExpense: "5500000005",
    operatingRentExpense: "5600000001",
    operatingUtilitiesExpense: "5600000002",
    operatingMaintenanceExpense: "5600000003",
    operatingCommunicationsExpense: "5600000004",
  };
  for (const companyId of [first, second]) {
    const accounts = await runtime.pool.query(
      "SELECT code,kind,category FROM accounts WHERE company_id=$1", [companyId],
    );
    const byCode = new Map(accounts.rows.map((a) => [a.code, [a.kind, a.category]]));
    for (const [code, expectedKindCategory] of Object.entries(expected))
      assert.deepEqual(byCode.get(code), expectedKindCategory, code);
    const links = await runtime.pool.query(
      "SELECT l.purpose,a.code FROM account_links l JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id WHERE l.company_id=$1",
      [companyId],
    );
    const byPurpose = new Map(links.rows.map((row) => [row.purpose, row.code]));
    for (const [purpose, code] of Object.entries(purposes))
      assert.equal(byPurpose.get(purpose), code, purpose);
    const policy = await runtime.pool.query(
      `SELECT p.revision,p.point_value,p.approval_mode,p.currency_id,
                a.code AS expense_code,c.code AS currency_code
         FROM wallet_conversion_policies p
         JOIN accounts a ON a.company_id=p.company_id AND a.id=p.expense_account_id
         JOIN company_currencies c ON c.company_id=p.company_id AND c.id=p.currency_id
         WHERE p.company_id=$1`, [companyId],
    );
    assert.equal(policy.rowCount, 1);
    assert.deepEqual({
      revision: policy.rows[0].revision, pointValue: policy.rows[0].point_value,
      approvalMode: policy.rows[0].approval_mode, expense: policy.rows[0].expense_code,
      currency: policy.rows[0].currency_code,
    }, { revision: 1, pointValue: null, approvalMode: null, expense: "5500000002", currency: "YER" });
    assert.equal((await runtime.pool.query(
      "SELECT count(*)::int AS count FROM financial_documents WHERE company_id=$1",
      [companyId],
    )).rows[0].count, 0);
  }

  // Re-running provisioning cannot rewrite the company's chosen mapping or policy.
  await runtime.pool.query(
    `UPDATE account_links SET account_id=(
        SELECT id FROM accounts WHERE company_id=$1 AND code='5500000001'
      ) WHERE company_id=$1 AND purpose='commissionExpense'`,
    [first],
  );
  await runtime.pool.query(
    `UPDATE wallet_conversion_policies SET point_value=0.25,approval_mode='approval',
        expense_account_id=(SELECT id FROM accounts WHERE company_id=$1 AND code='5500000001'),
        revision=revision+1 WHERE company_id=$1`, [first],
  );
  await runtime.pool.query("SELECT ensure_company_operational_accounts($1,$2)", [first, owner.id]);
  const mapped = await runtime.pool.query(
    `SELECT a.code FROM account_links l JOIN accounts a ON a.company_id=l.company_id
      AND a.id=l.account_id WHERE l.company_id=$1 AND l.purpose='commissionExpense'`, [first],
  );
  assert.equal(mapped.rows[0].code, "5500000001");
  const policyAfter = await runtime.pool.query(
    `SELECT revision,point_value::text,approval_mode FROM wallet_conversion_policies WHERE company_id=$1`,
    [first],
  );
  assert.deepEqual(policyAfter.rows[0], { revision: 2, point_value: "0.250000000000", approval_mode: "approval" });
  const otherPolicy = await runtime.pool.query(
    "SELECT point_value FROM wallet_conversion_policies WHERE company_id=$1", [second],
  );
  assert.equal(otherPolicy.rows[0].point_value, null);
});
