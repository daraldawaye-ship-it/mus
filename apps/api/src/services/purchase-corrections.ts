import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import {
  invoiceSchema,
  type User,
} from "../../../../packages/contracts/src/index.ts";
import { loadInvoice, createInvoice } from "./commerce.ts";
import {
  adenToday,
  assertMobileInvoiceCreation,
  assertYerWhenCurrencyHidden,
  controlValue,
} from "./control-values.ts";
import { conflict } from "./masters.ts";
import { emitNotification } from "./notifications.ts";
import { moneyUnits, moneyString } from "./finance.ts";

export const correctionSchema = z
  .object({
    reason: z.string().trim().min(1).max(500),
    invoice: invoiceSchema,
    previewHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function correctPurchase(
  client: PoolClient,
  companyId: number,
  user: User,
  id: number,
  input: z.output<typeof correctionSchema>,
  agent: string | undefined,
) {
  await client.query(
    "SELECT id FROM invoices WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [companyId, id],
  );
  const original = await loadInvoice(client, companyId, id);
  const fields = input.invoice;
  if (original.kind !== "purchase" || fields.kind !== "purchase")
    conflict("التصحيح للمشتريات فقط");
  const requestHash = hash([user.id, input]);
  const existing = (
    await client.query(
      "SELECT original_id,replacement_id,request_hash FROM purchase_invoice_corrections WHERE company_id=$1 AND (original_id=$2 OR reversal_id=$2)",
      [companyId, id],
    )
  ).rows[0];
  if (existing) {
    if (existing.request_hash === requestHash)
      return { replacementId: existing.replacement_id };
    conflict("سبق تصحيح هذه الفاتورة. افتح الفاتورة المصححة.");
  }
  if (
    original.lines.some((line) => BigInt(line.quantity) <= 0n) ||
    fields.lines.some((line) => BigInt(line.quantity) <= 0n)
  )
    conflict("هذا التصحيح متاح لفواتير الشراء ذات البنود الموجبة فقط");
  if (
    fields.currencyId !== original.currencyId ||
    fields.branchId !== original.branchId ||
    fields.locationId !== original.locationId
  )
    conflict("يجب أن يطابق الفرع والموقع والعملة فاتورة الأصل");
  await assertMobileInvoiceCreation(client, companyId, "purchase", agent);
  await assertYerWhenCurrencyHidden(client, companyId, fields.currencyId);
  const items = [
    ...new Set([...fields.lines, ...original.lines].map((line) => line.itemId)),
  ];
  const later = await client.query(
    "SELECT EXISTS(SELECT 1 FROM stock_movements WHERE company_id=$1 AND item_id=ANY($2::int[]) AND document_date>$3) OR EXISTS(SELECT 1 FROM financial_documents WHERE company_id=$1 AND status='posted' AND document_date>$3) AS found",
    [companyId, items, original.documentDate],
  );
  const documentDate =
    later.rows[0].found ||
    !(await controlValue(client, companyId, "edit_purchases_date"))
      ? await adenToday(client)
      : original.documentDate;
  await client.query("SAVEPOINT purchase_preview");
  const reversal = await createInvoice(
    client,
    companyId,
    user,
    {
      ...fields,
      documentDate,
      idempotencyKey: randomUUID(),
      counterpartyAccountId: original.counterpartyAccountId,
      supplierAccountId: original.supplierAccountId,
      supplierReceiptNumber: original.supplierReceiptNumber,
      description: "عكس للتصحيح " + original.number,
      discount: "0",
      lines: original.lines.map((line) => ({
        itemId: line.itemId,
        unit: line.unit,
        quantity: "-" + line.quantity,
        originalLineId: line.id,
        expiryDate: line.expiryDate,
      })),
    },
    undefined,
    true,
  );
  if (
    reversal.lines.some(
      (line, i) =>
        BigInt(line.smallestQuantity) !==
        -BigInt(original.lines[i]!.smallestQuantity),
    ) ||
    moneyUnits(reversal.baseTotal) !== -moneyUnits(original.baseTotal) ||
    moneyUnits(reversal.total) !== -moneyUnits(original.total)
  )
    conflict(
      "تعذر عكس الكمية أو القيمة الأصلية بالكامل بعوامل الوحدات وسعر الصرف الحاليين",
    );
  const unsafeStock = await client.query(
    `SELECT 1 FROM stock_movements m
      JOIN invoice_lines l ON l.company_id=m.company_id AND l.id=m.invoice_line_id
      JOIN stock_balances b ON b.company_id=m.company_id AND b.item_id=m.item_id
        AND b.location_id=m.location_id AND b.batch_key=m.batch_key
      JOIN stock_item_valuations v ON v.company_id=m.company_id AND v.item_id=m.item_id
      WHERE m.company_id=$1 AND m.invoice_id=$2 AND (b.quantity_smallest<0 OR v.quantity_smallest<0
        OR m.batch_key<>COALESCE(l.expiry_date::text,'')) LIMIT 1`,
    [companyId,reversal.id],
  );
  if (unsafeStock.rowCount)
    conflict("المتوفر من دفعة الأصل لا يكفي لعكس الفاتورة. راجع التسوية مع المحاسب.");
  // Never accept a key that refers to an independently posted invoice.
  if (
    (
      await client.query(
        "SELECT 1 FROM invoices WHERE company_id=$1 AND idempotency_key=$2",
        [companyId, fields.idempotencyKey],
      )
    ).rowCount
  )
    conflict("مفتاح التصحيح مستخدم من قبل");
  const replacement = await createInvoice(
    client,
    companyId,
    user,
    { ...fields, documentDate },
    undefined,
    true,
  );
  const journalIds = [reversal, replacement]
    .flatMap((i) => [
      i.financialDocumentId,
      i.varianceDocumentId,
      i.costDocumentId,
    ])
    .filter((n) => n !== null);
  const ledger = (
    await client.query(
      `SELECT account_code AS code,account_name AS name,
    sum(base_debit-base_credit)::text AS delta FROM financial_document_lines
    WHERE company_id=$1 AND document_id=ANY($2::int[]) GROUP BY account_code,account_name ORDER BY account_code,account_name`,
      [companyId, journalIds],
    )
  ).rows;
  const stock = (
    await client.query(
      `SELECT i.name,m.batch_key AS batch,sum(m.quantity_smallest)::text AS quantity,
    sum(m.cost_base)::text AS cost FROM stock_movements m JOIN items i ON i.company_id=m.company_id AND i.id=m.item_id
    WHERE m.company_id=$1 AND m.invoice_id=ANY($2::int[]) GROUP BY i.id,i.name,m.batch_key ORDER BY i.id,m.batch_key`,
      [companyId, [reversal.id, replacement.id]],
    )
  ).rows;
  const impact = {
    invoiceDate: original.documentDate,
    documentDate,
    oldTotal: original.total,
    newTotal: replacement.total,
    difference: moneyString(
      moneyUnits(replacement.total) - moneyUnits(original.total),
    ),
    stock,
    ledger,
  };
  const previewHash = hash([
    companyId,
    id,
    user.id,
    fields,
    input.reason,
    impact,
  ]);
  if (!input.previewHash) {
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await client.query("ROLLBACK TO SAVEPOINT purchase_preview");
    return { previewHash, impact };
  }
  if (input.previewHash !== previewHash)
    conflict("تغيّرت الفروقات. اعرض المعاينة مجددًا.");
  const name = user.displayName || user.name;
  const saved = await client.query(
    `INSERT INTO purchase_invoice_corrections(company_id,original_id,reversal_id,replacement_id,
    actor_id,actor_name,reason,before_invoice,after_invoice,impact,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    RETURNING to_char(corrected_at AT TIME ZONE 'Asia/Aden','DD/MM/YYYY HH24:MI:SS') AS local_time`,
    [
      companyId,
      id,
      reversal.id,
      replacement.id,
      user.id,
      name,
      input.reason,
      original,
      { ...replacement, documentDate: original.documentDate },
      impact,
      requestHash,
    ],
  );
  await emitNotification(client, {
    companyId,
    code: "PURCHASE_CORRECTED",
    subjectKey: "purchase:" + id,
    eventKey: "correction:" + replacement.id,
    message: `الأصل ${original.number}، التصحيح ${replacement.number}، ${name} (حساب ${user.id})، ${saved.rows[0].local_time}، السبب: ${input.reason}. الصافي ${original.total} ← ${replacement.total} ${original.currencyCode}.`,
    href: `/companies/${companyId}/invoices/${replacement.id}`,
  });
  return { replacementId: replacement.id };
}
