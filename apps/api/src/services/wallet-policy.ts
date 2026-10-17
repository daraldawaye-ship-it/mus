import type { QueryResultRow } from "pg";
import type { z } from "zod";
import {
  normalizeRate,
  type User,
} from "../../../../packages/contracts/src/index.ts";
import type {
  WalletPolicy,
  WalletCurrency,
  WalletAccount,
  EmployeeWalletAccount,
  WalletConversionPreview,
  walletPolicySchema,
  employeeWalletAccountSchema,
} from "../../../../packages/contracts/src/wallet.ts";
import type { Database } from "../db.ts";
import { HttpError, missing } from "../errors.ts";
import { audit } from "./audit.ts";
import { moneyString, quantum } from "./finance.ts";
import { walletSummary } from "./wallet.ts";

const accountJSON = (
  alias: string,
) => `CASE WHEN ${alias}.id IS NULL THEN NULL ELSE json_build_object(
 'id',${alias}.id,'code',${alias}.code,'name',${alias}.name,'active',${alias}.active,'kind',${alias}.kind,'category',${alias}.category) END`;
const currencyJSON = (
  alias: string,
) => `CASE WHEN ${alias}.id IS NULL THEN NULL ELSE json_build_object(
 'id',${alias}.id,'code',${alias}.code,'name',${alias}.name,'active',${alias}.active,'decimalPlaces',${alias}.decimal_places) END`;

export async function walletPolicy(
  db: Database,
  companyId: number,
): Promise<WalletPolicy> {
  const found = await db.query(
    `SELECT p.point_value::text,p.currency_id,p.expense_account_id,p.approval_mode,p.revision,
      ${currencyJSON("c")} AS currency,${accountJSON("a")} AS expense_account
     FROM wallet_conversion_policies p
     LEFT JOIN company_currencies c ON c.company_id=p.company_id AND c.id=p.currency_id
     LEFT JOIN accounts a ON a.company_id=p.company_id AND a.id=p.expense_account_id
     WHERE p.company_id=$1`,
    [companyId],
  );
  const row = found.rows[0];
  return {
    // Every point represents exactly one Yemeni rial.
    pointValue: "1",
    currencyId: row?.currency_id ?? null,
    currency: row?.currency ?? null,
    expenseAccountId: row?.expense_account_id ?? null,
    expenseAccount: row?.expense_account ?? null,
    approvalMode: row?.approval_mode ?? null,
    revision: row?.revision ?? null,
  };
}

export async function walletBaseCurrency(
  db: Database,
  companyId: number,
): Promise<WalletCurrency | null> {
  const found = await db.query(
    `SELECT ${currencyJSON("c")} AS currency FROM finance_settings f
     LEFT JOIN company_currencies c ON c.company_id=f.company_id AND c.id=f.base_currency_id
     WHERE f.company_id=$1`,
    [companyId],
  );
  return found.rows[0]?.currency ?? null;
}

const bindingSelect = `SELECT e.id,e.name,(e.active AND NOT u.archived) AS active,b.account_id,b.revision,
 ${accountJSON("a")} AS account FROM employees e JOIN users u ON u.id=e.user_id
 LEFT JOIN employee_wallet_accounts b ON b.company_id=e.company_id AND b.employee_id=e.id
 LEFT JOIN accounts a ON a.company_id=b.company_id AND a.id=b.account_id`;
const bindingDTO = (row: QueryResultRow): EmployeeWalletAccount => ({
  employeeId: row.id,
  employeeName: row.name,
  active: row.active,
  accountId: row.account_id ?? null,
  account: row.account ?? null,
  revision: row.revision ?? null,
});

export async function employeeWalletAccount(
  db: Database,
  companyId: number,
  employeeId: number,
): Promise<EmployeeWalletAccount> {
  const found = await db.query(
    bindingSelect + " WHERE e.company_id=$1 AND e.id=$2",
    [companyId, employeeId],
  );
  if (!found.rows[0]) missing();
  return bindingDTO(found.rows[0]);
}

async function validAccount(
  db: Database,
  companyId: number,
  accountId: number,
  expense = false,
): Promise<WalletAccount> {
  const found = await db.query(
    `SELECT id,code,name,active,kind,category FROM accounts WHERE company_id=$1 AND id=$2 FOR SHARE`,
    [companyId, accountId],
  );
  const account = found.rows[0] as WalletAccount | undefined;
  if (
    !account?.active ||
    account.kind !== "posting" ||
    (expense && account.category !== "expense")
  )
    throw new HttpError(
      400,
      "invalid_account",
      expense
        ? "اختر حساب مصروفات فعالًا وترحيليًا من الشركة نفسها"
        : "اختر حسابًا فعالًا وترحيليًا من الشركة نفسها",
    );
  return account;
}

export async function saveWalletPolicy(
  db: Database,
  user: User,
  companyId: number,
  input: z.output<typeof walletPolicySchema>,
): Promise<WalletPolicy> {
  const before = await walletPolicy(db, companyId);
  if (input.pointValue !== "1")
    throw new HttpError(400, "fixed_wallet_unit",
      "قيمة النقطة ثابتة: نقطة واحدة تساوي ريالًا يمنيًا واحدًا");
  if (input.revision !== before.revision)
    throw new HttpError(
      409,
      "conflict",
      "تغيرت إعدادات المحفظة؛ أعد تحميلها قبل الحفظ",
    );
  if (input.currencyId !== null) {
    const base = await walletBaseCurrency(db, companyId);
    if (!base?.active || base.code !== "YER" || base.id !== input.currencyId)
      throw new HttpError(
        400,
        "invalid_currency",
        "يجب أن تكون العملة الأساسية وعملة المحفظة هي الريال اليمني",
      );
    await db.query(
      "SELECT 1 FROM company_currencies WHERE company_id=$1 AND id=$2 FOR SHARE",
      [companyId, input.currencyId],
    );
  }
  if (input.expenseAccountId !== null) {
    await validAccount(db, companyId, input.expenseAccountId, true);
    if (
      (
        await db.query(
          "SELECT 1 FROM employee_wallet_accounts WHERE company_id=$1 AND account_id=$2 LIMIT 1",
          [companyId, input.expenseAccountId],
        )
      ).rowCount
    )
      throw new HttpError(
        400,
        "account_conflict",
        "حساب مصروف المكافآت يجب أن يختلف عن الحساب المرتبط بمحفظة الموظف",
      );
  }
  await db.query(
    `INSERT INTO wallet_conversion_policies(company_id,point_value,currency_id,expense_account_id,approval_mode,updated_by)
     VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(company_id) DO UPDATE SET point_value=EXCLUDED.point_value,
     currency_id=EXCLUDED.currency_id,expense_account_id=EXCLUDED.expense_account_id,approval_mode=EXCLUDED.approval_mode,
     updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp(),revision=wallet_conversion_policies.revision+1`,
    [
      companyId,
      input.pointValue,
      input.currencyId,
      input.expenseAccountId,
      input.approvalMode,
      user.id,
    ],
  );
  const after = await walletPolicy(db, companyId);
  await audit(
    db,
    user,
    "wallet.policy",
    "wallet-policy",
    companyId,
    before,
    after,
    companyId,
  );
  return after;
}

export async function saveEmployeeWalletAccount(
  db: Database,
  user: User,
  companyId: number,
  employeeId: number,
  input: z.output<typeof employeeWalletAccountSchema>,
): Promise<EmployeeWalletAccount> {
  const before = await employeeWalletAccount(db, companyId, employeeId);
  if (!before.active)
    throw new HttpError(
      400,
      "invalid_employee",
      "اختر موظفًا فعالًا من الشركة نفسها",
    );
  if (input.revision !== before.revision)
    throw new HttpError(
      409,
      "conflict",
      "تغير حساب المحفظة؛ أعد تحميله قبل الحفظ",
    );
  if (input.accountId !== null) {
    await validAccount(db, companyId, input.accountId);
    const policy = await walletPolicy(db, companyId);
    if (policy.expenseAccountId === input.accountId)
      throw new HttpError(
        400,
        "account_conflict",
        "حساب الموظف يجب أن يختلف عن حساب مصروف المكافآت",
      );
  }
  await db.query(
    `INSERT INTO employee_wallet_accounts(company_id,employee_id,account_id,updated_by) VALUES($1,$2,$3,$4)
     ON CONFLICT(company_id,employee_id) DO UPDATE SET account_id=EXCLUDED.account_id,updated_by=EXCLUDED.updated_by,
     updated_at=clock_timestamp(),revision=employee_wallet_accounts.revision+1`,
    [companyId, employeeId, input.accountId, user.id],
  );
  const after = await employeeWalletAccount(db, companyId, employeeId);
  await audit(
    db,
    user,
    "wallet.account",
    "employee-wallet-account",
    employeeId,
    before,
    after,
    companyId,
  );
  return after;
}

// Exact snapshot estimate. Execution must revalidate every current reference and revision.
// Points and the 12-place rate are multiplied exactly, then rounded half-up
// to the current base currency's precision before checking NUMERIC(28,6).
export function pointConversionAmount(
  points: string,
  pointValue: string,
  places: number,
): string {
  const [whole, fraction = ""] = pointValue.split(".");
  const rate = BigInt(whole) * 10n ** 12n + BigInt(fraction.padEnd(12, "0"));
  const numerator = BigInt(points) * rate;
  const divisor = 10n ** BigInt(12 - places);
  const rounded =
    numerator / divisor + ((numerator % divisor) * 2n >= divisor ? 1n : 0n);
  const units = rounded * quantum(places);
  if (units > 10n ** 28n - 1n)
    throw new HttpError(
      400,
      "amount_overflow",
      "المبلغ المتوقع يتجاوز الحد المالي المدعوم",
    );
  return moneyString(units);
}

export async function walletConversionPreview(
  db: Database,
  companyId: number,
  employeeId: number,
): Promise<WalletConversionPreview> {
  const binding = await employeeWalletAccount(db, companyId, employeeId);
  if (!binding.active)
    throw new HttpError(
      400,
      "invalid_employee",
      "لا يمكن معاينة تحويل محفظة موظف غير فعال",
    );
  const policy = await walletPolicy(db, companyId),
    base = await walletBaseCurrency(db, companyId),
    summary = await walletSummary(db, companyId, employeeId);
  if (!summary) missing();
  const points = summary.points,
    currencyValid =
      !!policy.currency?.active &&
      !!base?.active &&
      base.code === "YER" &&
      policy.currency.code === "YER" &&
      policy.currency.id === base.id,
    expenseValid =
      !!policy.expenseAccount?.active &&
      policy.expenseAccount.kind === "posting" &&
      policy.expenseAccount.category === "expense",
    accountValid =
      !!binding.account?.active &&
      binding.account.kind === "posting" &&
      binding.account.id !== policy.expenseAccountId,
    configurationComplete =
      policy.pointValue === "1" &&
      currencyValid &&
      expenseValid &&
      accountValid &&
      policy.approvalMode !== null;
  let amount: string | null = null,
    unavailableReason = !currencyValid
        ? "يلزم تحديد الريال اليمني عملة أساسية وعملة تحويل المحفظة"
        : !expenseValid
          ? "حدد حساب مصروف مكافآت فعالًا وترحيليًا"
          : !accountValid
            ? "اربط الموظف بحساب فعال وترحيلي يختلف عن حساب المصروف"
            : policy.approvalMode === null
              ? "لم تحدد الإدارة طريقة اعتماد التحويل بعد"
              : "";
  if (currencyValid) {
    try {
      amount = pointConversionAmount(
        points,
        "1",
        policy.currency!.decimalPlaces,
      );
      if (configurationComplete && points === "0")
        unavailableReason = "لا يوجد رصيد نقاط للتحويل";
      else if (configurationComplete && amount === "0")
        unavailableReason = "قيمة الرصيد أقل من أصغر جزء في العملة بعد التقريب";
    } catch (error) {
      if (!(error instanceof HttpError) || error.code !== "amount_overflow")
        throw error;
      unavailableReason = error.message;
    }
  }
  if (summary.reservedPoints !== "0")
    unavailableReason =
      "لديك طلب تحويل ينتظر الاعتماد؛ أكمله أو ألغِه قبل طلب تحويل آخر";
  return {
    employeeId,
    points,
    pointValue: policy.pointValue,
    amount,
    currency: policy.currency,
    account: binding.account,
    approvalMode: policy.approvalMode,
    configurationComplete,
    canConvert:
      configurationComplete &&
      summary.reservedPoints === "0" &&
      amount !== null &&
      amount !== "0" &&
      points !== "0",
    unavailableReason,
    policyRevision: policy.revision,
    accountRevision: binding.revision,
  };
}
