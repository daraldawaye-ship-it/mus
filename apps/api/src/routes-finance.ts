import { rewardVoucherPrintRequest } from "./services/wallet-print.ts";
import { Router, type Request } from "express";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  documentDateSchema,
  documentKinds,
  documentStatuses,
  financialDocumentSchema,
  financialDocumentPatchSchema,
  financialPostSchema,
  financialReverseSchema,
  normalizeRate,
  accountKinds,
  accountCategories,
  type AccountBalance,
  type AccountLedgerLine,
  type User,
} from "../../../packages/contracts/src/index.ts";
import { transaction } from "./db.ts";
import { HttpError, missing } from "./errors.ts";
import { actor, handler, id, parse } from "./http.ts";
import { companyAccess, currentActor } from "./policies/access.ts";
import { assertEditableDocumentDate, assertYerWhenCurrencyHidden } from "./services/control-values.ts";
import {
  accountDTO,
  accountSelect,
  branchDTO,
  branchSelect,
  currencyDTO,
  currencySelect,
} from "./repositories/masters.ts";
import { audit } from "./services/audit.ts";
import {
  assertBalanced,
  checkDocumentReferences,
  convertedUnits,
  documentDTOs,
  documentRow,
  documentTotals,
  financialFrom,
  financialSelect,
  findIdempotent,
  loadDocument,
  moneyString,
  moneyUnits,
  nextDocumentNumber,
  replaceDraftLines,
  type DocumentFields,
} from "./services/finance.ts";
import { listQuery, searchPattern } from "./services/lists.ts";
import { conflict, masterPage, mutateMaster } from "./services/masters.ts";

async function readFinance<T>(
  pool: Pool,
  req: Request,
  action: (client: PoolClient, companyId: number) => Promise<T>,
): Promise<T> {
  const companyId = id(req.params.companyId);
  return transaction(pool, async (client) => {
    await client.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    const user = await currentActor(client, actor(req), false);
    await companyAccess(client, user, companyId, "finance.view");
    return action(client, companyId);
  });
}
const documentColumns = {
  id: "d.id",
  number: "d.number",
  kind: "d.kind",
  status: "d.status",
  documentDate: "d.document_date",
  currencyId: "d.currency_id",
  currencyCode: "COALESCE(d.currency_code,c.code)",
  branchId: "d.branch_id",
  description: "d.description",
  supplierReceiptNumber: "d.supplier_receipt_number",
  totalDebit: "d.total_debit",
  totalCredit: "d.total_credit",
  createdAt: "d.created_at",
};
function fieldsOf(
  document: Awaited<ReturnType<typeof loadDocument>>,
): DocumentFields {
  return {
    kind: document.kind,
    documentDate: document.documentDate,
    currencyId: document.currencyId,
    branchId: document.branchId,
    cashAccountId: document.cashAccountId,
    supplierReceiptNumber: document.supplierReceiptNumber,
    description: document.description,
    lines: document.lines.map((line) => ({
      accountId: line.accountId,
      debit: line.debit,
      credit: line.credit,
      description: line.description,
    })),
  };
}
export async function insertDraft(
  client: PoolClient,
  companyId: number,
  user: User,
  input: DocumentFields,
  key: string,
  payload: unknown,
): Promise<number> {
  const number = await nextDocumentNumber(client, companyId);
  const total = documentTotals(input.lines);
  const result = await client.query(
    "INSERT INTO financial_documents(company_id,number,kind,document_date,currency_id,branch_id,cash_account_id,description,total_debit,total_credit,created_by,idempotency_key,creation_payload,supplier_receipt_number) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id",
    [
      companyId,
      number,
      input.kind,
      input.documentDate,
      input.currencyId,
      input.branchId,
      input.cashAccountId,
      input.description,
      total.debit,
      total.credit,
      user.id,
      key,
      JSON.stringify(payload),
      input.supplierReceiptNumber,
    ],
  );
  const documentId = result.rows[0].id as number;
  await replaceDraftLines(client, companyId, documentId, input.lines);
  return documentId;
}
export async function postDraft(
  client: PoolClient,
  companyId: number,
  documentId: number,
  user: User,
): Promise<void> {
  const document = await loadDocument(client, companyId, documentId);
  const fields = fieldsOf(document);
  await checkDocumentReferences(client, companyId, fields);
  assertBalanced(fields.lines);
  const currencies = await client.query(
    "SELECT c.*,b.id AS base_id,b.code AS base_code,b.decimal_places AS base_places,b.active AS base_active FROM company_currencies c JOIN finance_settings s ON s.company_id=c.company_id JOIN company_currencies b ON b.company_id=s.company_id AND b.id=s.base_currency_id WHERE c.company_id=$1 AND c.id=$2",
    [companyId, document.currencyId],
  );
  const currency = currencies.rows[0];
  if (!currency) conflict("اختر العملة الأساسية للشركة قبل الترحيل");
  if (!currency.base_active) conflict("العملة الأساسية موقوفة");
  let rate = "1",
    rateId: number | null = null,
    rateSource = "العملة الأساسية";
  if (document.currencyId !== currency.base_id) {
    // Calendar dates are UTC business days; do not depend on the host timezone.
    const rates = await client.query(
      "SELECT * FROM exchange_rates WHERE company_id=$1 AND currency_id=$2 AND base_currency_id=$3 AND active AND effective_at < (($4::date + 1)::timestamp AT TIME ZONE 'UTC') ORDER BY effective_at DESC,id DESC LIMIT 1",
      [companyId, document.currencyId, currency.base_id, document.documentDate],
    );
    if (!rates.rows[0])
      conflict("لا يوجد سعر صرف فعال بتاريخ المستند؛ سجّل سعرًا قبل الترحيل");
    rate = normalizeRate(rates.rows[0].rate);
    rateId = rates.rows[0].id;
    rateSource = rates.rows[0].source;
  }
  let baseDebit = 0n,
    baseCredit = 0n;
  for (const line of document.lines) {
    const debit = convertedUnits(line.debit, rate, currency.base_places);
    const credit = convertedUnits(line.credit, rate, currency.base_places);
    baseDebit += debit;
    baseCredit += credit;
    await client.query(
      "UPDATE financial_document_lines l SET base_debit=$1,base_credit=$2,account_code=a.code,account_name=a.name FROM accounts a WHERE l.company_id=$3 AND l.document_id=$4 AND l.id=$5 AND a.company_id=l.company_id AND a.id=l.account_id",
      [moneyString(debit), moneyString(credit), companyId, documentId, line.id],
    );
  }
  if (baseDebit !== baseCredit)
    throw new HttpError(
      400,
      "rounding_imbalance",
      "التقريب إلى دقة العملة الأساسية أحدث فرقًا؛ عدّل توزيع السطور قبل الترحيل",
    );
  if (baseDebit === 0n)
    throw new HttpError(
      400,
      "conversion_zero",
      "المبلغ أصغر من دقة العملة الأساسية بعد التحويل",
    );
  await client.query(
    "UPDATE financial_documents SET status='posted',revision=revision+1,posted_from_revision=revision,posted_at=now(),posted_by=$1,currency_code=$2,currency_name=$3,decimal_places=$4,base_currency_id=$5,base_currency_code=$6,base_decimal_places=$7,exchange_rate=$8,exchange_rate_id=$9,exchange_rate_source=$10,total_base_debit=$11,total_base_credit=$12,branch_name=(SELECT name FROM branches WHERE company_id=$13 AND id=branch_id) WHERE company_id=$13 AND id=$14",
    [
      user.id,
      currency.code,
      currency.name,
      currency.decimal_places,
      currency.base_id,
      currency.base_code,
      currency.base_places,
      rate,
      rateId,
      rateSource,
      moneyString(baseDebit),
      moneyString(baseCredit),
      companyId,
      documentId,
    ],
  );
}

function dateFilters(req: Request): { from: string | null; to: string | null } {
  const from =
    req.query.dateFrom === undefined
      ? null
      : parse(documentDateSchema, req.query.dateFrom);
  const to =
    req.query.dateTo === undefined
      ? null
      : parse(documentDateSchema, req.query.dateTo);
  if (from && to && from > to)
    throw new HttpError(400, "invalid_query", "بداية الفترة تتجاوز نهايتها");
  return { from, to };
}

/** Shared immutable ledger computation for either permitted account. */
async function readAccountLedger(
  client: PoolClient,
  companyId: number,
  accountId: number,
  req: Request,
) {
  const account = await client.query(
    "SELECT id,code,name FROM accounts WHERE company_id=$1 AND id=$2 AND kind='posting'",
    [companyId, accountId],
  );
  if (!account.rowCount)
    missing("الحساب الحركي غير موجود في هذه الشركة");
  const dates = dateFilters(req);
  const query = listQuery(
    req.query,
    {
      id: "f.id",
      documentId: "f.document_id",
      lineNumber: "f.line_number",
      documentDate: "f.document_date",
      documentNumber: "f.number",
      kind: "f.kind",
      debit: "f.debit",
      credit: "f.credit",
      baseDebit: "f.base_debit",
      baseCredit: "f.base_credit",
      runningBalance: "f.running_balance",
    },
    "documentDate:asc,documentId:asc,lineNumber:asc",
  );
  const params = [
    companyId,
    accountId,
    dates.from,
    dates.to,
    searchPattern(query.q),
  ];
  const from =
    "FROM financial_document_lines l JOIN financial_documents d ON d.company_id=l.company_id AND d.id=l.document_id WHERE l.company_id=$1 AND l.account_id=$2 AND d.status<>'draft'";
  const opening = await client.query(
    `SELECT COALESCE(sum(l.base_debit-l.base_credit),0)::text AS balance ${from} AND $3::date IS NOT NULL AND d.document_date < $3::date`,
    [companyId, accountId, dates.from],
  );
  const totals = await client.query(
    `SELECT COALESCE(sum(l.base_debit),0)::text AS debit,COALESCE(sum(l.base_credit),0)::text AS credit ${from} AND ($3::date IS NULL OR d.document_date >= $3::date) AND ($4::date IS NULL OR d.document_date <= $4::date)`,
    [companyId, accountId, dates.from, dates.to],
  );
  // Compute cumulative balance before filtering/search/paging, so each row retains its true chronological balance.
  const cte = `WITH full_ledger AS (SELECT l.*,d.number,d.document_date,d.kind,d.status,d.currency_id,d.currency_code,d.description AS document_description,d.reverses_document_id,sum(l.base_debit-l.base_credit) OVER(ORDER BY d.document_date,d.id,l.line_number ROWS UNBOUNDED PRECEDING) AS running_balance ${from})`;
  const filter =
    "($3::date IS NULL OR f.document_date >= $3::date) AND ($4::date IS NULL OR f.document_date <= $4::date) AND (f.number ILIKE $5 OR f.description ILIKE $5 OR f.document_description ILIKE $5)";
  const count = await client.query(
    `${cte} SELECT count(*)::integer AS total FROM full_ledger f WHERE ${filter}`,
    params,
  );
  const rows = await client.query(
    `${cte} SELECT f.*,f.document_date::text AS date_text FROM full_ledger f WHERE ${filter} ORDER BY ${query.order} LIMIT $6 OFFSET $7`,
    [...params, query.pageSize, query.offset],
  );
  const items: AccountLedgerLine[] = rows.rows.map((row) => ({
    id: row.id,
    documentId: row.document_id,
    documentNumber: row.number,
    documentDate: row.date_text,
    kind: row.kind,
    status: row.status,
    description: row.description || row.document_description,
    currencyId: row.currency_id,
    currencyCode: row.currency_code,
    debit: normalizeRate(row.debit),
    credit: normalizeRate(row.credit),
    baseDebit: normalizeRate(row.base_debit),
    baseCredit: normalizeRate(row.base_credit),
    runningBalance: moneyString(moneyUnits(row.running_balance)),
    reversesDocumentId: row.reverses_document_id,
  }));
  const settings = await client.query(
    "SELECT c.code FROM finance_settings s JOIN company_currencies c ON c.company_id=s.company_id AND c.id=s.base_currency_id WHERE s.company_id=$1",
    [companyId],
  );
  const openingUnits = moneyUnits(opening.rows[0].balance),
    debitUnits = moneyUnits(totals.rows[0].debit),
    creditUnits = moneyUnits(totals.rows[0].credit);
  return {
    items,
    total: count.rows[0].total,
    page: query.page,
    pageSize: query.pageSize,
    account: account.rows[0],
    totals: {
      openingBalance: moneyString(openingUnits),
      debit: moneyString(debitUnits),
      credit: moneyString(creditUnits),
      closingBalance: moneyString(
        openingUnits + debitUnits - creditUnits,
      ),
      baseCurrencyCode: settings.rows[0]?.code ?? null,
    },
  };
}

export function financeRoutes(pool: Pool): Router {
  const router = Router(),
    base = "/companies/:companyId";
  router.get(
    `${base}/financial-options`,
    handler(async (req, res) => {
      const result = await readFinance(pool, req, async (client, companyId) => {
        if (req.query.type === "accounts")
          return masterPage(
            client,
            req,
            companyId,
            accountSelect,
            "FROM accounts a LEFT JOIN accounts p ON p.company_id=a.company_id AND p.id=a.parent_id",
            "a",
            {
              id: "a.id",
              code: "a.code",
              name: "a.name",
              kind: "a.kind",
              category: "a.category",
              active: "a.active",
              cashOrBank: "a.cash_or_bank",
            },
            ["a.code", "a.name"],
            accountDTO,
            {
              kind: accountKinds,
              category: accountCategories,
              active: "boolean",
              cashOrBank: "boolean",
            },
            "code:asc",
          );
        if (req.query.type === "currencies")
          return masterPage(
            client,
            req,
            companyId,
            currencySelect,
            "FROM company_currencies c",
            "c",
            { id: "c.id", code: "c.code", name: "c.name", active: "c.active" },
            ["c.code", "c.name"],
            currencyDTO,
            { active: "boolean" },
            "code:asc",
          );
        if (req.query.type === "branches")
          return masterPage(
            client,
            req,
            companyId,
            branchSelect,
            "FROM branches b",
            "b",
            { id: "b.id", code: "b.code", name: "b.name", active: "b.active" },
            ["b.code", "b.name"],
            branchDTO,
            { active: "boolean" },
            "code:asc",
          );
        throw new HttpError(
          400,
          "invalid_query",
          "نوع قائمة الاختيار غير صالح",
        );
      });
      res.json(result);
    }),
  );
  router.get(
    `${base}/financial-documents`,
    handler(async (req, res) => {
      res.json(
        await readFinance(pool, req, async (client, companyId) => {
          const query = listQuery(
            req.query,
            documentColumns,
            "documentDate:desc,id:desc",
          );
          const params: unknown[] = [companyId, searchPattern(query.q)];
          let where =
            "d.company_id=$1 AND (d.number ILIKE $2 OR d.supplier_receipt_number ILIKE $2 OR d.description ILIKE $2)";
          for (const [field, allowed] of [
            ["kind", documentKinds],
            ["status", documentStatuses],
          ] as const) {
            const value = req.query[field];
            if (value === undefined) continue;
            if (
              typeof value !== "string" ||
              !(allowed as readonly string[]).includes(value)
            )
              throw new HttpError(
                400,
                "invalid_query",
                "فلتر المستندات غير صالح",
              );
            params.push(value);
            where += ` AND ${documentColumns[field]}=$${params.length}`;
          }
          const dates = dateFilters(req);
          if (dates.from) {
            params.push(dates.from);
            where += ` AND d.document_date >= $${params.length}::date`;
          }
          if (dates.to) {
            params.push(dates.to);
            where += ` AND d.document_date <= $${params.length}::date`;
          }
          const count = await client.query(
            `SELECT count(*)::integer AS total ${financialFrom} WHERE ${where}`,
            params,
          );
          const rows = await client.query(
            `${financialSelect} WHERE ${where} ORDER BY ${query.order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
            [...params, query.pageSize, query.offset],
          );
          return {
            items: await documentDTOs(client, rows.rows),
            total: count.rows[0].total,
            page: query.page,
            pageSize: query.pageSize,
          };
        }),
      );
    }),
  );
  router.post(
    `${base}/financial-documents`,
    handler(async (req, res) => {
      const input = parse(financialDocumentSchema, req.body);
      const result = await mutateMaster(
        pool,
        req,
        "finance.manage",
        async (client, user, companyId) => {
          const previous = await findIdempotent(
            client,
            companyId,
            input.idempotencyKey,
            input,
          );
          if (previous)
            return {
              document: await loadDocument(client, companyId, previous.id),
              created: false,
            };
          await assertEditableDocumentDate(client, companyId,
            input.kind === "receipt" ? "edit_receipts_date" :
            input.kind === "payment" ? "edit_payments_date" : "edit_journals_date",
            input.documentDate);
          await assertYerWhenCurrencyHidden(client, companyId, input.currencyId);
          await checkDocumentReferences(client, companyId, input);
          const documentId = await insertDraft(
            client,
            companyId,
            user,
            input,
            input.idempotencyKey,
            input,
          );
          const document = await loadDocument(client, companyId, documentId);
          await audit(
            client,
            user,
            "financialDocument.create",
            "financialDocument",
            documentId,
            null,
            document,
            companyId,
          );
          return { document, created: true };
        },
      );
      res
        .status(result.created ? 201 : 200)
        .json({ document: result.document });
    }),
  );
  router.get(
    `${base}/financial-documents/:id`,
    handler(async (req, res) => {
      const documentId = id(req.params.id);
      res.json({
        document: await readFinance(pool, req, (client, companyId) =>
          loadDocument(client, companyId, documentId),
        ),
      });
    }),
  );
  router.post(
    `${base}/financial-documents/:id/print-request`,
    handler(async (req, res) => {
      const documentId = id(req.params.id);
      const result = await mutateMaster(
        pool,
        req,
        "finance.view",
        (client, user, companyId) =>
          rewardVoucherPrintRequest(client, companyId, documentId, user),
      );
      res.json(result);
    }),
  );
  router.patch(
    `${base}/financial-documents/:id`,
    handler(async (req, res) => {
      const documentId = id(req.params.id),
        input = parse(financialDocumentPatchSchema, req.body);
      const document = await mutateMaster(
        pool,
        req,
        "finance.manage",
        async (client, user, companyId) => {
          await documentRow(client, companyId, documentId, true);
          const before = await loadDocument(client, companyId, documentId);
          if (before.status !== "draft")
            conflict("المستند المرحل لا يعدل؛ استخدم العكس بقيد مستقل");
          if (before.revision !== input.revision)
            conflict("عدّل مستخدم آخر هذه المسودة؛ أعد تحميلها قبل الحفظ");
          await assertEditableDocumentDate(client, companyId,
            input.kind === "receipt" ? "edit_receipts_date" :
            input.kind === "payment" ? "edit_payments_date" : "edit_journals_date",
            input.documentDate, before.documentDate);
          await checkDocumentReferences(client, companyId, input);
          const totals = documentTotals(input.lines);
          await client.query(
            "UPDATE financial_documents SET kind=$1,document_date=$2,currency_id=$3,branch_id=$4,cash_account_id=$5,description=$6,total_debit=$7,total_credit=$8,supplier_receipt_number=$9,revision=revision+1 WHERE company_id=$10 AND id=$11",
            [
              input.kind,
              input.documentDate,
              input.currencyId,
              input.branchId,
              input.cashAccountId,
              input.description,
              totals.debit,
              totals.credit,
              input.supplierReceiptNumber,
              companyId,
              documentId,
            ],
          );
          await replaceDraftLines(client, companyId, documentId, input.lines);
          const next = await loadDocument(client, companyId, documentId);
          await audit(
            client,
            user,
            "financialDocument.update",
            "financialDocument",
            documentId,
            before,
            next,
            companyId,
          );
          return next;
        },
      );
      res.json({ document });
    }),
  );
  router.post(
    `${base}/financial-documents/:id/post`,
    handler(async (req, res) => {
      const documentId = id(req.params.id),
        input = parse(financialPostSchema, req.body);
      const document = await mutateMaster(
        pool,
        req,
        "finance.post",
        async (client, user, companyId) => {
          const row = await documentRow(client, companyId, documentId, true);
          if (row.status !== "draft") {
            if (row.posted_from_revision === input.revision)
              return loadDocument(client, companyId, documentId);
            conflict("المستند مرحل بالفعل أو تغير إصداره");
          }
          const before = await loadDocument(client, companyId, documentId);
          if (before.revision !== input.revision)
            conflict("تغير إصدار المسودة؛ أعد تحميلها قبل الترحيل");
          await postDraft(client, companyId, documentId, user);
          const next = await loadDocument(client, companyId, documentId);
          await audit(
            client,
            user,
            "financialDocument.post",
            "financialDocument",
            documentId,
            before,
            next,
            companyId,
          );
          return next;
        },
      );
      res.json({ document });
    }),
  );
  router.post(
    `${base}/financial-documents/:id/reverse`,
    handler(async (req, res) => {
      const documentId = id(req.params.id),
        input = parse(financialReverseSchema, req.body);
      const result = await mutateMaster(
        pool,
        req,
        "finance.post",
        async (client, user, companyId) => {
          const payload = {
            operation: "reverse",
            originalDocumentId: documentId,
            ...input,
          };
          const previous = await findIdempotent(
            client,
            companyId,
            input.idempotencyKey,
            payload,
          );
          if (previous)
            return {
              document: await loadDocument(client, companyId, documentId),
              reversalDocument: await loadDocument(
                client,
                companyId,
                previous.id,
              ),
            };
          await documentRow(client, companyId, documentId, true);
          const before = await loadDocument(client, companyId, documentId);
          const linkedStock = await client.query("SELECT 1 FROM invoices WHERE company_id=$1 AND $2 IN(financial_document_id,cost_document_id,variance_document_id) UNION ALL SELECT 1 FROM stock_operations WHERE company_id=$1 AND financial_document_id=$2 LIMIT 1", [companyId, documentId]);
          if (linkedStock.rowCount) conflict("هذا القيد مرتبط بفاتورة أو حركة مخزون؛ صححه بمردود مرتبط أو تسوية مخزون موثقة");
          const linkedWallet = await client.query("SELECT 1 FROM wallet_conversions WHERE company_id=$1 AND financial_document_id=$2", [companyId, documentId]);
          if (linkedWallet.rowCount) conflict("هذا القيد مرتبط بتحويل نقاط؛ لا يمكن عكسه مستقلاً عن المحفظة");
          const linkedCashbox=await client.query(
            "SELECT 1 FROM employee_cashbox_operations WHERE company_id=$1 AND financial_document_id=$2",
            [companyId,documentId],
          );
          if(linkedCashbox.rowCount) conflict("القيد مرتبط بترحيل أو إغلاق صندوق الموظف؛ لا يمكن عكسه منفصلًا عن سجل الصندوق");
          const linkedPouchReceipt=await client.query(
            "SELECT 1 FROM employee_pouch_receipts WHERE company_id=$1 AND financial_document_id=$2",
            [companyId,documentId],
          );
          if(linkedPouchReceipt.rowCount)
            conflict("القيد مرتبط باستلام حركة حافظة؛ لا يمكن عكسه مستقلًا عن سجل الاستلام");
          const linkedElectronicReceipt=await client.query(
            "SELECT 1 FROM employee_electronic_receipts WHERE company_id=$1 AND financial_document_id=$2",
            [companyId,documentId],
          );
          if(linkedElectronicReceipt.rowCount)
            conflict("القيد مرتبط باستلام حركة محفظة إلكترونية؛ لا يمكن عكسه مستقلًا عن سجل الاستلام");
          if (before.status !== "posted")
            conflict("يمكن عكس المستند المرحل مرة واحدة فقط");
          if (before.reversesDocumentId !== null)
            conflict("قيد العكس لا يعكس مجددًا؛ أنشئ مستند تصحيح مستقلًا");
          if (input.documentDate < before.documentDate)
            throw new HttpError(
              400,
              "invalid_reverse_date",
              "تاريخ العكس لا يسبق تاريخ المستند الأصلي",
            );
          const reversedFields: DocumentFields = {
            ...fieldsOf(before),
            kind: "journal",
            cashAccountId: null,
            supplierReceiptNumber: "",
            documentDate: input.documentDate,
            description: input.reason,
            lines: before.lines.map((line) => ({
              accountId: line.accountId,
              debit: line.credit,
              credit: line.debit,
              description: line.description,
            })),
          };
          // Reversal is correction of history: inactive references and archived rate sources remain valid.
          const reversalId = await insertDraft(
            client,
            companyId,
            user,
            reversedFields,
            input.idempotencyKey,
            payload,
          );
          for (const line of before.lines)
            await client.query(
              "UPDATE financial_document_lines SET account_code=$1,account_name=$2,base_debit=$3,base_credit=$4 WHERE company_id=$5 AND document_id=$6 AND line_number=$7",
              [
                line.accountCode,
                line.accountName,
                line.baseCredit,
                line.baseDebit,
                companyId,
                reversalId,
                line.lineNumber,
              ],
            );
          await client.query(
            "UPDATE financial_documents SET currency_code=$1,currency_name=$2,decimal_places=$3,base_currency_id=$4,base_currency_code=$5,base_decimal_places=$6,exchange_rate=$7,exchange_rate_id=$8,exchange_rate_source=$9,branch_name=$10,total_base_debit=$11,total_base_credit=$12,reverses_document_id=$13,status='posted',revision=revision+1,posted_from_revision=revision,posted_by=$14,posted_at=now() WHERE company_id=$15 AND id=$16",
            [
              before.currencyCode,
              before.currencyName,
              before.decimalPlaces,
              before.baseCurrencyId,
              before.baseCurrencyCode,
              before.baseDecimalPlaces,
              before.exchangeRate,
              before.exchangeRateId,
              before.exchangeRateSource,
              before.branchName,
              before.totalBaseCredit,
              before.totalBaseDebit,
              before.id,
              user.id,
              companyId,
              reversalId,
            ],
          );
          await client.query(
            "UPDATE financial_documents SET status='reversed',reversal_document_id=$1,revision=revision+1 WHERE company_id=$2 AND id=$3",
            [reversalId, companyId, documentId],
          );
          const document = await loadDocument(client, companyId, documentId),
            reversalDocument = await loadDocument(
              client,
              companyId,
              reversalId,
            );
          await audit(
            client,
            user,
            "financialDocument.reverse",
            "financialDocument",
            documentId,
            before,
            { document, reversalDocument },
            companyId,
          );
          return { document, reversalDocument };
        },
      );
      res.json(result);
    }),
  );

  router.get(
    `${base}/account-balances`,
    handler(async (req, res) => {
      res.json(
        await readFinance(pool, req, async (client, companyId) => {
          const dates = dateFilters(req);
          const query = listQuery(
            req.query,
            {
              id: "a.id",
              accountId: "a.id",
              accountCode: "a.code",
              accountName: "a.name",
              debit: "COALESCE(t.debit,0)",
              credit: "COALESCE(t.credit,0)",
              balance: "COALESCE(t.debit,0)-COALESCE(t.credit,0)",
            },
            "accountCode:asc",
          );
          const params: unknown[] = [
            companyId,
            searchPattern(query.q),
            dates.from,
            dates.to,
          ];
          const from =
            "FROM accounts a LEFT JOIN (SELECT l.account_id,sum(l.base_debit) AS debit,sum(l.base_credit) AS credit FROM financial_document_lines l JOIN financial_documents d ON d.company_id=l.company_id AND d.id=l.document_id WHERE l.company_id=$1 AND d.status<>'draft' AND ($3::date IS NULL OR d.document_date >= $3::date) AND ($4::date IS NULL OR d.document_date <= $4::date) GROUP BY l.account_id) t ON t.account_id=a.id";
          let where =
            "a.company_id=$1 AND a.kind='posting' AND (a.code ILIKE $2 OR a.name ILIKE $2)";
          if (req.query.accountId !== undefined) {
            params.push(
              id(
                typeof req.query.accountId === "string"
                  ? req.query.accountId
                  : undefined,
              ),
            );
            where += ` AND a.id=$${params.length}`;
          }
          const count = await client.query(
            `SELECT count(*)::integer AS total ${from} WHERE ${where}`,
            params,
          );
          const rows = await client.query(
            `SELECT a.id,a.code,a.name,a.normal_side,COALESCE(t.debit,0)::text AS debit,COALESCE(t.credit,0)::text AS credit ${from} WHERE ${where} ORDER BY ${query.order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
            [...params, query.pageSize, query.offset],
          );
          const settings = await client.query(
            "SELECT c.code FROM finance_settings s JOIN company_currencies c ON c.company_id=s.company_id AND c.id=s.base_currency_id WHERE s.company_id=$1",
            [companyId],
          );
          const currencyCode = settings.rows[0]?.code ?? null;
          const items: AccountBalance[] = rows.rows.map((row) => ({
            id: row.id,
            accountId: row.id,
            accountCode: row.code,
            accountName: row.name,
            normalSide: row.normal_side,
            baseCurrencyCode: currencyCode,
            debit: moneyString(moneyUnits(row.debit)),
            credit: moneyString(moneyUnits(row.credit)),
            balance: moneyString(
              moneyUnits(row.debit) - moneyUnits(row.credit),
            ),
          }));
          return {
            items,
            total: count.rows[0].total,
            page: query.page,
            pageSize: query.pageSize,
          };
        }),
      );
    }),
  );
  router.get(
    `${base}/my-cashbox-ledger`,
    handler(async (req, res) => {
      const result = await transaction(pool, async (client) => {
        await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const companyId = id(req.params.companyId);
        const user = await currentActor(client, actor(req), false);
        // This action is independent of finance.view and cashbox ownership.
        const context = await companyAccess(
          client, user, companyId, "finance.own-cashbox.view",
        );
        // Never trust accountId or employeeId supplied by the caller.
        const linked = context.employee
          ? await client.query(
              `SELECT a.id
               FROM employee_account_links l
               JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id
               WHERE l.company_id=$1 AND l.employee_id=$2
                 AND l.account_kind='sales_cash'
                 AND a.active=true AND a.kind='posting' AND a.cash_or_bank=true
               LIMIT 1`,
              [companyId, context.employee.id],
            )
          : null;
        if (!linked?.rows[0]) {
          const paging = listQuery(req.query, { id: "id" });
          return {
            account: null,
            items: [],
            total: 0,
            page: paging.page,
            pageSize: paging.pageSize,
            totals: null,
          };
        }
        return readAccountLedger(client, companyId, linked.rows[0].id, req);
      });
      res.json(result);
    }),
  );
  router.get(
    `${base}/account-ledger`,
    handler(async (req, res) => {
      res.json(
        await readFinance(pool, req, (client, companyId) =>
          readAccountLedger(
            client,
            companyId,
            id(typeof req.query.accountId === "string" ? req.query.accountId : undefined),
            req,
          ),
        ),
      );
    }),
  );
  return router;
}
