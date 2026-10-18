import type { PoolClient, QueryResultRow } from "pg";
import type { z } from "zod";
import {
  accountStatisticsMetricByKey,
  accountStatisticsReportQuerySchema,
  type AccountStatisticsReport,
  type AccountStatisticsReportCell,
  type User,
} from "../../../../packages/contracts/src/index.ts";
import { HttpError } from "../errors.ts";
import { balanceDate } from "./account-balances.ts";
import { conflict } from "./masters.ts";
import { accountActivityVisibility, directoryEntries } from "./pages.ts";

type Filters = z.output<typeof accountStatisticsReportQuerySchema>;
type Metric = NonNullable<ReturnType<typeof accountStatisticsMetricByKey>>;
type Cell = AccountStatisticsReportCell;

// All SQL expressions below come from this code or shared registered metric
// descriptors. Neither metric keys nor query values are SQL identifiers.
const periods: Record<string, { from: string; to: string }> = {
  allTime: { from: "DATE '0001-01-01'", to: "$2::date" },
  oneMonth: { from: "($2::date-interval '1 month')::date+1", to: "$2::date" },
  fourMonths: {
    from: "($2::date-interval '4 months')::date+1",
    to: "$2::date",
  },
  currentMonth: { from: "date_trunc('month',$2::date)::date", to: "$2::date" },
  previousMonth: {
    from: "(date_trunc('month',$2::date)-interval '1 month')::date",
    to: "date_trunc('month',$2::date)::date-1",
  },
  twoMonthsAgo: {
    from: "(date_trunc('month',$2::date)-interval '2 months')::date",
    to: "(date_trunc('month',$2::date)-interval '1 month')::date-1",
  },
  last30Days: { from: "$2::date-29", to: "$2::date" },
  last7Days: { from: "$2::date-6", to: "$2::date" },
  currentWeek: {
    from: "$2::date-((extract(dow FROM $2::date)::integer+1)%7)",
    to: "$2::date",
  },
};
const balancePredicates: Record<string, string> = {
  oneYearAgoBase: "d.document_date<=($2::date-interval '1 year')::date",
  atCurrentYearStartBase: "d.document_date<date_trunc('year',$2::date)::date",
  atPreviousYearStartBase:
    "d.document_date<(date_trunc('year',$2::date)-interval '1 year')::date",
  atTwoYearsAgoStartBase:
    "d.document_date<(date_trunc('year',$2::date)-interval '2 years')::date",
};
const identity = "a.id,a.code,a.name,a.active,a.category,a.account_choice";
const configuration = `configuration AS (SELECT $1::integer company_id,$2::date as_of_date,
  $3::integer currency_id,$4::text currency_code,$5::uuid generation,$6::date stock_date)`;
const candidate = `SELECT ${identity} FROM accounts a
  WHERE a.company_id=$1 AND a.kind='posting'
    AND ($7::text='' OR a.code ILIKE '%'||$7||'%' OR a.name ILIKE '%'||$7||'%')
    AND ($8::text='all' OR a.active=($8='active'))
    AND ($9::text='all' OR a.category=$9)
    AND ($10::text='all' OR ($10='unset' AND a.account_choice IS NULL) OR a.account_choice=$10)`;

function numeric(expression: string): string {
  return `trim_scale(${expression})::text`;
}
function cellSql(input: {
  value: string;
  currency?: string;
  baseAmount?: string;
  baseCurrency?: string;
  source?: string;
  reason?: string;
}): string {
  return `jsonb_build_object('value',${input.value},
    'currencyCode',${input.currency ?? "NULL::text"},
    'baseAmount',${input.baseAmount ?? "NULL::text"},
    'baseCurrencyCode',${input.baseCurrency ?? "NULL::text"},
    'source',${input.source ?? "NULL::jsonb"},
    'unavailableReason',${input.reason ?? "NULL::text"})`;
}

interface Projection {
  sql: string;
  sortExpressions: Map<string, string>;
}

/** One bounded source query, with only the requested and permitted families. */
function projection(
  scopeSql: string,
  metrics: Metric[],
  allowed: (metric: Metric) => boolean,
): Projection {
  const available = metrics.filter(allowed);
  const balances = available.filter((m) => m.source === "balance");
  const operationMetrics = available.filter((m) =>
    ["count", "lastDate", "lastAmount", "total", "cashFourMonths"].includes(
      m.source,
    ),
  );
  const needsFollowUp = available.some((m) => m.source === "followup");
  const needsApproval = available.some((m) => m.source === "approval");
  const needsStock = available.some((m) => m.source === "stock");
  const ctes = [
    // Explicit casts keep the parameter contract stable even for a report
    // which needs no ledger, currency-dependent total or stock calculation.
    configuration,
    `scope AS MATERIALIZED (${scopeSql})`,
  ];
  const joins: string[] = [];
  const aliases = new Map(
    metrics.map((metric, index) => [metric.key, `m${index}`]),
  );
  const values = new Map<string, string>();
  const sorts = new Map<string, string>();
  if (balances.length) {
    ctes.push(`balances AS (
      SELECT l.account_id,${balances
        .map(
          (m) =>
            `COALESCE(sum(l.base_debit-l.base_credit) FILTER (WHERE ${balancePredicates[m.balanceField!]}),0) AS ${aliases.get(m.key)}`,
        )
        .join(",")}
      FROM financial_document_lines l
      JOIN scope s ON s.id=l.account_id
      JOIN financial_documents d ON d.company_id=l.company_id AND d.id=l.document_id
      WHERE l.company_id=$1 AND d.status IN ('posted','reversed') AND d.document_date<=$2::date
      GROUP BY l.account_id
    )`);
    joins.push("LEFT JOIN balances b ON b.account_id=s.id");
    for (const metric of balances) {
      const expression = `COALESCE(b.${aliases.get(metric.key)},0)`;
      sorts.set(metric.key, expression);
      values.set(
        metric.key,
        cellSql({
          value: numeric(expression),
          currency: "$4::text",
          baseAmount: numeric(expression),
          baseCurrency: "$4::text",
        }),
      );
    }
  }
  if (needsFollowUp) {
    ctes.push(`followups AS (
      SELECT DISTINCT ON (f.account_id) f.account_id,f.followed_up_at
      FROM account_balance_followups f JOIN scope s ON s.id=f.account_id
      WHERE f.company_id=$1 ORDER BY f.account_id,f.followed_up_at DESC,f.id DESC
    )`);
    joins.push("LEFT JOIN followups f ON f.account_id=s.id");
  }
  if (needsApproval) {
    ctes.push(`approvals AS (
      SELECT DISTINCT ON (a.account_id) a.account_id,a.balance_base,a.base_currency_code
      FROM account_balance_approvals a JOIN scope s ON s.id=a.account_id
      WHERE a.company_id=$1 AND a.source_generation=$5::uuid
      ORDER BY a.account_id,a.created_at DESC,a.id DESC
    )`);
    joins.push("LEFT JOIN approvals approved ON approved.account_id=s.id");
  }
  if (needsStock) {
    ctes.push(`stock AS (
      SELECT i.supplier_account_id AS account_id,COALESCE(sum(COALESCE(v.value_base,0)),0) AS value_base
      FROM items i JOIN scope s ON s.id=i.supplier_account_id
      LEFT JOIN stock_item_valuations v ON v.company_id=i.company_id AND v.item_id=i.id
      WHERE i.company_id=$1 GROUP BY i.supplier_account_id
    )`);
    joins.push("LEFT JOIN stock stock ON stock.account_id=s.id");
  }
  let currencyMismatch = "false";
  if (operationMetrics.length) {
    const families = new Set<string>();
    for (const metric of operationMetrics) {
      families.add(metric.operationFamily!);
      if (metric.source === "cashFourMonths") families.add("purchase_cash");
    }
    const familySql = [...families].map((name) => `'${name}'`).join(",");
    const needsAllTime = operationMetrics.some(
      (m) =>
        ["lastDate", "lastAmount"].includes(m.source) || m.period === "allTime",
    );
    const starts = operationMetrics.map(
      (m) =>
        periods[
          m.source === "cashFourMonths" ? "fourMonths" : (m.period ?? "allTime")
        ]!.from,
    );
    const from = needsAllTime
      ? ""
      : `AND e.document_date>=LEAST(${starts.join(",")})`;
    ctes.push(`events AS MATERIALIZED (
      SELECT e.* FROM account_operation_events e JOIN scope s ON s.id=e.account_id
      WHERE e.company_id=$1 AND e.document_date<=$2::date AND e.family IN (${familySql}) ${from}
    )`);
    currencyMismatch = `EXISTS(SELECT 1 FROM events e WHERE e.base_currency_id<>$3::integer AND e.base_amount<>0)`;
    const aggregateMetrics = operationMetrics.filter((m) =>
      ["count", "total", "cashFourMonths"].includes(m.source),
    );
    if (aggregateMetrics.length) {
      const aggregates = aggregateMetrics.map((metric) => {
        const period =
          periods[
            metric.source === "cashFourMonths"
              ? "fourMonths"
              : (metric.period ?? "allTime")
          ]!;
        const window = `e.document_date BETWEEN ${period.from} AND ${period.to}`;
        const family = `e.family='${metric.operationFamily}'`;
        const expression =
          metric.source === "count"
            ? `count(*) FILTER (WHERE ${family} AND ${window})`
            : metric.source === "cashFourMonths"
              ? `CASE WHEN count(*) FILTER (WHERE e.family='purchase' AND NOT e.cash_classification_known AND ${window})>0 THEN NULL::numeric ELSE COALESCE(sum(e.base_amount) FILTER (WHERE e.family='purchase_cash' AND ${window}),0) END`
              : `COALESCE(sum(e.base_amount) FILTER (WHERE ${family} AND ${window}),0)`;
        return `${expression} AS ${aliases.get(metric.key)}`;
      });
      ctes.push(
        `totals AS (SELECT e.account_id,${aggregates.join(",")} FROM events e GROUP BY e.account_id)`,
      );
      joins.push("LEFT JOIN totals t ON t.account_id=s.id");
      for (const metric of aggregateMetrics) {
        const raw = `t.${aliases.get(metric.key)}`;
        // A missing aggregate row is a known zero; an existing NULL cash value
        // means unknown legacy classification and must remain NULL.
        const expression =
          metric.source === "cashFourMonths"
            ? `CASE WHEN t.account_id IS NULL THEN 0::numeric ELSE ${raw} END`
            : `COALESCE(${raw},0)`;
        sorts.set(metric.key, expression);
        values.set(
          metric.key,
          cellSql({
            value:
              metric.source === "count"
                ? `${expression}::text`
                : numeric(expression),
            ...(metric.source === "count"
              ? {}
              : {
                  currency: "$4::text",
                  baseAmount: numeric(expression),
                  baseCurrency: "$4::text",
                }),
            ...(metric.source === "cashFourMonths"
              ? {
                  reason: `CASE WHEN ${expression} IS NULL THEN 'unknown'::text ELSE NULL::text END`,
                }
              : {}),
          }),
        );
      }
    }
    const latestMetrics = operationMetrics.filter((m) =>
      ["lastDate", "lastAmount"].includes(m.source),
    );
    if (latestMetrics.length) {
      ctes.push(`latest AS (
        SELECT DISTINCT ON (e.account_id,e.family) e.* FROM events e
        WHERE e.last_eligible AND (e.cancelled_on IS NULL OR e.cancelled_on>$2::date)
        ORDER BY e.account_id,e.family,e.document_date DESC,e.source_kind DESC,e.source_id DESC
      )`);
      for (const family of new Set(
        latestMetrics.map((m) => m.operationFamily!),
      ))
        joins.push(
          `LEFT JOIN latest last_${family} ON last_${family}.account_id=s.id AND last_${family}.family='${family}'`,
        );
      for (const metric of latestMetrics) {
        const ref = `last_${metric.operationFamily}`;
        sorts.set(
          metric.key,
          `${ref}.${metric.source === "lastDate" ? "document_date" : "base_amount"}`,
        );
        values.set(
          metric.key,
          cellSql({
            value:
              metric.source === "lastDate"
                ? `${ref}.document_date::text`
                : numeric(`${ref}.amount`),
            ...(metric.source === "lastAmount"
              ? {
                  currency: `${ref}.currency_code`,
                }
              : {}),
            baseAmount: numeric(`${ref}.base_amount`),
            baseCurrency: `${ref}.base_currency_code`,
            source: `CASE WHEN ${ref}.source_id IS NULL THEN NULL::jsonb ELSE jsonb_build_object('sourceKind',${ref}.source_kind,'sourceId',${ref}.source_id,'documentNumber',${ref}.source_number) END`,
            reason: `CASE WHEN ${ref}.source_id IS NULL THEN 'none'::text ELSE NULL::text END`,
          }),
        );
      }
    }
  }
  for (const metric of available) {
    if (metric.source === "followup") {
      sorts.set(metric.key, "f.followed_up_at");
      values.set(
        metric.key,
        cellSql({
          value: `to_char(f.followed_up_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
          reason:
            "CASE WHEN f.followed_up_at IS NULL THEN 'none'::text ELSE NULL::text END",
        }),
      );
    } else if (metric.source === "approval") {
      sorts.set(metric.key, "approved.balance_base");
      values.set(
        metric.key,
        cellSql({
          value: numeric("approved.balance_base"),
          currency: "approved.base_currency_code",
          baseAmount: numeric("approved.balance_base"),
          baseCurrency: "approved.base_currency_code",
          reason:
            "CASE WHEN approved.account_id IS NULL THEN 'none'::text ELSE NULL::text END",
        }),
      );
    } else if (metric.source === "stock") {
      const expression = "COALESCE(stock.value_base,0)";
      sorts.set(metric.key, expression);
      values.set(
        metric.key,
        cellSql({
          value: numeric(expression),
          currency: "$4::text",
          baseAmount: numeric(expression),
          baseCurrency: "$4::text",
        }),
      );
    }
  }
  const cells = metrics.map(
    (metric) =>
      `${values.get(metric.key) ?? cellSql({ value: "NULL::text", reason: "'restricted'::text" })} AS ${aliases.get(metric.key)}`,
  );
  return {
    sql: `WITH ${ctes.join(",\n")} SELECT s.*,${cells.length ? cells.join(",") + "," : ""}${currencyMismatch} AS invalid_currency
      FROM scope s CROSS JOIN configuration configuration ${joins.join("\n")}`,
    sortExpressions: sorts,
  };
}

function orderSql(filters: Filters, expressions?: Map<string, string>): string {
  const identitySorts: Record<string, string> = {
    code: "s.code",
    name: "s.name",
    active: "s.active",
  };
  const parts = filters.sort.map(({ key, desc }) => {
    const expression = identitySorts[key] ?? expressions?.get(key);
    if (!expression)
      throw new HttpError(400, "invalid_sort", "ترتيب المؤشر غير صالح");
    return `${expression} ${desc ? "DESC" : "ASC"} NULLS LAST`;
  });
  parts.push("s.code ASC", "s.id ASC");
  return parts.join(",");
}

/** Caller has locked the current actor and company and checked base grants. */
export async function readAccountStatisticsReport(
  client: PoolClient,
  user: User,
  companyId: number,
  filters: Filters,
): Promise<AccountStatisticsReport> {
  const asOfDate = await balanceDate(client, filters.asOfDate);
  const visibility = await accountActivityVisibility(client, user, companyId);
  const pages = await directoryEntries(client, user, companyId);
  const stockAllowed = [
    "company.items",
    "company.stock-balances",
    "company.stock-movements",
  ].every((key) =>
    pages.some((page) => page.key === key && page.actionAccess.view),
  );
  const allowed = (metric: Metric): boolean => {
    if (metric.source === "stock") return stockAllowed;
    if (metric.source === "cashFourMonths") return visibility.purchaseCash;
    return metric.operationFamily ? visibility[metric.operationFamily] : true;
  };
  const metrics = filters.metrics.map((key) =>
    accountStatisticsMetricByKey(key)!,
  );
  const byKey = new Map(metrics.map((metric) => [metric.key, metric]));
  const sortedMetrics = filters.sort.flatMap(({ key }) => {
    const metric = byKey.get(key);
    return metric ? [metric] : [];
  });
  if (sortedMetrics.some((metric) => !allowed(metric)))
    throw new HttpError(
      403,
      "metric_restricted",
      "لا يمكن الترتيب بمؤشر محجوب بالصلاحيات",
    );
  const settings = (
    await client.query(
      `
    SELECT c.id,c.code,c.decimal_places,s.generation,
      (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date::text AS today
    FROM finance_settings f
    JOIN company_currencies c ON c.company_id=f.company_id AND c.id=f.base_currency_id AND c.active
    JOIN account_balance_sources s ON s.company_id=f.company_id WHERE f.company_id=$1`,
      [companyId],
    )
  ).rows[0];
  if (!settings) conflict("يلزم تحديد عملة أساسية فعالة قبل عرض الإحصاءات");
  const common = [
    companyId,
    asOfDate,
    settings.id,
    settings.code,
    settings.generation,
    settings.today,
  ];
  const candidates = [
    ...common,
    filters.q,
    filters.active,
    filters.category,
    filters.accountChoice,
  ];
  const total = Number(
    (
      await client.query(
        `WITH ${configuration} SELECT count(*)::text AS total FROM (${candidate}) counted`,
        candidates,
      )
    ).rows[0].total,
  );
  let selected: QueryResultRow[];
  const pageArguments = [
    ...candidates,
    filters.pageSize,
    (filters.page - 1) * filters.pageSize,
  ];
  if (sortedMetrics.length) {
    const ranked = projection(candidate, sortedMetrics, allowed);
    selected = (
      await client.query(
        `${ranked.sql} ORDER BY ${orderSql(filters, ranked.sortExpressions)} LIMIT $11 OFFSET $12`,
        pageArguments,
      )
    ).rows;
    if (selected.some((row) => row.invalid_currency))
      conflict("تعذر جمع الحركات بالعملة الأساسية الحالية");
  } else {
    selected = (
      await client.query(
        `WITH ${configuration} SELECT s.* FROM (${candidate}) s ORDER BY ${orderSql(filters)} LIMIT $11 OFFSET $12`,
        pageArguments,
      )
    ).rows;
  }
  let rows: QueryResultRow[] = [];
  if (selected.length) {
    const projected = projection(
      `SELECT ${identity} FROM accounts a WHERE a.company_id=$1 AND a.id=ANY($7::integer[])`,
      metrics,
      allowed,
    );
    const data = await client.query(projected.sql, [
      ...common,
      selected.map((row) => row.id),
    ]);
    if (data.rows.some((row) => row.invalid_currency))
      conflict("تعذر جمع الحركات بالعملة الأساسية الحالية");
    const byId = new Map(data.rows.map((row) => [row.id, row]));
    rows = selected.map((row) => byId.get(row.id)!);
  }
  return {
    companyId,
    asOfDate,
    currentStockDate: settings.today as string,
    currency: {
      id: settings.id as number,
      code: settings.code as string,
      decimalPlaces: settings.decimal_places as number,
    },
    coverage: "recorded_history_only" as const,
    metrics: metrics.map((metric) => ({
      ...metric,
      available: allowed(metric),
    })),
    rows: rows.map((row) => ({
      account: {
        id: row.id as number,
        code: row.code as string,
        name: row.name as string,
        active: row.active as boolean,
        category: row.category,
        accountChoice: row.account_choice,
      },
      values: Object.fromEntries(
        metrics.map((metric, index) => [metric.key, row[`m${index}`] as Cell]),
      ),
    })),
    total,
    page: filters.page,
    pageSize: filters.pageSize,
  };
}
