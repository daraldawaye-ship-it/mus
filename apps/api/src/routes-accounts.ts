import { Router } from "express";
import type { Pool, PoolClient } from "pg";
import {
  accountCategories,
  accountKinds,
  accountLinkCategories,
  accountLinkPurposes,
  accountLinkSchema,
  accountPatchSchema,
  accountSchema,
  emptyInitializeSchema,
  type Account,
  type AccountCategory,
  type AccountLink,
  type AccountLinkPurpose,
  type NormalSide,
  type User,
} from "../../../packages/contracts/src/index.ts";
import { handler, id, parse } from "./http.ts";
import { HttpError, missing } from "./errors.ts";
import {
  accountDTO,
  accountLinkDTO,
  accountSelect,
} from "./repositories/masters.ts";
import { audit } from "./services/audit.ts";
import {
  conflict,
  masterPage,
  masterRow,
  mutateMaster,
  readMaster,
} from "./services/masters.ts";
import type { Database } from "./db.ts";

const columns = {
  id: "a.id",
  code: "a.code",
  name: "a.name",
  parentId: "a.parent_id",
  parentCode: "p.code",
  parentName: "p.name",
  kind: "a.kind",
  category: "a.category",
  normalSide: "a.normal_side",
  active: "a.active",
  cashOrBank: "a.cash_or_bank",
  rangeStart: "a.range_start",
  rangeEnd: "a.range_end",
  createdAt: "a.created_at",
};
const from =
  "FROM accounts a LEFT JOIN accounts p ON p.company_id=a.company_id AND p.id=a.parent_id";
async function links(db: Database, companyId: number): Promise<AccountLink[]> {
  const result = await db.query(
    "SELECT l.*,a.code AS account_code,a.name AS account_name FROM account_links l LEFT JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id WHERE l.company_id=$1",
    [companyId],
  );
  return accountLinkPurposes.map((purpose) => {
    const row = result.rows.find((item) => item.purpose === purpose);
    return row
      ? accountLinkDTO(row)
      : {
          companyId,
          purpose,
          accountId: null,
          accountCode: null,
          accountName: null,
        };
  });
}
async function insertAccount(
  client: PoolClient,
  user: User,
  companyId: number,
  input: ReturnType<typeof accountSchema.parse>,
): Promise<Account> {
  let parent: Account | null = null;
  if (input.parentId !== null) {
    const result = await client.query(
      `${accountSelect} WHERE a.company_id=$1 AND a.id=$2`,
      [companyId, input.parentId],
    );
    if (!result.rows[0]) conflict("الأب يجب أن يكون من الشركة نفسها");
    parent = accountDTO(result.rows[0]);
    if (parent.kind !== "group" || !parent.active)
      conflict("الأب يجب أن يكون مجموعة فعالة من الشركة");
    if (parent.category !== input.category)
      conflict("تصنيف الحساب يجب أن يطابق تصنيف الأب");
  }
  let code = input.code;
  if (!code) {
    const prefix = {
      asset: "1",
      liability: "2",
      equity: "3",
      income: "4",
      expense: "5",
    }[input.category];
    const start = parent?.rangeStart ?? `${prefix}000000001`;
    const end = parent?.rangeEnd ?? `${prefix}999999999`;
    const maximum = await client.query(
      "SELECT max(code) AS code FROM accounts WHERE company_id=$1 AND code BETWEEN $2 AND $3",
      [companyId, start, end],
    );
    const next =
      maximum.rows[0].code === null
        ? BigInt(start)
        : BigInt(maximum.rows[0].code) + 1n;
    if (next > BigInt(end)) conflict("نفد مجال ترقيم الحسابات");
    code = next.toString().padStart(10, "0");
  }
  const result = await client.query(
    "INSERT INTO accounts(company_id,code,name,parent_id,kind,category,normal_side,active,range_start,range_end,created_by,cash_or_bank) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id",
    [
      companyId,
      code,
      input.name,
      input.parentId,
      input.kind,
      input.category,
      input.normalSide,
      input.active,
      input.rangeStart,
      input.rangeEnd,
      user.id,
      input.cashOrBank,
    ],
  );
  return accountDTO(
    await masterRow(client, accountSelect, "a", companyId, result.rows[0].id),
  );
}
interface Seed {
  code: string;
  name: string;
  category: AccountCategory;
  normalSide: NormalSide;
  parentCode?: string;
  rangeStart?: string;
  rangeEnd?: string;
  purpose?: AccountLinkPurpose;
}
const seeds: Seed[] = [
  {
    code: "1000000000",
    name: "الأصول",
    category: "asset",
    normalSide: "debit",
  },
  {
    code: "2000000000",
    name: "الالتزامات",
    category: "liability",
    normalSide: "credit",
  },
  {
    code: "3000000000",
    name: "حقوق الملكية",
    category: "equity",
    normalSide: "credit",
  },
  {
    code: "4000000000",
    name: "الإيرادات",
    category: "income",
    normalSide: "credit",
  },
  {
    code: "5000000000",
    name: "المصروفات",
    category: "expense",
    normalSide: "debit",
  },
  {
    code: "1111000000",
    name: "الصناديق",
    category: "asset",
    normalSide: "debit",
    parentCode: "1000000000",
    rangeStart: "1111000001",
    rangeEnd: "1111999999",
  },
  {
    code: "1112000000",
    name: "البنوك",
    category: "asset",
    normalSide: "debit",
    parentCode: "1000000000",
    rangeStart: "1112000001",
    rangeEnd: "1112999999",
  },
  {
    code: "1120000000",
    name: "العملاء",
    category: "asset",
    normalSide: "debit",
    parentCode: "1000000000",
    rangeStart: "1120000001",
    rangeEnd: "1129999999",
  },
  {
    code: "2110000000",
    name: "الموردون",
    category: "liability",
    normalSide: "credit",
    parentCode: "2000000000",
    rangeStart: "2110000001",
    rangeEnd: "2119999999",
  },
  {
    code: "1130000000",
    name: "المخزون",
    category: "asset",
    normalSide: "debit",
    parentCode: "1000000000",
  },
  {
    code: "4100000001",
    name: "إيراد المبيعات",
    category: "income",
    normalSide: "credit",
    parentCode: "4000000000",
    purpose: "salesRevenue",
  },
  {
    code: "5100000001",
    name: "الخصم المسموح",
    category: "expense",
    normalSide: "debit",
    parentCode: "5000000000",
    purpose: "discountAllowed",
  },
  {
    code: "4200000001",
    name: "الخصم المكتسب",
    category: "income",
    normalSide: "credit",
    parentCode: "4000000000",
    purpose: "discountEarned",
  },
  {
    code: "1130000001",
    name: "حساب المخزون",
    category: "asset",
    normalSide: "debit",
    parentCode: "1130000000",
    purpose: "inventory",
  },
  {
    code: "5200000001",
    name: "المشتريات",
    category: "expense",
    normalSide: "debit",
    parentCode: "5000000000",
    purpose: "purchases",
  },
  {
    code: "5300000001",
    name: "تكلفة المبيعات",
    category: "expense",
    normalSide: "debit",
    parentCode: "5000000000",
    purpose: "costOfGoodsSold",
  },
  {
    code: "5400000001",
    name: "عجز المخزون",
    category: "expense",
    normalSide: "debit",
    parentCode: "5000000000",
    purpose: "stockShortage",
  },
  {
    code: "4300000001",
    name: "فائض المخزون",
    category: "income",
    normalSide: "credit",
    parentCode: "4000000000",
    purpose: "stockSurplus",
  },
];

export async function initializeCompanyAccounts(
  client: PoolClient,
  user: User,
  companyId: number,
): Promise<number> {
  const existing = await client.query(
    "SELECT 1 FROM accounts WHERE company_id=$1 LIMIT 1",
    [companyId],
  );
  if (existing.rowCount) conflict("تهيئة الدليل متاحة فقط عندما يكون فارغًا");
  const previousLinks = await links(client, companyId);
  const created: Account[] = [];
  for (const seed of seeds) {
    const parentId = seed.parentCode
      ? created.find((account) => account.code === seed.parentCode)!.id
      : null;
    const next = await insertAccount(client, user, companyId, {
      code: seed.code,
      name: seed.name,
      parentId,
      kind: seed.purpose ? "posting" : "group",
      category: seed.category,
      normalSide: seed.normalSide,
      active: true,
      cashOrBank: false,
      rangeStart: seed.rangeStart ?? null,
      rangeEnd: seed.rangeEnd ?? null,
    });
    created.push(next);
    if (seed.purpose)
      await client.query(
        "INSERT INTO account_links(company_id,purpose,account_id) VALUES($1,$2,$3) ON CONFLICT(company_id,purpose) DO UPDATE SET account_id=excluded.account_id",
        [companyId, seed.purpose, next.id],
      );
  }
  await audit(
    client,
    user,
    "accounts.initialize",
    "account",
    null,
    { accounts: [], links: previousLinks },
    { accounts: created, links: await links(client, companyId) },
    companyId,
  );
  return created.length;
}

export function accountRoutes(pool: Pool): Router {
  const router = Router(),
    base = "/companies/:companyId";
  router.get(
    `${base}/accounts`,
    handler(async (req, res) => {
      const companyId = await readMaster(pool, req, "accounts.view");
      res.json(
        await masterPage(
          pool,
          req,
          companyId,
          accountSelect,
          from,
          "a",
          columns,
          ["a.code", "a.name", "p.name"],
          accountDTO,
          {
            kind: accountKinds,
            category: accountCategories,
            active: "boolean",
            cashOrBank: "boolean",
            parentId: "id",
          },
          "code:asc",
        ),
      );
    }),
  );
  router.post(
    `${base}/accounts`,
    handler(async (req, res) => {
      const input = parse(accountSchema, req.body);
      const account = await mutateMaster(
        pool,
        req,
        "accounts.manage",
        async (client, user, companyId) => {
          const next = await insertAccount(client, user, companyId, input);
          await audit(
            client,
            user,
            "account.create",
            "account",
            next.id,
            null,
            next,
            companyId,
          );
          return next;
        },
      );
      res.status(201).json({ account });
    }),
  );
  router.post(
    `${base}/accounts/initialize`,
    handler(async (req, res) => {
      parse(emptyInitializeSchema, req.body);
      const created = await mutateMaster(
        pool,
        req,
        "accounts.manage",
        async (client, user, companyId) => {
          return initializeCompanyAccounts(client, user, companyId);
        },
      );
      res.status(201).json({ created });
    }),
  );
  router.get(
    `${base}/accounts/:id`,
    handler(async (req, res) => {
      const companyId = await readMaster(pool, req, "accounts.view");
      res.json({
        account: accountDTO(
          await masterRow(
            pool,
            accountSelect,
            "a",
            companyId,
            id(req.params.id),
          ),
        ),
      });
    }),
  );
  router.patch(
    `${base}/accounts/:id`,
    handler(async (req, res) => {
      const input = parse(accountPatchSchema, req.body),
        accountId = id(req.params.id);
      const account = await mutateMaster(
        pool,
        req,
        "accounts.manage",
        async (client, user, companyId) => {
          const before = accountDTO(
            await masterRow(client, accountSelect, "a", companyId, accountId),
          );
          if (
            input.cashOrBank !== undefined &&
            input.cashOrBank !== before.cashOrBank
          ) {
            if (
              input.cashOrBank &&
              (before.kind !== "posting" || before.category !== "asset")
            )
              conflict("الصندوق أو البنك يجب أن يكون حسابًا حركيًا من الأصول");
            const history = await client.query(
              "SELECT 1 FROM financial_document_lines l JOIN financial_documents d ON d.company_id=l.company_id AND d.id=l.document_id WHERE l.company_id=$1 AND l.account_id=$2 AND d.status<>'draft' LIMIT 1",
              [companyId, accountId],
            );
            if (history.rowCount)
              conflict(
                "لا يمكن تغيير تصنيف الصندوق أو البنك بعد ترحيل حركات عليه",
              );
          }
          if (input.active === false) {
            const children = await client.query(
              "SELECT 1 FROM accounts WHERE company_id=$1 AND parent_id=$2 AND active LIMIT 1",
              [companyId, accountId],
            );
            if (children.rowCount)
              conflict("أوقف الحسابات الفرعية الفعالة أولًا");
            const mapped = await client.query(
              "SELECT 1 FROM account_links WHERE company_id=$1 AND account_id=$2 LIMIT 1",
              [companyId, accountId],
            );
            if (mapped.rowCount) conflict("أزل الربط النظامي قبل إيقاف الحساب");
          }
          if (input.active === true && before.parentId !== null) {
            const parent = accountDTO(
              await masterRow(
                client,
                accountSelect,
                "a",
                companyId,
                before.parentId,
              ),
            );
            if (!parent.active) conflict("يجب تفعيل الأب أولًا");
          }
          await client.query(
            "UPDATE accounts SET name=$1,active=$2,cash_or_bank=$5 WHERE company_id=$3 AND id=$4",
            [
              input.name ?? before.name,
              input.active ?? before.active,
              companyId,
              accountId,
              input.cashOrBank ?? before.cashOrBank,
            ],
          );
          const next = accountDTO(
            await masterRow(client, accountSelect, "a", companyId, accountId),
          );
          await audit(
            client,
            user,
            "account.update",
            "account",
            accountId,
            before,
            next,
            companyId,
          );
          return next;
        },
      );
      res.json({ account });
    }),
  );
  router.get(
    `${base}/account-links`,
    handler(async (req, res) => {
      const companyId = await readMaster(pool, req, "accounts.view");
      res.json({ items: await links(pool, companyId) });
    }),
  );
  router.put(
    `${base}/account-links/:purpose`,
    handler(async (req, res) => {
      const purpose = req.params.purpose as AccountLinkPurpose;
      if (!accountLinkPurposes.includes(purpose))
        missing("وظيفة الربط غير موجودة");
      const input = parse(accountLinkSchema, req.body);
      const link = await mutateMaster(
        pool,
        req,
        "accounts.manage",
        async (client, user, companyId) => {
          const before = (await links(client, companyId)).find(
            (item) => item.purpose === purpose,
          )!;
          if (input.accountId !== null) {
            const result = await client.query(
              `${accountSelect} WHERE a.company_id=$1 AND a.id=$2`,
              [companyId, input.accountId],
            );
            if (!result.rows[0]) conflict("الحساب يجب أن يكون من الشركة نفسها");
            const account = accountDTO(result.rows[0]);
            if (
              !account.active ||
              account.kind !== "posting" ||
              account.category !== accountLinkCategories[purpose]
            )
              conflict("الربط يحتاج حسابًا حركيًا فعالًا بالتصنيف المناسب");
          }
          await client.query(
            "INSERT INTO account_links(company_id,purpose,account_id) VALUES($1,$2,$3) ON CONFLICT(company_id,purpose) DO UPDATE SET account_id=excluded.account_id",
            [companyId, purpose, input.accountId],
          );
          const next = (await links(client, companyId)).find(
            (item) => item.purpose === purpose,
          )!;
          await audit(
            client,
            user,
            "accountLink.update",
            "accountLink",
            null,
            before,
            next,
            companyId,
          );
          return next;
        },
      );
      res.json({ link });
    }),
  );
  return router;
}
