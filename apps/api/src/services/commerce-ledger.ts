import type { PoolClient } from "pg";
import type { User } from "../../../../packages/contracts/src/index.ts";
import { audit } from "./audit.ts";
import {
  assertBalanced,
  checkDocumentReferences,
  documentTotals,
  loadDocument,
  moneyUnits,
  nextDocumentNumber,
  replaceDraftLines,
  type DocumentFields,
} from "./finance.ts";
import { postDraft } from "../routes-finance.ts";
import { HttpError } from "../errors.ts";

/** Writes to the existing ledger within the caller's stock/invoice transaction. */
export async function postCommerceJournal(
  client: PoolClient,
  companyId: number,
  user: User,
  input: {
    documentDate: string;
    branchId: number | null;
    currencyId: number;
    description: string;
    idempotencyKey: string;
    lines: DocumentFields["lines"];
  },
): Promise<number> {
  const fields: DocumentFields = {
    kind: "journal",
    cashAccountId: null,
    documentDate: input.documentDate,
    branchId: input.branchId,
    currencyId: input.currencyId,
    description: input.description,
    lines: input.lines,
  };
  const maximum = 10n ** 28n - 1n;
  for (const line of input.lines)
    if (moneyUnits(line.debit) > maximum || moneyUnits(line.credit) > maximum)
      throw new HttpError(
        400,
        "amount_overflow",
        "مبلغ السطر المحاسبي يتجاوز الحد المدعوم",
      );
  assertBalanced(fields.lines);
  await checkDocumentReferences(client, companyId, fields);
  const totals = documentTotals(fields.lines);
  const result = await client.query(
    "INSERT INTO financial_documents(company_id,number,kind,document_date,currency_id,branch_id,description,total_debit,total_credit,created_by,idempotency_key,creation_payload) VALUES($1,$2,'journal',$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id",
    [
      companyId,
      await nextDocumentNumber(client, companyId),
      input.documentDate,
      input.currencyId,
      input.branchId,
      input.description,
      totals.debit,
      totals.credit,
      user.id,
      input.idempotencyKey,
      JSON.stringify(fields),
    ],
  );
  const documentId = result.rows[0].id as number;
  await replaceDraftLines(client, companyId, documentId, fields.lines);
  await postDraft(client, companyId, documentId, user);
  await audit(
    client,
    user,
    "financialDocument.post",
    "financialDocument",
    documentId,
    null,
    await loadDocument(client, companyId, documentId),
    companyId,
  );
  return documentId;
}
