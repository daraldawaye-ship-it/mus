/** The storage foundation only; no statistics endpoint is enabled by this module. */
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
  /** The later calculation engine will advance this transactionally. */
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
