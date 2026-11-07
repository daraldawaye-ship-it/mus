import { Router, type Request } from "express";
import type { Pool, PoolClient } from "pg";
import { documentDateSchema } from "../../../packages/contracts/src/index.ts";
import { transaction } from "./db.ts";
import { HttpError } from "./errors.ts";
import { actor, handler, id, parse } from "./http.ts";
import { companyAccess, currentActor } from "./policies/access.ts";
import { directoryEntries } from "./services/pages.ts";
import { moneyString, moneyUnits } from "./services/finance.ts";

// Read permission comes from the company central page policies. There is no
// hard-coded owner-only exception; an empty central view list is owner-only.
async function ownerReport<T>(pool: Pool, req: Request, work: (client: PoolClient, companyId: number) => Promise<T>): Promise<T> {
  const companyId = id(req.params.companyId);
  return transaction(pool, async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const user = await currentActor(client, actor(req), false);
    await companyAccess(client, user, companyId);
    const pageKey = req.path.endsWith("/trial-balance")
      ? "company.trial-balance" : "company.cash-flows";
    const page = (await directoryEntries(client, user, companyId))
      .find(entry => entry.key === pageKey);
    if (!page?.actionAccess.view)
      throw new HttpError(403, "page_forbidden",
        "هذه الصفحة المالية متاحة فقط للصفات المحددة في مركز الصلاحيات.");
    return work(client, companyId);
  });
}

function adenToday(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Aden", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const part = (name: string) => parts.find((entry) => entry.type === name)?.value ?? "";
  return part("year") + "-" + part("month") + "-" + part("day");
}
function dates(req: Request) {
  const today = adenToday();
  const from = req.query.dateFrom === undefined ? today : req.query.dateFrom === "" ? null : parse(documentDateSchema, req.query.dateFrom);
  const to = req.query.dateTo === undefined ? today : req.query.dateTo === "" ? null : parse(documentDateSchema, req.query.dateTo);
  if (from && to && from > to) throw new HttpError(400, "invalid_query", "بداية الفترة تتجاوز نهايتها");
  return { from, to };
}
type Amounts = { opening: bigint; debit: bigint; credit: bigint };
function decimal(value: bigint): string { return moneyString(value); }
function split(value: bigint) {
  return { debit: decimal(value > 0n ? value : 0n), credit: decimal(value < 0n ? -value : 0n) };
}
function currencyCode(client: PoolClient, companyId: number) {
  return client.query(
    "SELECT c.code FROM finance_settings s JOIN company_currencies c ON c.company_id=s.company_id AND c.id=s.base_currency_id WHERE s.company_id=$1",
    [companyId],
  ).then((result) => String(result.rows[0]?.code ?? ""));
}
export function financialReportsRoutes(pool: Pool): Router {
  const router = Router();
  const base = "/companies/:companyId";

  router.get(base + "/trial-balance", handler(async (req, res) => {
    const result = await ownerReport(pool, req, async (client, companyId) => {
      const { from, to } = dates(req);
      const currency = await currencyCode(client, companyId);
      // The effective financial date agrees with the account ledger, including purchase corrections.
      const effective = "COALESCE(pd.invoice_date,d.document_date)";
      const sql = [
        "WITH movements AS (SELECT l.account_id,",
        "SUM(CASE WHEN $2::date IS NOT NULL AND " + effective + " < $2::date THEN l.base_debit-l.base_credit ELSE 0 END) AS opening,",
        "SUM(CASE WHEN ($2::date IS NULL OR " + effective + " >= $2::date) THEN l.base_debit ELSE 0 END) AS debit,",
        "SUM(CASE WHEN ($2::date IS NULL OR " + effective + " >= $2::date) THEN l.base_credit ELSE 0 END) AS credit",
        "FROM financial_document_lines l",
        "JOIN financial_documents d ON (d.company_id,d.id)=(l.company_id,l.document_id)",
        "LEFT JOIN purchase_correction_journal_dates pd ON (pd.company_id,pd.document_id)=(d.company_id,d.id)",
        "WHERE l.company_id=$1 AND d.status<>'draft' AND ($3::date IS NULL OR " + effective + " <= $3::date)",
        "GROUP BY l.account_id)",
        "SELECT a.id,a.parent_id,a.code,a.name,a.kind,a.category,",
        "COALESCE(m.opening,0)::text AS opening, COALESCE(m.debit,0)::text AS debit, COALESCE(m.credit,0)::text AS credit",
        "FROM accounts a LEFT JOIN movements m ON m.account_id=a.id",
        "WHERE a.company_id=$1 ORDER BY a.code, a.id",
      ].join(" ");
      const fetched = await client.query(sql, [companyId, from, to]);
      type Internal = Amounts & { id: number; parentId: number | null; code: string; name: string; kind: string; category: string };
      const internal: Internal[] = fetched.rows.map((row) => ({
        id: Number(row.id), parentId: row.parent_id === null ? null : Number(row.parent_id),
        code: String(row.code), name: String(row.name), kind: String(row.kind), category: String(row.category),
        opening: moneyUnits(row.opening), debit: moneyUnits(row.debit), credit: moneyUnits(row.credit),
      }));
      const map = new Map(internal.map((row) => [row.id, row]));
      const grand = { openingDebit: 0n, openingCredit: 0n, debit: 0n, credit: 0n, closingDebit: 0n, closingCredit: 0n };
      for (const row of internal) {
        if (row.kind !== "posting") continue;
        const openingPair = row.opening;
        const closingPair = row.opening + row.debit - row.credit;
        grand.openingDebit += openingPair > 0n ? openingPair : 0n;
        grand.openingCredit += openingPair < 0n ? -openingPair : 0n;
        grand.debit += row.debit;
        grand.credit += row.credit;
        grand.closingDebit += closingPair > 0n ? closingPair : 0n;
        grand.closingCredit += closingPair < 0n ? -closingPair : 0n;
        let parentId = row.parentId;
        const visited = new Set<number>([row.id]);
        while (parentId !== null && !visited.has(parentId)) {
          visited.add(parentId);
          const parent = map.get(parentId);
          if (!parent) break;
          parent.opening += row.opening;
          parent.debit += row.debit;
          parent.credit += row.credit;
          parentId = parent.parentId;
        }
      }
      const present = (row: Amounts) => {
        const closing = row.opening + row.debit - row.credit;
        const openingPair = split(row.opening), closingPair = split(closing);
        return {
          openingDebit: openingPair.debit, openingCredit: openingPair.credit,
          debit: decimal(row.debit), credit: decimal(row.credit),
          closingDebit: closingPair.debit, closingCredit: closingPair.credit,
          hasMovement: row.debit !== 0n || row.credit !== 0n,
        };
      };
      const items = internal.map((row) => ({
        id: row.id, parentId: row.parentId, code: row.code, name: row.name,
        kind: row.kind, category: row.category, ...present(row),
      }));
      return { dateFrom: from, dateTo: to, currencyCode: currency, items,
        totals: {
          openingDebit: decimal(grand.openingDebit), openingCredit: decimal(grand.openingCredit),
          debit: decimal(grand.debit), credit: decimal(grand.credit),
          closingDebit: decimal(grand.closingDebit), closingCredit: decimal(grand.closingCredit),
        },
        balanced: grand.openingDebit === grand.openingCredit &&
          grand.debit === grand.credit && grand.closingDebit === grand.closingCredit };
    });
    res.json(result);
  }));

  router.get(base + "/cash-flows", handler(async (req, res) => {
    const result = await ownerReport(pool, req, async (client, companyId) => {
      const { from, to } = dates(req);
      const rawPage = req.query.page === undefined ? 1 : Number(req.query.page);
      if (!Number.isSafeInteger(rawPage) || rawPage < 1 || rawPage > 1000000)
        throw new HttpError(400, "invalid_query", "رقم الصفحة غير صالح");
      const pageSize = 100;
      const effective = "COALESCE(pd.invoice_date,d.document_date)";
      const cte = [
        "WITH cash_docs AS (SELECT d.id,d.number,d.kind,d.description, " + effective + "::date AS document_date,",
        "COALESCE(SUM(l.base_debit) FILTER (WHERE a.cash_or_bank),0) AS cash_debit,",
        "COALESCE(SUM(l.base_credit) FILTER (WHERE a.cash_or_bank),0) AS cash_credit,",
        "MIN(a.category::text) FILTER (WHERE NOT a.cash_or_bank) AS first_category,",
        "MAX(a.category::text) FILTER (WHERE NOT a.cash_or_bank) AS last_category,",
        "STRING_AGG(DISTINCT a.name, '، ') FILTER (WHERE NOT a.cash_or_bank) AS counterpart",
        "FROM financial_document_lines l",
        "JOIN financial_documents d ON (d.company_id,d.id)=(l.company_id,l.document_id)",
        "JOIN accounts a ON (a.company_id,a.id)=(l.company_id,l.account_id)",
        "LEFT JOIN purchase_correction_journal_dates pd ON (pd.company_id,pd.document_id)=(d.company_id,d.id)",
        "WHERE l.company_id=$1 AND d.status<>'draft' AND ($3::date IS NULL OR " + effective + " <= $3::date)",
        "GROUP BY d.id,d.number,d.kind,d.description," + effective + "),",
        "classified AS (SELECT *,cash_debit-cash_credit AS net,",
        "CASE WHEN first_category IN ('income','expense') AND last_category IN ('income','expense') THEN 'operating'",
        "WHEN first_category='equity' AND last_category='equity' THEN 'financing'",
        "ELSE 'unclassified' END AS activity FROM cash_docs WHERE cash_debit<>cash_credit)",
      ].join(" ");
      const period = "($2::date IS NULL OR document_date >= $2::date)";
      const params = [companyId, from, to];
      const summary = await client.query(cte + " SELECT " +
        "COALESCE(SUM(CASE WHEN $2::date IS NOT NULL AND document_date < $2::date THEN net ELSE 0 END),0)::text AS opening, " +
        "COALESCE(SUM(CASE WHEN " + period + " AND net>0 THEN net ELSE 0 END),0)::text AS incoming, " +
        "COALESCE(SUM(CASE WHEN " + period + " AND net<0 THEN -net ELSE 0 END),0)::text AS outgoing, " +
        "COUNT(*) FILTER (WHERE " + period + ")::integer AS total " +
        "FROM classified", params);
      const grouped = await client.query(cte + " SELECT activity, " +
        "COALESCE(SUM(CASE WHEN net>0 THEN net ELSE 0 END),0)::text AS incoming, " +
        "COALESCE(SUM(CASE WHEN net<0 THEN -net ELSE 0 END),0)::text AS outgoing " +
        "FROM classified WHERE " + period + " GROUP BY activity", params);
      const detail = await client.query(cte + " SELECT id,number,kind,description,document_date::text AS date, " +
        "counterpart,activity,CASE WHEN net>0 THEN net ELSE 0 END::text AS incoming, " +
        "CASE WHEN net<0 THEN -net ELSE 0 END::text AS outgoing " +
        "FROM classified WHERE " + period +
        " ORDER BY document_date DESC,id DESC LIMIT $4 OFFSET $5",
        [...params, pageSize, (rawPage - 1) * pageSize]);
      const opening = moneyUnits(summary.rows[0]?.opening ?? "0");
      const incoming = moneyUnits(summary.rows[0]?.incoming ?? "0");
      const outgoing = moneyUnits(summary.rows[0]?.outgoing ?? "0");
      const activities = Object.fromEntries(["operating", "investing", "financing", "unclassified"].map((key) => {
        const row = grouped.rows.find((item) => item.activity === key);
        return [key, { incoming: decimal(moneyUnits(row?.incoming ?? "0")), outgoing: decimal(moneyUnits(row?.outgoing ?? "0")) }];
      }));
      return {
        dateFrom: from, dateTo: to, currencyCode: await currencyCode(client, companyId),
        opening: decimal(opening), incoming: decimal(incoming), outgoing: decimal(outgoing),
        closing: decimal(opening + incoming - outgoing),
        total: Number(summary.rows[0]?.total ?? 0), page: rawPage, pageSize, activities,
        items: detail.rows.map((row) => ({
          id: Number(row.id), number: String(row.number), kind: String(row.kind),
          date: String(row.date), description: String(row.description ?? ""),
          counterpart: String(row.counterpart ?? ""), activity: String(row.activity),
          incoming: decimal(moneyUnits(row.incoming)), outgoing: decimal(moneyUnits(row.outgoing)),
        })),
      };
    });
    res.json(result);
  }));
  return router;
}
