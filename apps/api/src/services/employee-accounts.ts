import type { PoolClient } from "pg";
import type { Database } from "../db.ts";
import { missing } from "../errors.ts";
import type { Account, User } from "../../../../packages/contracts/src/index.ts";
import { HttpError } from "../errors.ts";
import { audit } from "./audit.ts";
import { accountDTO, accountSelect } from "../repositories/masters.ts";
import { employeeWalletAccount } from "./wallet-policy.ts";
import { employeeWalletAccount } from "./wallet-policy.ts";

type Kind = "advance" | "sales_cash" | "sales_pouch";
interface GroupSpec {
  code: string;
  name: string;
  start: string;
  end: string;
}
const groups: Record<Kind, GroupSpec> = {
  advance: {
    code: "1140000000",
    name: "سلف الموظفين",
    start: "1140000001",
    end: "1140999999",
  },
  sales_cash: {
    code: "1111000000",
    name: "الصناديق",
    start: "1111000001",
    end: "1111999999",
  },
  sales_pouch: {
    code: "1113000000",
    name: "الحوافظ",
    start: "1113000001",
    end: "1113999999",
  },
};

export interface EmployeeAccountLink {
  kind: Kind;
  accountId: number;
  code: string;
  name: string;
}

// Caller holds FOR UPDATE on the company row. Employee, accounts, links and audit
// are committed or rolled back together by that enclosing transaction.
async function ensureGroup(
  client: PoolClient,
  user: User,
  companyId: number,
  rootId: number,
  spec: GroupSpec,
): Promise<number> {
  const found = await client.query(
    "SELECT * FROM accounts WHERE company_id=$1 AND code=$2 FOR UPDATE",
    [companyId, spec.code],
  );
  if (found.rows[0]) {
    const row = found.rows[0];
    if (
      row.kind !== "group" || row.category !== "asset" ||
      row.normal_side !== "debit" || !row.active ||
      row.parent_id !== rootId ||
      (row.range_start !== null && row.range_start > spec.start) ||
      (row.range_end !== null && row.range_end < spec.end)
    )
      throw new HttpError(
        409,
        "employee_account_group_conflict",
        `المجموعة ${spec.code} مستخدمة بإعداد مختلف؛ صحح دليل الحسابات قبل إضافة الموظف`,
      );
    return row.id;
  }
  const created = await client.query(
    `INSERT INTO accounts(company_id,code,name,parent_id,kind,category,normal_side,active,range_start,range_end,created_by,cash_or_bank)
     VALUES($1,$2,$3,$4,'group','asset','debit',true,$5,$6,$7,false) RETURNING id`,
    [companyId, spec.code, spec.name, rootId, spec.start, spec.end, user.id],
  );
  const id = created.rows[0].id as number;
  const account = accountDTO((
    await client.query(`${accountSelect} WHERE a.company_id=$1 AND a.id=$2`, [companyId, id])
  ).rows[0]);
  await audit(client, user, "account.create", "account", id, null, account, companyId);
  return id;
}

async function createEmployeeAccount(
  client: PoolClient,
  user: User,
  companyId: number,
  employeeId: number,
  employeeName: string,
  rootId: number,
  kind: Kind,
): Promise<EmployeeAccountLink> {
  const spec = groups[kind];
  const parentId = await ensureGroup(client, user, companyId, rootId, spec);
  const name =
    kind === "advance" ? `سلفة ${employeeName}` :
    kind === "sales_cash" ? `صندوق مبيعات ${employeeName}` :
    `حافظة مبيعات ${employeeName}`;
  if (name.length > 120)
    throw new HttpError(400, "account_name_too_long", "اسم الموظف طويل لإنشاء حساباته؛ اختصر الاسم");
  // Company-level FOR UPDATE lock serializes concurrent employee registration
  // against other master changes, retaining sequential 10-digit account codes.
  const last = await client.query(
    "SELECT max(code) AS code FROM accounts WHERE company_id=$1 AND code BETWEEN $2 AND $3",
    [companyId, spec.start, spec.end],
  );
  const next = last.rows[0].code === null
    ? BigInt(spec.start)
    : BigInt(last.rows[0].code) + 1n;
  if (next > BigInt(spec.end))
    throw new HttpError(409, "account_range_exhausted", `نفد ترقيم المجموعة ${spec.code}`);
  const code = next.toString().padStart(10, "0");
  const created = await client.query(
    `INSERT INTO accounts(company_id,code,name,parent_id,kind,category,normal_side,active,range_start,range_end,created_by,cash_or_bank)
     VALUES($1,$2,$3,$4,'posting','asset','debit',true,NULL,NULL,$5,$6) RETURNING id`,
    [companyId, code, name, parentId, user.id, kind === "sales_cash"],
  );
  const accountId = created.rows[0].id as number;
  await client.query(
    `INSERT INTO option_values(company_id,definition_id,record_kind,account_id,value,created_by,updated_by)
     SELECT company_id,id,'account',$2,default_value,$3,$3 FROM option_definitions
     WHERE company_id=$1 AND record_kind='account' AND active=true
       AND native_binding IS NULL AND default_value <> 'null'::jsonb`,
    [companyId, accountId, user.id],
  );
  await client.query(
    `INSERT INTO employee_account_links(company_id,employee_id,account_kind,account_id)
     VALUES($1,$2,$3,$4)`,
    [companyId, employeeId, kind, accountId],
  );
  const account = accountDTO((
    await client.query(`${accountSelect} WHERE a.company_id=$1 AND a.id=$2`, [companyId, accountId])
  ).rows[0]);
  await audit(client, user, "account.create", "account", accountId, null, account, companyId);
  return { kind, accountId, code, name };
}

export async function provisionEmployeeAccounts(
  client: PoolClient,
  user: User,
  companyId: number,
  employeeId: number,
  employeeName: string,
  createSalesCashbox: boolean,
): Promise<EmployeeAccountLink[]> {
  const root = await client.query(
    "SELECT id,kind,category,normal_side,active FROM accounts WHERE company_id=$1 AND code='1000000000' FOR SHARE",
    [companyId],
  );
  const base = root.rows[0];
  if (!base || base.kind !== "group" || base.category !== "asset" ||
      base.normal_side !== "debit" || !base.active)
    throw new HttpError(
      409,
      "missing_assets_group",
      "مجموعة الأصول 1000000000 غير جاهزة؛ جهز دليل الحسابات قبل إضافة الموظف",
    );
  const accounts: EmployeeAccountLink[] = [];
  const advance = await createEmployeeAccount(
    client, user, companyId, employeeId, employeeName, base.id, "advance",
  );
  accounts.push(advance);
  // One financial destination for redeemed points: the employee's advance.
  // Points accrue only in the wallet ledger; accounting journal entries are
  // posted once, when an approved/direct point conversion is completed.
  await client.query(
    `INSERT INTO employee_wallet_accounts(company_id,employee_id,account_id,updated_by)
     VALUES($1,$2,$3,$4)`,
    [companyId, employeeId, advance.accountId, user.id],
  );
  await audit(
    client, user, "wallet.account", "employee-wallet-account", employeeId,
    null, await employeeWalletAccount(client, companyId, employeeId), companyId,
  );
  if (createSalesCashbox) {
    accounts.push(await createEmployeeAccount(
      client, user, companyId, employeeId, employeeName, base.id, "sales_cash",
    ));
    accounts.push(await createEmployeeAccount(
      client, user, companyId, employeeId, employeeName, base.id, "sales_pouch",
    ));
  }
  return accounts;
}

export interface EmployeeAccountsSnapshot {
  employeeId: number;
  links: Array<EmployeeAccountLink & { active: boolean }>;
  walletAccount: { id: number; code: string; name: string } | null;
}

/** Read exact employee-owned account codes, never infer ownership from names. */
export async function employeeAccountsSnapshot(
  db: Database,
  companyId: number,
  employeeId: number,
): Promise<EmployeeAccountsSnapshot> {
  const employee = await db.query(
    "SELECT 1 FROM employees WHERE company_id=$1 AND id=$2",
    [companyId, employeeId],
  );
  if (!employee.rowCount) missing("الموظف غير موجود في هذه الشركة");
  const linked = await db.query(
    `SELECT l.account_kind,a.id,a.code,a.name,a.active
     FROM employee_account_links l JOIN accounts a
       ON a.company_id=l.company_id AND a.id=l.account_id
     WHERE l.company_id=$1 AND l.employee_id=$2`,
    [companyId, employeeId],
  );
  const wallet = await db.query(
    `SELECT a.id,a.code,a.name FROM employee_wallet_accounts w
     JOIN accounts a ON a.company_id=w.company_id AND a.id=w.account_id
     WHERE w.company_id=$1 AND w.employee_id=$2`,
    [companyId, employeeId],
  );
  return {
    employeeId,
    links: linked.rows.map((r) => ({
      kind: r.account_kind as EmployeeAccountLink["kind"],
      accountId: r.id,
      code: r.code,
      name: r.name,
      active: r.active,
    })),
    walletAccount: wallet.rows[0] ?? null,
  };
}

/** Explicit opt-in repair for an existing employee; never change posted history. */
export async function completeEmployeeAccounts(
  client: PoolClient,
  actor: User,
  companyId: number,
  employeeId: number,
  createSalesCashbox: boolean,
): Promise<EmployeeAccountsSnapshot> {
  const employee = await client.query(
    "SELECT id,name FROM employees WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [companyId, employeeId],
  );
  if (!employee.rows[0]) missing("الموظف غير موجود في هذه الشركة");
  const old = await employeeAccountsSnapshot(client, companyId, employeeId);
  const existing = new Map(old.links.map((link) => [link.kind, link]));
  const needs = ["advance", ...(createSalesCashbox ? ["sales_cash", "sales_pouch"] : [])] as Kind[];
  if (needs.some((kind) => !existing.has(kind))) {
    const root = await client.query(
      "SELECT id,kind,category,normal_side,active FROM accounts WHERE company_id=$1 AND code='1000000000' FOR SHARE",
      [companyId],
    );
    const row = root.rows[0];
    if (!row || !row.active || row.kind !== "group" ||
        row.category !== "asset" || row.normal_side !== "debit")
      throw new HttpError(409, "missing_assets_group", "مجموعة الأصول غير جاهزة لإنشاء حسابات الموظف");
    for (const kind of needs) {
      if (!existing.has(kind)) {
        const added = await createEmployeeAccount(
          client, actor, companyId, employeeId, employee.rows[0].name, row.id, kind,
        );
        existing.set(kind, { ...added, active: true });
      }
    }
  }
  // Preserve any explicitly configured binding, including a deliberately
  // cleared one. Only new, unbound wallets are assigned to employee advances.
  const advance = existing.get("advance");
  if (advance) {
    const result = await client.query(
      `INSERT INTO employee_wallet_accounts(company_id,employee_id,account_id,updated_by)
       VALUES($1,$2,$3,$4) ON CONFLICT(company_id,employee_id) DO NOTHING RETURNING employee_id`,
      [companyId, employeeId, advance.accountId, actor.id],
    );
    if (result.rowCount) {
      await audit(client, actor, "wallet.account", "employee-wallet-account", employeeId,
        null, await employeeWalletAccount(client, companyId, employeeId), companyId);
    }
  }
  return employeeAccountsSnapshot(client, companyId, employeeId);
}
