import type { PoolClient, QueryResultRow } from "pg";
import {
  accountOperationPeriods,
  type AccountOperationFamilyStatistics,
  type AccountOperationPeriod,
  type AccountOperationReference,
  type AccountOperationStatistics,
  type AccountOperationVisibility,
  type AccountStatisticsComponentMetadata,
} from "../../../../packages/contracts/src/index.ts";
import { conflict } from "./masters.ts";

const decimal = (value: string): string => {
  const normalized = value.includes(".")
    ? value.replace(/0+$/, "").replace(/\.$/, "")
    : value;
  return normalized === "-0" ? "0" : normalized;
};
function reference(
  row: QueryResultRow | undefined,
): AccountOperationReference | null {
  return row
    ? {
        sourceKind: row.source_kind,
        sourceId: row.source_id,
        documentNumber: row.source_number,
        documentDate: row.day,
        currency: {
          id: row.currency_id,
          code: row.currency_code,
          decimalPlaces: row.decimal_places,
        },
        baseCurrency: {
          id: row.base_currency_id,
          code: row.base_currency_code,
          decimalPlaces: row.base_decimal_places,
        },
        amount: decimal(row.amount),
        baseAmount: decimal(row.base_amount),
        isCorrection: row.is_correction,
      }
    : null;
}
const periodSql = `SELECT name,first_day::text AS first_day,last_day::text AS last_day FROM (VALUES
  ('oneMonth',($1::date-interval '1 month')::date+1,$1::date),
  ('fourMonths',($1::date-interval '4 months')::date+1,$1::date),
  ('currentMonth',date_trunc('month',$1::date)::date,$1::date),
  ('previousMonth',(date_trunc('month',$1::date)-interval '1 month')::date,date_trunc('month',$1::date)::date-1),
  ('twoMonthsAgo',(date_trunc('month',$1::date)-interval '2 months')::date,(date_trunc('month',$1::date)-interval '1 month')::date-1),
  ('last30Days',$1::date-29,$1::date),
  ('last7Days',$1::date-6,$1::date),
  ('currentWeek',$1::date-((extract(dow FROM $1::date)::integer+1)%7),$1::date)
) AS periods(name,first_day,last_day)`;

export async function readAccountOperations(
  client: PoolClient,
  companyId: number,
  accountId: number,
  asOfDate: string,
  visibility: AccountOperationVisibility,
): Promise<{
  operations: AccountOperationStatistics;
  activityMetadata: AccountStatisticsComponentMetadata | null;
  commerceMetadata: AccountStatisticsComponentMetadata | null;
}> {
  const periodRows = (await client.query(periodSql, [asOfDate])).rows;
  const periods = Object.fromEntries(
    periodRows.map((row) => [
      row.name,
      { from: row.first_day, to: row.last_day },
    ]),
  ) as AccountOperationStatistics["periods"];
  const operations: AccountOperationStatistics = {
    availability: visibility,
    periods,
    activity: null,
    sale: null,
    purchase: null,
    payment: null,
    receipt: null,
  };
  const allowedFamilies = [
    ...(visibility.activity ? ["activity"] : []),
    ...(visibility.sale ? ["sale"] : []),
    ...(visibility.purchase
      ? ["purchase", ...(visibility.purchaseCash ? ["purchase_cash"] : [])]
      : []),
    ...(visibility.payment ? ["payment"] : []),
    ...(visibility.receipt ? ["receipt"] : []),
  ];
  if (!allowedFamilies.length)
    return { operations, activityMetadata: null, commerceMetadata: null };
  // A derived cache can be rebuilt internally; every data SELECT below limits
  // its families to the viewer's current grants before reading totals/refs.
  const refreshed = await client.query(
    "SELECT refresh_account_activity_statistics($1,$2,$3::date) AS ready",
    [companyId, accountId, asOfDate],
  );
  if (!refreshed.rows[0].ready)
    conflict("تعذر احتساب إحصاءات الحركات بالعملة الأساسية الحالية");
  const metadataRow = (
    await client.query(
      `SELECT source_revision,activity_state,activity_computed_revision,
    activity_as_of_date::text AS activity_date,activity_computed_at,
    commerce_state,commerce_computed_revision,commerce_as_of_date::text AS commerce_date,commerce_computed_at
    FROM account_statistics WHERE company_id=$1 AND account_id=$2`,
      [companyId, accountId],
    )
  ).rows[0]!;
  const metadata = (
    component: "activity" | "commerce",
  ): AccountStatisticsComponentMetadata => ({
    state: metadataRow[`${component}_state`],
    computedRevision: metadataRow[`${component}_computed_revision`],
    asOfDate: metadataRow[`${component}_date`],
    computedAt: (metadataRow[`${component}_computed_at`] as Date).toISOString(),
  });
  const totals = (
    await client.query(
      `WITH periods AS (${periodSql})
    SELECT p.name,f.family,COALESCE(sum(d.document_count),0)::text AS documents,
      COALESCE(sum(d.base_amount),0)::text AS base_amount
    FROM periods p CROSS JOIN unnest($4::text[]) AS f(family)
    LEFT JOIN account_daily_activity d ON d.company_id=$2 AND d.account_id=$3 AND d.family=f.family
      AND d.document_date BETWEEN p.first_day::date AND p.last_day::date
    GROUP BY p.name,f.family`,
      [asOfDate, companyId, accountId, allowedFamilies],
    )
  ).rows;
  const allTime = (
    await client.query(
      `SELECT family,sum(document_count)::text AS documents
    FROM account_daily_activity WHERE company_id=$1 AND account_id=$2
      AND document_date<=$3::date AND family=ANY($4::text[]) GROUP BY family`,
      [companyId, accountId, asOfDate, allowedFamilies],
    )
  ).rows;
  const latestFamilies = allowedFamilies.filter(
    (family) => family !== "purchase_cash",
  );
  const latest = (
    await client.query(
      `SELECT DISTINCT ON (family) *,document_date::text AS day,
      amount::text AS amount,base_amount::text AS base_amount
    FROM account_operation_events
    WHERE company_id=$1 AND account_id=$2 AND family=ANY($4::text[])
      AND document_date<=$3::date AND last_eligible
      AND (cancelled_on IS NULL OR cancelled_on>$3::date)
    ORDER BY family,document_date DESC,source_kind DESC,source_id DESC`,
      [companyId, accountId, asOfDate, latestFamilies],
    )
  ).rows;
  const family = (name: string): AccountOperationFamilyStatistics => ({
    documentsAllTime:
      allTime.find((row) => row.family === name)?.documents ?? "0",
    documentsFourMonths:
      totals.find((row) => row.family === name && row.name === "fourMonths")
        ?.documents ?? "0",
    totalsBase: Object.fromEntries(
      accountOperationPeriods.map((period) => [
        period,
        decimal(
          totals.find((row) => row.family === name && row.name === period)
            ?.base_amount ?? "0",
        ),
      ]),
    ) as Record<AccountOperationPeriod, string>,
    last: reference(latest.find((row) => row.family === name)),
  });
  if (visibility.activity) {
    const activity = family("activity");
    operations.activity = {
      documentsAllTime: activity.documentsAllTime,
      documentsFourMonths: activity.documentsFourMonths,
      last: activity.last,
    };
  }
  if (visibility.sale) operations.sale = family("sale");
  if (visibility.payment) operations.payment = family("payment");
  if (visibility.receipt) operations.receipt = family("receipt");
  if (visibility.purchase) {
    const fourMonths = periods.fourMonths;
    const quality = (
      await client.query(
        `SELECT
      count(*) FILTER (WHERE NOT cash_classification_known)::text AS cash_unknown,
      count(*) FILTER (WHERE supplier_conflict)::text AS supplier_conflicts
      FROM account_operation_events WHERE company_id=$1 AND account_id=$2 AND family='purchase'
        AND document_date BETWEEN $3::date AND $4::date`,
        [companyId, accountId, fourMonths.from, fourMonths.to],
      )
    ).rows[0]!;
    const companyQuality = (
      await client.query(
        `SELECT count(*)::text AS unknown_supplier FROM invoices
      WHERE company_id=$1 AND posted AND kind='purchase' AND supplier_account_id IS NULL
        AND document_date BETWEEN $2::date AND $3::date`,
        [companyId, fourMonths.from, fourMonths.to],
      )
    ).rows[0]!;
    const knownCash = visibility.purchaseCash
      ? family("purchase_cash").totalsBase.fourMonths
      : "0";
    operations.purchase = {
      ...family("purchase"),
      knownCashPurchasesFourMonthsBase: knownCash,
      cashPurchasesFourMonthsBase:
        visibility.purchaseCash && quality.cash_unknown === "0"
          ? knownCash
          : null,
      quality: {
        cashClassificationUnknownFourMonths: quality.cash_unknown,
        supplierConflictsFourMonths: quality.supplier_conflicts,
        companyUnknownSupplierDocumentsFourMonths:
          companyQuality.unknown_supplier,
      },
    };
  }
  return {
    operations,
    activityMetadata: visibility.activity ? metadata("activity") : null,
    commerceMetadata:
      visibility.sale &&
      visibility.purchase &&
      visibility.payment &&
      visibility.receipt
        ? metadata("commerce")
        : null,
  };
}
