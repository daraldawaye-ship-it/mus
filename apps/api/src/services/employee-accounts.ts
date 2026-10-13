import type { PoolClient } from "pg";
import type { Account, User } from "../../../../packages/contracts/src/index.ts";
import { HttpError } from "../errors.ts";
import { audit } from "./audit.ts";
import { accountDTO, accountSelect } from "../repositories/masters.ts";

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
  accounts.push(await createEmployeeAccount(
    client, user, companyId, employeeId, employeeName, base.id, "advance",
  ));
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
