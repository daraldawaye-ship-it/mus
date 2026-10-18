import { z } from "zod";

const id = z.number().int().positive().max(2_147_483_647);
const name = z.string().trim().min(1, "الاسم مطلوب").max(120);
const accountName = z.string().trim().min(1, "الاسم مطلوب").max(500);
export function normalizeDigits(value: string): string {
  return value
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)));
}
const code = z
  .string()
  .trim()
  .transform(normalizeDigits)
  .pipe(z.string().regex(/^\d{10}$/, "الكود يجب أن يتكون من 10 أرقام"));
const siteCode = z
  .string()
  .trim()
  .transform((value) => normalizeDigits(value).toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9_-]{1,20}$/, "الكود غير صالح"));
const phone = z
  .string()
  .trim()
  .max(40)
  .transform((value) => normalizeDigits(value.replace(/[\s()\-]/g, "")))
  .refine(
    (value) => value === "" || /^\+?[0-9]{3,20}$/.test(value),
    "رقم الهاتف غير صالح",
  );

export const accountKinds = ["group", "posting"] as const;
export const accountCategories = [
  "asset",
  "liability",
  "equity",
  "income",
  "expense",
] as const;
// Optional descriptive choice on an account card. This is NOT an accounting
// category, ledger side, cash-account setting or active/archived status.
// The two "صندوق" entries are deliberately distinct IDs to preserve the
// exact ordering and labels requested by the user.
export const accountChoices = [
  "company",
  "customer",
  "expense",
  "wholesale",
  "distributor",
  "doctor",
  "employee",
  "pledges",
  "cashbox",
  "custody",
  "pouch",
  "administrative",
  "purchaseCashbox",
  "cashboxSecond",
  "pharmacy",
  "archived",
  "stopped",
  "followUp",
] as const;
export type AccountChoice = (typeof accountChoices)[number];
export const accountChoiceLabels: Record<AccountChoice, string> = {
  company: "شركة",
  customer: "عميل",
  expense: "مصروف",
  wholesale: "جملة",
  distributor: "موزع",
  doctor: "طبيب",
  employee: "موظف",
  pledges: "الرهونات",
  cashbox: "صندوق",
  custody: "عهدة",
  pouch: "حافظة",
  administrative: "حساب اداري",
  purchaseCashbox: "صندوق مشتريات",
  cashboxSecond: "صندوق",
  pharmacy: "صيدلية",
  archived: "مؤرشف",
  stopped: "موقف",
  followUp: "متابعة",
};
export const normalSides = ["debit", "credit"] as const;
export const accountLinkPurposes = [
  "salesRevenue",
  "discountAllowed",
  "discountEarned",
  "inventory",
  "purchases",
  "costOfGoodsSold",
  "stockShortage",
  "stockSurplus",
] as const;
export const locationKinds = ["showroom", "warehouse"] as const;
export type AccountKind = (typeof accountKinds)[number];
export type AccountCategory = (typeof accountCategories)[number];
export type NormalSide = (typeof normalSides)[number];
export type AccountLinkPurpose = (typeof accountLinkPurposes)[number];
export type LocationKind = (typeof locationKinds)[number];
export const accountKindLabels: Record<AccountKind, string> = {
  group: "مجموعة",
  posting: "حركي",
};
export const accountCategoryLabels: Record<AccountCategory, string> = {
  asset: "أصول",
  liability: "التزامات",
  equity: "حقوق ملكية",
  income: "إيرادات",
  expense: "مصروفات",
};
export const normalSideLabels: Record<NormalSide, string> = {
  debit: "مدين",
  credit: "دائن",
};
export const locationKindLabels: Record<LocationKind, string> = {
  showroom: "معرض",
  warehouse: "مخزن",
};
export const accountLinkLabels: Record<AccountLinkPurpose, string> = {
  salesRevenue: "إيراد المبيعات",
  discountAllowed: "الخصم المسموح",
  discountEarned: "الخصم المكتسب",
  inventory: "المخزون",
  purchases: "المشتريات",
  costOfGoodsSold: "تكلفة المبيعات",
  stockShortage: "عجز المخزون",
  stockSurplus: "فائض المخزون",
};
export const accountLinkCategories: Record<
  AccountLinkPurpose,
  AccountCategory
> = {
  salesRevenue: "income",
  discountAllowed: "expense",
  discountEarned: "income",
  inventory: "asset",
  purchases: "expense",
  costOfGoodsSold: "expense",
  stockShortage: "expense",
  stockSurplus: "income",
};

export interface Account {
  accountLimit?: string | null;
  dailyLimit?: string | null;
  weeklyLimit?: string | null;
  monthlyLimit?: string | null;
  privacyLevel?: number;
  lastApprovalDate?: string | null;
  goodsValueAccountId?: number | null;
  ownerPhone?: string;
  dailyDefault?: string | null;
  weeklyDefault?: string | null;
  monthlyDefault?: string | null;
  id: number;
  companyId: number;
  code: string;
  name: string;
  parentId: number | null;
  parentCode: string | null;
  parentName: string | null;
  kind: AccountKind;
  category: AccountCategory;
  normalSide: NormalSide;
  accountChoice: AccountChoice | null;
  // Page-only derived posted balance in the company's base currency.
  // No fixed debit/credit direction exists for the current balance.
  balanceAmount?: string | null;
  balanceDirection?: "debit" | "credit" | "zero" | null;
  active: boolean;
  cashOrBank: boolean;
  rangeStart: string | null;
  rangeEnd: string | null;
  createdBy: number;
  createdAt: string;
}
export interface AccountLink {
  companyId: number;
  purpose: AccountLinkPurpose;
  accountId: number | null;
  accountCode: string | null;
  accountName: string | null;
}
export interface CompanyCurrency {
  id: number;
  companyId: number;
  code: string;
  name: string;
  decimalPlaces: number;
  active: boolean;
  createdBy: number;
  createdAt: string;
}
export interface FinanceSettings {
  companyId: number;
  baseCurrencyId: number;
  baseCurrencyCode: string;
  baseCurrencyName: string;
}
export interface ExchangeRate {
  id: number;
  companyId: number;
  currencyId: number;
  currencyCode: string;
  baseCurrencyId: number;
  baseCurrencyCode: string;
  rate: string;
  effectiveAt: string;
  source: string;
  active: boolean;
  createdBy: number;
  createdAt: string;
}
export interface EffectiveExchangeRate {
  currencyId: number;
  baseCurrencyId: number;
  at: string;
  rate: string | null;
  exchangeRateId: number | null;
}
export interface Branch {
  id: number;
  companyId: number;
  code: string;
  name: string;
  phone: string;
  address: string;
  active: boolean;
  createdBy: number;
  createdAt: string;
}
export interface Location {
  id: number;
  companyId: number;
  branchId: number;
  code: string;
  name: string;
  kind: LocationKind;
  active: boolean;
  branchName: string;
  branchActive: boolean;
  effectiveActive: boolean;
  createdBy: number;
  createdAt: string;
}

const accountMoney = z.string().trim().transform(normalizeDigits).pipe(z.string().regex(/^\d{1,22}(?:\.\d{1,6})?$/, "المبلغ غير صالح")).nullable();
export const accountSchema = z
  .object({
    code: code.optional(),
    name: accountName,
    parentId: id.nullable().optional().default(null),
    kind: z.enum(accountKinds),
    category: z.enum(accountCategories),
    accountChoice: z.enum(accountChoices).nullable().default("administrative"),
    accountLimit: accountMoney.default(null),
    dailyLimit: accountMoney.default(null),
    weeklyLimit: accountMoney.default(null),
    monthlyLimit: accountMoney.default(null),
    dailyDefault: accountMoney.default(null),
    weeklyDefault: accountMoney.default(null),
    monthlyDefault: accountMoney.default(null),
    privacyLevel: z.number().int().min(1).max(5).default(1),
    lastApprovalDate: z.iso.date().nullable().default(null),
    goodsValueAccountId: id.nullable().default(null),
    ownerPhone: phone.default(""),
    // Accepted for compatibility with existing integrations; the server sets
    // the accounting classification automatically from the account category.
    normalSide: z.enum(normalSides).optional(),
    active: z.boolean().default(true),
    cashOrBank: z.boolean().default(false),
    rangeStart: code.nullable().optional().default(null),
    rangeEnd: code.nullable().optional().default(null),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.cashOrBank &&
      (value.kind !== "posting" || value.category !== "asset")
    )
      context.addIssue({
        code: "custom",
        message: "حساب الصندوق أو البنك يجب أن يكون حركيًا من الأصول",
        path: ["cashOrBank"],
      });
    if ((value.rangeStart === null) !== (value.rangeEnd === null))
      context.addIssue({
        code: "custom",
        message: "بداية المجال ونهايته مطلوبتان معًا",
        path: ["rangeStart"],
      });
    if (value.rangeStart && value.rangeEnd && value.rangeStart > value.rangeEnd)
      context.addIssue({
        code: "custom",
        message: "بداية المجال تتجاوز نهايته",
        path: ["rangeStart"],
      });
    if (value.kind === "posting" && value.rangeStart !== null)
      context.addIssue({
        code: "custom",
        message: "الحساب الحركي لا يملك مجال ترقيم",
        path: ["rangeStart"],
      });
  });
export const accountPatchSchema = z
  .object({
    name: accountName.optional(),
    active: z.boolean().optional(),
    cashOrBank: z.boolean().optional(),
    accountChoice: z.enum(accountChoices).nullable().optional(),
    accountLimit: accountMoney.optional(),
    dailyLimit: accountMoney.optional(),
    weeklyLimit: accountMoney.optional(),
    monthlyLimit: accountMoney.optional(),
    dailyDefault: accountMoney.optional(),
    weeklyDefault: accountMoney.optional(),
    monthlyDefault: accountMoney.optional(),
    privacyLevel: z.number().int().min(1).max(5).optional(),
    lastApprovalDate: z.iso.date().nullable().optional(),
    goodsValueAccountId: id.nullable().optional(),
    ownerPhone: phone.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "لا توجد تغييرات");
export const accountLinkSchema = z
  .object({ accountId: id.nullable() })
  .strict();
export const currencySchema = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/),
    name,
    decimalPlaces: z.number().int().min(0).max(6),
    active: z.boolean().default(true),
  })
  .strict();
export const currencyPatchSchema = z
  .object({ name: name.optional(), active: z.boolean().optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "لا توجد تغييرات");
export const currenciesInitializeSchema = z
  .object({
    baseCurrency: z
      .string()
      .trim()
      .toUpperCase()
      .pipe(z.enum(["YER", "SAR", "USD"]))
      .default("YER"),
  })
  .strict();
export const financeSettingsSchema = z.object({ baseCurrencyId: id }).strict();
export function normalizeRate(value: string): string {
  const [integer, fractional = ""] = value.split(".");
  const whole = integer.replace(/^0+(?=\d)/, "");
  const fraction = fractional.replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}
export const rateSchema = z
  .string()
  .trim()
  .transform((value) => normalizeDigits(value).replace(/٫/g, "."))
  .pipe(
    z
      .string()
      .regex(
        /^\d{1,16}(?:\.\d{1,12})?$/,
        "السعر يتطلب نصًا عشريًا حتى 16 رقمًا صحيحًا و12 رقمًا كسريًا",
      )
      .refine((value) => /[1-9]/.test(value), "سعر الصرف يجب أن يكون موجبًا"),
  )
  .transform(normalizeRate);
export const effectiveAtSchema = z.iso
  .datetime({ offset: true })
  .refine((value) => {
    const fraction = value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1];
    return fraction === undefined || fraction.length <= 3;
  }, "وقت السريان يدعم حتى ثلاثة أرقام كسرية للثانية")
  .refine((value) => {
    const instant = new Date(value);
    return (
      Number(value.slice(0, 4)) >= 1 &&
      Number.isFinite(instant.getTime()) &&
      instant.getUTCFullYear() >= 1 &&
      instant.getUTCFullYear() <= 9999
    );
  }, "وقت السريان غير صالح")
  .transform((value) => new Date(value).toISOString());
export const exchangeRateSchema = z
  .object({
    currencyId: id,
    rate: rateSchema,
    effectiveAt: effectiveAtSchema,
    source: z.string().trim().min(1, "مصدر السعر مطلوب").max(200),
  })
  .strict();
export const exchangeRatePatchSchema = z
  .object({ active: z.boolean() })
  .strict();
export const branchSchema = z
  .object({
    code: siteCode,
    name,
    phone: phone.default(""),
    address: z.string().trim().max(500).default(""),
    active: z.boolean().default(true),
  })
  .strict();
export const branchPatchSchema = z
  .object({
    name: name.optional(),
    phone: phone.optional(),
    address: z.string().trim().max(500).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "لا توجد تغييرات");
export const locationSchema = z
  .object({ branchId: id, code: siteCode, name, kind: z.enum(locationKinds) })
  .strict();
export const locationPatchSchema = currencyPatchSchema;
export const emptyInitializeSchema = z.object({}).strict();
export type AccountInput = z.input<typeof accountSchema>;
export type CompanyCurrencyInput = z.input<typeof currencySchema>;
export type ExchangeRateInput = z.input<typeof exchangeRateSchema>;
export type BranchInput = z.input<typeof branchSchema>;
export type LocationInput = z.input<typeof locationSchema>;
export const masterCatalog = {
  accountKinds,
  accountCategories,
  normalSides,
  accountLinkPurposes,
  locationKinds,
  accountKindLabels,
  accountCategoryLabels,
  normalSideLabels,
  accountLinkLabels,
  accountLinkCategories,
  locationKindLabels,
};
