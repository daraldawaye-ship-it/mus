import { z } from "zod";
import { accountCategories, accountChoices } from "./masters.ts";
import type {
  AccountBalanceCurrency,
  AccountBalanceStatistics,
  AccountOperationPeriod,
  AccountOperationReference,
} from "./account-statistics.ts";

export const accountStatisticsReportGroupLabels = {
  balances: "الأرصدة والمتابعة",
  purchases: "المشتريات",
  activity: "أعداد الحركات",
  latestDates: "تواريخ آخر العمليات",
  latestAmounts: "مبالغ آخر العمليات",
  periods: "إجماليات الفترات",
  stock: "قيمة الأصناف الحالية",
} as const;
export type AccountStatisticsReportGroup =
  keyof typeof accountStatisticsReportGroupLabels;
export interface AccountStatisticsMetricDefinition {
  key: string;
  label: string;
  kind: "money" | "count" | "date" | "datetime";
  group: AccountStatisticsReportGroup;
  family:
    | "balance"
    | "followup"
    | "approval"
    | "activity"
    | "sale"
    | "purchase"
    | "payment"
    | "receipt"
    | "stock";
  source:
    | "balance"
    | "followup"
    | "approval"
    | "count"
    | "lastDate"
    | "lastAmount"
    | "total"
    | "cashFourMonths"
    | "stock";
  balanceField?:
    | "oneYearAgoBase"
    | "atCurrentYearStartBase"
    | "atPreviousYearStartBase"
    | "atTwoYearsAgoStartBase";
  operationFamily?: "activity" | "sale" | "purchase" | "payment" | "receipt";
  period?: AccountOperationPeriod | "allTime";
}
const metric = (definition: AccountStatisticsMetricDefinition) => definition;
export const accountStatisticsMetricDefinitions: readonly AccountStatisticsMetricDefinition[] =
  [
    metric({
      key: "lastBalanceFollowUpAt",
      label: "آخر متابعة مسجّلة للرصيد",
      kind: "datetime",
      group: "balances",
      family: "followup",
      source: "followup",
    }),
    metric({
      key: "lastApprovedBalanceBase",
      label: "رصيد آخر اعتماد",
      kind: "money",
      group: "balances",
      family: "approval",
      source: "approval",
    }),
    ...(
      [
        ["balanceOneYearAgoBase", "الرصيد قبل سنة", "oneYearAgoBase"],
        [
          "balanceAtCurrentYearStartBase",
          "الرصيد بداية هذا العام",
          "atCurrentYearStartBase",
        ],
        [
          "balanceAtPreviousYearStartBase",
          "الرصيد بداية العام الماضي",
          "atPreviousYearStartBase",
        ],
        [
          "balanceAtTwoYearsAgoStartBase",
          "الرصيد بداية العام قبل الماضي",
          "atTwoYearsAgoStartBase",
        ],
      ] as const
    ).map(([key, label, balanceField]) =>
      metric({
        key,
        label,
        balanceField,
        kind: "money",
        group: "balances",
        family: "balance",
        source: "balance",
      }),
    ),
    metric({
      key: "cashPurchasesFourMonthsBase",
      label: "المشتريات النقدية آخر أربعة أشهر",
      kind: "money",
      group: "purchases",
      family: "purchase",
      source: "cashFourMonths",
      operationFamily: "purchase",
      period: "fourMonths",
    }),
    metric({
      key: "purchasesFourMonthsBase",
      label: "المشتريات آخر أربعة أشهر",
      kind: "money",
      group: "purchases",
      family: "purchase",
      source: "total",
      operationFamily: "purchase",
      period: "fourMonths",
    }),
    metric({
      key: "purchasesOneMonthBase",
      label: "المشتريات آخر شهر",
      kind: "money",
      group: "purchases",
      family: "purchase",
      source: "total",
      operationFamily: "purchase",
      period: "oneMonth",
    }),
    ...(
      [
        [
          "activityDocumentsAllTime",
          "عدد الحركات منذ البداية",
          "activity",
          "allTime",
        ],
        [
          "activityDocumentsFourMonths",
          "عدد الحركات آخر أربعة أشهر",
          "activity",
          "fourMonths",
        ],
        [
          "purchaseDocumentsFourMonths",
          "عدد المشتريات آخر أربعة أشهر",
          "purchase",
          "fourMonths",
        ],
        [
          "saleDocumentsFourMonths",
          "عدد المبيعات آخر أربعة أشهر",
          "sale",
          "fourMonths",
        ],
        [
          "paymentDocumentsFourMonths",
          "عدد الصرف آخر أربعة أشهر",
          "payment",
          "fourMonths",
        ],
        [
          "receiptDocumentsFourMonths",
          "عدد القبض آخر أربعة أشهر",
          "receipt",
          "fourMonths",
        ],
        [
          "saleDocumentsAllTime",
          "عدد حركات المبيعات منذ البداية",
          "sale",
          "allTime",
        ],
      ] as const
    ).map(([key, label, operationFamily, period]) =>
      metric({
        key,
        label,
        operationFamily,
        period,
        family: operationFamily,
        source: "count",
        kind: "count",
        group: "activity",
      }),
    ),
    ...(
      [
        ["activity", "Activity", "حركة"],
        ["sale", "Sale", "بيع"],
        ["purchase", "Purchase", "شراء"],
        ["payment", "Payment", "صرف"],
        ["receipt", "Receipt", "قبض"],
      ] as const
    ).map(([operationFamily, suffix, label]) =>
      metric({
        key: `last${suffix}Date`,
        label: `تاريخ آخر ${label}`,
        family: operationFamily,
        operationFamily,
        source: "lastDate",
        kind: "date",
        group: "latestDates",
      }),
    ),
    ...(
      [
        ["payment", "Payment", "صرف"],
        ["receipt", "Receipt", "قبض"],
        ["sale", "Sale", "بيع"],
        ["purchase", "Purchase", "شراء"],
      ] as const
    ).map(([operationFamily, suffix, label]) =>
      metric({
        key: `last${suffix}Amount`,
        label: `مبلغ آخر ${label}`,
        family: operationFamily,
        operationFamily,
        source: "lastAmount",
        kind: "money",
        group: "latestAmounts",
      }),
    ),
    metric({
      key: "assignedItemsStockValueBase",
      label: "قيمة الأصناف المنسوبة الحالية",
      kind: "money",
      group: "stock",
      family: "stock",
      source: "stock",
    }),
    ...(
      [
        ["currentMonth", "CurrentMonth", "الشهر الحالي"],
        ["previousMonth", "PreviousMonth", "الشهر السابق"],
        ["twoMonthsAgo", "TwoMonthsAgo", "الشهر قبل السابق"],
        ["last30Days", "Last30Days", "آخر 30 يومًا"],
        ["last7Days", "Last7Days", "آخر 7 أيام"],
        ["currentWeek", "CurrentWeek", "الأسبوع الحالي"],
      ] as const
    ).flatMap(([period, suffix, periodLabel]) =>
      (
        [
          ["payment", "payments", "الصرف"],
          ["receipt", "receipts", "القبض"],
          ["purchase", "purchases", "المشتريات"],
          ["sale", "sales", "المبيعات"],
        ] as const
      ).map(([operationFamily, prefix, label]) =>
        metric({
          key: `${prefix}${suffix}Base`,
          label: `${label} — ${periodLabel}`,
          family: operationFamily,
          operationFamily,
          period,
          source: "total",
          kind: "money",
          group: "periods",
        }),
      ),
    ),
  ];
export const accountStatisticsMetricByKey = (key: string) =>
  accountStatisticsMetricDefinitions.find(
    (definition) => definition.key === key,
  );
const defaults = accountStatisticsMetricDefinitions
  .filter((definition) => definition.group === "balances")
  .map((definition) => definition.key)
  .join(",");
const metrics = z
  .string()
  .default(defaults)
  .transform((value) => value.split(","))
  .pipe(
    z
      .array(
        z
          .string()
          .refine(
            (key) => !!accountStatisticsMetricByKey(key),
            "مؤشر غير صالح",
          ),
      )
      .min(1)
      .max(8),
  )
  .refine((keys) => new Set(keys).size === keys.length, "المؤشرات مكررة");
const integer = (fallback: string, max: number) =>
  z
    .string()
    .regex(/^[1-9]\d*$/)
    .default(fallback)
    .transform(Number)
    .pipe(z.number().int().min(1).max(max));
export const accountStatisticsReportQuerySchema = z
  .object({
    q: z.string().trim().max(120).default(""),
    page: integer("1", 1_000_000),
    pageSize: integer("20", 100),
    active: z.enum(["all", "active", "archived"]).default("active"),
    category: z.enum(["all", ...accountCategories]).default("all"),
    accountChoice: z.enum(["all", "unset", ...accountChoices]).default("all"),
    asOfDate: z.iso
      .date()
      .refine((date) => date >= "0003-01-01")
      .optional(),
    metrics,
    sort: z
      .string()
      .default("code:asc")
      .transform((value) =>
        value.split(",").map((part) => {
          const [key, direction, extra] = part.split(":");
          return {
            key: key ?? "",
            desc: direction === "desc",
            valid: !extra && ["asc", "desc"].includes(direction ?? ""),
          };
        }),
      )
      .pipe(
        z
          .array(
            z.object({
              key: z.string(),
              desc: z.boolean(),
              valid: z.literal(true),
            }),
          )
          .min(1)
          .max(5),
      ),
  })
  .strict()
  .superRefine((query, context) => {
    const keys = query.sort.map((sort) => sort.key);
    if (
      new Set(keys).size !== keys.length ||
      keys.some(
        (key) => !["code", "name", "active", ...query.metrics].includes(key),
      )
    )
      context.addIssue({
        code: "custom",
        path: ["sort"],
        message: "ترتيب النتائج غير صالح أو مكرر",
      });
  });
export type AccountStatisticsReportQuery = z.output<
  typeof accountStatisticsReportQuerySchema
>;
export interface AccountStatisticsReportCell {
  value: string | null;
  currencyCode: string | null;
  baseAmount: string | null;
  baseCurrencyCode: string | null;
  source: {
    sourceKind: "invoice" | "financial_document";
    sourceId: number;
    documentNumber: string;
  } | null;
  unavailableReason: "restricted" | "none" | "unknown" | null;
}
export interface AccountStatisticsReport {
  companyId: number;
  asOfDate: string;
  currentStockDate: string;
  currency: AccountBalanceCurrency;
  coverage: "recorded_history_only";
  metrics: Array<AccountStatisticsMetricDefinition & { available: boolean }>;
  rows: Array<{
    account: {
      id: number;
      code: string;
      name: string;
      active: boolean;
      category: (typeof accountCategories)[number];
      accountChoice: (typeof accountChoices)[number] | null;
    };
    values: Record<string, AccountStatisticsReportCell>;
  }>;
  total: number;
  page: number;
  pageSize: number;
}
export function accountStatisticCell(
  statistics: AccountBalanceStatistics,
  key: string,
): AccountStatisticsReportCell {
  const definition = accountStatisticsMetricByKey(key);
  const cell: AccountStatisticsReportCell = {
    value: null,
    currencyCode: null,
    baseAmount: null,
    baseCurrencyCode: null,
    source: null,
    unavailableReason: "none",
  };
  if (!definition) return cell;
  const money = (
    value: string | null,
    currency = statistics.currency.code,
  ) => ({
    ...cell,
    value,
    currencyCode: currency,
    baseAmount: value,
    baseCurrencyCode: currency,
    unavailableReason: value === null ? ("none" as const) : null,
  });
  if (definition.source === "balance")
    return money(statistics.balance[definition.balanceField!]);
  if (definition.source === "followup")
    return {
      ...cell,
      value: statistics.lastFollowUp?.followedUpAt ?? null,
      unavailableReason: statistics.lastFollowUp ? null : "none",
    };
  if (definition.source === "approval")
    return statistics.lastApproval
      ? money(
          statistics.lastApproval.balanceBase,
          statistics.lastApproval.currency.code,
        )
      : cell;
  if (definition.source === "stock")
    return statistics.stock
      ? money(statistics.stock.valueBase, statistics.stock.currency.code)
      : { ...cell, unavailableReason: "restricted" };
  const family = statistics.operations[definition.operationFamily!];
  if (!family) return { ...cell, unavailableReason: "restricted" };
  if (definition.source === "count")
    return {
      ...cell,
      value:
        definition.period === "allTime"
          ? family.documentsAllTime
          : family.documentsFourMonths,
      unavailableReason: null,
    };
  if (definition.source === "cashFourMonths") {
    const value = statistics.operations.purchase!.cashPurchasesFourMonthsBase;
    return {
      ...money(value),
      unavailableReason: value === null ? "unknown" : null,
    };
  }
  if (definition.source === "total" && "totalsBase" in family)
    return money(
      family.totalsBase[definition.period as AccountOperationPeriod],
    );
  const last: AccountOperationReference | null = family.last;
  if (!last) return cell;
  return {
    ...cell,
    value: definition.source === "lastDate" ? last.documentDate : last.amount,
    currencyCode:
      definition.source === "lastAmount" ? last.currency.code : null,
    baseAmount: last.baseAmount,
    baseCurrencyCode: last.baseCurrency.code,
    source: {
      sourceKind: last.sourceKind,
      sourceId: last.sourceId,
      documentNumber: last.documentNumber,
    },
    unavailableReason: null,
  };
}
