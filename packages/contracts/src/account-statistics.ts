import { z } from "zod";

/** Shared policy for the staged account statistics engine. */
export const ACCOUNT_STATISTICS_POLICY_VERSION = 1;
export const ACCOUNT_STATISTICS_TIME_ZONE = "Asia/Aden";
/** JavaScript weekday numbering: Saturday is 6. */
export const ACCOUNT_STATISTICS_WEEK_START = 6;

export const accountStatisticsStates = [
  "uncomputed",
  "stale",
  "ready",
] as const;
export type AccountStatisticsState = (typeof accountStatisticsStates)[number];

export const accountStatisticsComponents = [
  "balance",
  "activity",
  "commerce",
  "stock",
] as const;
export type AccountStatisticsComponent =
  (typeof accountStatisticsComponents)[number];

/** Revisions are exact BIGINT strings, independently of record IDs. */
export type AccountStatisticsComponentMetadata =
  | {
      state: "uncomputed";
      computedRevision: null;
      asOfDate: null;
      computedAt: null;
    }
  | {
      state: "stale" | "ready";
      computedRevision: string;
      asOfDate: string;
      computedAt: string;
    };

export interface AccountStatisticsMetadata {
  companyId: number;
  accountId: number;
  policyVersion: number;
  /** Advanced transactionally when a financial source changes. */
  sourceRevision: string;
  components: Record<
    AccountStatisticsComponent,
    AccountStatisticsComponentMetadata
  >;
  createdAt: string;
  updatedAt: string;
}

export const accountDailyActivityFamilies = [
  "ledger",
  "activity",
  "sale",
  "purchase",
  "purchase_cash",
  "payment",
  "receipt",
] as const;
export type AccountDailyActivityFamily =
  (typeof accountDailyActivityFamilies)[number];

const balanceDate = z.iso
  .date()
  .refine((value) => value >= "0003-01-01", "تاريخ الرصيد غير صالح");
const signedBalance = z
  .string()
  .trim()
  .regex(
    /^-?\d{1,32}(?:\.\d{1,6})?$/,
    "الرصيد نص عشري دقيق حتى 32 رقمًا و6 كسور",
  )
  .transform((value) => {
    const negative = value.startsWith("-");
    const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
    const normalized =
      whole!.replace(/^0+(?=\d)/, "") +
      (fraction.replace(/0+$/, "") ? `.${fraction.replace(/0+$/, "")}` : "");
    return negative && normalized !== "0" ? `-${normalized}` : normalized;
  });
const sourceRevision = z
  .string()
  .regex(/^(0|[1-9]\d{0,18})$/)
  .refine(
    (value) => BigInt(value) <= 9223372036854775807n,
    "إصدار المصدر غير صالح",
  );
export const accountStatisticsQuerySchema = z
  .object({ asOfDate: balanceDate.optional() })
  .strict();
export const accountBalanceFollowUpSchema = z
  .object({
    idempotencyKey: z.uuid(),
    note: z.string().trim().max(2000).default(""),
  })
  .strict();
export const accountBalanceApprovalSchema = accountBalanceFollowUpSchema
  .extend({
    balanceDate,
    expectedBalanceBase: signedBalance,
    expectedCurrencyId: z.number().int().positive().max(2_147_483_647),
    expectedSourceRevision: sourceRevision,
    expectedSourceGeneration: z
      .uuid()
      .transform((value) => value.toLowerCase()),
  })
  .strict();
export type AccountBalanceFollowUpInput = z.input<
  typeof accountBalanceFollowUpSchema
>;
export type AccountBalanceApprovalInput = z.input<
  typeof accountBalanceApprovalSchema
>;

export interface AccountBalanceCurrency {
  id: number;
  code: string;
  decimalPlaces: number;
}
export interface AccountBalanceFollowUp {
  id: number;
  companyId: number;
  accountId: number;
  followedUpAt: string;
  createdBy: number;
  createdAt: string;
  note: string;
}
export interface AccountBalanceApproval {
  id: number;
  companyId: number;
  accountId: number;
  balanceDate: string;
  balanceBase: string;
  currency: AccountBalanceCurrency;
  sourceRevision: string;
  sourceGeneration: string | null;
  policyVersion: number;
  createdBy: number;
  createdAt: string;
  note: string;
}
export type AccountBalanceApprovalQuote = Omit<
  z.output<typeof accountBalanceApprovalSchema>,
  "idempotencyKey" | "note"
>;
export interface AccountBalanceStatistics {
  companyId: number;
  accountId: number;
  asOfDate: string;
  policyVersion: number;
  sourceRevision: string;
  sourceGeneration: string;
  coverage: "recorded_history_only";
  currency: AccountBalanceCurrency;
  balance: {
    currentBase: string;
    oneYearAgoBase: string;
    atCurrentYearStartBase: string;
    atPreviousYearStartBase: string;
    atTwoYearsAgoStartBase: string;
  };
  components: {
    balance: AccountStatisticsComponentMetadata;
    activity: AccountStatisticsComponentMetadata | null;
    commerce: AccountStatisticsComponentMetadata | null;
    stock: AccountStatisticsComponentMetadata;
  };
  lastFollowUp: AccountBalanceFollowUp | null;
  lastApproval: AccountBalanceApproval | null;
  approvalQuote: AccountBalanceApprovalQuote;
  capabilities: { canFollowUp: boolean; canApprove: boolean };
  operations: AccountOperationStatistics;
}

export const accountOperationPeriods = [
  "oneMonth",
  "fourMonths",
  "currentMonth",
  "previousMonth",
  "twoMonthsAgo",
  "last30Days",
  "last7Days",
  "currentWeek",
] as const;
export type AccountOperationPeriod = (typeof accountOperationPeriods)[number];
export interface AccountOperationReference {
  sourceKind: "invoice" | "financial_document";
  sourceId: number;
  documentNumber: string;
  documentDate: string;
  currency: AccountBalanceCurrency;
  baseCurrency: AccountBalanceCurrency;
  amount: string;
  baseAmount: string;
  isCorrection: boolean;
}
export interface AccountOperationFamilyStatistics {
  documentsAllTime: string;
  documentsFourMonths: string;
  totalsBase: Record<AccountOperationPeriod, string>;
  last: AccountOperationReference | null;
}
export interface AccountOperationVisibility {
  ledger: boolean;
  sale: boolean;
  purchase: boolean;
  purchaseCash: boolean;
  payment: boolean;
  receipt: boolean;
  activity: boolean;
}
export interface AccountOperationStatistics {
  availability: AccountOperationVisibility;
  periods: Record<AccountOperationPeriod, { from: string; to: string }>;
  activity: {
    documentsAllTime: string;
    documentsFourMonths: string;
    last: AccountOperationReference | null;
  } | null;
  sale: AccountOperationFamilyStatistics | null;
  purchase:
    | (AccountOperationFamilyStatistics & {
        /** NULL if any purchase in this window has an unknown cash classification. */
        cashPurchasesFourMonthsBase: string | null;
        knownCashPurchasesFourMonthsBase: string;
        quality: {
          cashClassificationUnknownFourMonths: string;
          supplierConflictsFourMonths: string;
          /** Company-wide coverage, never an attribution of unknown invoices to this account. */
          companyUnknownSupplierDocumentsFourMonths: string;
        };
      })
    | null;
  payment: AccountOperationFamilyStatistics | null;
  receipt: AccountOperationFamilyStatistics | null;
}
