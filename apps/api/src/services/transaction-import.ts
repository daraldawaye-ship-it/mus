import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { z } from "zod";
import type { User } from "../../../../packages/contracts/src/index.ts";
import type { batchSchema } from "../routes-transaction-import-schemas.ts";
import { HttpError } from "../errors.ts";
import { audit } from "./audit.ts";
import { createInvoice, loadInvoice } from "./commerce.ts";
import {
  assertBalanced,
  checkDocumentReferences,
  loadDocument,
} from "./finance.ts";
import { insertDraft, postDraft } from "../routes-finance.ts";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
const fingerprint = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
export type ImportSummary = {
  type: "invoice" | "voucher";
  sourceId: string;
  id: number;
  number: string;
  total: string;
};
export type ImportFailure = {
  type: "invoice" | "voucher";
  sourceId: string;
  code: string;
  message: string;
};

export type ImportBatch = z.infer<typeof batchSchema>;
export type ImportBatchResult = {
  companyId: number;
  sourceSystem: string;
  postingDate: string;
  imported: ImportSummary[];
  existing: ImportSummary[];
  failed: ImportFailure[];
  replayed: boolean;
};

/** The caller owns the transaction and must authorize the current actor/company first. */
export async function importTransactionBatch(
  client: PoolClient,
  user: User,
  companyId: number,
  input: ImportBatch,
  assertPages: () => Promise<void>,
): Promise<ImportBatchResult> {
  const hash = fingerprint(input);
  const previous = (
    await client.query(
      "SELECT * FROM transaction_import_batches WHERE company_id=$1 AND idempotency_key=$2",
      [companyId, input.idempotencyKey],
    )
  ).rows[0];
  if (previous) {
    if (previous.created_by !== user.id || previous.request_hash !== hash)
      throw new HttpError(
        409,
        "conflict",
        "استُخدم مفتاح الدفعة لبيانات مختلفة",
      );
    return { ...previous.result, replayed: true };
  }
  await assertPages();
  const imported: ImportSummary[] = [],
    existing: ImportSummary[] = [],
    failed: ImportFailure[] = [];
  // Fetch duplicate identities once per batch instead of once per invoice.
  const mappedRows = await client.query(
    "SELECT * FROM transaction_source_imports WHERE company_id=$1 AND source_system=$2 AND source_kind=$3 AND source_id=ANY($4::text[])",
    [companyId, input.sourceSystem, "invoice", input.documents.filter(doc=>doc.type==="invoice").map(doc=>doc.sourceId)],
  );
  const mappedInvoices = new Map<string, (typeof mappedRows.rows)[number]>(
    mappedRows.rows.map(row=>[String(row.source_id),row]),
  );
  const mappedVoucherRows = await client.query(
    "SELECT * FROM transaction_source_imports WHERE company_id=$1 AND source_system=$2 AND source_kind=$3 AND source_id=ANY($4::text[])",
    [companyId, input.sourceSystem, "voucher", input.documents.filter(doc=>doc.type==="voucher").map(doc=>doc.sourceId)],
  );
  const mappedVouchers = new Map<string, (typeof mappedVoucherRows.rows)[number]>(
    mappedVoucherRows.rows.map(row=>[String(row.source_id),row]),
  );
  for (const source of input.documents) {
    await client.query("SAVEPOINT transaction_import_document");
    try {
      const recordHash = fingerprint(source);
      const mapped = (source.type === "invoice" ? mappedInvoices : mappedVouchers).get(source.sourceId);
      if (mapped) {
        if (
          mapped.created_by !== user.id ||
          mapped.request_hash !== recordHash
        )
          throw new HttpError(
            409,
            "source_conflict",
            "سبق ترحيل هوية المصدر ببيانات مختلفة",
          );
        const document =
          source.type === "invoice"
            ? await loadInvoice(client, companyId, mapped.invoice_id)
            : await loadDocument(
                client,
                companyId,
                mapped.financial_document_id,
              );
        existing.push({
          type: source.type,
          sourceId: source.sourceId,
          id: document.id,
          number: document.number,
          total:
            "total" in document ? document.total : document.totalDebit,
        });
        await client.query(
          "RELEASE SAVEPOINT transaction_import_document",
        );
        continue;
      }
      const table =
        source.type === "invoice" ? "invoices" : "financial_documents";
      const occupied = await client.query(
        `SELECT 1 FROM ${table} WHERE company_id=$1 AND idempotency_key=$2`,
        [companyId, source.payload.idempotencyKey],
      );
      if (occupied.rowCount)
        throw new HttpError(
          409,
          "source_key_conflict",
          "مفتاح المستند مرتبط بحركة سابقة خارج هذه الهوية",
        );
      const reference = `ترحيل تاريخي | المصدر ${input.sourceSystem} | الرقم السابق ${source.sourceDocumentNumber} | التاريخ السابق ${source.sourceCreatedAt} | المستخدم الأصلي ${source.sourceCreators.join("، ")}`;
      const description = (
        reference +
        " | " +
        source.payload.description
      ).slice(0, 1000);
      let summary: ImportSummary;
      if (source.type === "invoice") {
        const invoice = await createInvoice(
          client,
          companyId,
          user,
          { ...source.payload, description },
          {
            allowHistoricalPrice: true,
            allowUnknownExpiry: true,
            suppressRewards: true,
            allowHistoricalStockChronology: true,
            allowExpenseCounterparty: true,
            allowHistoricalInactiveItems: true,
          },
        );
        summary = {
          type: source.type,
          sourceId: source.sourceId,
          id: invoice.id,
          number: invoice.number,
          total: invoice.total,
        };
      } else {
        const payload = { ...source.payload, description };
        await checkDocumentReferences(client, companyId, payload);
        assertBalanced(payload.lines);
        const documentId = await insertDraft(
          client,
          companyId,
          user,
          payload,
          payload.idempotencyKey,
          payload,
        );
        await postDraft(client, companyId, documentId, user);
        const document = await loadDocument(
          client,
          companyId,
          documentId,
        );
        await audit(
          client,
          user,
          "financialDocument.post",
          "financialDocument",
          documentId,
          null,
          document,
          companyId,
        );
        summary = {
          type: source.type,
          sourceId: source.sourceId,
          id: document.id,
          number: document.number,
          total: document.totalDebit,
        };
      }
      const { payload: unused, ...metadata } = source;
      await client.query(
        "INSERT INTO transaction_source_imports(company_id,source_system,source_kind,source_id,created_by,request_hash,source_metadata,invoice_id,financial_document_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          companyId,
          input.sourceSystem,
          source.type,
          source.sourceId,
          user.id,
          recordHash,
          JSON.stringify(metadata),
          source.type === "invoice" ? summary.id : null,
          source.type === "voucher" ? summary.id : null,
        ],
      );
      // Force deferred accounting/stock checks inside this savepoint. A bad
      // document cannot poison the successful documents in the same batch.
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      await client.query("RELEASE SAVEPOINT transaction_import_document");
      imported.push(summary);
    } catch (error) {
      await client.query(
        "ROLLBACK TO SAVEPOINT transaction_import_document",
      );
      await client.query("RELEASE SAVEPOINT transaction_import_document");
      failed.push({
        type: source.type,
        sourceId: source.sourceId,
        code: error instanceof HttpError ? error.code : "import_failed",
        message:
          error instanceof HttpError
            ? error.message
            : "تعذر ترحيل المستند؛ لم يُحفظ أي جزء منه",
      });
      if (!(error instanceof HttpError)) {
        const code = error && typeof error === "object" && "code" in error
          ? String(error.code) : "import_failed";
        console.error(
          "Historical transaction import failed",
          source.type,
          source.sourceId,
          /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : "import_failed",
        );
      }
    }
  }
  const result = {
    companyId,
    sourceSystem: input.sourceSystem,
    postingDate: input.postingDate,
    imported,
    existing,
    failed,
  };
  await audit(
    client,
    user,
    "company.transactions.import",
    "company",
    companyId,
    null,
    {
      sourceSystem: input.sourceSystem,
      postingDate: input.postingDate,
      imported: imported.length,
      existing: existing.length,
      failed: failed.length,
    },
    companyId,
  );
  await client.query(
    "INSERT INTO transaction_import_batches(company_id,idempotency_key,created_by,request_hash,result) VALUES($1,$2,$3,$4,$5)",
    [
      companyId,
      input.idempotencyKey,
      user.id,
      hash,
      JSON.stringify(result),
    ],
  );
  return { ...result, replayed: false };
}
