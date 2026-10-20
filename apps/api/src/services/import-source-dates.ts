import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { documentDateSchema } from "../../../../packages/contracts/src/index.ts";
import { HttpError } from "../errors.ts";

const sourceDate =
  "substring(s.source_metadata->>'sourceCreatedAt' from 1 for 10)::date";
const tables = ["invoices", "financial_documents", "stock_movements"] as const;

export async function prepareSourceDateTargets(
  db: PoolClient,
  companyId: number,
  sourceSystem: string,
) {
  const sources = await db.query(
    "SELECT source_metadata->>'sourceCreatedAt' AS date FROM transaction_source_imports WHERE company_id=$1 AND source_system=$2",
    [companyId, sourceSystem],
  );
  if (sources.rowCount! > 50_000)
    throw new HttpError(
      409,
      "conflict",
      "عدد المستندات يتجاوز حد تصحيح التواريخ",
    );
  for (const row of sources.rows) {
    if (
      typeof row.date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}(?:[ T]|$)/.test(row.date) ||
      !documentDateSchema.safeParse(row.date.slice(0, 10)).success
    )
      throw new HttpError(
        409,
        "conflict",
        "يوجد مستند مستورد دون تاريخ مصدر صالح؛ لم يتغير أي تاريخ",
      );
  }
  await db.query(`CREATE TEMP TABLE tijara_source_date_targets (
    company_id integer NOT NULL,table_name text NOT NULL,id integer NOT NULL,
    original_date date NOT NULL,source_date date NOT NULL,
    PRIMARY KEY(company_id,table_name,id)
  ) ON COMMIT DROP`);
  await db.query(
    `INSERT INTO tijara_source_date_targets
    SELECT i.company_id,'invoices',i.id,i.document_date,${sourceDate}
    FROM transaction_source_imports s JOIN invoices i ON i.company_id=s.company_id AND i.id=s.invoice_id
    WHERE s.company_id=$1 AND s.source_system=$2 AND i.posted`,
    [companyId, sourceSystem],
  );
  await db.query(
    `INSERT INTO tijara_source_date_targets
    SELECT DISTINCT d.company_id,'financial_documents',d.id,d.document_date,x.source_date
    FROM (
      SELECT s.company_id,s.financial_document_id AS id,${sourceDate} AS source_date
      FROM transaction_source_imports s WHERE s.company_id=$1 AND s.source_system=$2 AND s.financial_document_id IS NOT NULL
      UNION ALL
      SELECT i.company_id,link.id,${sourceDate}
      FROM transaction_source_imports s JOIN invoices i ON i.company_id=s.company_id AND i.id=s.invoice_id
      CROSS JOIN LATERAL unnest(ARRAY[i.financial_document_id,i.cost_document_id,i.variance_document_id]) link(id)
      WHERE s.company_id=$1 AND s.source_system=$2 AND i.posted AND link.id IS NOT NULL
    ) x JOIN financial_documents d ON d.company_id=x.company_id AND d.id=x.id`,
    [companyId, sourceSystem],
  );
  await db.query(
    `INSERT INTO tijara_source_date_targets
    SELECT m.company_id,'stock_movements',m.id,m.document_date,${sourceDate}
    FROM transaction_source_imports s JOIN stock_movements m ON m.company_id=s.company_id AND m.invoice_id=s.invoice_id
    WHERE s.company_id=$1 AND s.source_system=$2`,
    [companyId, sourceSystem],
  );
}

export async function sourceDateState(
  db: PoolClient,
  companyId: number,
  sourceSystem: string,
) {
  const fingerprint = createHash("sha256"),
    unchanged = createHash("sha256");
  fingerprint.update(JSON.stringify({ companyId, sourceSystem }));
  unchanged.update(JSON.stringify({ companyId, sourceSystem }));
  for (const table of [
    ...tables,
    "invoice_lines",
    "financial_document_lines",
    "stock_balances",
    "stock_item_valuations",
    "transaction_source_imports",
  ]) {
    const target = tables.includes(table as (typeof tables)[number]);
    const result = await db.query(
      `SELECT
      encode(sha256(convert_to(COALESCE(string_agg(encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex'),'|' ORDER BY ${table === "transaction_source_imports" ? "r.source_system,r.source_kind,r.source_id" : table === "stock_item_valuations" ? "r.item_id" : "r.id"}),''),'UTF8')),'hex') AS full_hash,
      encode(sha256(convert_to(COALESCE(string_agg(encode(sha256(convert_to(${target ? "CASE WHEN t.id IS NOT NULL THEN to_jsonb(r)-'document_date' ELSE to_jsonb(r) END" : "to_jsonb(r)"}::text,'UTF8')),'hex'),'|' ORDER BY ${table === "transaction_source_imports" ? "r.source_system,r.source_kind,r.source_id" : table === "stock_item_valuations" ? "r.item_id" : "r.id"}),''),'UTF8')),'hex') AS unchanged_hash
      FROM ${table} r ${target ? "LEFT JOIN tijara_source_date_targets t ON t.company_id=r.company_id AND t.table_name='" + table + "' AND t.id=r.id" : ""}
      WHERE r.company_id=$1`,
      [companyId],
    );
    fingerprint.update(table + ":" + result.rows[0].full_hash);
    unchanged.update(table + ":" + result.rows[0].unchanged_hash);
  }
  const counts = (
    await db.query(`SELECT table_name,count(*)::integer AS total,
    count(*) FILTER(WHERE r_date<>source_date)::integer AS pending,
    COALESCE(sum(r_bytes) FILTER(WHERE r_date<>source_date),0)::text AS pending_row_bytes,
    min(source_date)::text AS first_date,max(source_date)::text AS last_date
    FROM (
      SELECT t.*,i.document_date AS r_date,pg_column_size(i) AS r_bytes FROM tijara_source_date_targets t JOIN invoices i ON t.company_id=i.company_id AND t.id=i.id WHERE table_name='invoices'
      UNION ALL SELECT t.*,d.document_date,pg_column_size(d) FROM tijara_source_date_targets t JOIN financial_documents d ON t.company_id=d.company_id AND t.id=d.id WHERE table_name='financial_documents'
      UNION ALL SELECT t.*,m.document_date,pg_column_size(m) FROM tijara_source_date_targets t JOIN stock_movements m ON t.company_id=m.company_id AND t.id=m.id WHERE table_name='stock_movements'
    ) x GROUP BY table_name ORDER BY table_name`)
  ).rows;
  const ledger = (
    await db.query(
      `SELECT count(*)::integer AS documents,COALESCE(sum(total_base_debit),0)::text AS debit,
    COALESCE(sum(total_base_credit),0)::text AS credit FROM financial_documents WHERE company_id=$1 AND status<>'draft'`,
      [companyId],
    )
  ).rows[0];
  return {
    fingerprint: fingerprint.digest("hex"),
    unchangedFingerprint: unchanged.digest("hex"),
    counts,
    ledger,
  };
}

export async function applySourceDates(db: PoolClient, companyId: number) {
  const changes = (
    await db.query(`SELECT table_name AS table,id,original_date::text AS from,source_date::text AS to
    FROM tijara_source_date_targets WHERE original_date<>source_date ORDER BY table_name,id`)
  ).rows;
  if (!changes.length) return changes;
  await db.query(`CREATE TEMP TABLE tijara_source_date_days ON COMMIT DROP AS
    SELECT DISTINCT l.item_id,d.day FROM tijara_source_date_targets t
    JOIN invoice_lines l ON l.company_id=t.company_id AND l.invoice_id=t.id
    CROSS JOIN LATERAL unnest(ARRAY[t.original_date,t.source_date]) d(day)
    WHERE t.table_name='invoices' AND t.original_date<>t.source_date`);
  await db.query("CREATE UNIQUE INDEX ON tijara_source_date_days(item_id,day)");
  await db.query(`CREATE TEMP TABLE tijara_source_price_days ON COMMIT DROP AS
    SELECT DISTINCT f.item_id,f.base_currency_id,d.day FROM item_purchase_price_facts f
    JOIN tijara_source_date_targets t ON t.company_id=f.company_id AND t.id=f.invoice_id AND t.table_name='invoices'
    CROSS JOIN LATERAL unnest(ARRAY[t.original_date,t.source_date]) d(day)
    WHERE t.original_date<>t.source_date`);
  await db.query(
    "SELECT set_config('tijara.source_date_company',$1,true),set_config('tijara.source_date_txid',txid_current()::text,true)",
    [String(companyId)],
  );
  for (const table of tables) {
    await db.query(
      `UPDATE ${table} r SET document_date=t.source_date FROM tijara_source_date_targets t
      WHERE t.company_id=r.company_id AND t.id=r.id AND t.table_name=$1 AND r.document_date<>t.source_date`,
      [table],
    );
  }
  // Only rebuild affected item/day facts, including any ordinary invoices on
  // those days. Existing composition triggers refresh their own projections.
  await db.query(
    `DELETE FROM item_daily_activity d USING tijara_source_date_days t
    WHERE d.company_id=$1 AND d.item_id=t.item_id AND d.document_date=t.day`,
    [companyId],
  );
  await db.query(
    `WITH per_invoice AS (
    SELECT i.id,i.kind,i.document_date,l.item_id,
      count(*) FILTER(WHERE l.smallest_quantity>0) AS positive_lines,
      count(*) FILTER(WHERE l.smallest_quantity<0) AS negative_lines,
      COALESCE(sum(l.smallest_quantity) FILTER(WHERE l.smallest_quantity>0),0) AS positive_quantity,
      -COALESCE(sum(l.smallest_quantity) FILTER(WHERE l.smallest_quantity<0),0) AS negative_quantity
    FROM invoices i JOIN invoice_lines l ON l.company_id=i.company_id AND l.invoice_id=i.id
    JOIN tijara_source_date_days d ON d.item_id=l.item_id AND d.day=i.document_date
    WHERE i.company_id=$1 AND i.posted GROUP BY i.id,i.kind,i.document_date,l.item_id
  ) INSERT INTO item_daily_activity(company_id,item_id,document_date,
    sale_invoices,sale_return_invoices,sale_lines,sale_return_lines,sale_quantity,sale_return_quantity,
    purchase_invoices,purchase_return_invoices,purchase_lines,purchase_return_lines,purchase_quantity,purchase_return_quantity)
  SELECT $1,item_id,document_date,
    count(*) FILTER(WHERE kind='sale' AND positive_lines>0),count(*) FILTER(WHERE kind='sale' AND negative_lines>0),
    COALESCE(sum(positive_lines) FILTER(WHERE kind='sale'),0),COALESCE(sum(negative_lines) FILTER(WHERE kind='sale'),0),
    COALESCE(sum(positive_quantity) FILTER(WHERE kind='sale'),0),COALESCE(sum(negative_quantity) FILTER(WHERE kind='sale'),0),
    count(*) FILTER(WHERE kind='purchase' AND positive_lines>0),count(*) FILTER(WHERE kind='purchase' AND negative_lines>0),
    COALESCE(sum(positive_lines) FILTER(WHERE kind='purchase'),0),COALESCE(sum(negative_lines) FILTER(WHERE kind='purchase'),0),
    COALESCE(sum(positive_quantity) FILTER(WHERE kind='purchase'),0),COALESCE(sum(negative_quantity) FILTER(WHERE kind='purchase'),0)
    FROM per_invoice GROUP BY item_id,document_date`,
    [companyId],
  );
  await db.query(
    `DELETE FROM item_purchase_price_daily d USING tijara_source_price_days t
    WHERE d.company_id=$1 AND d.item_id=t.item_id AND d.document_date=t.day AND d.base_currency_id=t.base_currency_id`,
    [companyId],
  );
  await db.query(`UPDATE item_purchase_price_facts f SET document_date=t.source_date FROM tijara_source_date_targets t
    WHERE t.company_id=f.company_id AND t.id=f.invoice_id AND t.table_name='invoices' AND f.document_date<>t.source_date`);
  await db.query(
    "SELECT refresh_item_purchase_price_day($1,item_id,day,base_currency_id) FROM tijara_source_price_days ORDER BY item_id,day,base_currency_id",
    [companyId],
  );
  await db.query("SELECT invalidate_company_account_balance_statistics($1)", [
    companyId,
  ]);
  await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  await db.query(
    "SELECT set_config('tijara.source_date_company','',true),set_config('tijara.source_date_txid','',true)",
  );
  return changes;
}
